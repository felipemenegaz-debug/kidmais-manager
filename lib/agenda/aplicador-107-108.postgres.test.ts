import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 29/10/2026 — APLICADOR REAL da 107/108 (scripts/migration-107-108-comum.cjs, o mesmo núcleo do staging) no PostgreSQL
 * descartável (plano "E4 aplicadores 107 108 staging 20261029", rev. 2 + rev. 2.1; D-E1..D-E4). Modelos 106 (as duas
 * ausentes), 107 (só a 108) e 108 (já aplicadas): o estado do modelo é conferido como está e depois normalizado para a
 * base canônica (downs), onde os cenários rodam; no fim o modelo volta ao estado inicial.
 * Os esperados do retrato (database/checks/20261029_108_retratos_esperados.json) ainda estão A_MEDIR_NO_CLUSTER: a suíte
 * MEDE no cluster (F0 canônico, F0 com a deriva exata do staging, F1 e F2, aplicando as migrations pelos arquivos e
 * voltando pelos downs) e INJETA em KIDMAIS_RETRATOS_108_TESTE num aplicador de teste (aceitaRetratosTeste); o aplicador
 * de staging recusa essa variável (provado aqui). Os hashes medidos vão para o diagnóstico (t.diagnostic) e, com
 * KIDMAIS_APLICADOR_107_108_EVIDENCIAS=<pasta>, para um arquivo — candidatos ao JSON versionado, por revisão própria.
 * Cenários (cliente real; a única substituição é a identidade respondida como a do banco de staging):
 *   1. canônico: CONFERIR PRONTA (F0 canonico) sem mudar nada; APLICAR as duas (CONFIRMADO/CONFIRMADO); CONFERIR JA;
 *      reexecução JA sem DDL;
 *   2. deriva exata do staging (25/10): CONFERIR PRONTA com F0 deriva_conhecida; APLICAR leva ao canônico (F2 igual);
 *   3. 107 aplicada, 108 falhando DE VERDADE dentro da transação 2 (o gancho cria agenda_saloes.combinado antes do corpo:
 *      42701) → NAO_COMMITADA, ROLLBACK real; marcador da etapa 108 trava; renomeados → retomada só da 108;
 *   4. 108 PARCIAL (coluna membros solta) → RECUSARIA/FALHA sem escrita;
 *   5. 098 histórica (ANTIGA: corpo de conflito da 098 e sem marcador sobre a 108) → COM_098_HISTORICA;
 *   6. retrato divergente (coluna a mais numa tabela do escopo) → RETRATO_F0_DIVERGENTE com diff por seção (só
 *      'colunas' muda);
 *   7. papel mínimo não superusuário (SET ROLE; donos transferidos; esperados medidos nessa configuração): cada revogação
 *      → recusa nomeada antes de dados e de escrita; com o mínimo, aplica as duas.
 * Fica no cliente simulado (scripts/migration-107-108.test.cjs): COMMIT indeterminado, marcador sem permissão/ilegível.
 */
let a: Client;
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[]; fase?: string;
  retrato?: { fase: string; hash: string | null; variante?: string; secoes: Record<string, { n: number; sha256: string }> | null };
  verificacoes?: Record<string, unknown>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string };
type Aplicador = { conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado>; principal(argv: string[], env: unknown, deps?: unknown): Promise<unknown> };
type Comum = { criarAplicador(amb: unknown): Aplicador; ENV_RETRATOS_TESTE: string; FLAG_CONFERIR: string; MARCADOR: string; SQL_LOCK: Record<string, string>;
  marcadorEtapa(id: string): string; semMoldura(sql: string, nome: string): string };
type Retrato = { sqlRetrato108(o: { raiz: string }): string; hashTrecho(t: string): string; trechoRetrato108(): string };
const comum = exigir(join(raiz, "scripts/migration-107-108-comum.cjs")) as Comum;
const stg = exigir(join(raiz, "scripts/migration-107-108-staging.cjs")) as Aplicador & { SQL_IDENTIDADE: string; ALVO: unknown; identidade(l: unknown, env: unknown): unknown };
const ret = exigir(join(raiz, "scripts/migration-108-retrato.cjs")) as Retrato;
// Configuração FICTÍCIA: só satisfaz a trava; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_107_108", OUTRO = "kidmais_teste_outro_107_108";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8").replace(/\r\n/g, "\n");
const M107 = "database/migrations/20261028_107_reparo_deriva_agenda.sql";
const M108 = "database/migrations/20261028_108_saloes_combinados.sql";
const M098 = "database/migrations/20261023_098_saloes_combinados.sql";
const DOWN107 = "database/rollback/20261028_107_reparo_deriva_agenda_down.sql";
const DOWN108 = "database/rollback/20261028_108_saloes_combinados_down.sql";
const CORPO108 = comum.semMoldura(sql(M108), "migration 108");
const BACKUP = "PITR 2026-10-29T21:00Z teste", DRENAGEM = "web escala zero teste cron suspenso";
const SUBSTITUIDAS = ["kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)",
  "kidmais019_validar_contrato()", "kidmais_validar_agenda_revisao()"];
const CONFLITO_RE = /CREATE OR REPLACE FUNCTION public\.kidmais094_conflito_ocupacao\([\s\S]*?AS \$\$[\s\S]*?\$\$;/;

/** A deriva do staging (diagnóstico de 25/10/2026), exatamente (mesma de reparo-agenda-107.postgres.test.ts). */
const DERIVA = `BEGIN;
ALTER INDEX public.bloqueios_agenda_data_ativos_idx RENAME TO ix_bloqueios_agenda_data_ativos;
ALTER INDEX public.bloqueios_agenda_intervalo_ativos_idx RENAME TO ix_bloqueios_agenda_intervalo_ativos;
ALTER INDEX public.configuracao_agenda_ativos_idx RENAME TO ix_configuracao_agenda_ativos;
ALTER TABLE public.bloqueios_agenda RENAME CONSTRAINT bloqueios_agenda_periodo_check TO ck_bloqueios_agenda_periodo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_intervalo_check TO ck_configuracao_agenda_intervalo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_tolerancia_check TO ck_configuracao_agenda_tolerancia;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_passo_check TO ck_configuracao_agenda_passo;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_passo_compativel_check TO ck_configuracao_agenda_passo_compativel;
ALTER TABLE public.configuracao_agenda RENAME CONSTRAINT configuracao_agenda_ordem_check TO ck_configuracao_agenda_ordem;
ALTER TABLE public.bloqueios_agenda DROP CONSTRAINT bloqueios_agenda_motivo_nao_vazio;
ALTER TABLE public.configuracao_agenda DROP CONSTRAINT configuracao_agenda_codigo_nao_vazio, DROP CONSTRAINT configuracao_agenda_nome_nao_vazio;
DROP TRIGGER bloqueios_agenda_atualizado_em_trg ON public.bloqueios_agenda;
DROP TRIGGER configuracao_agenda_atualizado_em_trg ON public.configuracao_agenda;
COMMIT;`;

/** Consultas e erros de cada cliente do aplicador. */
const registro: { consultas: string[]; erros: { consulta: string; code?: string }[] } = { consultas: [], erros: [] };
type Ganchos = { papel?: string; antesDe?: (q: string, c: Client) => Promise<void> };
function clienteDescartavel(cfg: Ganchos = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      registro.consultas = []; registro.erros = [];
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string) {
      if (q === stg.SQL_IDENTIDADE) return { rows: [IDENTIDADE] };
      registro.consultas.push(q);
      if (cfg.antesDe) await cfg.antesDe(q, this.c!);
      try { return await this.c!.query(q); }
      catch (e) { registro.erros.push({ consulta: q.slice(0, 120), code: (e as { code?: string }).code }); throw e; }
    }
    async end() { if (this.c) await this.c.end(); }
  };
}
const escreveu = () => registro.consultas.some((q) => q.startsWith("LOCK TABLE") || q === CORPO108 || q.includes("CREATE TABLE public.kidmais107_reparos"));

/** Aplicador de TESTE: o núcleo do staging, aceitando os esperados medidos aqui (o de staging recusa a variável). */
const aplicador = comum.criarAplicador({ nome: "teste-postgres", ALVO: stg.ALVO, DIR: "/nao-usado", SQL_IDENTIDADE: stg.SQL_IDENTIDADE,
  alvo: () => ({}), identidade: (l: unknown, env: unknown) => stg.identidade(l, env), exigirDisco: () => undefined, aceitaRetratosTeste: true });

test.before(async () => { a = await conectarDescartavel(); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("aplicador 107/108 real: canônico, deriva do staging, falha da 108 e retomada, parcial, 098 histórica, retrato divergente, papel mínimo", { timeout: 1_800_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-107-108-")); dirs.push(d); return d; };
  const estado = async () => (await a.query<{ m107: boolean; m108: boolean }>(`SELECT to_regclass('public.kidmais107_reparos') IS NOT NULL AS m107,
    to_regprocedure('public.kidmais108_instalada()') IS NOT NULL AS m108`)).rows[0];
  const normalizar = async () => { const e = await estado(); if (e.m108) await a.query(sql(DOWN108)); if (e.m107) await a.query(sql(DOWN107)); };
  const restaurar = async (e: { m107: boolean; m108: boolean }) => { if (e.m107) await a.query(sql(M107)); if (e.m108) await a.query(sql(M108)); };
  /** Hash do retrato pela MESMA consulta do aplicador (READ ONLY, search_path = pg_catalog). */
  const medir = async () => {
    await a.query("BEGIN TRANSACTION READ ONLY");
    try { await a.query("SET LOCAL search_path = pg_catalog"); return (await a.query<{ hash_108: string }>(ret.sqlRetrato108({ raiz }))).rows[0].hash_108; }
    finally { await a.query("ROLLBACK"); }
  };
  const comoPapel = async (papel: string | undefined, arquivo: string) => {
    if (papel) await a.query(`SET ROLE ${papel}`);
    try { await a.query(sql(arquivo)); } finally { if (papel) await a.query("RESET ROLE"); }
  };
  /** Mede F0 (estado atual), F1 (107 aplicada como `papel`) e F2 (108 também) e volta pelos downs. */
  const medirFases = async (papel?: string) => {
    const F0 = await medir();
    await comoPapel(papel, M107); const F1 = await medir();
    await comoPapel(papel, M108); const F2 = await medir();
    await a.query(sql(DOWN108)); await a.query(sql(DOWN107));
    assert.equal(await medir(), F0, "downs voltam ao F0 medido");
    return { F0, F1, F2 };
  };
  const esperadosDe = (F0: string, F0d: string, F1: string, F2: string) => ({ descricao: "medido pela suíte aplicador-107-108", versao_pg_maior: 18,
    trecho_sha256: ret.hashTrecho(ret.trechoRetrato108()), F0: { canonico: F0, deriva_conhecida: F0d }, F1: { canonico: F1 }, F2: { canonico: F2 } });
  let env: Record<string, string> = {};
  const conferir = (papel?: string) => aplicador.conferir({ env, raiz, Client: clienteDescartavel({ papel }) });
  const executar = (dir = novoDir(), g: Ganchos = {}) => aplicador.executar({ env, backup: BACKUP, drenagem: DRENAGEM, dir, raiz, disco: () => undefined, Client: clienteDescartavel(g) });
  /** Schema public, ACL efetiva e dados das tabelas do escopo (nada pode mudar numa recusa nem no CONFERIR). Texto por item,
   *  uma linha cada, para o assert mostrar o objeto divergente. */
  const impressao = async () => (await a.query<{ h: string }>(`SELECT concat_ws(E'\n§\n',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), E'\n' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, at.attname, format_type(at.atttypid, at.atttypmod)), E'\n' ORDER BY cl.relname, at.attname)
         FROM pg_attribute at JOIN pg_class cl ON cl.oid = at.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND at.attnum > 0 AND NOT at.attisdropped),
      (SELECT string_agg(x, E'\n' ORDER BY x COLLATE "C") FROM (SELECT concat_ws(':', k.conrelid::regclass::text, conname, pg_get_constraintdef(k.oid)) x
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public') kk),
      (SELECT string_agg(x, E'\n' ORDER BY x COLLATE "C") FROM (SELECT concat_ws(':', tg.tgrelid::regclass::text, tgname, pg_get_triggerdef(tg.oid), tgenabled) x FROM pg_trigger tg WHERE NOT tgisinternal) tt),
      (SELECT string_agg(concat_ws(':', p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner)), E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C")
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      -- ACL EFETIVA (o padrão explicitado por acldefault): GRANT de volta a PUBLIC depois de um REVOKE é igual ao padrão.
      (SELECT string_agg(x, E'\n' ORDER BY x) FROM (
         SELECT concat_ws(':', 'f', p.proname, coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type) x
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e WHERE n.nspname = 'public'
         UNION ALL SELECT concat_ws(':', 'r', cl.relname, coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type)
           FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace, aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) e WHERE n.nspname = 'public'
         UNION ALL SELECT concat_ws(':', 'd', coalesce(pg_get_userbyid(nullif(e.grantee, 0)), 'PUBLIC'), e.privilege_type)
           FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) e WHERE d.datname = current_database()) acl),
      (SELECT md5(string_agg(md5(s::text), ',' ORDER BY s.id)) FROM agenda_saloes s),
      (SELECT md5(string_agg(md5(b::text), ',' ORDER BY b.id)) FROM bloqueios_agenda b),
      (SELECT md5(string_agg(md5(c::text), ',' ORDER BY c.id)) FROM configuracao_agenda c)) AS h`)).rows[0].h;
  /** Impressões iguais; na divergência, os itens a mais e os que faltam (o assert do node trunca o texto). */
  const mesmaImpressao = (atual: string, esperada: string, msg = "impressão igual") => {
    if (atual === esperada) return;
    const A = new Set(atual.split("\n")), E = new Set(esperada.split("\n"));
    assert.fail(`${msg}: a mais ${JSON.stringify([...A].filter((x) => !E.has(x)).slice(0, 20))}; faltando ${JSON.stringify([...E].filter((x) => !A.has(x)).slice(0, 20))}`);
  };
  /** Recusa: CONFERIR 3 (RECUSARIA) e APLICAR FALHA sem nenhuma escrita; impressão igual. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), { papel });
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.ok(!escreveu(), "nenhum LOCK/corpo enviado: " + motivo.source);
    mesmaImpressao(await impressao(), antes, "nada mudou: " + motivo.source);
    return r;
  };

  const inicial = await estado();
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const donos = (await a.query<{ bloqueios: string; config: string; saloes: string; contratos: string; f0: string; f1: string; f2: string; banco: string }>(`SELECT
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.bloqueios_agenda'::regclass)) AS bloqueios,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.configuracao_agenda'::regclass)) AS config,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.agenda_saloes'::regclass)) AS saloes,
    pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.contratos'::regclass)) AS contratos,
    ${SUBSTITUIDAS.map((f, i) => `pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.${f}'::regprocedure)) AS f${i}`).join(",\n    ")},
    current_database() AS banco`)).rows[0];
  try {
    // Medição no cluster: base canônica (F0/F1/F2) e a deriva exata do staging (F0 deriva; a 107 sobre ela dá o MESMO F1).
    await normalizar();
    const canonica = await medirFases();
    await a.query(DERIVA);
    const F0d = await medir();
    assert.notEqual(F0d, canonica.F0, "a deriva muda o retrato F0");
    await a.query(sql(M107));
    assert.equal(await medir(), canonica.F1, "107 sobre a deriva = o mesmo F1 da base canônica");
    await a.query("DROP TABLE public.kidmais107_reparos");
    assert.equal(await medir(), canonica.F0, "deriva reparada sem o registro = base canônica");
    const esperados = esperadosDe(canonica.F0, F0d, canonica.F1, canonica.F2);
    t.diagnostic("retratos medidos (candidatos ao JSON versionado): " + JSON.stringify(esperados));
    if (process.env.KIDMAIS_APLICADOR_107_108_EVIDENCIAS) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(process.env.KIDMAIS_APLICADOR_107_108_EVIDENCIAS, { recursive: true });
      writeFileSync(join(process.env.KIDMAIS_APLICADOR_107_108_EVIDENCIAS, "retratos-medidos.json"), JSON.stringify(esperados, null, 2) + "\n");
    }
    env = { ...ENV_STG, [comum.ENV_RETRATOS_TESTE]: JSON.stringify(esperados) };
    await assert.rejects(stg.principal([comum.FLAG_CONFERIR], env, { Client: clienteDescartavel() }), /RETRATOS_DE_TESTE_RECUSADOS/, "staging recusa o override");

    // Estado do modelo como veio: 106 → PRONTA F0; 107 → PRONTA F1; 108 → JA.
    await restaurar(inicial);
    const c0 = await conferir();
    assert.equal(c0.resultado, inicial.m108 ? "JA_APLICADA_INTEGRIDADE_PASS" : "PRONTA_PARA_APLICAR", JSON.stringify(c0));
    assert.equal(c0.fase, inicial.m108 ? "F2" : inicial.m107 ? "F1" : "F0");
    if (inicial.m107 && !inicial.m108) {
      const r = await executar();
      assert.equal(r.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(r)); assert.deepEqual(r.etapas, ["transacao 108"]); assert.deepEqual(r.commits, { 108: "CONFIRMADO" });
    }
    await normalizar();

    // 1. Canônico.
    const antes = await impressao();
    const c1 = await conferir();
    assert.equal(c1.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(c1)); assert.equal(c1.retrato!.variante, "canonico");
    mesmaImpressao(await impressao(), antes, "CONFERIR não muda nada (nenhum objeto novo no catálogo)");
    const d1 = novoDir();
    const r1 = await executar(d1);
    assert.equal(r1.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(r1));
    assert.deepEqual(r1.commits, { 107: "CONFIRMADO", 108: "CONFIRMADO" });
    assert.equal(await medir(), canonica.F2);
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
    // Registro da 107 sem um dos CHECKs: a integridade da 107 recusa em F2; re-adicionado (mesmo nome automático), volta a passar.
    await a.query("ALTER TABLE public.kidmais107_reparos DROP CONSTRAINT kidmais107_reparos_check");
    try {
      const semCheck = await conferir();
      assert.equal(semCheck.resultado, "RECUSARIA", JSON.stringify(semCheck)); assert.match(semCheck.motivo!, /PK ou CHECKs diferentes da 107/);
    } finally { await a.query("ALTER TABLE public.kidmais107_reparos ADD CHECK ((acao LIKE 'RENOMEAR_%') = (nome_anterior IS NOT NULL))"); }
    const aplicadas = await impressao();
    const j = await executar();
    assert.equal(j.resultado, "JA_APLICADA_INTEGRIDADE_PASS", JSON.stringify(j)); assert.deepEqual(j.commits, {});
    assert.ok(!escreveu(), "reexecução sem DDL"); mesmaImpressao(await impressao(), aplicadas);
    await normalizar();
    mesmaImpressao(await impressao(), antes, "downs voltam à impressão inicial");

    // 2. Deriva exata do staging.
    await a.query(DERIVA);
    const c2 = await conferir();
    assert.equal(c2.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(c2)); assert.equal(c2.retrato!.variante, "deriva_conhecida");
    const r2 = await executar();
    assert.equal(r2.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(r2));
    assert.equal(await medir(), canonica.F2, "a deriva reparada chega ao mesmo F2");
    await a.query(sql(DOWN108)); await a.query(sql(DOWN107));
    assert.equal(await medir(), F0d, "o down da 107 devolve a deriva exata");
    await a.query(sql(M107)); await a.query("DROP TABLE public.kidmais107_reparos");
    mesmaImpressao(await impressao(), antes, "base canônica restaurada");

    // 3. 107 confirmada; 108 falha DE VERDADE dentro da transação 2; marcador da etapa trava; retomada só da 108.
    const d3 = novoDir();
    let primeira = true;
    const r3 = await executar(d3, { antesDe: async (consulta, cl) => {
      if (consulta === CORPO108 && primeira) { primeira = false; await cl.query("ALTER TABLE public.agenda_saloes ADD COLUMN combinado boolean"); }
    } });
    assert.equal(r3.resultado, "FALHA", JSON.stringify(r3)); assert.deepEqual(r3.commits, { 107: "CONFIRMADO", 108: "NAO_COMMITADA" });
    // A coluna do gancho faz o precheck da própria 108 recusar (P0001: instalação parcial) antes do ALTER (que daria 42701).
    assert.ok(registro.erros.some((e) => e.consulta.startsWith(CORPO108.slice(0, 40)) && (e.code === "P0001" || e.code === "42701")),
      "falha real do corpo da 108: " + JSON.stringify(registro.erros));
    assert.deepEqual(await estado(), { m107: true, m108: false }, "ROLLBACK real da 108; 107 fica");
    assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.agenda_saloes'::regclass AND attname = 'combinado'`)).rows[0].n, 0);
    await assert.rejects(executar(d3), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(d3, comum.MARCADOR), join(d3, "migration-107-108.2026-10-29T22-00.json"));
    const r3b = await executar(d3);
    assert.equal(r3b.resultado, "FALHA"); assert.match(r3b.falha!.mensagem, /ETAPA_JA_TENTADA_REVISAR 108/); assert.ok(!escreveu(), "etapa já tentada: sem escrita");
    renameSync(join(d3, comum.MARCADOR), join(d3, "migration-107-108.2026-10-29T22-10.json"));
    renameSync(join(d3, comum.marcadorEtapa("108")), join(d3, "migration-107-108.etapa-108.2026-10-29T22-10.json"));
    const r3c = await executar(d3);
    assert.equal(r3c.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(r3c)); assert.deepEqual(r3c.etapas, ["transacao 108"]); assert.deepEqual(r3c.commits, { 108: "CONFIRMADO" });
    await normalizar();

    // 3b. Atividade ENTRE as etapas (P3-2 da revisão da E4): logo depois do COMMIT da 107, outra conexão REAL abre transação
    // e ESCREVE em bloqueios_agenda (UPDATE sem COMMIT: RowExclusiveLock conferido em pg_locks; 2ª revisão do Astra pediu o
    // escritor, não só leitura). A releitura da atividade recusa: 107 confirmada e íntegra, 108 nunca começa (sem LOCK das
    // tabelas da 108 e sem o corpo). Sem a releitura (mutante E15), a 108 seria aplicada com o escritor vivo.
    const antes3b = await impressao();
    let intrusa: Client | null = null, commitou107 = false;
    try {
      const r3d = await executar(novoDir(), { antesDe: async (consulta) => {
        if (consulta === "COMMIT" && !commitou107) { commitou107 = true; return; }
        if (commitou107 && !intrusa) {
          const s = await conectarDescartavel({ travar: false });
          await s.query("BEGIN"); await s.query("UPDATE public.bloqueios_agenda SET ativo = ativo");
          const modo = (await s.query<{ escreve: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid()
            AND locktype = 'relation' AND relation = 'public.bloqueios_agenda'::regclass AND mode = 'RowExclusiveLock' AND granted) AS escreve`)).rows[0];
          assert.ok(modo.escreve, "intrusa é ESCRITORA (RowExclusiveLock em bloqueios_agenda)");
          intrusa = s;
        }
      } });
      assert.ok(intrusa, "sessão intrusa aberta depois do COMMIT da 107");
      assert.equal(r3d.resultado, "FALHA", JSON.stringify(r3d)); assert.match(r3d.falha!.mensagem, /ATIVIDADE_NAS_TABELAS 1 /);
      assert.deepEqual(r3d.commits, { 107: "CONFIRMADO" }, "só a 107 confirmada");
      assert.ok(!registro.consultas.includes(comum.SQL_LOCK["108"]), "nenhum LOCK das tabelas da 108");
      assert.ok(!registro.consultas.includes(CORPO108), "corpo da 108 nunca enviado");
      assert.deepEqual(await estado(), { m107: true, m108: false }, "107 preservada, 108 ausente");
    } finally {
      const s = intrusa as Client | null;
      if (s) { await s.query("ROLLBACK").catch(() => undefined); await s.end(); }
    }
    const c3d = await conferir();
    assert.equal(c3d.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(c3d)); assert.equal(c3d.fase, "F1", "107 íntegra: F1");
    await normalizar();
    mesmaImpressao(await impressao(), antes3b, "downs depois do cenário de atividade");

    // 4. 108 PARCIAL.
    await a.query("ALTER TABLE public.agenda_saloes ADD COLUMN membros uuid[]");
    try { await recusa(/APLICACAO_PARCIAL_108/); } finally { await a.query("ALTER TABLE public.agenda_saloes DROP COLUMN membros"); }

    // 5. 098 histórica (ANTIGA): a 108 com o corpo de conflito da 098 e sem marcador.
    await a.query(sql(M107)); await a.query(sql(M108));
    const conflito098 = CONFLITO_RE.exec(sql(M098))![0], conflito108 = CONFLITO_RE.exec(sql(M108))![0];
    const marcador108 = /CREATE FUNCTION public\.kidmais108_instalada\(\)[\s\S]*?\$\$;/.exec(sql(M108))![0];
    await a.query(`BEGIN; SET LOCAL search_path = public, pg_catalog; ${conflito098} DROP FUNCTION public.kidmais108_instalada(); COMMIT;`);
    try { await recusa(/COM_098_HISTORICA/); }
    finally { await a.query(`BEGIN; SET LOCAL search_path = public, pg_catalog; ${conflito108} ${marcador108} COMMIT;`); }
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "108 restaurada");
    await normalizar();

    // 6. Retrato divergente: uma coluna a mais numa tabela do escopo → diff só na seção 'colunas'.
    await a.query("ALTER TABLE public.agenda_escopo_config ADD COLUMN x_teste_retrato int");
    try {
      const r6 = await recusa(/RETRATO_F0_DIVERGENTE/);
      const mudou = Object.keys(r6.retrato!.secoes!).filter((k) => r6.retrato!.secoes![k].sha256 !== c1.retrato!.secoes![k].sha256);
      assert.deepEqual(mudou, ["colunas"], "diff sanitizado por seção");
    } finally { await a.query("ALTER TABLE public.agenda_escopo_config DROP COLUMN x_teste_retrato"); }
    mesmaImpressao(await impressao(), antes);

    // 7. Papel mínimo não superusuário: donos transferidos, esperados medidos nessa configuração.
    for (const p of [MINIMO, OUTRO]) await a.query(`DROP ROLE IF EXISTS ${p}`);
    await a.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    await a.query(`CREATE ROLE ${OUTRO} NOLOGIN NOSUPERUSER`);
    const banco = q(donos.banco);
    try {
      for (const p of [MINIMO, OUTRO]) {
        await a.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${p}`);
        await a.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${p}`);
        await a.query(`GRANT pg_read_all_stats TO ${p}`);
      }
      for (const tabela of ["bloqueios_agenda", "configuracao_agenda", "agenda_saloes", "contratos"]) await a.query(`ALTER TABLE public.${tabela} OWNER TO ${MINIMO}`);
      for (const f of SUBSTITUIDAS) await a.query(`ALTER FUNCTION public.${f} OWNER TO ${MINIMO}`);
      const minimo = await medirFases(MINIMO);
      env = { ...ENV_STG, [comum.ENV_RETRATOS_TESTE]: JSON.stringify(esperadosDe(minimo.F0, F0d, minimo.F1, minimo.F2)) };
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
      // Com o mínimo, o papel não superusuário aplica as duas (antes das revogações: o REVOKE/GRANT de EXECUTE deixa a ACL
      // explícita numa função do escopo e mudaria o retrato).
      const rm = await executar(novoDir(), { papel: MINIMO });
      assert.equal(rm.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(rm)); assert.deepEqual(rm.commits, { 107: "CONFIRMADO", 108: "CONFIRMADO" });
      assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
      await normalizar();
      // Cada revogação isolada: recusa nomeada antes de dados e de escrita (o catálogo recusa antes do retrato).
      await recusa(/SEM_PRIVILEGIO_107 DONO_BLOQUEIOS_AGENDA DONO_CONFIGURACAO_AGENDA TRIGGER_BLOQUEIOS_AGENDA TRIGGER_CONFIGURACAO_AGENDA LOCK_BLOQUEIOS_AGENDA LOCK_CONFIGURACAO_AGENDA$/, OUTRO);
      for (const [revogar, conceder, motivo] of [
        [`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`, `GRANT CREATE ON SCHEMA public TO ${MINIMO}`, /SEM_PRIVILEGIO_107 CREATE$/],
        [`REVOKE TEMP ON DATABASE ${banco} FROM PUBLIC, ${MINIMO}`, `GRANT TEMP ON DATABASE ${banco} TO PUBLIC`, /SEM_PRIVILEGIO_107 TEMP$/],
        [`REVOKE TRIGGER ON public.bloqueios_agenda FROM ${MINIMO}`, `GRANT TRIGGER ON public.bloqueios_agenda TO ${MINIMO}`, /SEM_PRIVILEGIO_107 TRIGGER_BLOQUEIOS_AGENDA$/],
        [`REVOKE UPDATE, DELETE, TRUNCATE, MAINTAIN ON public.contratos FROM ${MINIMO}`, `GRANT UPDATE, DELETE, TRUNCATE, MAINTAIN ON public.contratos TO ${MINIMO}`, /SEM_PRIVILEGIO_108 LOCK_CONTRATOS$/],
        [`REVOKE EXECUTE ON FUNCTION public.kidmais_set_atualizado_em() FROM PUBLIC, ${MINIMO}`, `GRANT EXECUTE ON FUNCTION public.kidmais_set_atualizado_em() TO PUBLIC`,
          /SEM_PRIVILEGIO_107 EXECUTE_KIDMAIS_SET_ATUALIZADO_EM$/],
        [`REVOKE SELECT ON public.contrato_fluxos FROM ${MINIMO}`, `GRANT SELECT ON public.contrato_fluxos TO ${MINIMO}`, /SEM_PRIVILEGIO_LEITURA SELECT_CONTRATO_FLUXOS$/],
        [`ALTER FUNCTION public.kidmais019_validar_contrato() OWNER TO ${q(donos.f1)}`, `ALTER FUNCTION public.kidmais019_validar_contrato() OWNER TO ${MINIMO}`,
          /SEM_PRIVILEGIO_108 DONO_FUNCOES_SUBSTITUIDAS$/],
        [`REVOKE pg_read_all_stats FROM ${MINIMO}`, `GRANT pg_read_all_stats TO ${MINIMO}`, /ATIVIDADE_NAO_VERIFICAVEL/],
      ] as const) {
        await a.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await a.query(conceder); }
      }
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await a.query("RESET ROLE").catch(() => undefined);
      await a.query(`ALTER TABLE public.bloqueios_agenda OWNER TO ${q(donos.bloqueios)}`);
      await a.query(`ALTER TABLE public.configuracao_agenda OWNER TO ${q(donos.config)}`);
      await a.query(`ALTER TABLE public.agenda_saloes OWNER TO ${q(donos.saloes)}`);
      await a.query(`ALTER TABLE public.contratos OWNER TO ${q(donos.contratos)}`);
      for (const [i, f] of SUBSTITUIDAS.entries()) await a.query(`ALTER FUNCTION public.${f} OWNER TO ${q([donos.f0, donos.f1, donos.f2][i])}`);
      await a.query(`GRANT TEMP ON DATABASE ${banco} TO PUBLIC`);
      await a.query(`GRANT EXECUTE ON FUNCTION public.kidmais_set_atualizado_em() TO PUBLIC`);
      for (const p of [MINIMO, OUTRO]) {
        await a.query(`REASSIGN OWNED BY ${p} TO ${q(donos.saloes)}`); await a.query(`DROP OWNED BY ${p}`); await a.query(`DROP ROLE ${p}`);
      }
    }
    mesmaImpressao(await impressao(), antes, "impressão inicial depois do papel mínimo");
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    const agora = await estado().catch(() => null);
    if (agora && (agora.m107 !== inicial.m107 || agora.m108 !== inicial.m108)) { await normalizar(); await restaurar(inicial); }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
