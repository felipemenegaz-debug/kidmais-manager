import { readFileSync } from "node:fs";
import type pg from "pg";

/**
 * Apoio das suítes PostgreSQL de ordem de aplicação e rollback do atendimento (ordem-staging-real, estado misto): SQL das
 * migrations 060, 065, 080–082 e 078/079 do staging, impressões digitais do schema e dos dados, e o rollback na ordem.
 * Só usado por *.postgres.test.ts. Extraído de ordem-staging-real.postgres.test.ts em 12/10/2026 sem mudar o conteúdo.
 */
const ler = (f: string) => readFileSync(f, "utf8");
export const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));

export const A060 = { up: ler("database/migrations/20261001_060_whatsapp_atendimento.sql"), post: ler("database/checks/20261001_060_postcheck.sql"),
  down: ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql"), preDown: ler("database/checks/20261001_060_rollback_precheck.sql"), posDown: ler("database/checks/20261001_060_rollback_postcheck.sql") };
export const A065 = { up: ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql"), post: ler("database/checks/20261004_065_postcheck.sql"),
  down: ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql"), posDown: ler("database/checks/20261004_065_rollback_postcheck.sql") };
export const A080 = { up: ler("database/migrations/20261011_080_whatsapp_mensagens_prontas.sql"), post: ler("database/checks/20261011_080_postcheck.sql"),
  down: ler("database/rollback/20261011_080_whatsapp_mensagens_prontas_down.sql"), posDown: ler("database/checks/20261011_080_rollback_postcheck.sql") };
export const A081 = { up: ler("database/migrations/20261011_081_whatsapp_prontas_midia.sql"), post: ler("database/checks/20261011_081_postcheck.sql"),
  down: ler("database/rollback/20261011_081_whatsapp_prontas_midia_down.sql"), posDown: ler("database/checks/20261011_081_rollback_postcheck.sql") };
export const A082 = { up: ler("database/migrations/20261011_082_wall_e_atendimento.sql"), post: ler("database/checks/20261011_082_postcheck.sql"),
  down: ler("database/rollback/20261011_082_wall_e_atendimento_down.sql") };
const st = (data: string, n: string, nome: string) => ({ n, pre: ler(`database/checks/${data}_${n}_precheck.sql`), up: ler(`database/migrations/${data}_${n}_${nome}.sql`),
  post: ler(`database/checks/${data}_${n}_postcheck.sql`), down: ler(`database/rollback/${data}_${n}_${nome}_down.sql`) });
export const S078 = st("20261010", "078", "catalogo_buffet_por_empresa"), S079 = st("20261011", "079", "convite_recuperacao_manual");

/** Objetos do atendimento: tabelas whatsapp_atendimento_* e funções kidmais(_)060/065/080/081/082. */
export const TABELA_ATENDIMENTO = "^whatsapp_atendimento_";
export const FUNCAO_ATENDIMENTO = "^kidmais_?(060|065|08[012])";

export type Q = (sql: string, v?: unknown[]) => Promise<pg.QueryResult>;

/**
 * Impressão digital do schema public pelo catálogo (definições, nunca OID nem posição de coluna). `fora`: só o que não é
 * do atendimento (tabelas e funções acima; restrições, índices e gatilhos dessas tabelas também ficam de fora).
 */
export async function schema(q: Q, fora = false): Promise<string[]> {
  const r = await q(`
    WITH rel AS (
      SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') AND ($1::boolean IS FALSE OR c.relname !~ $2)
    ), fn AS (
      SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND ($1::boolean IS FALSE OR p.proname !~ $3)
    )
    SELECT x FROM (
      SELECT 'rel:' || relname || ':' || relkind::text AS x FROM rel
      UNION ALL SELECT 'col:' || r.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
             || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attidentity::text || ':' || a.attgenerated::text
        FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
      UNION ALL SELECT 'con:' || r.relname || '.' || co.conname || ':' || pg_get_constraintdef(co.oid) FROM pg_constraint co JOIN rel r ON r.oid = co.conrelid
      UNION ALL SELECT 'idx:' || r.relname || '.' || i.relname || ':' || pg_get_indexdef(ix.indexrelid)
        FROM pg_index ix JOIN rel r ON r.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
      UNION ALL SELECT 'trg:' || r.relname || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN rel r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal
      UNION ALL SELECT 'fn:' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || '):' || md5(pg_get_functiondef(f.oid)) FROM fn f
      UNION ALL SELECT 'view:' || r.relname || ':' || md5(pg_get_viewdef(r.oid)) FROM rel r WHERE r.relkind IN ('v','m')
      UNION ALL SELECT 'pol:' || p.tablename || '.' || p.policyname || ':' || p.cmd || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '')
        FROM pg_policies p WHERE p.schemaname = 'public' AND ($1::boolean IS FALSE OR p.tablename !~ $2)
      UNION ALL SELECT 'enum:' || t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname = 'public' GROUP BY t.typname
    ) s ORDER BY x`, [fora, TABELA_ATENDIMENTO, FUNCAO_ATENDIMENTO]);
  return r.rows.map((x) => x.x as string);
}

/** Impressão digital dos DADOS de todas as tabelas fora do atendimento (mesmo banco: a ordem das colunas não muda). */
export async function dadosFora(q: Q): Promise<Record<string, string>> {
  const tabelas = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename !~ $1 ORDER BY 1`, [TABELA_ATENDIMENTO])).rows.map((x) => x.tablename as string);
  const r: Record<string, string> = {};
  for (const tb of tabelas) r[tb] = (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM "${tb}" x`)).rows.map((x) => `${x.n}:${x.h}`)[0];
  return r;
}

export const tabelasAtendimento = async (q: Q) => (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ $1 ORDER BY 1`, [TABELA_ATENDIMENTO])).rows.map((x) => x.tablename as string);

/** Retrato do atendimento (dados + objetos), para provar que os downs do staging não o tocam. */
export async function atendimento(q: Q) {
  const tabelas = await tabelasAtendimento(q);
  const dados: Record<string, string> = {};
  for (const tb of tabelas) dados[tb] = (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM "${tb}" x`)).rows.map((x) => `${x.n}:${x.h}`)[0];
  const objetos = (await schema(q)).filter((x) => /^(rel|col|con|idx|trg|pol):whatsapp_atendimento_/.test(x) || /^fn:kidmais_?(060|065|08[012])/.test(x));
  return { tabelas, dados, objetos };
}

export const ROLLBACK = [
  { n: "082", run: async (q: Q) => { await q(comDecisoes(A082.down, "kidmais.rollback_082_descartar")); } },
  { n: "081", run: async (q: Q) => { await q(comDecisoes(A081.down, "kidmais.rollback_081_descartar_midias", "kidmais.rollback_081_descartar_prontas_midia")); await q(A081.posDown); } },
  { n: "080", run: async (q: Q) => { await q(comDecisoes(A080.down, "kidmais.rollback_080_descartar_prontas")); await q(A080.posDown); } },
  { n: "065", run: async (q: Q) => { await q(comDecisoes(A065.down, "kidmais.rollback_065_descartar_nomes")); await q(A065.posDown); } },
  { n: "060", run: async (q: Q) => { await q(A060.preDown); await q(comDecisoes(A060.down, "kidmais.rollback_060_descartar_atendimento")); await q(A060.posDown); } },
];
