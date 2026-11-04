/**
 * Franquias de IA por plano — F1 (plano "Franquias de IA por plano 20261102", rev. 4.1, §4.1–4.2 e §4.6; migration 116).
 * Só CONVITES nesta fase (WHATSAPP entra na F3 com a M-C; COPILOTO nunca usa carteira). Atrás de
 * CREDITOS_FRANQUIA_PLANO_ATIVO: desligada, o worker segue exatamente o caminho legado (concederFranquiaConvites).
 *
 * reconhecerFranquia, sempre DENTRO da transação de quem chama:
 *   1. trava a empresa (FOR SHARE) e a carteira CONVITES (sem carteira = SEM_CORTE); mês do corte = só o LEGADO (MES_DO_CORTE);
 *   2. classifica: sem 074/isenta/sem contratação confirmada vigente = SEM_LIMITE (o chamador usa o caminho legado);
 *      plano desconhecido = erro (nunca infere); acesso não COMPLETO = ACESSO_NAO_COMPLETO;
 *   3. trava a linha da assinatura (FOR SHARE: a sincronização, que a atualiza, espera ou é esperada) e SÓ ENTÃO lê o
 *      histórico de contratações; a contratação confirmada mais recente tem de ser a atual (senão HISTORICO_DIVERGENTE,
 *      nada concedido: a premissa da reconstrução não vale e o plano volta à revisão);
 *   4. adota o lote mensal criado pelo worker legado (linha ADOCAO com a quantidade REAL), reconstrói o devido do
 *      histórico e credita só `devido − já creditado`, numa linha RECONHECIMENTO 1:1 com o lote novo.
 * Ordem global de travas (revisão r1, P2-1; modo corrigido na revisão r2): empresas (FOR SHARE) → carteira →
 * empresa_assinaturas (FOR SHARE). É a ordem que o resto do sistema já segue: a sincronização (empresa FOR UPDATE →
 * assinatura), a geração de convites (empresa FOR UPDATE → carteira) e a reconciliação da contratação (empresa FOR NO KEY
 * UPDATE → assinatura FOR UPDATE → promoção da empresa a FOR UPDATE pelo gatilho 074a ou pela sincronização) pegam a
 * empresa primeiro. Conflito de chave de lote é erro, nunca é engolido.
 */
import type { DbExecutor } from '../db/contracts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { empresaIsenta, schemaPlanosInstalado } from '../assinatura/ofertas.ts';
import { planoComercialValido } from '../assinatura/planos-comerciais.ts';
import { fimDoMesBrasilia, mesBrasilia } from './dominio.ts';
import { creditarLote, lerCarteira } from './ledger.ts';
import { enfileirarNotificacao } from './notificacoes.ts';
import { chaveFranquia, devidoDoCiclo, marcoDeUso, TABELA_FRANQUIAS, type MudancaNoCiclo, type PlanoFranquia } from './franquias-regra.ts';

export class FranquiaEmConflito extends Error {
    constructor(chave: string) { super(`Lote de franquia já existe com a chave ${chave}: reconhecimento recusado.`); this.name = 'FranquiaEmConflito'; }
}
export class PlanoIlegivel extends Error {
    constructor() { super('Plano da contratação vigente não reconhecido: nenhuma franquia concedida.'); this.name = 'PlanoIlegivel'; }
}

export async function franquiasInstaladas(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_credito_franquias_ciclo') IS NOT NULL
        AND to_regclass('public.ia_credito_franquia_pendencias') IS NOT NULL AS ok`)).rows[0]?.ok === true;
}

export type MotivoFranquia = 'SEM_CORTE' | 'MES_DO_CORTE' | 'SEM_LIMITE' | 'ACESSO_NAO_COMPLETO' | 'HISTORICO_DIVERGENTE' | 'JA_RECONHECIDA';
export type Reconhecimento = { concedida: boolean; quantidade: number; motivo: MotivoFranquia | null; adotado: number; devido: number | null };
const nada = (motivo: MotivoFranquia): Reconhecimento => ({ concedida: false, quantidade: 0, motivo, adotado: 0, devido: null });

type Fotografia = { atual_id: string | null; atual_plano: string | null; ultima_id: string | null; plano_inicial: string | null;
    inicial_id: string | null; inicial_em: string | null; mudancas: { id: string; plano: string; dia: number; em: string }[]; dias_no_mes: number };
const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
async function fotografia(tx: DbExecutor, empresaId: string, ciclo: string): Promise<Fotografia | null> {
    // Trava primeiro, lê depois: a leitura seguinte já não pode cruzar uma troca de contratação em curso.
    if (!(await tx.query('SELECT 1 FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR SHARE', [empresaId])).rows.length) return null;
    return (await tx.query<Fotografia>(`WITH limites AS (
            SELECT ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS inicio,
                   ($2::date + interval '1 month')::timestamp AT TIME ZONE 'America/Sao_Paulo' AS fim,
                   extract(day FROM $2::date + interval '1 month' - interval '1 day')::int AS dias_no_mes)
        SELECT a.contratacao_atual_id::text AS atual_id,
               (SELECT c.plano FROM assinatura_contratacoes c WHERE c.id = a.contratacao_atual_id AND c.empresa_id = a.empresa_id AND c.estado = 'CONFIRMADA') AS atual_plano,
               (SELECT h.id::text FROM assinatura_contratacoes h WHERE h.empresa_id = a.empresa_id AND h.estado = 'CONFIRMADA'
                  ORDER BY h.confirmada_em DESC, h.id DESC LIMIT 1) AS ultima_id,
               i.plano AS plano_inicial, i.id::text AS inicial_id, ${ISO('i.confirmada_em')} AS inicial_em,
               COALESCE((SELECT json_agg(json_build_object('id', h.id::text, 'plano', h.plano, 'em', ${ISO('h.confirmada_em')},
                           'dia', extract(day FROM h.confirmada_em AT TIME ZONE 'America/Sao_Paulo')::int) ORDER BY h.confirmada_em, h.id)
                  FROM assinatura_contratacoes h, limites l WHERE h.empresa_id = a.empresa_id AND h.estado = 'CONFIRMADA'
                  AND h.confirmada_em >= l.inicio AND h.confirmada_em < l.fim), '[]'::json) AS mudancas,
               (SELECT dias_no_mes FROM limites) AS dias_no_mes
          FROM empresa_assinaturas a
          LEFT JOIN LATERAL (SELECT h.id, h.plano, h.confirmada_em FROM assinatura_contratacoes h, limites l WHERE h.empresa_id = a.empresa_id
                AND h.estado = 'CONFIRMADA' AND h.confirmada_em < l.inicio ORDER BY h.confirmada_em DESC, h.id DESC LIMIT 1) i ON true
         WHERE a.empresa_id = $1::uuid`, [empresaId, ciclo])).rows[0] ?? null;
}

function plano(valor: string | null): PlanoFranquia | null {
    if (valor === null) return null;
    const p = valor.toLowerCase();
    if (!planoComercialValido(p)) throw new PlanoIlegivel();
    return p;
}

/**
 * Primeira trava da manutenção de uma empresa, ANTES da carteira. FOR SHARE (revisão r2, P2): conflita com FOR UPDATE
 * (sincronização, geração de convites, checkout, gatilhos 074a) E com FOR NO KEY UPDATE (reconciliação da contratação) — com
 * KEY SHARE a reconciliação entrava junto, travava a assinatura e, ao promover a empresa a FOR UPDATE (gatilho 074a no
 * VINCULADA ou sincronizarEmpresa depois do CONCILIADA), esperava esta transação, que esperava a assinatura: deadlock.
 * Continua compatível com KEY SHARE: o marcador de exclusão da reconciliação (transação independente) e as FKs das
 * notificações e do pagamento passam. Nada daqui promove a empresa (manutenção não escreve em empresa_assinaturas nem nas
 * tabelas 074a), então duas manutenções da mesma empresa só se enfileiram na carteira.
 */
export async function travarEmpresaAntesDaCarteira(tx: DbExecutor, empresaId: string) {
    await tx.query('SELECT 1 FROM empresas WHERE id = $1::uuid FOR SHARE', [empresaId]);
}

export async function reconhecerFranquia(tx: DbExecutor, empresaId: string): Promise<Reconhecimento> {
    await travarEmpresaAntesDaCarteira(tx, empresaId);
    if (!await lerCarteira(tx, empresaId, 'CONVITES', true)) return nada('SEM_CORTE');
    const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const ciclo = mesBrasilia(agora);
    const corte = (await tx.query<{ mes: string }>("SELECT to_char(mes, 'YYYY-MM-DD') AS mes FROM ia_credito_cortes WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'",
        [empresaId])).rows[0];
    if (corte?.mes === ciclo) return nada('MES_DO_CORTE');
    if (!await schemaPlanosInstalado(tx) || await empresaIsenta(tx, empresaId)) return nada('SEM_LIMITE');
    const f = await fotografia(tx, empresaId, ciclo);
    if (!f?.atual_id || f.atual_plano === null) return nada('SEM_LIMITE');
    plano(f.atual_plano);
    if (f.ultima_id !== f.atual_id) return nada('HISTORICO_DIVERGENTE');
    if ((await lerEstadoComercial(tx, empresaId)).acesso.nivel !== 'COMPLETO') return nada('ACESSO_NAO_COMPLETO');

    const legado = (await tx.query<{ limite_mensal: number; ativo: boolean }>('SELECT limite_mensal, ativo FROM convite_carteiras WHERE empresa_id = $1::uuid',
        [empresaId])).rows[0];
    const piso = legado?.ativo ? Math.max(0, Number(legado.limite_mensal)) : 0;
    const mudancas: MudancaNoCiclo[] = f.mudancas.map((m) => ({ dia: Number(m.dia), plano: plano(m.plano)!, contratacaoId: m.id, confirmadaEm: m.em }));
    const calculo = devidoDoCiclo({ recurso: 'CONVITES', piso, diasNoMes: Number(f.dias_no_mes), planoInicial: plano(f.plano_inicial), mudancas,
        inicial: f.inicial_id && f.inicial_em ? { contratacaoId: f.inicial_id, confirmadaEm: f.inicial_em } : null });

    const chaveMensal = chaveFranquia(ciclo, 0, false);
    const linhas = (await tx.query<{ lote_id: string; concedido: string }>(
        'SELECT lote_id::text, concedido FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid AND recurso = $2 AND ciclo = $3::date',
        [empresaId, 'CONVITES', ciclo])).rows;
    const mensal = (await tx.query<{ id: string; quantidade: string }>(
        'SELECT id::text, quantidade FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND recurso = $2 AND chave_origem = $3',
        [empresaId, 'CONVITES', chaveMensal])).rows[0];
    let adotado = 0;
    if (mensal && !linhas.some((l) => l.lote_id === mensal.id)) {
        // Lote do worker legado (flag desligada no início do mês): entra com a quantidade REAL, nunca a calculada.
        adotado = Number(mensal.quantidade);
        await tx.query(`INSERT INTO ia_credito_franquias_ciclo (empresa_id, recurso, ciclo, chave, lote_id, tipo, concedido)
            VALUES ($1::uuid, 'CONVITES', $2::date, $3, $4::uuid, 'ADOCAO', $5)`, [empresaId, ciclo, chaveMensal, mensal.id, adotado]);
        linhas.push({ lote_id: mensal.id, concedido: String(adotado) });
    }
    const jaCreditado = linhas.reduce((s, l) => s + Number(l.concedido), 0);
    const falta = calculo.devido - jaCreditado;
    if (falta <= 0) return { concedida: false, quantidade: 0, motivo: 'JA_RECONHECIDA', adotado, devido: calculo.devido };

    const chave = chaveFranquia(ciclo, linhas.length, Boolean(mensal));
    const lote = await creditarLote(tx, { empresaId, recurso: 'CONVITES', origem: 'FRANQUIA', chaveOrigem: chave, quantidade: falta,
        venceEm: fimDoMesBrasilia(agora), ciclo, ator: 'SISTEMA' });
    if (!lote.novo) throw new FranquiaEmConflito(chave);
    await tx.query(`INSERT INTO ia_credito_franquias_ciclo (empresa_id, recurso, ciclo, chave, lote_id, tipo, concedido, devido_calculado, contratacao_id, versao_tabela, historico)
        VALUES ($1::uuid, 'CONVITES', $2::date, $3, $4::uuid, 'RECONHECIMENTO', $5, $6, $7::uuid, $8, $9::jsonb)`,
    [empresaId, ciclo, chave, lote.loteId, falta, calculo.devido, f.atual_id, TABELA_FRANQUIAS.versao, JSON.stringify(calculo.segmentos)]);
    return { concedida: true, quantidade: falta, motivo: null, adotado, devido: calculo.devido };
}

/**
 * Intenção de reconhecer, gravada pela sincronização NA MESMA transação em que a contratação atual muda. Isolada em
 * SAVEPOINT: sem a 116 ou com falha, a sincronização segue (o worker diário reconstrói o devido de qualquer forma).
 */
export async function registrarPendenciaFranquia(tx: DbExecutor, empresaId: string, contratacaoId: string) {
    await tx.query('SAVEPOINT kidmais_pendencia_franquia');
    try {
        let criada = false;
        if (await franquiasInstaladas(tx))
            criada = (await tx.query(`INSERT INTO ia_credito_franquia_pendencias (empresa_id, contratacao_id) VALUES ($1::uuid, $2::uuid)
                ON CONFLICT DO NOTHING`, [empresaId, contratacaoId])).rowCount === 1;
        await tx.query('RELEASE SAVEPOINT kidmais_pendencia_franquia');
        return criada;
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_pendencia_franquia');
        await tx.query('RELEASE SAVEPOINT kidmais_pendencia_franquia');
        console.warn('[franquias] pendência não registrada; a sincronização segue', error instanceof Error ? error.name : typeof error);
        return false;
    }
}

type ComTransacao = <T>(t: (tx: DbExecutor) => Promise<T>) => Promise<T>;
/** Processa as pendências abertas, uma transação por pendência. Erro: conta a tentativa e segue (o worker cobre depois). */
export async function processarPendenciasFranquia(withTransaction: ComTransacao, limite = 50) {
    const r = { processadas: 0, concedidas: 0, falhas: 0 };
    const abertas = await withTransaction(async (tx) => (await franquiasInstaladas(tx))
        ? (await tx.query<{ empresa_id: string; contratacao_id: string }>(`SELECT empresa_id::text, contratacao_id::text FROM ia_credito_franquia_pendencias
            WHERE processada_em IS NULL ORDER BY criada_em LIMIT $1`, [limite])).rows
        : []);
    for (const p of abertas) {
        try {
            await withTransaction(async (tx) => {
                const rec = await reconhecerFranquia(tx, p.empresa_id);
                await tx.query(`UPDATE ia_credito_franquia_pendencias SET processada_em = clock_timestamp(), tentativas = tentativas + 1, ultimo_motivo = $3
                    WHERE empresa_id = $1::uuid AND contratacao_id = $2::uuid AND processada_em IS NULL`, [p.empresa_id, p.contratacao_id, rec.motivo ?? 'CONCEDIDA']);
                r.processadas += 1;
                if (rec.concedida) r.concedidas += 1;
            });
        }
        catch (error) {
            r.falhas += 1;
            const motivo = error instanceof PlanoIlegivel ? 'PLANO_ILEGIVEL' : error instanceof FranquiaEmConflito ? 'CHAVE_EM_CONFLITO' : 'ERRO';
            await withTransaction(async (tx) => tx.query(`UPDATE ia_credito_franquia_pendencias SET tentativas = LEAST(tentativas + 1, 1000), ultimo_motivo = $3
                WHERE empresa_id = $1::uuid AND contratacao_id = $2::uuid AND processada_em IS NULL`, [p.empresa_id, p.contratacao_id, motivo])).catch(() => undefined);
        }
    }
    return r;
}

/**
 * Avisos de 80% e 100% (§4.6): sobre o direito reconhecido no ciclo MAIS os saldos válidos; dedupe por empresa, recurso e mês.
 *   base = direito do ciclo + Σ (disponível + reservado) dos outros lotes válidos + consumo do ciclo nesses lotes
 *   uso  = consumo dos lotes de franquia do ciclo + consumo do ciclo nos outros lotes válidos
 * "Outros lotes válidos": CONVITES da empresa, fora da franquia do ciclo, liberados e ainda não vencidos (compra, cortesia,
 * legado, franquias de ciclos anteriores ainda vigentes). O filtro é só esse (liberação e vencimento); o lote em si nunca é
 * excluído por bloqueio ou cancelamento (revisão r2, P3):
 *   - saldo de um lote = disponível + reservado (reservas em aberto contam como saldo); as quantidades bloqueada (devolução
 *     em curso), cancelada e expirada não são saldo;
 *   - o consumo DO CICLO num lote válido continua na base e no uso, mesmo que o resto do lote esteja bloqueado ou cancelado
 *     (foi usado neste mês). Ex.: franquia 30 com 22 consumidos + lote com 10 consumidos no ciclo e os 90 restantes
 *     cancelados → uso 32, base 30 + 0 + 10 = 40 → 80%;
 *   - franquia de ciclo anterior ainda vigente: entra como outro lote (saldo restante + consumo só deste ciclo);
 *   - reserva sobre a franquia do ciclo não é uso (só o consumido conta; o direito já está na base).
 * Consumo do ciclo = lançamentos CONSUMO desde o início do mês em São Paulo. Lote vencido (ainda não expirado pelo worker)
 * sai da base e do uso por inteiro. Sem direito no ciclo, nenhum aviso (o aviso é da franquia).
 */
export async function usoDaFranquia(tx: DbExecutor, empresaId: string) {
    const ciclo = (await tx.query<{ c: string }>("SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS c")).rows[0].c;
    const u = (await tx.query<{ direito: string; uso: string; base: string }>(`WITH
            franquia AS (SELECT l.id, l.consumido FROM ia_credito_lotes l JOIN ia_credito_franquias_ciclo f ON f.lote_id = l.id
              WHERE f.empresa_id = $1::uuid AND f.recurso = 'CONVITES' AND f.ciclo = $2::date),
            outros AS (SELECT l.id, l.disponivel + l.reservado AS saldo FROM ia_credito_lotes l
              WHERE l.empresa_id = $1::uuid AND l.recurso = 'CONVITES' AND l.id NOT IN (SELECT id FROM franquia)
                AND l.liberado_em <= clock_timestamp() AND l.vence_em > clock_timestamp()),
            consumo_outros AS (SELECT COALESCE(sum(x.quantidade), 0) AS q FROM ia_credito_lancamentos x
              WHERE x.empresa_id = $1::uuid AND x.recurso = 'CONVITES' AND x.tipo = 'CONSUMO' AND x.lote_id IN (SELECT id FROM outros)
                AND x.criado_em >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
            direito AS (SELECT COALESCE(sum(concedido), 0) AS q FROM ia_credito_franquias_ciclo WHERE empresa_id = $1::uuid AND recurso = 'CONVITES' AND ciclo = $2::date)
        SELECT (SELECT q FROM direito) AS direito,
               (SELECT COALESCE(sum(consumido), 0) FROM franquia) + (SELECT q FROM consumo_outros) AS uso,
               (SELECT q FROM direito) + (SELECT COALESCE(sum(saldo), 0) FROM outros) + (SELECT q FROM consumo_outros) AS base`, [empresaId, ciclo])).rows[0];
    return { ciclo, direito: Number(u.direito), uso: Number(u.uso), base: Number(u.base) };
}

/** Avisos de 80% e 100% sobre `usoDaFranquia` (§4.6); dedupe por empresa, recurso e mês. */
export async function avisosDeUsoFranquia(tx: DbExecutor, empresaId: string) {
    if (!await franquiasInstaladas(tx)) return 0;
    const { ciclo, direito, uso, base } = await usoDaFranquia(tx, empresaId);
    if (direito <= 0) return 0;
    const marco = marcoDeUso(uso, base);
    if (!marco) return 0;
    // Só o marco alcançado: quem passa direto de menos de 80% para 100% recebe um aviso, não dois.
    await enfileirarNotificacao(tx, { empresaId, tipo: marco, dedupe: `${marco}:${empresaId}:CONVITES:${ciclo.slice(0, 7)}` });
    return 1;
}
