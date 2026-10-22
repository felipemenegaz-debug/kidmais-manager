/**
 * Processamento idempotente dos pedidos de créditos (095) a partir da LEITURA do provedor — o mesmo serviço para o
 * webhook (lib/assinatura/sincronizacao.ts → processarEvento) e para a reconciliação/manutenção. Nada aqui confia no
 * conteúdo do evento: o pedido é travado (FOR UPDATE) e o Asaas é reconsultado DENTRO da trava (como sincronizarEmpresa),
 * para duas instâncias nunca aplicarem leituras cruzadas. Cada leitura tem 10 s de limite (lib/assinatura/asaas.ts).
 *
 *   CRIACAO_EM_CURSO (parado) / CRIACAO_INCERTA → procura pela externalReference (todas as páginas): 1 compatível vincula;
 *       mais de 1 → REVISAO (duplicidade: um crédito por pedido, excedente devolvido); 0 não prova ausência — depois de
 *       24 h vai para REVISAO (operador decide com evidência). Nunca repete o POST.
 *   AGUARDANDO_PAGAMENTO / VENCIDO / REVISAO → GET da cobrança canônica e decidirPagamento: CONFIRMED/RECEIVED com vínculo,
 *       valor e forma conferidos credita UMA vez (lote COMPRA único por pedido); vencido, cancelado, estorno e disputa
 *       mudam só o que a máquina de estados permite.
 * Estorno e disputa nunca deixam carteira negativa: bloqueiam/cancelam só o remanescente do lote; o já usado vira
 * exposição registrada na cobrança. Evento favorável só desbloqueia remanescente de disputa resolvida sem devolução final.
 */
import type { DbExecutor } from '../db/contracts';
import { AsaasFalhou, type CobrancaProvedor, type ProvedorCreditos } from '../assinatura/asaas.ts';
import { decidirPagamento, lerReferenciaExterna, proporcionalCentavos, referenciaExterna, STATUS_LIBERA, vencimentoEmDias, type Forma } from './dominio.ts';
import { abrirCarteira, bloquearDisponivel, cancelarBloqueado, creditarLote, desbloquear, lerCarteira } from './ledger.ts';
import { enfileirarNotificacao } from './notificacoes.ts';
import type { Recurso } from './catalogo.ts';

export type ContextoProvedor = { provedor: Pick<ProvedorCreditos, 'obterCobranca' | 'listarCobrancasPorReferencia'>; ambiente: 'sandbox' | 'producao'; conta: string };
export type ResultadoPedido = { resultado: 'CREDITADO' | 'SEM_MUDANCA' | 'VINCULADO' | 'AGUARDANDO' | 'VENCIDO' | 'ENCERRADO' | 'REVISAO' | 'ESTORNO' | 'DISPUTA' | 'JA_CONCLUIDO';
    motivo?: string; valorLidoCentavos?: number | null };

type Pedido = { id: string; empresa_id: string; protocolo: string; recurso: Recurso; estado: string; quantidade: string; preco_centavos: string; validade_dias: number;
    forma: Forma; ambiente: 'sandbox' | 'producao'; idade_s: string; creditado_em: string | null };
type Cobranca = { id: string; pagamento_id: string; canonica: boolean; situacao_provedor: string; disputa: string; confirmada_em: string | null; estornado_centavos: string };

const MINUTOS_PARADO = 10;
const HORAS_SEM_COBRANCA = 24;

async function travarPedido(tx: DbExecutor, pedidoId: string) {
    return (await tx.query<Pedido>(`SELECT id, empresa_id, protocolo, recurso, estado, quantidade, preco_centavos, validade_dias, forma, ambiente, creditado_em,
        extract(epoch FROM clock_timestamp() - criado_em)::bigint AS idade_s FROM ia_credito_pedidos WHERE id = $1::uuid FOR UPDATE`, [pedidoId])).rows[0] ?? null;
}
async function clienteDaEmpresa(tx: DbExecutor, empresaId: string) {
    return (await tx.query<{ c: string | null }>("SELECT provedor_cliente_id AS c FROM empresa_assinaturas WHERE empresa_id = $1::uuid AND provedor = 'ASAAS'", [empresaId])).rows[0]?.c ?? null;
}
async function mudarEstado(tx: DbExecutor, p: Pedido, estado: string, motivo: string | null = null) {
    if (p.estado === estado && estado !== 'REVISAO') return;
    await tx.query('UPDATE ia_credito_pedidos SET estado = $2, revisao_motivo = $3 WHERE id = $1::uuid', [p.id, estado, estado === 'REVISAO' ? motivo : null]);
    p.estado = estado;
}
async function registrarCobranca(tx: DbExecutor, p: Pedido, ctx: ContextoProvedor, c: CobrancaProvedor, canonica: boolean) {
    await tx.query(`INSERT INTO ia_credito_cobrancas (empresa_id, pedido_id, provedor, ambiente, conta, pagamento_id, referencia_externa, canonica, valor_centavos,
            forma_provedor, situacao_provedor, url_fatura, vencimento)
        VALUES ($1::uuid, $2::uuid, 'ASAAS', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date)
        ON CONFLICT ON CONSTRAINT ia_credito_cobrancas_pagamento_uk DO NOTHING`,
    [p.empresa_id, p.id, ctx.ambiente, ctx.conta, c.id, referenciaExterna(p.ambiente, p.id), canonica, c.valorCentavos ?? Number(p.preco_centavos),
        c.billingType ?? null, /^[A-Z_]{1,40}$/.test(c.status) ? c.status : 'DESCONHECIDO', c.invoiceUrl, c.dueDate]);
}

/** Primeira gravação do vínculo depois do POST (caminho da tela): idempotente pelo id do pagamento. */
export async function vincularCobrancaCriada(tx: DbExecutor, pedidoId: string, ctx: ContextoProvedor, c: CobrancaProvedor) {
    const p = await travarPedido(tx, pedidoId);
    if (!p) return null;
    const existente = (await tx.query<{ pagamento_id: string }>('SELECT pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica', [p.id])).rows[0];
    if (!existente) await registrarCobranca(tx, p, ctx, c, true);
    if (p.estado === 'CRIACAO_EM_CURSO' || p.estado === 'CRIACAO_INCERTA') await mudarEstado(tx, p, 'AGUARDANDO_PAGAMENTO');
    return p.estado;
}

async function creditar(tx: DbExecutor, p: Pedido, c: Cobranca, lido: CobrancaProvedor) {
    // Ordem de travas: pedido (já travado) → carteira → lote. CONVITES só existe com corte (compra exigiu o corte).
    const carteira = p.recurso === 'WALLE' ? await abrirCarteira(tx, p.empresa_id, 'WALLE') : await lerCarteira(tx, p.empresa_id, 'CONVITES', true);
    if (!carteira) { await mudarEstado(tx, p, 'REVISAO', 'CARTEIRA_SEM_CORTE'); return { resultado: 'REVISAO' as const, motivo: 'CARTEIRA_SEM_CORTE' }; }
    const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    await creditarLote(tx, { empresaId: p.empresa_id, recurso: p.recurso, origem: 'COMPRA', chaveOrigem: `COMPRA:${p.id}`, quantidade: Number(p.quantidade),
        venceEm: vencimentoEmDias(agora, p.validade_dias), precoCentavos: Number(p.preco_centavos), pedidoId: p.id, protocolo: p.protocolo, ator: 'SISTEMA' });
    await tx.query(`UPDATE ia_credito_pedidos SET estado = 'CREDITADO', creditado_em = clock_timestamp(), revisao_motivo = NULL WHERE id = $1::uuid`, [p.id]);
    await tx.query(`UPDATE ia_credito_cobrancas SET confirmada_em = coalesce(confirmada_em, clock_timestamp()), situacao_provedor = $2 WHERE id = $1::uuid`, [c.id, lido.status]);
    await enfileirarNotificacao(tx, { empresaId: p.empresa_id, tipo: 'PAGAMENTO_CONFIRMADO', dedupe: `PAGAMENTO_CONFIRMADO:${p.id}`, protocolo: p.protocolo });
    return { resultado: 'CREDITADO' as const };
}

async function loteDoPedido(tx: DbExecutor, p: Pedido) {
    return (await tx.query<{ id: string; quantidade: string; consumido: string }>('SELECT id, quantidade, consumido FROM ia_credito_lotes WHERE pedido_id = $1::uuid AND empresa_id = $2::uuid',
        [p.id, p.empresa_id])).rows[0] ?? null;
}

/** Estorno/disputa lidos no provedor, com o pedido já creditado: só o remanescente do lote é afetado. */
async function aplicarEstornoOuDisputa(tx: DbExecutor, p: Pedido, c: Cobranca, lido: CobrancaProvedor, tipo: 'ESTORNO' | 'DISPUTA'): Promise<ResultadoPedido> {
    await tx.query('UPDATE ia_credito_cobrancas SET situacao_provedor = $2 WHERE id = $1::uuid', [c.id, lido.status]);
    if (!p.creditado_em) {
        if (tipo === 'ESTORNO') await mudarEstado(tx, p, 'ENCERRADO');
        else await mudarEstado(tx, p, 'REVISAO', 'DISPUTA_SEM_CREDITO');
        return { resultado: tipo };
    }
    const lote = await loteDoPedido(tx, p);
    const devolucao = (await tx.query<{ id: string; estado: string }>('SELECT id, estado FROM ia_credito_devolucoes WHERE pedido_id = $1::uuid FOR UPDATE', [p.id])).rows[0];
    await lerCarteira(tx, p.empresa_id, p.recurso, true);
    if (tipo === 'ESTORNO') {
        if (devolucao) {
            // Estorno pedido por nós: conclusão confirmada pelo provedor (REFUNDED); em andamento só registra a situação.
            if (lido.status === 'REFUNDED' && devolucao.estado !== 'CONCLUIDO' && devolucao.estado !== 'AGUARDANDO_MANUAL')
                await tx.query(`UPDATE ia_credito_devolucoes SET estado = 'CONCLUIDO', status_provedor = $2, referencia = $3 WHERE id = $1::uuid`,
                    [devolucao.id, lido.status, `asaas:${c.pagamento_id}:REFUNDED`]);
            else if (lido.status === 'REFUNDED' && devolucao.estado === 'AGUARDANDO_MANUAL')
                await tx.query(`UPDATE ia_credito_devolucoes SET estado = 'CONCLUIDO', modo = 'MANUAL', status_provedor = $2, referencia = $3 WHERE id = $1::uuid`,
                    [devolucao.id, lido.status, `asaas:${c.pagamento_id}:REFUNDED`]);
            return { resultado: 'ESTORNO' };
        }
        // Estorno sem pedido nosso (painel do provedor, disputa perdida): cancela o remanescente; o usado vira exposição.
        if (lote) {
            await bloquearDisponivel(tx, p.empresa_id, p.recurso, lote.id, `ESTORNO_EXTERNO:${c.id}`, 'SISTEMA', p.protocolo);
            await cancelarBloqueado(tx, p.empresa_id, p.recurso, lote.id, `ESTORNO_EXTERNO:${c.id}`, 'SISTEMA', p.protocolo);
        }
        const exposicao = lote ? proporcionalCentavos(Number(p.preco_centavos), Number(lote.consumido), Number(lote.quantidade)) : 0;
        await tx.query(`UPDATE ia_credito_cobrancas SET disputa = CASE WHEN disputa = 'ABERTA' THEN 'PERDIDA' ELSE disputa END,
            exposicao_centavos = GREATEST(exposicao_centavos, $2), revisao_motivo = CASE WHEN disputa = 'ABERTA' THEN revisao_motivo ELSE 'ESTORNO_SEM_PEDIDO' END
            WHERE id = $1::uuid`, [c.id, exposicao]);
        return { resultado: 'ESTORNO' };
    }
    // Disputa aberta: bloqueia o remanescente (sem cancelar) e registra a exposição do já usado.
    if (c.disputa !== 'ABERTA') {
        if (lote && !devolucao) await bloquearDisponivel(tx, p.empresa_id, p.recurso, lote.id, `DISPUTA:${c.id}`, 'SISTEMA', p.protocolo);
        const exposicao = lote ? proporcionalCentavos(Number(p.preco_centavos), Number(lote.consumido), Number(lote.quantidade)) : 0;
        await tx.query(`UPDATE ia_credito_cobrancas SET disputa = 'ABERTA', exposicao_centavos = GREATEST(exposicao_centavos, $2) WHERE id = $1::uuid`, [c.id, exposicao]);
    }
    return { resultado: 'DISPUTA' };
}

/**
 * P2-5 (revisão de 22/10): soma dos estornos concluídos (`refunds[]` com status DONE) gravada em `estornado_centavos` (só
 * aumenta). Com devolução nossa: conclui quando a soma alcança o valor devolvido. Sem devolução nossa (estorno feito fora,
 * parcial): bloqueia o remanescente do lote e marca a cobrança para o operador decidir (liberar ou cancelar), nunca em silêncio.
 * P2-N1 (revisão do delta): `estornado_centavos` é o valor já TRATADO — só um aumento é episódio novo (a mesma soma relida
 * depois da decisão do operador não realarma), e a operação do bloqueio leva o valor (um 2º estorno maior bloqueia de novo).
 */
async function aplicarEstornosParciais(tx: DbExecutor, p: Pedido, c: Cobranca, lido: CobrancaProvedor): Promise<ResultadoPedido | null> {
    const feitos = (lido.estornos ?? []).filter((e) => e.status === 'DONE' && (e.valorCentavos ?? 0) > 0).reduce((s, e) => s + (e.valorCentavos ?? 0), 0);
    if (feitos <= 0) return null;
    const anterior = Number(c.estornado_centavos);
    const tratado = Number((await tx.query<{ estornado_centavos: string }>(
        'UPDATE ia_credito_cobrancas SET estornado_centavos = GREATEST(estornado_centavos, LEAST(valor_centavos, $2)) WHERE id = $1::uuid RETURNING estornado_centavos',
        [c.id, feitos])).rows[0].estornado_centavos);
    if (tratado <= anterior) return null;
    const devolucao = (await tx.query<{ id: string; estado: string; valor_centavos: string }>('SELECT id, estado, valor_centavos FROM ia_credito_devolucoes WHERE pedido_id = $1::uuid FOR UPDATE',
        [p.id])).rows[0];
    if (devolucao) {
        if (devolucao.estado === 'CONCLUIDO' || feitos < Number(devolucao.valor_centavos)) return null;
        await tx.query(`UPDATE ia_credito_devolucoes SET estado = 'CONCLUIDO', status_provedor = $2, referencia = $3 WHERE id = $1::uuid`,
            [devolucao.id, /^[A-Z_]{1,40}$/.test(lido.status) ? lido.status : null, `asaas:${c.pagamento_id}:REFUND_DONE`]);
        return { resultado: 'ESTORNO' };
    }
    const lote = await loteDoPedido(tx, p);
    await lerCarteira(tx, p.empresa_id, p.recurso, true);
    if (lote) await bloquearDisponivel(tx, p.empresa_id, p.recurso, lote.id, `ESTORNO_PARCIAL:${c.id}:${tratado}`, 'SISTEMA', p.protocolo);
    await tx.query("UPDATE ia_credito_cobrancas SET revisao_motivo = 'ESTORNO_EXTERNO_PARCIAL' WHERE id = $1::uuid", [c.id]);
    return { resultado: 'REVISAO', motivo: 'ESTORNO_EXTERNO_PARCIAL' };
}

async function canonica(tx: DbExecutor, pedidoId: string) {
    return (await tx.query<Cobranca>(`SELECT id, pagamento_id, canonica, situacao_provedor, disputa, confirmada_em, estornado_centavos FROM ia_credito_cobrancas
        WHERE pedido_id = $1::uuid AND canonica FOR UPDATE`, [pedidoId])).rows[0] ?? null;
}

/** Serviço único: estado do pedido a partir da leitura do provedor (transação do chamador). */
export async function processarPedido(tx: DbExecutor, pedidoId: string, ctx: ContextoProvedor): Promise<ResultadoPedido> {
    const p = await travarPedido(tx, pedidoId);
    if (!p) return { resultado: 'JA_CONCLUIDO', motivo: 'PEDIDO_NAO_ENCONTRADO' };
    if (p.ambiente !== ctx.ambiente) return { resultado: 'SEM_MUDANCA', motivo: 'AMBIENTE_DIVERGENTE' };
    if (p.estado === 'FALHOU_CRIACAO') return { resultado: 'JA_CONCLUIDO' };
    const referencia = referenciaExterna(p.ambiente, p.id);
    let c = await canonica(tx, p.id);
    // P2-2 (revisão de 22/10): pedido ENCERRADO (cobrança cancelada) que mesmo assim recebeu pagamento vai para REVISAO —
    // dinheiro nunca fica sem crédito nem sem alarme (D3: o cliente escolhe créditos ou devolução integral).
    if (p.estado === 'ENCERRADO') {
        if (!c || p.creditado_em) return { resultado: 'JA_CONCLUIDO' };
        const lidoEncerrado = await ctx.provedor.obterCobranca(c.pagamento_id);
        if (!lidoEncerrado || !STATUS_LIBERA.has(lidoEncerrado.status)) return { resultado: 'JA_CONCLUIDO' };
        await tx.query('UPDATE ia_credito_cobrancas SET situacao_provedor = $2, revisao_motivo = $3 WHERE id = $1::uuid', [c.id, lidoEncerrado.status, 'PAGO_APOS_CANCELAMENTO']);
        await mudarEstado(tx, p, 'REVISAO', 'PAGO_APOS_CANCELAMENTO');
        return { resultado: 'REVISAO', motivo: 'PAGO_APOS_CANCELAMENTO' };
    }
    if (!c) {
        if (p.estado === 'CRIACAO_EM_CURSO' && Number(p.idade_s) < MINUTOS_PARADO * 60) return { resultado: 'SEM_MUDANCA', motivo: 'CRIACAO_EM_CURSO' };
        const achadas = await ctx.provedor.listarCobrancasPorReferencia(referencia);
        if (achadas.length === 0) {
            if (Number(p.idade_s) >= HORAS_SEM_COBRANCA * 3600) { await mudarEstado(tx, p, 'REVISAO', 'CRIACAO_NAO_LOCALIZADA'); return { resultado: 'REVISAO', motivo: 'CRIACAO_NAO_LOCALIZADA' }; }
            if (p.estado === 'CRIACAO_EM_CURSO') await mudarEstado(tx, p, 'CRIACAO_INCERTA');
            return { resultado: 'SEM_MUDANCA', motivo: 'COBRANCA_NAO_LOCALIZADA_AINDA' };
        }
        if (achadas.length > 1) {
            for (const a of achadas) await registrarCobranca(tx, p, ctx, a, false);
            if (p.estado === 'CRIACAO_EM_CURSO') await mudarEstado(tx, p, 'CRIACAO_INCERTA');
            await mudarEstado(tx, p, 'REVISAO', 'COBRANCA_DUPLICADA');
            return { resultado: 'REVISAO', motivo: 'COBRANCA_DUPLICADA' };
        }
        await registrarCobranca(tx, p, ctx, achadas[0], true);
        if (p.estado === 'CRIACAO_EM_CURSO' || p.estado === 'CRIACAO_INCERTA') await mudarEstado(tx, p, 'AGUARDANDO_PAGAMENTO');
        c = await canonica(tx, p.id);
        if (!c) return { resultado: 'REVISAO', motivo: 'VINCULO_DIVERGENTE' };
    }
    const lido = await ctx.provedor.obterCobranca(c.pagamento_id);
    const cliente = await clienteDaEmpresa(tx, p.empresa_id);
    const decisao = decidirPagamento(lido && { id: lido.id, status: lido.status, valorCentavos: lido.valorCentavos ?? null, clienteId: lido.clienteId ?? null,
        externalReference: lido.externalReference ?? null, billingType: lido.billingType ?? null, deleted: lido.deleted },
    { pagamentoId: c.pagamento_id, valorCentavos: Number(p.preco_centavos), clienteId: cliente ?? '', referencia, forma: p.forma });
    // P2-5: estornos parciais (refunds[] DONE) antes da decisão — o status do pagamento continua RECEIVED nesses casos.
    if (lido && p.creditado_em && lido.status !== 'REFUNDED') {
        const parcial = await aplicarEstornosParciais(tx, p, c, lido);
        if (parcial) return parcial;
    }
    switch (decisao.acao) {
        case 'CREDITAR':
            if (p.creditado_em) {
                // Disputa resolvida a favor (status volta a pago): devolve ao disponível só o remanescente ainda bloqueado.
                if (c.disputa === 'ABERTA') {
                    const lote = await loteDoPedido(tx, p);
                    const devolucao = (await tx.query('SELECT 1 FROM ia_credito_devolucoes WHERE pedido_id = $1::uuid', [p.id])).rows.length > 0;
                    await lerCarteira(tx, p.empresa_id, p.recurso, true);
                    if (lote && !devolucao) await desbloquear(tx, p.empresa_id, p.recurso, lote.id, `DISPUTA_FAVORAVEL:${c.id}`, 'SISTEMA');
                    await tx.query(`UPDATE ia_credito_cobrancas SET disputa = 'FAVORAVEL', situacao_provedor = $2 WHERE id = $1::uuid`, [c.id, lido!.status]);
                    return { resultado: 'SEM_MUDANCA', motivo: 'DISPUTA_FAVORAVEL' };
                }
                if (lido && lido.status !== c.situacao_provedor) await tx.query('UPDATE ia_credito_cobrancas SET situacao_provedor = $2 WHERE id = $1::uuid', [c.id, lido.status]);
                return { resultado: 'JA_CONCLUIDO' };
            }
            return creditar(tx, p, c, lido!);
        case 'AGUARDAR':
            if (lido) await tx.query('UPDATE ia_credito_cobrancas SET situacao_provedor = $2 WHERE id = $1::uuid', [c.id, lido.status]);
            if (p.estado === 'REVISAO' && p.creditado_em === null) await mudarEstado(tx, p, 'AGUARDANDO_PAGAMENTO');
            return { resultado: 'AGUARDANDO' };
        case 'VENCIDO':
            await tx.query('UPDATE ia_credito_cobrancas SET situacao_provedor = $2 WHERE id = $1::uuid', [c.id, lido!.status]);
            if (p.estado === 'AGUARDANDO_PAGAMENTO') await mudarEstado(tx, p, 'VENCIDO');
            return { resultado: 'VENCIDO' };
        case 'CANCELADO':
            if (!p.creditado_em) await mudarEstado(tx, p, 'ENCERRADO');
            return { resultado: 'ENCERRADO' };
        case 'ESTORNO':
        case 'DISPUTA':
            return aplicarEstornoOuDisputa(tx, p, c, lido!, decisao.acao);
        case 'REVISAO':
            // P2-N2 (revisão do delta 2): grava também o status lido desta cobrança — o CRÍTICO de cliente/referência
            // divergente (D4) depende de saber se o dinheiro já foi recebido. Leitura de outro pagamento (id divergente) não conta.
            await tx.query('UPDATE ia_credito_cobrancas SET revisao_motivo = $2, situacao_provedor = coalesce($3, situacao_provedor) WHERE id = $1::uuid',
                [c.id, decisao.motivo, lido && lido.id === c.pagamento_id && /^[A-Z_]{1,40}$/.test(lido.status) ? lido.status : null]);
            if (!p.creditado_em) await mudarEstado(tx, p, 'REVISAO', decisao.motivo);
            return { resultado: 'REVISAO', motivo: decisao.motivo };
    }
}

/** Cobrança não canônica paga (duplicidade): registrada para devolução do excedente, nunca credita de novo. */
async function processarExtra(tx: DbExecutor, cobrancaId: string, ctx: ContextoProvedor) {
    const c = (await tx.query<{ id: string; pagamento_id: string }>('SELECT id, pagamento_id FROM ia_credito_cobrancas WHERE id = $1::uuid FOR UPDATE', [cobrancaId])).rows[0];
    if (!c) return { resultado: 'JA_CONCLUIDO' as const };
    const lido = await ctx.provedor.obterCobranca(c.pagamento_id);
    if (lido) await tx.query(`UPDATE ia_credito_cobrancas SET situacao_provedor = $2, revisao_motivo = CASE WHEN $3 THEN 'PAGAMENTO_DUPLICADO' ELSE revisao_motivo END WHERE id = $1::uuid`,
        [c.id, /^[A-Z_]{1,40}$/.test(lido.status) ? lido.status : 'DESCONHECIDO', ['CONFIRMED', 'RECEIVED'].includes(lido.status)]);
    return { resultado: 'REVISAO' as const, motivo: 'PAGAMENTO_DUPLICADO' };
}

export type EventoCreditos = { cobrancaProvedorId: string | null; referenciaExterna: string | null };
/** O evento é de créditos? (pagamento vinculado a um pedido ou referência km:<amb>:creditos:<pedido>). */
export async function pedidoDoEvento(tx: DbExecutor, ev: EventoCreditos): Promise<{ pedidoId: string; cobrancaId: string | null; canonica: boolean } | null> {
    if (ev.cobrancaProvedorId) {
        const r = (await tx.query<{ pedido_id: string; id: string; canonica: boolean }>('SELECT pedido_id, id, canonica FROM ia_credito_cobrancas WHERE pagamento_id = $1 ORDER BY canonica DESC LIMIT 1',
            [ev.cobrancaProvedorId])).rows[0];
        if (r) return { pedidoId: r.pedido_id, cobrancaId: r.id, canonica: r.canonica };
    }
    const ref = lerReferenciaExterna(ev.referenciaExterna);
    if (ref && (await tx.query('SELECT 1 FROM ia_credito_pedidos WHERE id = $1::uuid', [ref.pedidoId])).rows.length)
        return { pedidoId: ref.pedidoId, cobrancaId: null, canonica: false };
    return null;
}

/** Entrada do webhook: resolve o pedido e chama o mesmo serviço da reconciliação. Provedor fora → lança AsaasFalhou. */
export async function processarEventoCreditos(tx: DbExecutor, ev: EventoCreditos, alvo: { pedidoId: string; cobrancaId: string | null; canonica: boolean }, ctx: ContextoProvedor) {
    if (alvo.cobrancaId && !alvo.canonica) return processarExtra(tx, alvo.cobrancaId, ctx);
    return processarPedido(tx, alvo.pedidoId, ctx);
}

/** Pedidos que a reconciliação revisita (abertos, ou creditados com cobrança em disputa/estorno não concluído). */
export async function pedidosParaReconciliar(tx: DbExecutor, limite = 200) {
    return (await tx.query<{ id: string }>(`SELECT p.id FROM ia_credito_pedidos p WHERE p.estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'AGUARDANDO_PAGAMENTO', 'VENCIDO', 'REVISAO')
        OR EXISTS (SELECT 1 FROM ia_credito_cobrancas c WHERE c.pedido_id = p.id AND (c.disputa = 'ABERTA'))
        OR EXISTS (SELECT 1 FROM ia_credito_devolucoes d WHERE d.pedido_id = p.id AND d.estado IN ('EM_CURSO', 'SOLICITADO', 'SEM_CONFIRMACAO'))
        -- P2-2: cobrança cancelada há até 90 dias ainda pode ser paga (Pix já aberto, boleto impresso).
        OR (p.estado = 'ENCERRADO' AND p.creditado_em IS NULL AND p.atualizado_em > clock_timestamp() - interval '90 days'
            AND EXISTS (SELECT 1 FROM ia_credito_cobrancas c WHERE c.pedido_id = p.id AND c.canonica))
        ORDER BY p.criado_em LIMIT $1`, [limite])).rows.map((r) => r.id);
}

/**
 * Crédito decidido pelo operador depois de uma REVISAO (P2-3): só com o pagamento CONFIRMED/RECEIVED relido no provedor
 * agora (divergência aceita: valor com juros, pago após cancelamento). Mesmo crédito único do caminho normal.
 */
export async function creditarAposRevisao(tx: DbExecutor, pedidoId: string, ctx: ContextoProvedor): Promise<ResultadoPedido> {
    const p = await travarPedido(tx, pedidoId);
    if (!p || p.estado !== 'REVISAO') return { resultado: 'SEM_MUDANCA', motivo: 'PEDIDO_NAO_ESTA_EM_REVISAO' };
    if (p.ambiente !== ctx.ambiente) return { resultado: 'SEM_MUDANCA', motivo: 'AMBIENTE_DIVERGENTE' };
    const c = await canonica(tx, p.id);
    if (!c) return { resultado: 'SEM_MUDANCA', motivo: 'SEM_COBRANCA_CANONICA' };
    const lido = await ctx.provedor.obterCobranca(c.pagamento_id);
    if (!lido || lido.id !== c.pagamento_id || !STATUS_LIBERA.has(lido.status)) return { resultado: 'SEM_MUDANCA', motivo: 'PAGAMENTO_NAO_CONFIRMADO_NO_PROVEDOR' };
    await tx.query('UPDATE ia_credito_cobrancas SET revisao_motivo = NULL WHERE id = $1::uuid', [c.id]);
    // P3-5 (revisão do delta): o valor lido segue para a auditoria do operador ao lado do preço do pedido.
    return { ...(await creditar(tx, p, c, lido)), valorLidoCentavos: lido.valorCentavos ?? null };
}

export const ehFalhaDoProvedor = (e: unknown) => e instanceof AsaasFalhou;
