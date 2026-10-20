import { z } from 'zod';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirDesenvolvedorNaTransacao } from '../desenvolvedor/autorizacao.ts';
import type { ClienteAsaas } from './asaas.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';
import { concluirIntencao, marcadoresDeRemocao, PREFIXO_CRIACAO, PREFIXO_REMOCAO_SEM_CONFIRMACAO, TIPO_PENDENCIA } from './reconciliacao-contratacao.ts';

/**
 * Liberação MANUAL e auditada de uma intenção de criação comprovadamente NÃO executada (painel do desenvolvedor).
 * Enquanto a intenção está aberta, a empresa não faz novo POST de criação; nada a libera por prazo. Só libera se,
 * na mesma transação (concessão de desenvolvedor travada, trava da contratação da empresa):
 *   1. é uma intenção de criação (`kidmais:criacao:`) desta empresa, aberta e sem id de assinatura;
 *   2. a empresa não tem vínculo nem outra pendência aberta com id de assinatura (operação executada em alguma forma);
 *   3. o provedor, consultado agora, não mostra nenhuma assinatura não removida com a referência da empresa;
 *   4. a pessoa declara que conferiu no painel do provedor (confirmação literal) e justifica (10–500 caracteres).
 * Senha confirmada há ≤ 5 min é exigida por quem chama (lib/desenvolvedor/cobranca.ts). Grava auditoria com o motivo.
 * Recusas não alteram nada.
 */
export const CONFIRMACAO_LIBERACAO = 'CONFERI_NO_PROVEDOR_QUE_NAO_FOI_CRIADA';
const Entrada = z.object({
    pendenciaId: z.string().uuid(),
    motivo: z.string().trim().min(10).max(500),
    confirmacao: z.literal(CONFIRMACAO_LIBERACAO),
}).strict();

const ABERTAS = "('PENDENTE', 'FALHOU')";
const recusa = (mensagem: string, status = 409) => erroAcesso('CONFLITO', mensagem, status);
/** Sem atalho para ignorar: o marcador só fecha quando a releitura no provedor confirma a exclusão. */
export const MENSAGEM_BLOQUEIO_REMOCAO = 'Liberação bloqueada: há uma exclusão de assinatura no provedor com resultado desconhecido nesta empresa. Confira no painel do Asaas; a liberação volta a ser possível quando a reconciliação confirmar a exclusão.';

export async function liberarIntencaoCriacao(tx: DbExecutor, sessao: Pick<SessaoAdmin, 'usuario_id'>, empresaId: string, raw: unknown,
    provedor: Pick<ClienteAsaas, 'listarAssinaturasPorReferencia'>, ctx: { requestId: string; ip?: string | null }) {
    const entrada = Entrada.safeParse(raw);
    if (!entrada.success)
        throw erroAcesso('DADOS_INVALIDOS', 'Informe a intenção, a confirmação de que conferiu no provedor e o motivo (10 a 500 caracteres).', 400);
    const { pendenciaId, motivo } = entrada.data;
    await exigirDesenvolvedorNaTransacao(tx, sessao);
    // Mesma trava da contratação: nenhuma contratação da empresa corre durante a liberação.
    if (!(await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1)) AS ok", [empresaId])).rows[0]?.ok)
        throw erroAcesso('CONTRATACAO_EM_ANDAMENTO', 'Há uma contratação desta empresa em andamento. Tente de novo em instantes.', 409);
    const pend = (await tx.query<{ evento_id: string; tipo: string; situacao: string; assinatura_provedor_id: string | null }>(
        'SELECT evento_id, tipo, situacao, assinatura_provedor_id FROM cobranca_eventos WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE',
        [pendenciaId, empresaId])).rows[0];
    if (!pend || pend.tipo !== TIPO_PENDENCIA || !pend.evento_id.startsWith(PREFIXO_CRIACAO))
        throw recusa('Somente intenções de criação desta empresa podem ser liberadas.', 404);
    if (pend.situacao !== 'PENDENTE' && pend.situacao !== 'FALHOU')
        throw recusa('Esta intenção já foi resolvida.');
    if (pend.assinatura_provedor_id)
        throw recusa('A intenção tem assinatura confirmada: use a reconciliação.');
    const linha = (await tx.query<{ provedor_assinatura_id: string | null }>(
        'SELECT provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha)
        throw recusa('Esta empresa não tem cobrança registrada.', 404);
    // Exclusão no provedor com resultado desconhecido nesta empresa: a liberação fica bloqueada até a releitura resolver.
    if ((await marcadoresDeRemocao(tx, empresaId)).length > 0)
        throw recusa(MENSAGEM_BLOQUEIO_REMOCAO);
    const comId = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cobranca_eventos WHERE empresa_id = $1::uuid AND tipo = $2 AND situacao IN ${ABERTAS} AND assinatura_provedor_id IS NOT NULL`,
        [empresaId, TIPO_PENDENCIA])).rows[0].n;
    if (comId > 0)
        throw recusa('Há assinatura confirmada aguardando vínculo para esta empresa: use a reconciliação.');
    // Conferência no provedor AGORA (falha do provedor propaga: nada é liberado).
    const noProvedor = (await provedor.listarAssinaturasPorReferencia(empresaId)).filter((s) => !s.deleted);
    if (noProvedor.length > 0)
        throw recusa('O provedor mostra assinatura desta empresa: a criação foi executada. Use a reconciliação.');
    // Vínculo anterior (ex.: assinatura cancelada) não impede a liberação, mas fica registrado na auditoria.
    await concluirIntencao(tx, pendenciaId, 'LIBERADA_MANUALMENTE: CRIACAO_NAO_EXECUTADA');
    await auditarCobranca(tx, {
        acao: 'COBRANCA_INTENCAO_LIBERADA', empresaId, origem: { tipo: 'DESENVOLVEDOR', usuarioId: sessao.usuario_id, requestId: ctx.requestId },
        ip: ctx.ip ?? null, justificativa: motivo,
        depois: { pendenciaId, conferencia: 'SEM_ASSINATURA_NO_PROVEDOR', declaracao: CONFIRMACAO_LIBERACAO, vinculoAnterior: Boolean(linha.provedor_assinatura_id) },
    });
    return { resultado: 'LIBERADA' as const, pendenciaId };
}

const bloqueioPorRemocao = (marcadores: readonly unknown[]) => (marcadores.length ? 'REMOCAO_SEM_CONFIRMACAO' as const : null);

/** Pendências abertas da empresa para o painel (sem ids do provedor). */
export async function pendenciasDaEmpresa(tx: DbExecutor, sessao: Pick<SessaoAdmin, 'usuario_id'>, empresaId: string) {
    await exigirDesenvolvedorNaTransacao(tx, sessao);
    if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0]?.ok)
        return [];
    const bloqueio = bloqueioPorRemocao(await marcadoresDeRemocao(tx, empresaId));
    const rows = (await tx.query<{ id: string; evento_id: string; situacao: string; ultimo_erro: string | null; tem_assinatura: boolean; recebido_em: string; tentativas: number }>(
        `SELECT id, evento_id, situacao, ultimo_erro, assinatura_provedor_id IS NOT NULL AS tem_assinatura,
                to_char(recebido_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recebido_em, tentativas
           FROM cobranca_eventos WHERE empresa_id = $1::uuid AND tipo = $2 AND situacao IN ${ABERTAS} ORDER BY recebido_em`,
        [empresaId, TIPO_PENDENCIA])).rows;
    return rows.map((r) => {
        const criacao = r.evento_id.startsWith(PREFIXO_CRIACAO);
        const tipo = criacao ? 'INTENCAO_CRIACAO' as const : r.evento_id.startsWith(PREFIXO_REMOCAO_SEM_CONFIRMACAO) ? 'REMOCAO_SEM_CONFIRMACAO' as const : 'RECONCILIACAO' as const;
        return {
            id: r.id, tipo, situacao: r.situacao, motivo: r.ultimo_erro,
            temAssinatura: r.tem_assinatura, recebidoEm: r.recebido_em, tentativas: r.tentativas, liberavel: criacao && !r.tem_assinatura && !bloqueio,
            bloqueadaPor: criacao && !r.tem_assinatura && bloqueio ? bloqueio : null,
        };
    });
}
