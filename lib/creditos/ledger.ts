/**
 * Extrato e carteiras dos créditos de IA (095), sempre DENTRO da transação de quem chama. Importável sem o driver.
 *
 * ORDEM ÚNICA DE TRAVAS (todas as operações): [convite] → [pedido] → carteira (empresa, recurso) → lotes por
 * (vence_em, id) → [orçamento global dos Convites]. A trava da carteira serializa reserva, consumo, liberação, expiração,
 * crédito, bloqueio e devolução da mesma carteira: duas conexões disputando o último crédito esperam uma pela outra e a
 * segunda vê o saldo já reservado. Constraints e gatilhos (095) recusam saldo negativo e extrato alterado; a reconciliação
 * (conferirCarteira) recalcula tudo a partir do extrato e dos lotes.
 *
 * Cada efeito grava UMA linha de extrato por lote, com chave (empresa, recurso, operação, tipo, lote): repetir a mesma
 * operação não duplica nada (ON CONFLICT DO NOTHING; a carteira só muda quando o lançamento é novo).
 */
import type { DbExecutor } from '../db/contracts';
import { alocar, type Origem } from './dominio.ts';
import type { Recurso } from './catalogo.ts';

export type Ator = 'GESTAO' | 'EQUIPE' | 'CLIENTE' | 'SISTEMA' | 'PLATAFORMA';
export type TipoLancamento = 'CREDITO' | 'RESERVA' | 'LIBERACAO' | 'CONSUMO' | 'BLOQUEIO' | 'DESBLOQUEIO' | 'EXPIRACAO' | 'REVERSAO';
const DELTAS: Record<TipoLancamento, [number, number, number]> = {
    CREDITO: [1, 0, 0], RESERVA: [0, 1, 0], LIBERACAO: [0, -1, 0], CONSUMO: [-1, -1, 0],
    BLOQUEIO: [0, 0, 1], DESBLOQUEIO: [0, 0, -1], EXPIRACAO: [-1, 0, 0], REVERSAO: [-1, 0, -1],
};
/** Variação de cada contador do LOTE por tipo (disponivel, reservado, bloqueado, consumido, expirado, cancelado). */
const NO_LOTE: Record<TipoLancamento, [number, number, number, number, number, number]> = {
    CREDITO: [0, 0, 0, 0, 0, 0], RESERVA: [-1, 1, 0, 0, 0, 0], LIBERACAO: [1, -1, 0, 0, 0, 0], CONSUMO: [0, -1, 0, 1, 0, 0],
    BLOQUEIO: [-1, 0, 1, 0, 0, 0], DESBLOQUEIO: [1, 0, -1, 0, 0, 0], EXPIRACAO: [-1, 0, 0, 0, 1, 0], REVERSAO: [0, 0, -1, 0, 0, 1],
};

export class SaldoInsuficiente extends Error {
    constructor() { super('Saldo de créditos insuficiente.'); this.name = 'SaldoInsuficiente'; }
}
export class CreditosNaoInstalados extends Error {
    constructor() { super('Créditos de IA não instalados neste ambiente (095 ausente).'); this.name = 'CreditosNaoInstalados'; }
}

/** 095 aplicada (as onze tabelas nascem juntas numa transação; basta conferir o extrato e a guarda). */
export async function creditosInstalados(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>(
        "SELECT to_regclass('public.ia_credito_lancamentos') IS NOT NULL AND to_regprocedure('public.kidmais_095_guarda()') IS NOT NULL AS ok")).rows[0]?.ok === true;
}
export async function exigirInstalados(tx: DbExecutor) {
    if (!await creditosInstalados(tx)) throw new CreditosNaoInstalados();
}

export type Carteira = { empresa_id: string; recurso: Recurso; saldo: number; reservado: number; bloqueado: number; corte_em: string | null };
const n = (v: unknown) => Number(v);
function carteira(r: Record<string, unknown>): Carteira {
    return { empresa_id: String(r.empresa_id), recurso: r.recurso as Recurso, saldo: n(r.saldo), reservado: n(r.reservado), bloqueado: n(r.bloqueado),
        corte_em: (r.corte_em as string | null) ?? null };
}
const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function lerCarteira(tx: DbExecutor, empresaId: string, recurso: Recurso, travar = false): Promise<Carteira | null> {
    const r = (await tx.query(`SELECT empresa_id, recurso, saldo, reservado, bloqueado, ${ISO('corte_em')} AS corte_em FROM ia_credito_carteiras
        WHERE empresa_id = $1::uuid AND recurso = $2 ${travar ? 'FOR UPDATE' : ''}`, [empresaId, recurso])).rows[0];
    return r ? carteira(r) : null;
}
/** Cria (se preciso) e trava a carteira. CONVITES só nasce pelo corte (corteEm obrigatório; constraint da 095). */
export async function abrirCarteira(tx: DbExecutor, empresaId: string, recurso: Recurso, corteEm: string | null = null) {
    await tx.query(`INSERT INTO ia_credito_carteiras (empresa_id, recurso, corte_em) VALUES ($1::uuid, $2, $3::timestamptz) ON CONFLICT DO NOTHING`,
        [empresaId, recurso, corteEm]);
    return (await lerCarteira(tx, empresaId, recurso, true))!;
}

type Lancamento = { empresaId: string; recurso: Recurso; loteId: string; tipo: TipoLancamento; quantidade: number; operacao: string; protocolo?: string | null; ator: Ator };
/** Grava o lançamento e aplica a variação no lote e na carteira (só se o lançamento for novo). true = novo. */
async function lancar(tx: DbExecutor, l: Lancamento) {
    if (!Number.isSafeInteger(l.quantidade) || l.quantidade <= 0) throw new Error('quantidade inválida no extrato');
    const [ds, dr, db] = DELTAS[l.tipo].map((f) => f * l.quantidade);
    const novo = (await tx.query(`INSERT INTO ia_credito_lancamentos (empresa_id, recurso, lote_id, tipo, quantidade, delta_saldo, delta_reservado, delta_bloqueado, operacao, protocolo, ator)
        VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT ON CONSTRAINT ia_credito_lancamentos_operacao_uk DO NOTHING RETURNING id`,
    [l.empresaId, l.recurso, l.loteId, l.tipo, l.quantidade, ds, dr, db, l.operacao, l.protocolo ?? null, l.ator])).rows[0];
    if (!novo) return false;
    const [a, b, c, d, e, f] = NO_LOTE[l.tipo].map((x) => x * l.quantidade);
    if (a || b || c || d || e || f) {
        const lote = await tx.query(`UPDATE ia_credito_lotes SET disponivel = disponivel + $3, reservado = reservado + $4, bloqueado = bloqueado + $5,
            consumido = consumido + $6, expirado = expirado + $7, cancelado = cancelado + $8 WHERE id = $1::uuid AND empresa_id = $2::uuid RETURNING id`,
        [l.loteId, l.empresaId, a, b, c, d, e, f]);
        if (lote.rowCount !== 1) throw new Error('lote do lançamento não encontrado');
    }
    const w = await tx.query(`UPDATE ia_credito_carteiras SET saldo = saldo + $3, reservado = reservado + $4, bloqueado = bloqueado + $5
        WHERE empresa_id = $1::uuid AND recurso = $2 RETURNING empresa_id`, [l.empresaId, l.recurso, ds, dr, db]);
    if (w.rowCount !== 1) throw new Error('carteira do lançamento não encontrada');
    return true;
}

export type NovoLote = { empresaId: string; recurso: Recurso; origem: Origem; chaveOrigem: string; quantidade: number; venceEm: number;
    precoCentavos?: number | null; pedidoId?: string | null; ciclo?: string | null; protocolo?: string | null; ator: Ator };
/** Cria o lote e o CREDITO (idempotente pela chave de origem). Exige a carteira travada pelo chamador. */
export async function creditarLote(tx: DbExecutor, l: NovoLote): Promise<{ loteId: string; novo: boolean }> {
    const criado = (await tx.query<{ id: string }>(`INSERT INTO ia_credito_lotes (empresa_id, recurso, origem, chave_origem, quantidade, disponivel, preco_centavos, pedido_id, ciclo, vence_em)
        VALUES ($1::uuid, $2, $3, $4, $5, $5, $6, $7::uuid, $8::date, $9::timestamptz)
        ON CONFLICT ON CONSTRAINT ia_credito_lotes_origem_uk DO NOTHING RETURNING id`,
    [l.empresaId, l.recurso, l.origem, l.chaveOrigem, l.quantidade, l.precoCentavos ?? null, l.pedidoId ?? null, l.ciclo ?? null, new Date(l.venceEm).toISOString()])).rows[0];
    if (!criado) {
        const existente = (await tx.query<{ id: string }>('SELECT id FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND recurso = $2 AND chave_origem = $3',
            [l.empresaId, l.recurso, l.chaveOrigem])).rows[0];
        return { loteId: existente.id, novo: false };
    }
    // O lote nasce com o saldo inteiro disponível (gatilho da 095); o CREDITO só move a carteira.
    await lancar(tx, { empresaId: l.empresaId, recurso: l.recurso, loteId: criado.id, tipo: 'CREDITO', quantidade: l.quantidade,
        operacao: `CREDITO:${l.chaveOrigem.replace(/^[A-Z]+:/, '')}`, protocolo: l.protocolo, ator: l.ator });
    return { loteId: criado.id, novo: true };
}

type LinhaLote = { id: string; origem: Origem; disponivel: string; reservado: string; vence_ms: string; vencido: boolean; cancelado_definitivo: boolean; em_bloqueio: boolean };
async function lotesTravados(tx: DbExecutor, empresaId: string, recurso: Recurso, ids?: readonly string[]) {
    return (await tx.query<LinhaLote>(`SELECT l.id, l.origem, l.disponivel, l.reservado, (extract(epoch FROM l.vence_em) * 1000)::bigint AS vence_ms,
            l.vence_em <= clock_timestamp() AS vencido, (l.cancelado > 0) AS cancelado_definitivo, (l.bloqueado > 0) AS em_bloqueio
        FROM ia_credito_lotes l WHERE l.empresa_id = $1::uuid AND l.recurso = $2 AND ${ids ? 'l.id = ANY($3::uuid[])' : '(l.disponivel > 0 AND l.vence_em > clock_timestamp())'}
        ORDER BY l.vence_em, l.id FOR UPDATE`, ids ? [empresaId, recurso, ids] : [empresaId, recurso])).rows;
}
async function agoraMs(tx: DbExecutor) {
    return Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
}

export type Reserva = { id: string; estado: 'ABERTA' | 'CONSUMIDA' | 'LIBERADA'; quantidade: number; consumido: number | null; repetida: boolean };
/**
 * Reserva `quantidade` para a operação (geração/chamada): carteira travada, lotes vigentes em ordem de consumo, alocação
 * congelada. A mesma operação devolve a reserva existente (nunca reserva duas vezes). Sem saldo: SaldoInsuficiente.
 */
export async function reservar(tx: DbExecutor, r: { empresaId: string; recurso: Recurso; operacaoId: string; quantidade: number; versaoPrecos?: string | null; ator: Ator }): Promise<Reserva> {
    const w = await lerCarteira(tx, r.empresaId, r.recurso, true);
    if (!w) throw new SaldoInsuficiente();
    const anterior = (await tx.query<{ id: string; estado: Reserva['estado']; quantidade: string; consumido: string | null }>(
        'SELECT id, estado, quantidade, consumido FROM ia_credito_reservas WHERE empresa_id = $1::uuid AND recurso = $2 AND operacao_id = $3',
        [r.empresaId, r.recurso, r.operacaoId])).rows[0];
    if (anterior) return { id: anterior.id, estado: anterior.estado, quantidade: n(anterior.quantidade), consumido: anterior.consumido === null ? null : n(anterior.consumido), repetida: true };
    const lotes = await lotesTravados(tx, r.empresaId, r.recurso);
    const agora = await agoraMs(tx);
    const alocacao = alocar(lotes.map((l) => ({ id: l.id, origem: l.origem, disponivel: n(l.disponivel), venceEm: n(l.vence_ms) })), r.quantidade, agora);
    if (!alocacao) throw new SaldoInsuficiente();
    const reserva = (await tx.query<{ id: string }>(`INSERT INTO ia_credito_reservas (empresa_id, recurso, operacao_id, quantidade, versao_precos)
        VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id`, [r.empresaId, r.recurso, r.operacaoId, r.quantidade, r.versaoPrecos ?? null])).rows[0];
    let ordem = 0;
    for (const a of alocacao) {
        ordem += 1;
        await tx.query('INSERT INTO ia_credito_reserva_lotes (reserva_id, lote_id, empresa_id, ordem, quantidade) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
            [reserva.id, a.loteId, r.empresaId, ordem, a.quantidade]);
        await lancar(tx, { empresaId: r.empresaId, recurso: r.recurso, loteId: a.loteId, tipo: 'RESERVA', quantidade: a.quantidade, operacao: `RESERVA:${reserva.id}`, ator: r.ator });
    }
    return { id: reserva.id, estado: 'ABERTA', quantidade: r.quantidade, consumido: null, repetida: false };
}

export type Encerramento = { estado: 'CONSUMIDA' | 'LIBERADA' | 'SEM_RESERVA'; consumido: number; liberado: number; repetido: boolean; excedente: number };
/**
 * Encerra a reserva da operação: consome `quantidadeFinal` (padrão: o reservado) nos lotes da alocação, na ordem, e devolve
 * o resto. O resto volta ao disponível do lote, ou EXPIRA se o lote venceu durante a operação, ou é CANCELADO se o lote
 * teve perda confirmada (devolução/estorno/disputa perdida: nunca reabre crédito devolvido), ou fica BLOQUEADO se o lote
 * está em disputa aberta (volta inteiro se ela terminar a favor). Consumo acima do reservado nunca entra na
 * carteira (`excedente` = custo absorvido pela plataforma, a registrar como divergência). Idempotente: reserva já
 * encerrada devolve o estado anterior.
 */
export async function encerrarReserva(tx: DbExecutor, e: { empresaId: string; recurso: Recurso; operacaoId: string; quantidadeFinal?: number; custoRealMicrousd?: number | null; ator: Ator }): Promise<Encerramento> {
    if (!await lerCarteira(tx, e.empresaId, e.recurso, true)) return { estado: 'SEM_RESERVA', consumido: 0, liberado: 0, repetido: false, excedente: 0 };
    const r = (await tx.query<{ id: string; estado: string; quantidade: string; consumido: string | null }>(
        'SELECT id, estado, quantidade, consumido FROM ia_credito_reservas WHERE empresa_id = $1::uuid AND recurso = $2 AND operacao_id = $3 FOR UPDATE',
        [e.empresaId, e.recurso, e.operacaoId])).rows[0];
    if (!r) return { estado: 'SEM_RESERVA', consumido: 0, liberado: 0, repetido: false, excedente: 0 };
    const total = n(r.quantidade);
    if (r.estado !== 'ABERTA') {
        const c = r.consumido === null ? 0 : n(r.consumido);
        return { estado: r.estado as 'CONSUMIDA' | 'LIBERADA', consumido: c, liberado: total - c, repetido: true, excedente: 0 };
    }
    const pedido = e.quantidadeFinal ?? total;
    if (!Number.isSafeInteger(pedido) || pedido < 0) throw new Error('consumo inválido');
    const final = Math.min(pedido, total);
    const alocacao = (await tx.query<{ lote_id: string; quantidade: string }>(
        'SELECT lote_id, quantidade FROM ia_credito_reserva_lotes WHERE reserva_id = $1::uuid AND empresa_id = $2::uuid ORDER BY ordem', [r.id, e.empresaId])).rows;
    const lotes = new Map((await lotesTravados(tx, e.empresaId, e.recurso, alocacao.map((a) => a.lote_id))).map((l) => [l.id, l]));
    let falta = final;
    for (const a of alocacao) {
        const q = n(a.quantidade), consumir = Math.min(falta, q), resto = q - consumir;
        falta -= consumir;
        const base = { empresaId: e.empresaId, recurso: e.recurso, loteId: a.lote_id, ator: e.ator };
        if (consumir > 0) await lancar(tx, { ...base, tipo: 'CONSUMO', quantidade: consumir, operacao: `CONSUMO:${r.id}` });
        if (resto > 0) {
            await lancar(tx, { ...base, tipo: 'LIBERACAO', quantidade: resto, operacao: `LIBERACAO:${r.id}` });
            const lote = lotes.get(a.lote_id);
            // P2-6 (revisão de 22/10): perda CONFIRMADA (devolução registrada, disputa perdida, estorno) cancela; disputa ABERTA
            // só bloqueia — o resto liberado fica bloqueado junto e volta inteiro se a disputa terminar a favor (desbloquear).
            if (lote?.cancelado_definitivo) {
                await lancar(tx, { ...base, tipo: 'BLOQUEIO', quantidade: resto, operacao: `LIBERACAO:${r.id}` });
                await lancar(tx, { ...base, tipo: 'REVERSAO', quantidade: resto, operacao: `LIBERACAO:${r.id}` });
            } else if (lote?.em_bloqueio) await lancar(tx, { ...base, tipo: 'BLOQUEIO', quantidade: resto, operacao: `LIBERACAO:${r.id}` });
            else if (lote?.vencido) await lancar(tx, { ...base, tipo: 'EXPIRACAO', quantidade: resto, operacao: `LIBERACAO:${r.id}` });
        }
        await tx.query('UPDATE ia_credito_reserva_lotes SET consumido = $3, liberado = $4 WHERE reserva_id = $1::uuid AND lote_id = $2::uuid', [r.id, a.lote_id, consumir, resto]);
    }
    const estado = final > 0 ? 'CONSUMIDA' : 'LIBERADA';
    await tx.query(`UPDATE ia_credito_reservas SET estado = $2, consumido = $3, custo_real_microusd = $4 WHERE id = $1::uuid AND estado = 'ABERTA'`,
        [r.id, estado, final > 0 ? final : null, e.custoRealMicrousd ?? null]);
    return { estado, consumido: final, liberado: total - final, repetido: false, excedente: Math.max(0, pedido - total) };
}

/** Expira o disponível dos lotes vencidos da carteira (worker diário; idempotente por lote). */
export async function expirarVencidos(tx: DbExecutor, empresaId: string, recurso: Recurso) {
    if (!await lerCarteira(tx, empresaId, recurso, true)) return 0;
    const vencidos = (await tx.query<{ id: string; disponivel: string }>(`SELECT id, disponivel FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND recurso = $2
        AND vence_em <= clock_timestamp() AND disponivel > 0 ORDER BY vence_em, id FOR UPDATE`, [empresaId, recurso])).rows;
    let total = 0;
    for (const l of vencidos)
        if (await lancar(tx, { empresaId, recurso, loteId: l.id, tipo: 'EXPIRACAO', quantidade: n(l.disponivel), operacao: `EXPIRACAO:${l.id}`, ator: 'SISTEMA' }))
            total += n(l.disponivel);
    return total;
}

/** Bloqueia o disponível do lote (devolução ou disputa). Exige carteira travada pelo chamador. */
export async function bloquearDisponivel(tx: DbExecutor, empresaId: string, recurso: Recurso, loteId: string, operacao: string, ator: Ator, protocolo?: string | null) {
    const l = (await tx.query<{ disponivel: string }>('SELECT disponivel FROM ia_credito_lotes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE', [loteId, empresaId])).rows[0];
    const q = l ? n(l.disponivel) : 0;
    if (q > 0) await lancar(tx, { empresaId, recurso, loteId, tipo: 'BLOQUEIO', quantidade: q, operacao, protocolo, ator });
    return q;
}
/** Cancela definitivamente o bloqueado do lote (devolução concluída/registrada, disputa perdida). */
export async function cancelarBloqueado(tx: DbExecutor, empresaId: string, recurso: Recurso, loteId: string, operacao: string, ator: Ator, protocolo?: string | null) {
    const l = (await tx.query<{ bloqueado: string }>('SELECT bloqueado FROM ia_credito_lotes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE', [loteId, empresaId])).rows[0];
    const q = l ? n(l.bloqueado) : 0;
    if (q > 0) await lancar(tx, { empresaId, recurso, loteId, tipo: 'REVERSAO', quantidade: q, operacao, protocolo, ator });
    return q;
}
/** Devolve ao disponível o bloqueado do lote (disputa resolvida a favor, sem devolução final). */
export async function desbloquear(tx: DbExecutor, empresaId: string, recurso: Recurso, loteId: string, operacao: string, ator: Ator) {
    const l = (await tx.query<{ bloqueado: string; cancelado: string }>('SELECT bloqueado, cancelado FROM ia_credito_lotes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE',
        [loteId, empresaId])).rows[0];
    const q = l && n(l.cancelado) === 0 ? n(l.bloqueado) : 0;
    if (q > 0) await lancar(tx, { empresaId, recurso, loteId, tipo: 'DESBLOQUEIO', quantidade: q, operacao, ator });
    return q;
}

export type ResumoLote = { origem: Origem; quantidade: number; disponivel: number; reservado: number; bloqueado: number; consumido: number; expirado: number; cancelado: number;
    liberadoEm: string; venceEm: string; protocolo: string | null };
export type ResumoCarteira = { recurso: Recurso; saldo: number; reservado: number; bloqueado: number; disponivel: number; corteEm: string | null; lotes: ResumoLote[];
    referencia: number };
/** Resumo de leitura (sem ids internos de lote). `referencia` = maior lote vigente (base do aviso de saldo baixo). */
export async function resumoCarteira(tx: DbExecutor, empresaId: string, recurso: Recurso): Promise<ResumoCarteira | null> {
    const w = await lerCarteira(tx, empresaId, recurso);
    if (!w) return null;
    const lotes = (await tx.query<Record<string, unknown>>(`SELECT l.origem, l.quantidade, l.disponivel, l.reservado, l.bloqueado, l.consumido, l.expirado, l.cancelado,
            ${ISO('l.liberado_em')} AS liberado, ${ISO('l.vence_em')} AS vence, p.protocolo
        FROM ia_credito_lotes l LEFT JOIN ia_credito_pedidos p ON p.id = l.pedido_id AND p.empresa_id = l.empresa_id
        WHERE l.empresa_id = $1::uuid AND l.recurso = $2 AND (l.disponivel > 0 OR l.reservado > 0 OR l.bloqueado > 0 OR l.vence_em > clock_timestamp() - interval '90 days')
        ORDER BY l.vence_em, l.id LIMIT 50`, [empresaId, recurso])).rows.map((l) => ({
        origem: l.origem as Origem, quantidade: n(l.quantidade), disponivel: n(l.disponivel), reservado: n(l.reservado), bloqueado: n(l.bloqueado),
        consumido: n(l.consumido), expirado: n(l.expirado), cancelado: n(l.cancelado), liberadoEm: String(l.liberado), venceEm: String(l.vence), protocolo: (l.protocolo as string | null) ?? null }));
    const vigentes = lotes.filter((l) => Date.parse(l.venceEm) > Date.now());
    return { recurso, saldo: w.saldo, reservado: w.reservado, bloqueado: w.bloqueado, disponivel: w.saldo - w.reservado - w.bloqueado, corteEm: w.corte_em, lotes,
        referencia: vigentes.reduce((m, l) => Math.max(m, l.quantidade), 0) };
}

export type Divergencia = { recurso: Recurso; tipo: 'CARTEIRA_X_EXTRATO' | 'CARTEIRA_X_LOTES' | 'LOTE_X_EXTRATO' | 'RESERVA_X_ALOCACAO' };
/** Recomputação independente (reconciliação): carteira = soma do extrato = soma dos lotes; reservas abertas = reservado. */
export async function conferirCarteira(tx: DbExecutor, empresaId: string, recurso: Recurso): Promise<Divergencia[]> {
    const r = (await tx.query<Record<string, string>>(`SELECT
        w.saldo, w.reservado, w.bloqueado,
        (SELECT coalesce(sum(delta_saldo), 0) FROM ia_credito_lancamentos x WHERE x.empresa_id = w.empresa_id AND x.recurso = w.recurso) AS ext_saldo,
        (SELECT coalesce(sum(delta_reservado), 0) FROM ia_credito_lancamentos x WHERE x.empresa_id = w.empresa_id AND x.recurso = w.recurso) AS ext_reservado,
        (SELECT coalesce(sum(delta_bloqueado), 0) FROM ia_credito_lancamentos x WHERE x.empresa_id = w.empresa_id AND x.recurso = w.recurso) AS ext_bloqueado,
        (SELECT coalesce(sum(disponivel + reservado + bloqueado), 0) FROM ia_credito_lotes l WHERE l.empresa_id = w.empresa_id AND l.recurso = w.recurso) AS lot_saldo,
        (SELECT coalesce(sum(reservado), 0) FROM ia_credito_lotes l WHERE l.empresa_id = w.empresa_id AND l.recurso = w.recurso) AS lot_reservado,
        (SELECT coalesce(sum(bloqueado), 0) FROM ia_credito_lotes l WHERE l.empresa_id = w.empresa_id AND l.recurso = w.recurso) AS lot_bloqueado,
        (SELECT coalesce(sum(rl.quantidade - rl.consumido - rl.liberado), 0) FROM ia_credito_reserva_lotes rl JOIN ia_credito_reservas rv ON rv.id = rl.reserva_id
           WHERE rv.empresa_id = w.empresa_id AND rv.recurso = w.recurso AND rv.estado = 'ABERTA') AS res_aberto,
        (SELECT count(*) FROM ia_credito_lotes l CROSS JOIN LATERAL (SELECT
             coalesce(sum(x.quantidade) FILTER (WHERE x.tipo = 'CREDITO'), 0) AS cred,
             coalesce(sum(x.quantidade) FILTER (WHERE x.tipo = 'CONSUMO'), 0) AS cons,
             coalesce(sum(x.quantidade) FILTER (WHERE x.tipo = 'EXPIRACAO'), 0) AS exp,
             coalesce(sum(x.quantidade) FILTER (WHERE x.tipo = 'REVERSAO'), 0) AS rev,
             coalesce(sum(x.delta_reservado), 0) AS res, coalesce(sum(x.delta_bloqueado), 0) AS blq
           FROM ia_credito_lancamentos x WHERE x.lote_id = l.id AND x.empresa_id = l.empresa_id) e
          WHERE l.empresa_id = w.empresa_id AND l.recurso = w.recurso
            AND (e.cred <> l.quantidade OR e.cons <> l.consumido OR e.exp <> l.expirado OR e.rev <> l.cancelado OR e.res <> l.reservado OR e.blq <> l.bloqueado)) AS lotes_divergentes
      FROM ia_credito_carteiras w WHERE w.empresa_id = $1::uuid AND w.recurso = $2`, [empresaId, recurso])).rows[0];
    if (!r) return [];
    const d: Divergencia[] = [];
    if (r.saldo !== r.ext_saldo || r.reservado !== r.ext_reservado || r.bloqueado !== r.ext_bloqueado) d.push({ recurso, tipo: 'CARTEIRA_X_EXTRATO' });
    if (r.saldo !== r.lot_saldo || r.reservado !== r.lot_reservado || r.bloqueado !== r.lot_bloqueado) d.push({ recurso, tipo: 'CARTEIRA_X_LOTES' });
    if (Number(r.lotes_divergentes) > 0) d.push({ recurso, tipo: 'LOTE_X_EXTRATO' });
    if (r.reservado !== r.res_aberto) d.push({ recurso, tipo: 'RESERVA_X_ALOCACAO' });
    return d;
}
