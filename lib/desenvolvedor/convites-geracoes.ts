import { z } from 'zod';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import type { DbExecutor } from '../db/contracts';
import { erroAcesso } from '../acessos/erros.ts';
import { ConviteError } from '../convites/domain';
import { concluirGeracaoComImagem, evidenciaSanitizada, reconciliarGeracoesParadas, resolverGeracaoIncerta } from '../convites/service';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';

/**
 * Fila do operador da plataforma para gerações de IA de convites sem resultado confirmado. Buffet e cliente veem só
 * "Estamos verificando sua geração"; a evidência técnica e a decisão financeira ficam aqui, com a concessão de
 * desenvolvedor (conferida de novo e travada na transação), senha recente para decidir e auditoria do painel.
 * Nenhuma consulta ao provedor: a conferência é no painel de uso/custos da OpenAI ou com o suporte (X-Client-Request-Id).
 */
export type GeracoesConvitesDeps = PainelDeps & {
    reconciliar: () => Promise<unknown>;
    resolver: (tx: DbExecutor, operadorId: string, raw: unknown) => ReturnType<typeof resolverGeracaoIncerta>;
    concluir: (tx: DbExecutor, operadorId: string, raw: unknown) => ReturnType<typeof concluirGeracaoComImagem>;
};
export const geracoesConvitesDepsPadrao = (): GeracoesConvitesDeps => ({
    ...painelDepsPadrao, reconciliar: () => reconciliarGeracoesParadas(), resolver: resolverGeracaoIncerta, concluir: concluirGeracaoComImagem,
});

// O que a documentação do provedor permite (Images API, conferido em 18/10/2026) — mostrado junto da fila.
export const LIMITES_PROVEDOR = [
    'A Images API não aceita chave de idempotência, não tem consulta de status e não permite recuperar uma imagem depois.',
    'O x-request-id e o X-Client-Request-Id (enviamos a chave da geração) servem só para o suporte da OpenAI localizar o pedido.',
    'Uso e custos da organização são agregados (uso por minuto, custo por dia); não há cobrança por requisição.',
    'moderation_blocked, timeout ou ausência de dados no painel não comprovam, sozinhos, que não houve cobrança.',
];

type Pendente = {
    id: string; criado_em: string; enviado_em: string | null; recebido_em: string | null; falha_classe: string | null; falha_diagnostico: string | null;
    falha_detalhes: unknown; evento: unknown; modelo: string; reserva_microusd: string; origem: string; imagem_retida: boolean;
    festa_id: string | null; empresa_id: string; empresa_nome: string;
};
type Automatica = { id: string; estado: string; criado_em: string; falha_classe: string | null; falha_diagnostico: string | null; empresa_nome: string };
type Decisao = { id: string; resolucao_resultado: string; resolucao_em: string; resolucao_evidencia: string; resolvedor: string | null; empresa_nome: string; criado_em: string; falha_classe: string | null };

export async function filaGeracoesConvites(sessao: SessaoAdmin, deps: GeracoesConvitesDeps = geracoesConvitesDepsPadrao()) {
    // Sem provedor: só conclui imagens guardadas, devolve o que não foi enviado e classifica as paradas.
    await deps.reconciliar().catch(() => undefined);
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        const pendentes = (await tx.query<Pendente>(`SELECT g.id,g.criado_em,g.enviado_em,g.recebido_em,g.falha_classe,g.falha_diagnostico,g.falha_detalhes,
              g.modelo,g.reserva_microusd::text AS reserva_microusd,split_part(g.ator,':',1) AS origem,(g.resultado_pendente IS NOT NULL) AS imagem_retida,
              c.festa_id,e.id AS empresa_id,e.nome AS empresa_nome,
              (SELECT ev.detalhe FROM convite_eventos ev WHERE ev.convite_id=g.convite_id AND ev.acao='IA_INCERTA'
                 AND ev.detalhe->>'geracao'=g.id::text ORDER BY ev.id DESC LIMIT 1) AS evento
            FROM convite_geracoes g JOIN convites c ON c.id=g.convite_id AND c.empresa_id=g.empresa_id JOIN empresas e ON e.id=g.empresa_id
            WHERE g.estado='INCERTA' ORDER BY g.criado_em LIMIT 100`)).rows;
        const automaticas = (await tx.query<Automatica>(`SELECT g.id,g.estado,g.criado_em,g.falha_classe,g.falha_diagnostico,e.nome AS empresa_nome
            FROM convite_geracoes g JOIN empresas e ON e.id=g.empresa_id
            WHERE g.criado_em > now() - interval '30 days' AND (g.estado='NAO_ENVIADA' OR (g.estado='CONCLUIDA' AND EXISTS (
              SELECT 1 FROM convite_eventos ev WHERE ev.convite_id=g.convite_id AND ev.acao='IA_CONCLUIDA' AND ev.detalhe->>'geracao'=g.id::text
                AND (ev.detalhe ? 'recuperada' OR ev.detalhe ? 'aposVerificacao'))))
            ORDER BY g.criado_em DESC LIMIT 30`)).rows;
        const decisoes = (await tx.query<Decisao>(`SELECT g.id,g.resolucao_resultado,g.resolucao_em,g.resolucao_evidencia,u.nome AS resolvedor,e.nome AS empresa_nome,
              g.criado_em,g.falha_classe
            FROM convite_geracoes g JOIN empresas e ON e.id=g.empresa_id LEFT JOIN usuarios_administrativos u ON u.id=g.resolucao_por
            WHERE g.estado IN ('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA') ORDER BY g.resolucao_em DESC LIMIT 30`)).rows;
        return {
            pendentes: pendentes.map((g) => ({
                id: g.id, criadoEm: g.criado_em, enviadoEm: g.enviado_em, recebidoEm: g.recebido_em, origem: g.origem === 'CLIENTE' ? 'CLIENTE' : 'BUFFET',
                // Gerações anteriores à 084 não têm classe: a evidência vem só do evento IA_INCERTA.
                classe: g.falha_classe ?? 'SEM_CLASSE', diagnostico: g.falha_diagnostico,
                evidencia: { ...evidenciaSanitizada(g.evento), ...evidenciaSanitizada(g.falha_detalhes) },
                modelo: g.modelo, reservaMicrousd: g.reserva_microusd, imagemRetida: g.imagem_retida,
                festaId: g.festa_id, empresaId: g.empresa_id, empresaNome: g.empresa_nome,
            })),
            automaticas: automaticas.map((g) => ({ id: g.id, estado: g.estado, criadoEm: g.criado_em, classe: g.falha_classe, diagnostico: g.falha_diagnostico, empresaNome: g.empresa_nome })),
            decisoes: decisoes.map((d) => ({ id: d.id, resultado: d.resolucao_resultado, em: d.resolucao_em, evidencia: d.resolucao_evidencia, resolvedor: d.resolvedor, empresaNome: d.empresa_nome, criadoEm: d.criado_em, classe: d.falha_classe })),
            limites: LIMITES_PROVEDOR,
        };
    });
}

// decidir: cobrança confirmada (mantém) ou sem cobrança (devolve uma vez); concluir_com_imagem: entrega a imagem já
// recebida e retida, sem chamar o provedor (crédito mantido). O conteúdo é validado de novo pelo serviço.
const operacaoSchema = z.discriminatedUnion('acao', [
    z.object({ acao: z.literal('decidir'), geracaoId: z.unknown(), resultado: z.unknown(), evidencia: z.unknown() }).strict(),
    z.object({ acao: z.literal('concluir_com_imagem'), geracaoId: z.unknown() }).strict(),
]);

/** Operação do operador sobre uma geração INCERTA: senha confirmada há ≤ 5 min, concessão travada e auditoria. */
export async function resolverGeracaoConvite(sessao: SessaoAdmin, raw: unknown, ctx: ContextoPainel, deps: GeracoesConvitesDeps = geracoesConvitesDepsPadrao()) {
    exigirReautenticacaoRecente(sessao);
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            const { acao, ...dados } = operacaoSchema.parse(raw);
            const r = acao === 'concluir_com_imagem' ? await deps.concluir(tx, sessao.usuario_id, dados) : await deps.resolver(tx, sessao.usuario_id, dados);
            await auditarPainel(deps.registrarAuditoria, tx, {
                atorId: sessao.usuario_id, acao: acao === 'concluir_com_imagem' ? 'CONVITE_GERACAO_CONCLUIDA_COM_IMAGEM' : 'CONVITE_GERACAO_RESOLVIDA', entidadeTipo: 'CONVITE_GERACAO', entidadeId: r.geracaoId, empresaId: r.empresaId,
                resultado: 'SUCESSO', depois: { estado: r.estado, liberouReserva: r.liberouReserva }, ctx,
            });
            return { estado: r.estado, liberouReserva: r.liberouReserva };
        });
    }
    catch (error) {
        if (error instanceof ConviteError)
            throw erroAcesso(error.status === 404 ? 'NAO_ENCONTRADO' : 'CONFLITO', error.message, error.status);
        throw error;
    }
}
