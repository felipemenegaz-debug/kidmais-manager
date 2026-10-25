import type { DbExecutor } from '../../db/contracts.ts';
import { posicaoEconomica, reaisCentavos } from '../../pagamentos/services/alteracao-financeira-core.ts';
import { situacaoCobranca } from '../../pagamentos/services/cancelamento-core.ts';
import type { OrigemReferencia } from '../versao-referencia.ts';

/**
 * Lista de contratos da empresa comprovada (plano "Contratos: tela simplificada", fase 2 — rev. 3 §N8 + rev. 4).
 * Somente leitura, sempre presa à empresa no SQL (nunca lista global filtrada depois).
 *
 * - Versão de referência: a MESMA ordem de `versaoDeReferencia` (lib/contratos/versao-referencia.ts), em SQL, com
 *   paridade testada em PostgreSQL: vigente do fluxo → maior ASSINADA → preparação do fluxo → maior ATIVA → maior.
 * - Financeiro: o SQL só agrega cada relação por pagamento ANTES de juntar (nada se multiplica); a posição e a
 *   cobrança são calculadas pelas MESMAS funções da leitura do contrato (`posicaoEconomica`, `situacaoCobranca`,
 *   `reaisCentavos`). O que essas funções recusariam vira "Conferir", sem números. 0 ou 2+ pagamentos também.
 *   Não reproduz, por custo, a conferência de integridade do snapshot nem as checagens de versão da leitura do
 *   contrato: a tela do contrato continua sendo a fonte confiável.
 * - Paginação por cursor (data do evento, id), datas nulas no fim; contagens dos filtros sobre o conjunto da busca.
 *   Garantia: ordem estável para quem não muda; contrato cuja data muda durante a navegação pode repetir ou sumir.
 */
export const FILTROS = ['proximas', 'aguardando', 'alteracao', 'todas', 'canceladas'] as const;
export type Filtro = typeof FILTROS[number];
export const LIMITE_PAGINA = 50;

/** Prioridade da versão de referência (mesma ordem de `versaoDeReferencia`). `v` = versão, `cf` = fluxo. */
export const PRIORIDADE_REFERENCIA_SQL = `CASE WHEN v.id = cf.versao_vigente_id THEN 1 WHEN v.status = 'ASSINADA' THEN 2
  WHEN v.id = cf.versao_em_preparacao_id THEN 3 WHEN v.status = 'ATIVA' THEN 4 ELSE 5 END`;
export const ORIGEM_POR_PRIORIDADE: Record<number, OrigemReferencia> = { 1: 'VIGENTE_FLUXO', 2: 'VIGENTE_LEGADA', 3: 'PREPARACAO_INICIAL', 4: 'ATIVA_SEM_FLUXO', 5: 'SEM_VERSAO_VALIDA' };

const EDICAO_ABERTA = `('EM_ELABORACAO','ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE')`;
// Sempre booleano: referência sem edição (estado NULL) não é cancelada — mesma semântica `IS DISTINCT FROM` da lista antiga.
const CANCELADO = `(b.status = 'CANCELADO' OR (b.status <> 'ASSINADO' AND b.estado_referencia IS NOT DISTINCT FROM 'CANCELADA'))`;
const CONDICAO: Record<Filtro, string> = {
  proximas: `NOT ${CANCELADO} AND b.futura`,
  aguardando: `NOT ${CANCELADO} AND (b.status = 'AGUARDANDO_ASSINATURA' OR b.estado_preparacao = 'AGUARDANDO_CLIENTE')`,
  alteracao: `NOT ${CANCELADO} AND b.versao_vigente_id IS NOT NULL AND b.estado_preparacao IN ${EDICAO_ABERTA}`,
  todas: `NOT ${CANCELADO}`,
  canceladas: CANCELADO,
};
const ASCENDENTE: Record<Filtro, boolean> = { proximas: true, aguardando: false, alteracao: false, todas: false, canceladas: false };

export type Cursor = { f: Filtro; n: 0 | 1; d: string | null; i: string };
export type Busca = { texto: string | null; data: string | null };

/** Data de calendário que o PostgreSQL aceita sem erro: AAAA-MM-DD real, ano de 1000 a 9999 (o ano 0000 não existe no tipo date). */
export function dataDeCalendario(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < '1000-01-01') return false;
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/** Busca de 2 a 80 caracteres: dd/mm/aaaa vira data exata; o resto, texto (sem curingas do usuário). */
export function interpretarBusca(bruta: string | null | undefined): Busca {
  const t = (bruta ?? '').trim();
  if (!t) return { texto: null, data: null };
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (dataDeCalendario(iso)) return { texto: null, data: iso };
  }
  if (t.length < 2 || t.length > 80) throw new Error('BUSCA_INVALIDA');
  return { texto: t.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase(), data: null };
}

export function codificarCursor(c: Cursor) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
export function decodificarCursor(bruto: string | null | undefined, filtro: Filtro): Cursor | null {
  if (!bruto) return null;
  let c: Cursor;
  try { c = JSON.parse(Buffer.from(bruto, 'base64url').toString('utf8')); } catch { throw new Error('CURSOR_INVALIDO'); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!c || typeof c !== 'object' || c.f !== filtro || (c.n !== 0 && c.n !== 1) || typeof c.i !== 'string' || !uuid.test(c.i) || (c.d !== null && !dataDeCalendario(c.d)) || (c.n === 1) !== (c.d === null))
    throw new Error('CURSOR_INVALIDO');
  return c;
}

/** Condição do cursor: (data nula, data, id) depois do último item, na direção do filtro. */
function condicaoCursor(asc: boolean) {
  const cmp = asc ? '>' : '<';
  return `($4::int IS NULL OR (b.data_evento IS NULL)::int > $4::int OR ((b.data_evento IS NULL)::int = $4::int AND (
    COALESCE(b.data_evento, DATE '0001-01-01') ${cmp} COALESCE($5::date, DATE '0001-01-01')
    OR (COALESCE(b.data_evento, DATE '0001-01-01') = COALESCE($5::date, DATE '0001-01-01') AND b.id ${cmp} $6::uuid))))`;
}

const BASE_SQL = `WITH base AS (
  SELECT c.id, c.status, ref.id AS versao_id, ref.prioridade, ref.snapshot,
         CASE WHEN ref.snapshot->'evento'->>'data' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (ref.snapshot->'evento'->>'data')::date END AS data_evento,
         cf.versao_vigente_id, prep.estado AS estado_preparacao, ref_e.estado AS estado_referencia,
         COALESCE(ref.snapshot->'evento'->>'data' >= $3::text, false) AS futura
    FROM contratos c
    JOIN fechamentos fech ON fech.id = c.fechamento_id AND fech.empresa_id = $1::uuid
    JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
    LEFT JOIN contrato_fluxos cf ON cf.contrato_id = c.id
    LEFT JOIN LATERAL (
      SELECT v.id, v.snapshot, ${PRIORIDADE_REFERENCIA_SQL} AS prioridade
        FROM contrato_versoes v WHERE v.contrato_id = c.id
       ORDER BY prioridade, v.numero_versao DESC LIMIT 1) ref ON true
    LEFT JOIN contrato_edicoes ref_e ON ref_e.contrato_versao_id = ref.id
    LEFT JOIN contrato_edicoes prep ON prep.contrato_versao_id = cf.versao_em_preparacao_id
   WHERE ($2::text IS NULL OR lower(ref.snapshot->'contratante'->>'nomeCompleto') LIKE '%' || $2::text || '%' ESCAPE '\\'
                           OR lower(ref.snapshot->'aniversariante'->>'nome') LIKE '%' || $2::text || '%' ESCAPE '\\')
     AND ($7::date IS NULL OR ref.snapshot->'evento'->>'data' = $7::text)
)`;

type SnapshotLista = { contratante?: { nomeCompleto?: unknown }; aniversariante?: { nome?: unknown; idadeNoEvento?: unknown }; evento?: { pacote?: { nome?: unknown }; convidados?: unknown }; comercial?: { valorFinalContrato?: unknown } };
type LinhaBase = { id: string; status: string; versao_id: string | null; prioridade: number | null; snapshot: SnapshotLista | null; data_evento: string | null; versao_vigente_id: string | null; estado_preparacao: string | null; estado_referencia: string | null };
/** rec/est: somas em CENTAVOS dos movimentos confirmados; `invalido`: algum movimento confirmado que `reaisCentavos` recusaria. */
type LinhaFinanceira = { contrato_id: string; n: number; status: string; valor_total_contratado: string; rec: string | null; est: string | null; dev: string | null; aj: string | null; res: string | null; invalido: boolean };

export type FinanceiroLista =
  | { tipo: 'OK'; recebido: string; aCobrar: string; obrigacao: string; encerrada: boolean }
  | { tipo: 'CONFERIR' } | { tipo: 'SEM_ASSINATURA' };

/** Mesmas funções da leitura do contrato; qualquer recusa ⇒ CONFERIR (sem números). */
export function financeiroDaLinha(statusContrato: string, origem: OrigemReferencia, linhas: LinhaFinanceira[]): FinanceiroLista {
  if (origem !== 'VIGENTE_FLUXO' && origem !== 'VIGENTE_LEGADA') return { tipo: 'SEM_ASSINATURA' };
  // Zero ou 2+ pagamentos (OBRIGACAO_NAO_DISPONIVEL) e movimento inválido: conferência, sem números.
  if (linhas.length !== 1 || linhas[0].n !== 1 || linhas[0].invalido) return { tipo: 'CONFERIR' };
  const l = linhas[0];
  try {
    const p = posicaoEconomica(reaisCentavos(l.valor_total_contratado), BigInt(l.aj ?? '0'), BigInt(l.rec ?? '0'), BigInt(l.est ?? '0'), BigInt(l.dev ?? '0'), BigInt(l.res ?? '0'));
    const cobranca = situacaoCobranca(statusContrato, l.status, 0, p.saldo);
    return { tipo: 'OK', recebido: p.liquido.toString(), aCobrar: cobranca.saldoACobrar.toString(), obrigacao: p.obrigacao.toString(), encerrada: cobranca.encerrada };
  } catch { return { tipo: 'CONFERIR' }; }
}

export type ItemLista = {
  id: string; origem: 'CORE'; status: string; cancelado: boolean; alteracao: boolean; aguardandoCliente: boolean;
  contratante: string | null; aniversariante: string | null; idade: number | null; dataEvento: string | null; pacote: string | null; convidados: number | null;
  valor: number | null; referencia: { origem: OrigemReferencia; diagnostico: boolean }; financeiro: FinanceiroLista;
};

const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const inteiro = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export async function listarContratosPaginados(tx: DbExecutor, empresaId: string, entrada: { filtro: Filtro; busca: Busca; cursor: Cursor | null; hoje: string; limite?: number }) {
  const limite = Math.min(Math.max(entrada.limite ?? LIMITE_PAGINA, 1), LIMITE_PAGINA);
  const asc = ASCENDENTE[entrada.filtro];
  const ordem = asc ? '(b.data_evento IS NULL), b.data_evento ASC, b.id ASC' : '(b.data_evento IS NULL), b.data_evento DESC, b.id DESC';
  const params = [empresaId, entrada.busca.texto, entrada.hoje, entrada.cursor?.n ?? null, entrada.cursor?.d ?? null, entrada.cursor?.i ?? null, entrada.busca.data];
  // Contagens sobre o conjunto da busca, antes de qualquer cursor (os parâmetros do cursor vão nulos).
  const semCursor = [empresaId, entrada.busca.texto, entrada.hoje, null, null, null, entrada.busca.data];
  const contagens = (await tx.query<Record<Filtro, number>>(
    `${BASE_SQL} SELECT ${FILTROS.map(f => `count(*) FILTER (WHERE ${CONDICAO[f]})::int AS ${f}`).join(', ')} FROM base b
      WHERE $4::int IS NULL AND $5::date IS NULL AND $6::uuid IS NULL`, semCursor)).rows[0] ?? Object.fromEntries(FILTROS.map(f => [f, 0])) as Record<Filtro, number>;
  const linhas = (await tx.query<LinhaBase>(
    `${BASE_SQL} SELECT b.id, b.status, b.versao_id, b.prioridade, b.snapshot, b.data_evento::text AS data_evento, b.versao_vigente_id, b.estado_preparacao, b.estado_referencia
       FROM base b WHERE ${CONDICAO[entrada.filtro]} AND ${condicaoCursor(asc)}
      ORDER BY ${ordem} LIMIT ${limite + 1}`, params)).rows;
  const pagina = linhas.slice(0, limite);
  const fin = pagina.length ? (await tx.query<LinhaFinanceira>(FINANCEIRO_SQL, [pagina.map(l => l.id), empresaId])).rows : [];
  const itens: ItemLista[] = pagina.map((l) => {
    const s: SnapshotLista = l.snapshot ?? {}, origem = ORIGEM_POR_PRIORIDADE[l.prioridade ?? 5];
    const cancelado = l.status === 'CANCELADO' || (l.status !== 'ASSINADO' && l.estado_referencia === 'CANCELADA');
    return {
      id: l.id, origem: 'CORE', status: l.status, cancelado,
      alteracao: !cancelado && !!l.versao_vigente_id && ['EM_ELABORACAO', 'ASSINADA_KIDMAIS', 'AGUARDANDO_CLIENTE'].includes(l.estado_preparacao ?? ''),
      aguardandoCliente: !cancelado && (l.status === 'AGUARDANDO_ASSINATURA' || l.estado_preparacao === 'AGUARDANDO_CLIENTE'),
      contratante: texto(s.contratante?.nomeCompleto), aniversariante: texto(s.aniversariante?.nome), idade: inteiro(s.aniversariante?.idadeNoEvento),
      dataEvento: l.data_evento, pacote: texto(s.evento?.pacote?.nome), convidados: inteiro(s.evento?.convidados),
      valor: typeof s.comercial?.valorFinalContrato === 'number' ? s.comercial.valorFinalContrato : null,
      referencia: { origem, diagnostico: origem === 'SEM_VERSAO_VALIDA' },
      financeiro: financeiroDaLinha(l.status, origem, fin.filter(f => f.contrato_id === l.id)),
    };
  });
  const ultimo = pagina.at(-1);
  const proximoCursor = linhas.length > limite && ultimo ? codificarCursor({ f: entrada.filtro, n: ultimo.data_evento ? 0 : 1, d: ultimo.data_evento, i: ultimo.id }) : null;
  return { itens, proximoCursor, contagens };
}

/**
 * Movimento que `reaisCentavos` aceitaria: número (não NaN), não negativo, até 2 casas e até o limite monetário. Nulo é
 * inválido. Só ele é convertido para centavos; os demais marcam `invalido` (CONFERIR) sem chegar ao cast.
 */
const valido = (c: string) => `(${c} IS NOT NULL AND ${c} <> 'NaN'::numeric AND ${c} >= 0 AND ${c} * 100 = trunc(${c} * 100) AND ${c} * 100 <= 999999999999)`;

/** Uma linha por pagamento dos contratos da página; cada relação agregada por pagamento ANTES de juntar. */
export const FINANCEIRO_SQL = `WITH pg AS (
    SELECT p.id, pv.contrato_id, p.valor_total_contratado, p.status
      FROM pagamentos p
      JOIN contrato_versoes pv ON pv.id = p.contrato_versao_id
      JOIN contratos c ON c.id = pv.contrato_id
      JOIN fechamentos fech ON fech.id = c.fechamento_id AND fech.empresa_id = $2::uuid
     WHERE pv.contrato_id = ANY($1::uuid[])),
  qtd AS (SELECT contrato_id, count(*)::int AS n FROM pg GROUP BY contrato_id),
  -- Cada movimento confirmado é validado como em reaisCentavos (não negativo, até 2 casas, até o limite); a soma é em centavos.
  rec AS (SELECT r.pagamento_id, sum(CASE WHEN ${valido('r.valor_bruto')} THEN (r.valor_bruto * 100)::bigint END) FILTER (WHERE r.status = 'CONFIRMADO') AS v,
                 COALESCE(bool_or(NOT ${valido('r.valor_bruto')}) FILTER (WHERE r.status = 'CONFIRMADO'), false) AS invalido
            FROM pagamento_recebimentos r WHERE r.pagamento_id IN (SELECT id FROM pg) GROUP BY r.pagamento_id),
  est AS (SELECT r.pagamento_id, sum(CASE WHEN ${valido('e.valor')} THEN (e.valor * 100)::bigint END) FILTER (WHERE e.status = 'CONFIRMADO') AS v,
                 COALESCE(bool_or(NOT ${valido('e.valor')}) FILTER (WHERE e.status = 'CONFIRMADO'), false) AS invalido
            FROM pagamento_estornos e JOIN pagamento_recebimentos r ON r.id = e.recebimento_id
           WHERE r.pagamento_id IN (SELECT id FROM pg) GROUP BY r.pagamento_id),
  dev AS (SELECT d.pagamento_id, sum(d.valor_centavos) FILTER (WHERE d.estado = 'CONCLUIDA') AS v
            FROM pagamento_devolucoes d WHERE d.pagamento_id IN (SELECT id FROM pg) GROUP BY d.pagamento_id),
  aj AS (SELECT a.pagamento_id, sum(a.delta_centavos) AS v
           FROM pagamento_ajustes_contratuais a JOIN pagamento_eventos ev ON ev.id = a.evento_id
          WHERE a.pagamento_id IN (SELECT id FROM pg) GROUP BY a.pagamento_id),
  res AS (SELECT cr.pagamento_id, sum(cr.valor_centavos) FILTER (WHERE cr.estado = 'ATIVA') AS v
            FROM pagamento_credito_reservas cr WHERE cr.pagamento_id IN (SELECT id FROM pg) GROUP BY cr.pagamento_id)
  SELECT pg.contrato_id, q.n, pg.status, pg.valor_total_contratado::text,
         rec.v::text AS rec, est.v::text AS est, dev.v::text AS dev, aj.v::text AS aj, res.v::text AS res,
         COALESCE(rec.invalido, false) OR COALESCE(est.invalido, false) AS invalido
    FROM pg JOIN qtd q ON q.contrato_id = pg.contrato_id
    LEFT JOIN rec ON rec.pagamento_id = pg.id LEFT JOIN est ON est.pagamento_id = pg.id
    LEFT JOIN dev ON dev.pagamento_id = pg.id LEFT JOIN aj ON aj.pagamento_id = pg.id LEFT JOIN res ON res.pagamento_id = pg.id`;
