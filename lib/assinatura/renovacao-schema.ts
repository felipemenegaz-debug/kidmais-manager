import type { DbExecutor } from '../db/contracts';
import { RETRATO_075, RETRATO_109 } from './renovacao-schema-retratos.ts';

/**
 * Contrato versionado de integridade de `assinatura_renovacoes` (plano docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md rev. 5,
 * §2.6; R2-F2, R3-F1, R4-F1). FONTE ÚNICA da capacidade em tempo de execução, do preflight e do postcheck da 109 (gerado daqui:
 * scripts/gerar-postcheck-109.mjs; um teste confere que o arquivo não diverge).
 *
 * Retrato COMPLETO da tabela, comparado por igualdade de conjunto (nada pode faltar, sobrar ou divergir), em cinco famílias:
 * colunas (tipo, not null, default), constraints (definição, validação, diferimento), índices (definição, único, válido,
 * pronto), gatilhos (definição completa por pg_get_triggerdef, habilitação, WHEN ausente, UPDATE OF ausente, função, constraint
 * por NOME) e funções ligadas (sha256 do corpo com CRLF→LF, SECURITY DEFINER, configuração). Nenhum OID entra no retrato.
 * Os valores aprovados (renovacao-schema-retratos.ts) foram capturados de um PG descartável com as migrations do repositório;
 * a conferência em real é gate futuro e nunca aprova desvio.
 */
export const SQL_RETRATO = `WITH t AS (SELECT to_regclass('public.assinatura_renovacoes') AS rel),
colunas AS (
  SELECT jsonb_agg(jsonb_build_object('nome', a.attname, 'tipo', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attname) AS v
  FROM pg_attribute a CROSS JOIN t LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = t.rel AND a.attnum > 0 AND NOT a.attisdropped),
constraints AS (
  SELECT jsonb_agg(jsonb_build_object('nome', c.conname, 'tipo', c.contype, 'def', pg_get_constraintdef(c.oid), 'validada', c.convalidated,
      'deferivel', c.condeferrable, 'diferida', c.condeferred) ORDER BY c.conname) AS v
  FROM pg_constraint c CROSS JOIN t WHERE c.conrelid = t.rel AND c.contype <> 't'),
indices AS (
  SELECT jsonb_agg(jsonb_build_object('nome', ci.relname, 'def', pg_get_indexdef(i.indexrelid), 'unico', i.indisunique, 'valido', i.indisvalid,
      'pronto', i.indisready) ORDER BY ci.relname) AS v
  FROM pg_index i CROSS JOIN t JOIN pg_class ci ON ci.oid = i.indexrelid WHERE i.indrelid = t.rel),
gatilhos AS (
  SELECT jsonb_agg(jsonb_build_object('nome', g.tgname, 'def', pg_get_triggerdef(g.oid), 'habilitado', g.tgenabled::text,
      'semWhen', g.tgqual IS NULL, 'semUpdateOf', g.tgattr::text = '', 'funcao', fn.nspname || '.' || f.proname,
      'constraint', cc.conname, 'deferivel', g.tgdeferrable, 'diferido', g.tginitdeferred) ORDER BY g.tgname) AS v
  FROM pg_trigger g CROSS JOIN t JOIN pg_proc f ON f.oid = g.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace
  LEFT JOIN pg_constraint cc ON cc.oid = g.tgconstraint
  WHERE g.tgrelid = t.rel AND NOT g.tgisinternal),
funcoes AS (
  SELECT jsonb_agg(jsonb_build_object('nome', x.nome, 'corpo', x.corpo, 'secdef', x.secdef, 'config', x.config) ORDER BY x.nome) AS v
  FROM (SELECT DISTINCT fn.nspname || '.' || f.proname AS nome,
      encode(sha256(convert_to(replace(f.prosrc, E'\\r\\n', E'\\n'), 'UTF8')), 'hex') AS corpo, f.prosecdef AS secdef,
      coalesce(array_to_string(f.proconfig, ';'), '') AS config
    FROM pg_trigger g CROSS JOIN t JOIN pg_proc f ON f.oid = g.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace
    WHERE g.tgrelid = t.rel AND NOT g.tgisinternal) x)
SELECT CASE WHEN to_regclass('public.assinatura_renovacoes') IS NULL THEN NULL ELSE jsonb_build_object(
  'colunas', coalesce((SELECT v FROM colunas), '[]'), 'constraints', coalesce((SELECT v FROM constraints), '[]'),
  'indices', coalesce((SELECT v FROM indices), '[]'), 'gatilhos', coalesce((SELECT v FROM gatilhos), '[]'),
  'funcoes', coalesce((SELECT v FROM funcoes), '[]')) END AS retrato`;

export type ObjetoRetrato = { nome: string } & Record<string, unknown>;
export type Retrato = Record<'colunas' | 'constraints' | 'indices' | 'gatilhos' | 'funcoes', ObjetoRetrato[]>;
export type Capacidade = { capacidade: '075' | '109' } | { capacidade: 'INCOMPATIVEL'; divergencias: string[] };
export const FAMILIAS = ['colunas', 'constraints', 'indices', 'gatilhos', 'funcoes'] as const;

const canonico = (o: unknown): string => JSON.stringify(o, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v);

/** Diferenças por família e nome (`familia:nome:FALTA|SOBRA|DIVERGE`). Só nomes: definições nunca saem no relatório. */
export function compararRetrato(lido: Retrato, esperado: Retrato): string[] {
    const r: string[] = [];
    for (const f of FAMILIAS) {
        const a = new Map((lido[f] ?? []).map((x) => [x.nome, canonico(x)]));
        const b = new Map(esperado[f].map((x) => [x.nome, canonico(x)]));
        for (const [nome, v] of b) if (!a.has(nome)) r.push(`${f}:${nome}:FALTA`); else if (a.get(nome) !== v) r.push(`${f}:${nome}:DIVERGE`);
        for (const nome of a.keys()) if (!b.has(nome)) r.push(`${f}:${nome}:SOBRA`);
    }
    return r.sort();
}

/** Igual à 109 → '109'; igual à 075 → '075'; qualquer outro → INCOMPATIVEL com as divergências contra a versão mais próxima. */
export function classificarRetrato(lido: Retrato | null): Capacidade {
    if (!lido) return { capacidade: 'INCOMPATIVEL', divergencias: ['tabela:assinatura_renovacoes:FALTA'] };
    const d109 = compararRetrato(lido, RETRATO_109);
    if (!d109.length) return { capacidade: '109' };
    const d075 = compararRetrato(lido, RETRATO_075);
    if (!d075.length) return { capacidade: '075' };
    return { capacidade: 'INCOMPATIVEL', divergencias: d075.length <= d109.length ? d075 : d109 };
}

export async function lerRetrato(tx: DbExecutor): Promise<Retrato | null> {
    // O deparse (pg_get_expr/constraintdef/indexdef/triggerdef) qualifica nomes conforme o search_path da sessão: o retrato é
    // SEMPRE lido com o mesmo caminho fixo (só pg_catalog), e o caminho anterior da sessão é restaurado.
    const anterior = (await tx.query<{ v: string }>("SELECT current_setting('search_path') AS v")).rows[0]?.v ?? '';
    await tx.query(`SELECT set_config('search_path', '${CAMINHO_RETRATO}', false)`);
    try { return (await tx.query<{ retrato: Retrato | null }>(SQL_RETRATO)).rows[0]?.retrato ?? null; }
    finally { await tx.query("SELECT set_config('search_path', $1, false)", [anterior]); }
}
export const CAMINHO_RETRATO = 'pg_catalog, pg_temp';

/** Lida UMA vez por execução, antes da primeira empresa (pressupõe o cutover controlado: sem DDL concorrente). */
export async function capacidadeRenovacao(tx: DbExecutor): Promise<Capacidade> {
    return classificarRetrato(await lerRetrato(tx));
}

/** Postcheck da 109 gerado do contrato (scripts/gerar-postcheck-109.mjs). */
export function postcheck109() {
    const esperado = canonico(RETRATO_109).replace(/'/g, "''");
    return `-- GERADO por scripts/gerar-postcheck-109.mjs a partir de lib/assinatura/renovacao-schema.ts. Não editar à mão.
-- Somente leitura: o retrato completo de assinatura_renovacoes tem de ser IGUAL ao aprovado para a 109.
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE lido jsonb;
BEGIN
  PERFORM set_config('search_path', '${CAMINHO_RETRATO}', true);
  ${SQL_RETRATO.replace(/\n/g, '\n  ')} INTO lido;
  IF lido IS DISTINCT FROM '${esperado}'::jsonb THEN RAISE EXCEPTION '109 postcheck: retrato de assinatura_renovacoes diverge do aprovado'; END IF;
END $$;
ROLLBACK;
`;
}
