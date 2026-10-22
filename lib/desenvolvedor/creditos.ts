import { z } from 'zod';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirDesenvolvedorNaTransacao, exigirReautenticacaoRecente } from './autorizacao.ts';
import { auditarPainel, type ContextoPainel } from './auditoria.ts';
import { painelDepsPadrao, type PainelDeps } from './interessadas.ts';
import { creditosInstalados } from '../creditos/ledger.ts';
import { CAMPANHAS, concederCortesia, CortesiaRecusada } from '../creditos/cortesia.ts';
import { registrarDevolucao } from '../creditos/devolucao.ts';
import { simularCorte } from '../creditos/corte.ts';

/**
 * Operação da plataforma sobre os créditos de IA (090), no painel do desenvolvedor: concessão de desenvolvedor travada na
 * transação, senha recente para escrever e auditoria do painel. A Gestão do buffet nunca tem estas ações.
 *   fila             pedidos em revisão/incertos, devoluções abertas (prazo) e cobranças com disputa ou duplicidade;
 *   cortesia         lote CORTESIA dentro do teto da campanha (motivo e protocolo);
 *   concluir_devolucao  estorno feito no painel do Asaas, com referência (comprovante/id) — boleto e fila manual;
 *   devolucao_atendimento  pedido de devolução recebido pelo atendimento (login inacessível), mesmas regras da tela;
 *   simular_corte    leitura: o que o corte do motor legado faria para a empresa (a aplicação é pelo script autorizado).
 */
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const PROTOCOLO = z.string().regex(/^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$/);
const operacaoSchema = z.discriminatedUnion('acao', [
    z.object({ acao: z.literal('cortesia'), empresaId: UUID, campanha: z.string().max(40), quantidade: z.number().int().positive(), motivo: z.string().min(5).max(300), chave: UUID }).strict(),
    z.object({ acao: z.literal('concluir_devolucao'), protocolo: PROTOCOLO, referencia: z.string().trim().min(3).max(200) }).strict(),
    z.object({ acao: z.literal('devolucao_atendimento'), empresaId: UUID, pedido: PROTOCOLO, tipo: z.enum(['ARREPENDIMENTO_7_DIAS', 'SALDO_NAO_UTILIZADO']),
        valorEsperadoCentavos: z.number().int().positive(), chave: UUID }).strict(),
    z.object({ acao: z.literal('simular_corte'), empresaId: UUID }).strict(),
]);

export async function filaCreditos(sessao: SessaoAdmin, deps: PainelDeps = painelDepsPadrao) {
    return deps.withTransaction(async (tx) => {
        await exigirDesenvolvedorNaTransacao(tx, sessao);
        if (!await creditosInstalados(tx)) return { instalado: false, campanhas: CAMPANHAS };
        const pedidos = (await tx.query(`SELECT p.protocolo, p.estado, p.revisao_motivo, p.recurso, p.preco_centavos, p.forma, p.criado_em, e.nome AS empresa_nome, p.empresa_id
            FROM ia_credito_pedidos p JOIN empresas e ON e.id = p.empresa_id WHERE p.estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'REVISAO') ORDER BY p.criado_em LIMIT 100`)).rows;
        const devolucoes = (await tx.query(`SELECT d.protocolo, d.tipo, d.estado, d.valor_centavos, d.forma, d.prazo, d.solicitado_em, e.nome AS empresa_nome
            FROM ia_credito_devolucoes d JOIN empresas e ON e.id = d.empresa_id WHERE d.estado <> 'CONCLUIDO' ORDER BY d.prazo, d.solicitado_em LIMIT 100`)).rows;
        const cobrancas = (await tx.query(`SELECT c.pagamento_id, c.situacao_provedor, c.disputa, c.exposicao_centavos, c.revisao_motivo, p.protocolo, e.nome AS empresa_nome
            FROM ia_credito_cobrancas c JOIN ia_credito_pedidos p ON p.id = c.pedido_id JOIN empresas e ON e.id = c.empresa_id
            WHERE c.disputa = 'ABERTA' OR c.revisao_motivo IS NOT NULL ORDER BY c.atualizada_em LIMIT 100`)).rows;
        return { instalado: true, pedidos, devolucoes, cobrancas, campanhas: CAMPANHAS };
    });
}

export async function operarCreditos(sessao: SessaoAdmin, raw: unknown, ctx: ContextoPainel, deps: PainelDeps = painelDepsPadrao) {
    const op = operacaoSchema.parse(raw);
    if (op.acao !== 'simular_corte') exigirReautenticacaoRecente(sessao);
    try {
        return await deps.withTransaction(async (tx) => {
            await exigirDesenvolvedorNaTransacao(tx, sessao);
            if (!await creditosInstalados(tx)) throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'Os créditos de IA não estão instalados neste ambiente.', 503);
            if (op.acao === 'simular_corte') return simularCorte(tx, op.empresaId);
            if (op.acao === 'cortesia') {
                const r = await concederCortesia(tx, sessao.usuario_id, { empresaId: op.empresaId, campanha: op.campanha, quantidade: op.quantidade, motivo: op.motivo, chave: op.chave });
                await auditarPainel(deps.registrarAuditoria, tx, { atorId: sessao.usuario_id, acao: 'CREDITOS_CORTESIA', entidadeTipo: 'EMPRESA', entidadeId: op.empresaId,
                    empresaId: op.empresaId, resultado: 'SUCESSO', depois: { protocolo: r.protocolo, campanha: op.campanha, quantidade: op.quantidade, repetida: r.repetida }, ctx });
                return r;
            }
            if (op.acao === 'concluir_devolucao') {
                const d = (await tx.query<{ id: string; empresa_id: string; estado: string }>(
                    'SELECT id, empresa_id, estado FROM ia_credito_devolucoes WHERE protocolo = $1 FOR UPDATE', [op.protocolo])).rows[0];
                if (!d) throw erroAcesso('NAO_ENCONTRADO', 'Devolução não encontrada.', 404);
                if (d.estado === 'CONCLUIDO') return { estado: 'CONCLUIDO', repetida: true };
                if (d.estado === 'EM_CURSO') throw erroAcesso('CONFLITO', 'Estorno automático em andamento: confira no Asaas antes de concluir.', 409);
                await tx.query(`UPDATE ia_credito_devolucoes SET estado = 'CONCLUIDO', referencia = $2 WHERE id = $1::uuid`, [d.id, op.referencia]);
                await auditarPainel(deps.registrarAuditoria, tx, { atorId: sessao.usuario_id, acao: 'CREDITOS_DEVOLUCAO_CONCLUIDA', entidadeTipo: 'EMPRESA', entidadeId: d.empresa_id,
                    empresaId: d.empresa_id, resultado: 'SUCESSO', depois: { protocolo: op.protocolo }, ctx });
                return { estado: 'CONCLUIDO', repetida: false };
            }
            const r = await registrarDevolucao(tx, { empresaId: op.empresaId, protocoloPedido: op.pedido, tipo: op.tipo, valorEsperado: op.valorEsperadoCentavos,
                chave: op.chave.toLowerCase(), solicitadoPor: sessao.usuario_id, origem: 'ATENDIMENTO' });
            await auditarPainel(deps.registrarAuditoria, tx, { atorId: sessao.usuario_id, acao: 'CREDITOS_DEVOLUCAO_ATENDIMENTO', entidadeTipo: 'EMPRESA', entidadeId: op.empresaId,
                empresaId: op.empresaId, resultado: 'SUCESSO', depois: { protocolo: r.protocolo, pedido: op.pedido, valorCentavos: r.valorCentavos }, ctx });
            return { protocolo: r.protocolo, estado: r.estado, valorCentavos: r.valorCentavos, repetido: r.repetido };
        });
    }
    catch (error) {
        if (error instanceof CortesiaRecusada) throw erroAcesso('CONFLITO', 'Cortesia recusada.', 409, { motivo: error.motivo });
        throw error;
    }
}
