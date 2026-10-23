/**
 * Saídas do operador da plataforma para o que pede ação humana (P2-3 da revisão de 22/10/2026). Chamadas só pelo painel do
 * desenvolvedor (lib/desenvolvedor/creditos.ts: concessão travada na transação, senha recente e auditoria do painel) —
 * a Gestão do buffet nunca tem estas ações. Toda ação grava auditoria mínima (protocolo, ação, resultado, referência).
 *
 *   reprocessarPedido     o mesmo serviço do webhook/reconciliação (evento FALHOU depois do 200, provedor que voltou);
 *   resolverRevisao       CREDITAR (só com o pagamento CONFIRMED/RECEIVED relido agora no provedor) ou ENCERRAR (com
 *                         referência: devolução feita no painel do Asaas, cobrança sem pagamento comprovado);
 *   concluirCobrancaExtra pagamento duplicado devolvido no painel do Asaas (referência obrigatória);
 *   resolverBloqueio      estorno externo parcial (ESTORNO_EXTERNO_PARCIAL): LIBERAR o saldo bloqueado ou CANCELAR (perda).
 */
import type { DbExecutor } from '../db/contracts';
import { auditarCreditos } from './auditoria.ts';
import { cancelarBloqueado, desbloquear, lerCarteira } from './ledger.ts';
import { creditarAposRevisao, processarPedido, type ContextoProvedor, type ResultadoPedido } from './pagamento.ts';
import { STATUS_LIBERA } from './dominio.ts';
import type { Recurso } from './catalogo.ts';

export class OperacaoRecusada extends Error {
    readonly motivo: string;
    constructor(motivo: string) { super(`Operação recusada: ${motivo}`); this.name = 'OperacaoRecusada'; this.motivo = motivo; }
}
const REFERENCIA = /^[^\r\n]{3,200}$/;
function exigirReferencia(referencia: string) {
    const r = referencia.trim();
    if (!REFERENCIA.test(r)) throw new OperacaoRecusada('REFERENCIA_OBRIGATORIA');
    return r;
}

/** Trava o pedido antes de ler o estado (P3-4 da revisão do delta): o webhook não muda o pedido entre a leitura e a decisão. */
async function pedidoPorProtocolo(tx: DbExecutor, protocolo: string) {
    const p = (await tx.query<{ id: string; empresa_id: string; estado: string; preco_centavos: string }>(
        'SELECT id, empresa_id, estado, preco_centavos FROM ia_credito_pedidos WHERE protocolo = $1 FOR UPDATE', [protocolo])).rows[0];
    if (!p) throw new OperacaoRecusada('PEDIDO_NAO_ENCONTRADO');
    return p;
}

export async function reprocessarPedido(tx: DbExecutor, operadorId: string, protocolo: string, ctx: ContextoProvedor): Promise<ResultadoPedido> {
    const p = await pedidoPorProtocolo(tx, protocolo);
    const r = await processarPedido(tx, p.id, ctx);
    await auditarCreditos(tx, { usuarioId: operadorId, acao: 'CREDITOS_PEDIDO_REPROCESSADO', entidadeTipo: 'IA_CREDITO_PEDIDO', entidadeId: p.id,
        dados: { protocolo, resultado: r.resultado, motivo: r.motivo ?? null } });
    return r;
}

export async function resolverRevisao(tx: DbExecutor, operadorId: string, r: { protocolo: string; resultado: 'CREDITAR' | 'ENCERRAR'; referencia: string }, ctx: ContextoProvedor) {
    const referencia = exigirReferencia(r.referencia);
    const p = await pedidoPorProtocolo(tx, r.protocolo);
    if (p.estado !== 'REVISAO') throw new OperacaoRecusada('PEDIDO_NAO_ESTA_EM_REVISAO');
    let resultado: string, valorLidoCentavos: number | null = null;
    if (r.resultado === 'CREDITAR') {
        const c = await creditarAposRevisao(tx, p.id, ctx);
        if (c.resultado !== 'CREDITADO') throw new OperacaoRecusada(c.motivo ?? c.resultado);
        resultado = 'CREDITADO';
        valorLidoCentavos = c.valorLidoCentavos ?? null;
    }
    else {
        // P3-2 (revisão do delta): encerrar com o pagamento ainda confirmado no provedor deixaria dinheiro sem crédito e o
        // pedido voltaria à revisão na reconciliação; primeiro devolver no painel do Asaas (status REFUNDED), depois encerrar.
        const canonica = (await tx.query<{ pagamento_id: string }>('SELECT pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica', [p.id])).rows[0];
        if (canonica) {
            const lido = await ctx.provedor.obterCobranca(canonica.pagamento_id);
            if (!lido) throw new OperacaoRecusada('PAGAMENTO_NAO_LIDO_NO_PROVEDOR');
            if (STATUS_LIBERA.has(lido.status)) throw new OperacaoRecusada('PAGAMENTO_CONFIRMADO_DEVOLVER_ANTES');
        }
        const n = (await tx.query("UPDATE ia_credito_pedidos SET estado = 'ENCERRADO', revisao_motivo = NULL WHERE id = $1::uuid AND estado = 'REVISAO'", [p.id])).rowCount;
        if (n !== 1) throw new OperacaoRecusada('PEDIDO_NAO_ESTA_EM_REVISAO');
        await tx.query('UPDATE ia_credito_cobrancas SET revisao_motivo = NULL WHERE pedido_id = $1::uuid AND canonica', [p.id]);
        resultado = 'ENCERRADO';
    }
    await auditarCreditos(tx, { usuarioId: operadorId, acao: 'CREDITOS_REVISAO_RESOLVIDA', entidadeTipo: 'IA_CREDITO_PEDIDO', entidadeId: p.id,
        dados: { protocolo: r.protocolo, resultado, referencia, precoCentavos: Number(p.preco_centavos), valorLidoCentavos } });
    return { estado: resultado };
}

/** Ordem de travas igual à do serviço de pagamento: pedido → cobrança (→ carteira → lote). */
async function cobrancaPorPagamento(tx: DbExecutor, pagamentoId: string) {
    const achadas = (await tx.query<{ id: string; pedido_id: string }>('SELECT id, pedido_id FROM ia_credito_cobrancas WHERE pagamento_id = $1', [pagamentoId])).rows;
    if (achadas.length !== 1) throw new OperacaoRecusada(achadas.length ? 'PAGAMENTO_AMBIGUO' : 'COBRANCA_NAO_ENCONTRADA');
    await tx.query('SELECT id FROM ia_credito_pedidos WHERE id = $1::uuid FOR UPDATE', [achadas[0].pedido_id]);
    return (await tx.query<{ id: string; empresa_id: string; pedido_id: string; valor_centavos: string; revisao_motivo: string | null; retencao_motivo: string | null; canonica: boolean; estornado_centavos: string }>(
        'SELECT id, empresa_id, pedido_id, valor_centavos, revisao_motivo, retencao_motivo, canonica, estornado_centavos FROM ia_credito_cobrancas WHERE id = $1::uuid FOR UPDATE', [achadas[0].id])).rows[0];
}

export async function concluirCobrancaExtra(tx: DbExecutor, operadorId: string, r: { pagamentoId: string; referencia: string }) {
    const referencia = exigirReferencia(r.referencia);
    const c = await cobrancaPorPagamento(tx, r.pagamentoId);
    if (c.canonica || c.revisao_motivo !== 'PAGAMENTO_DUPLICADO') throw new OperacaoRecusada('NAO_E_PAGAMENTO_DUPLICADO');
    await tx.query('UPDATE ia_credito_cobrancas SET estornado_centavos = valor_centavos, revisao_motivo = NULL WHERE id = $1::uuid', [c.id]);
    await auditarCreditos(tx, { usuarioId: operadorId, acao: 'CREDITOS_COBRANCA_EXTRA_DEVOLVIDA', entidadeTipo: 'IA_CREDITO_COBRANCA', entidadeId: c.id,
        dados: { valorCentavos: Number(c.valor_centavos), referencia } });
    return { concluida: true };
}

export async function resolverBloqueio(tx: DbExecutor, operadorId: string, r: { pagamentoId: string; resultado: 'LIBERAR' | 'CANCELAR'; referencia: string }) {
    const referencia = exigirReferencia(r.referencia);
    const c = await cobrancaPorPagamento(tx, r.pagamentoId);
    if (c.retencao_motivo !== 'ESTORNO_EXTERNO_PARCIAL') throw new OperacaoRecusada('SEM_BLOQUEIO_PENDENTE');
    const p = (await tx.query<{ recurso: Recurso; protocolo: string }>('SELECT recurso, protocolo FROM ia_credito_pedidos WHERE id = $1::uuid', [c.pedido_id])).rows[0];
    const lote = (await tx.query<{ id: string }>('SELECT id FROM ia_credito_lotes WHERE pedido_id = $1::uuid AND empresa_id = $2::uuid', [c.pedido_id, c.empresa_id])).rows[0];
    await lerCarteira(tx, c.empresa_id, p.recurso, true);
    const quantidade = !lote ? 0 : r.resultado === 'LIBERAR'
        ? await desbloquear(tx, c.empresa_id, p.recurso, lote.id, `ESTORNO_PARCIAL_LIBERADO:${c.id}:${c.estornado_centavos}`, 'PLATAFORMA')
        : await cancelarBloqueado(tx, c.empresa_id, p.recurso, lote.id, `ESTORNO_PARCIAL_CANCELADO:${c.id}:${c.estornado_centavos}`, 'PLATAFORMA', p.protocolo);
    // R5-P2-2/R6-P2-1: CANCELAR grava a perda definitiva em coluna própria (nenhum diagnóstico posterior a apaga) — reservas
    // em andamento são canceladas ao liberar, mesmo com zero cancelado agora. R7-P3-1: a decisão limpa só a retenção; o
    // último diagnóstico (revisao_motivo, ex.: valor divergente) continua visível.
    await tx.query(`UPDATE ia_credito_cobrancas SET retencao_motivo = NULL,
        perda_definitiva_em = CASE WHEN $2 THEN coalesce(perda_definitiva_em, clock_timestamp()) ELSE perda_definitiva_em END WHERE id = $1::uuid`,
        [c.id, r.resultado === 'CANCELAR']);
    await auditarCreditos(tx, { usuarioId: operadorId, acao: 'CREDITOS_BLOQUEIO_RESOLVIDO', entidadeTipo: 'IA_CREDITO_COBRANCA', entidadeId: c.id,
        dados: { protocolo: p.protocolo, resultado: r.resultado, quantidade, referencia } });
    return { resultado: r.resultado, quantidade };
}
