import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * B-26: o conferidor G-VAZIO real no PostgreSQL descartável, modelo b14-P0a (até a 088), levado pelas migrations reais do inventário até cada
 * prefixo da §9.2.2: base 099 e 105, depois a sequência do runbook. Só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL. Prova:
 *   cada prefixo declarado corretamente = PASS; migration aplicada e não declarada, declarada e não aplicada e parcial = FALHA com o motivo próprio;
 *   RLS que induziria zero e falta de privilégio nunca viram zero; tabela nova reprova; linha real em cada objeto, hash de classificados, terminais,
 *   PENDENTE, auditoria, LDT e os resultados S; nada é escrito pela leitura.
 * r5: roda sem a guarda de teste do harness (semGuardaSalao na seleção), como production; um negativo a instala e exige FALHA (R4-01).
 * O restore é real: pg_dump/pg_restore do banco de trabalho para o _rollback em k = 0, 8 (logo depois da 097) e 10, dois ciclos (R4-02).
 * r6 (R5-01): em todo j = 0..10, restore no prefixo j e o resto da sequência pelas migrations reais no restaurado, lendo cada k até 10.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Rel = { resultado: string; motivos: string[]; fora_do_prefixo?: { item: string; medido: string | null; esperado: string | null }[]; estrutura_detalhe?: Record<string, string[]>; estrutura_divergente?: Record<string, string[]>; classificados?: Record<string, { contagem: number; linhas_classificadas: number }>; estado_atual?: string; base?: string; migracoes: Record<string, string>; dominio: Record<string, { contagem?: number; hash?: string; situacoes?: Record<string, number>; presente: boolean }>;
  regra_de_fechamento?: string[]; cadastros?: { por_situacao: Record<string, number>; pendentes_nao_expirados: number }; auditoria?: { ocorrencias_nao_tratadas?: unknown[]; classes: Record<string, number>; linhas_origem_cobranca: number }; marcador_perda_nao_descartada: boolean; papel: { current_user: string; somente_leitura: string; isolamento: string }; identidade: { banco: string; prefixo_declarado: string[] } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cg = exigir(join(raiz, "scripts/conferidor-g-vazio.cjs")) as any;
const { aplicarMigracoes } = exigir(join(raiz, "scripts/regressao-v1-postgres-receita.cjs")) as { aplicarMigracoes(c: Client, n: string[]): Promise<void> };
const SEQUENCIA: string[] = cg.SEQUENCIA;
/** R3-03: a mensagem de toda asserção de resultado carrega os motivos, para a identidade da falha distinguir um efeito do outro. */
const comMotivos = (r: { motivos?: string[] }, msg = "") => `${msg}|motivos=${(r.motivos ?? []).join(",")}`;
const CORTE = "2026-01-01T00:00:00.000Z";
const PAPEL_LEITOR = "kidmais_teste_conferidor_leitor";

const fechada = () => ({ ...Object.fromEntries(cg.L1_DESLIGADAS.map((k: string) => [k, "AUSENTE"])), ...Object.fromEntries(cg.L1_AUSENTES.map((k: string) => [k, "AUSENTE"])) });
const barreira = (l2 = "ARTEFATO_SEM_L2") => ({ l1: Object.fromEntries(cg.SERVICOS_L1.map((s: string) => [s, fechada()])), c2: { quem_tem_acesso: "so Felipe", em: CORTE }, crons_suspensos: true, artefato: "bb65640a", l2 });
const provedor = { em: CORTE, declarante: "Felipe", conta_existe: false, o_que_foi_olhado: "lista de contas do provedor" };
const marcadorDe = (id: string) => `/m/migration-${id}.json`;
const lerMarcador = () => JSON.stringify({ situacao: "CONCLUIDA", resultado: "APLICADA_POSTCHECK_PASS" });
const prefixoDe = (ids: string[]) => ({ fonte: "marcadores", pastas_marcadores: ["/m"], itens: ids.map((migracao) => ({ migracao, marcador: marcadorDe(migracao) })) });

type Cfg = { papel?: string; sqls?: string[]; database?: string };
function clienteDescartavel(cfg: Cfg = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() { this.c = await conectarDescartavel({ travar: false, ...(cfg.database ? { database: cfg.database } : {}) }); if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`); }
    async query(sql: string, params?: unknown[]) { cfg.sqls?.push(sql); return this.c!.query(sql, params as never[]); }
    async end() { if (this.c) await this.c.end(); }
  };
}
type Decl = Record<string, unknown>;
async function ler(ids: string[], extra: Decl = {}, cfg: Cfg = {}): Promise<Rel> {
  const d = { versao: 1, ponto: "P1", alvo: "teste", corte_p1: CORTE, prefixo: prefixoDe(ids), barreira: barreira(), provedor, ...extra };
  return cg.conferir(d, { env: {}, Client: clienteDescartavel(cfg), lerMarcador, listarPasta: () => [] });
}
const HASH_VAZIO = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LB_ZERO = Object.fromEntries((cg.OBJETOS_HASHEADOS_CLASSIFICADOS as string[]).map((o) => [o, { contagem: 0, hash: HASH_VAZIO }]));
const semMigration = (motivos: string[]) => motivos.filter((m) => !m.startsWith("TABELA_FORA_DA_MATRIZ:"));
type Matriz = { objeto: string; migracao: string }[];
/** Migration dona do objeto da matriz (a que o cria). */
const donoDe = (tabela: string) => (cg.MATRIZ as Matriz).find((m) => m.objeto === tabela)?.migracao;
/**
 * O que uma guarda desligada (ou com outro modo) produz: o item gatilho_ da migration da guarda; a estrutura da tabela, se ela for da matriz,
 * na migration dona; e a âncora da relação, fora do prefixo.
 */
function guardaDesligada(id: string, tabela: string, g: string) {
  const dono = donoDe(tabela);
  const itens = [`gatilho_${g}`, ...(dono === id ? [`estrutura_${tabela}`] : [])].sort();
  const extra: Record<string, string[]> = dono && dono !== id ? { [dono]: [`estrutura_${tabela}`] } : {};
  return { itens, extra, ancoras: [`relacao:${tabela}`] };
}
/** Âncoras cujo estado muda entre dois prefixos (k = quantas da sequência). */
const mudamEntre = (a: number, b: number) => (cg.ANCORAS as string[]).filter((i) => cg.estadoEsperado(i, a) !== cg.estadoEsperado(i, b));
const ordenados = (xs: string[]) => [...xs].sort();
let defSolicitacaoAntes = "";
const ancoraDe = (r: { item: string }) => r.item;
/** Leitura R2 (prefixo de restore com os ids declarados), no banco pedido. */
const lerRestoreEm = (ids: string[], database?: string) => cg.conferir({ versao: 1, ponto: "R2", alvo: "isolado", corte_p1: CORTE, prefixo: { fonte: "restore", registro: { ponto: CORTE, origem: "backup de teste" }, itens: ids.map((migracao) => ({ migracao })) }, barreira: barreira(), provedor, linha_base: LB_ZERO, cadastros_referencia: {} },
  { env: { DATABASE_URL: "postgresql://x@127.0.0.1:1/x" }, Client: clienteDescartavel({ database }) }) as Promise<Rel>;

/**
 * R4-02: restore fiel de verdade. pg_dump em formato custom do banco de trabalho e pg_restore no _rollback (o outro banco que o conector
 * aceita; o runner o remove entre suítes), com os binários do próprio servidor (BINDIR do pg_config), sem dono e sem privilégios, numa
 * transação só, parando no primeiro erro. Ambiente limpo: só PATH e SystemRoot, sem variável PG herdada.
 */
const TRABALHO = "kidmais_pacotes_v1_descartavel";
const ROLLBACK = "kidmais_pacotes_v1_rollback";
const pastaDumps = mkdtempSync(join(tmpdir(), "b26-restore-"));
let bindir = "";
function cliPg(exe: string, args: string[]) {
  const env = { PATH: bindir } as unknown as NodeJS.ProcessEnv;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = spawnSync(join(bindir, process.platform === "win32" ? `${exe}.exe` : exe), ["-w", "-h", "127.0.0.1", "-p", String(portaDescartavel()), "-U", "kidmais_descartavel", ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, `${exe}: ${r.error?.message ?? ""} ${r.stderr}`);
}
const despejar = (db: string, arquivo: string) => cliPg("pg_dump", ["-d", db, "--format=custom", "--no-owner", "--no-privileges", "-f", arquivo]);
async function restaurarNoRollback(c: Client, arquivo: string) {
  await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`);
  await c.query(`CREATE DATABASE ${ROLLBACK} TEMPLATE template0`);
  cliPg("pg_restore", ["-d", ROLLBACK, "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", arquivo]);
}
type Leitura = { ancoras: Record<string, string | null>; linhas: Record<string, string[]> };
/** Âncoras (e as linhas cruas das relações ancoradas) lidas com o código do próprio conferidor, num dos dois bancos. */
async function lerEm(database: string): Promise<Leitura> {
  const db = await conectarDescartavel({ travar: false, database });
  try {
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL search_path = pg_catalog"); await db.query("SET LOCAL TIME ZONE 'UTC'"); await db.query("SET LOCAL DateStyle = 'ISO, YMD'");
    const l = (await cg.lerAncoras(db)) as Leitura;
    return { ancoras: Object.fromEntries(Object.entries(l.ancoras).map(([item, h]) => [ancoraDe({ item }), h])), linhas: l.linhas };
  } finally { await db.query("ROLLBACK").catch(() => undefined); await db.end(); }
}
/** Âncoras fora da trajetória medida do prefixo k. */
const foraDaTrajetoria = (ancoras: Record<string, string | null>, k: number) => (cg.ANCORAS as string[]).filter((i) => ancoras[i] !== cg.estadoEsperado(i, k));
/** Relações cujas linhas cruas (antes da projeção) diferem entre duas leituras. */
const reescritas = (a: Leitura, b: Leitura) => [...new Set([...Object.keys(a.linhas), ...Object.keys(b.linhas)])].filter((t) => JSON.stringify([...(a.linhas[t] ?? [])].sort()) !== JSON.stringify([...(b.linhas[t] ?? [])].sort())).sort();
/** Executa um comando no _rollback (mudança material depois do restore). */
async function noRollback(sql: string) {
  const db = await conectarDescartavel({ travar: false, database: ROLLBACK });
  try { return await db.query<Record<string, string>>(sql); } finally { await db.end(); }
}
/**
 * Restore fiel no prefixo k = ids.length (aplicados e declarados), dois ciclos: o segundo restaura o dump do próprio restaurado. O restore
 * reescreve linhas (a reanálise do PostgreSQL, conferida aqui: sem ela a prova não exercitaria a projeção), mas nenhuma âncora muda: todas
 * seguem a trajetória de k, P1 dá PASS e R2 dá CONFORME.
 */
async function restoreFiel(c: Client, ids: string[], rotulo: string) {
  const k = ids.length;
  const origem = await lerEm(TRABALHO);
  assert.deepEqual(foraDaTrajetoria(origem.ancoras, k), [], `${rotulo}: origem na trajetória`);
  for (const ciclo of [1, 2]) {
    const quem = `${rotulo} ciclo ${ciclo}`;
    const arquivo = join(pastaDumps, `${rotulo}-${ciclo}.dump`);
    despejar(ciclo === 1 ? TRABALHO : ROLLBACK, arquivo);
    await restaurarNoRollback(c, arquivo);
    const restaurado = await lerEm(ROLLBACK);
    assert.ok(reescritas(origem, restaurado).length > 0, `${quem}: o restore reanalisa alguma definição neste prefixo`);
    assert.deepEqual(restaurado.ancoras, origem.ancoras, `${quem}: nenhuma âncora muda`);
    const p1 = await ler(ids, {}, { database: ROLLBACK });
    assert.equal(p1.identidade.banco, ROLLBACK);
    assert.deepEqual(p1.motivos, [], quem);
    assert.equal(p1.resultado, "PASS", comMotivos(p1, quem));
    const r2 = await lerRestoreEm(ids, ROLLBACK);
    assert.deepEqual(r2.motivos, [], quem);
    assert.equal(r2.resultado, "CONFORME", comMotivos(r2, quem));
  }
}
/** Mudança material no restaurado (troca a definição de uma restrição): R2 INCONCLUSIVO pela relação, P1 FALHA. Repõe depois. */
async function materialReprova(ids: string[], tabela: string, restricao: string, mudar: (def: string) => string) {
  const def = (await noRollback(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${restricao}' AND conrelid = 'public.${tabela}'::regclass`)).rows[0].d;
  const nova = mudar(def);
  assert.notEqual(nova, def, restricao);
  await noRollback(`ALTER TABLE public.${tabela} DROP CONSTRAINT ${restricao}, ADD CONSTRAINT ${restricao} ${nova}`);
  try {
    const r2 = await lerRestoreEm(ids, ROLLBACK);
    assert.equal(r2.resultado, "INCONCLUSIVO", comMotivos(r2, restricao));
    assert.equal(r2.motivos[0], "RESTORE_DIVERGENTE", restricao);
    assert.ok(r2.motivos.includes(`FORA_DO_PREFIXO:relacao:${tabela}`), comMotivos(r2, restricao));
    const p1 = await ler(ids, {}, { database: ROLLBACK });
    assert.equal(p1.resultado, "FALHA", comMotivos(p1, restricao));
    assert.ok(p1.motivos.includes(`FORA_DO_PREFIXO:relacao:${tabela}`), comMotivos(p1, restricao));
  } finally { await noRollback(`ALTER TABLE public.${tabela} DROP CONSTRAINT ${restricao}, ADD CONSTRAINT ${restricao} ${def}`); }
  assert.deepEqual((await lerRestoreEm(ids, ROLLBACK)).motivos, [], `${restricao}: reposta`);
}
/**
 * R5-01: restore fiel no prefixo j = ids.length e, no restaurado, o resto da sequência pelas migrations reais (com os postchecks), lendo cada
 * k = j..10: âncoras na trajetória de k, P1 PASS e R2 CONFORME. Chamada em todo j, cobre toda composição restaurar(j) → migrations até k.
 * `noPasso` roda depois das leituras de cada k (negativos materiais na forma mista).
 */
async function restoreEAvanca(c: Client, ids: string[], noPasso?: (k: number, feitas: string[], lido: Leitura) => Promise<void>) {
  const j = ids.length;
  const origem = await lerEm(TRABALHO);
  const arquivo = join(pastaDumps, `avanca-${j}.dump`);
  despejar(TRABALHO, arquivo);
  await restaurarNoRollback(c, arquivo);
  const r = await conectarDescartavel({ travar: false, database: ROLLBACK });
  try {
    const feitas = [...ids];
    for (let k = j; k <= SEQUENCIA.length; k++) {
      const quem = `restore em j=${j}, migrations até k=${k}`;
      if (k > j) { await aplicarMigracoes(r, [SEQUENCIA[k - 1]]); feitas.push(SEQUENCIA[k - 1]); }
      const lido = await lerEm(ROLLBACK);
      if (k === j) assert.ok(reescritas(origem, lido).length > 0, `${quem}: o restore reanalisa alguma definição`);
      assert.deepEqual(foraDaTrajetoria(lido.ancoras, k), [], quem);
      const p1 = await ler(feitas, {}, { database: ROLLBACK });
      assert.equal(p1.identidade.banco, ROLLBACK);
      assert.deepEqual(p1.motivos, [], quem);
      assert.equal(p1.resultado, "PASS", comMotivos(p1, quem));
      const r2 = await lerRestoreEm(feitas, ROLLBACK);
      assert.deepEqual(r2.motivos, [], quem);
      assert.equal(r2.resultado, "CONFORME", comMotivos(r2, quem));
      if (noPasso) await noPasso(k, feitas, lido);
    }
  } finally { await r.end(); }
  await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`);
}

test("conferidor G-VAZIO real: cada prefixo, parcial, RLS, privilégio, tabela nova, dados, LDT e resultados", { timeout: 840_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    bindir = (await c.query<{ setting: string }>("SELECT setting FROM pg_config WHERE name = 'BINDIR'")).rows[0].setting;
    // Base de production: até a 088 mais 099 e 105.
    await aplicarMigracoes(c, ["099", "105"]);

    await t.test("base: PASS, só leitura, transação conforme o protocolo", async () => {
      const sqls: string[] = [];
      const antes = (await c.query<{ n: string }>("SELECT sum(n_tup_ins + n_tup_upd + n_tup_del)::text AS n FROM pg_stat_user_tables")).rows[0].n;
      const r = await ler([], {}, { sqls });
      assert.deepEqual(r.motivos, []);
      assert.equal(r.resultado, "PASS", comMotivos(r));
      assert.equal(r.papel.somente_leitura, "on");
      assert.equal(r.papel.isolamento, "repeatable read");
      assert.equal(r.identidade.banco, "kidmais_pacotes_v1_descartavel");
      assert.deepEqual(r.regra_de_fechamento, []);
      assert.equal(sqls[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.equal(sqls.at(-1), "ROLLBACK");
      assert.ok(sqls.includes("SET LOCAL search_path = pg_catalog"), "nada resolvido por um esquema que outro papel possa criar");
      for (const s of sqls.slice(1, -1)) assert.match(s, /^(SET LOCAL |SELECT )/);
      assert.equal(r.dominio.cobranca_eventos.contagem, 0);
      assert.equal(r.dominio.assinatura_encerramentos.presente, false);
      const depois = (await c.query<{ n: string }>("SELECT sum(n_tup_ins + n_tup_upd + n_tup_del)::text AS n FROM pg_stat_user_tables")).rows[0].n;
      assert.equal(depois, antes);
    });

    await t.test("escrita dentro da transação do conferidor é recusada pelo próprio banco", async () => {
      const db = await conectarDescartavel({ travar: false });
      try {
        await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await assert.rejects(db.query("CREATE TABLE public.tentativa (x int)"), { code: "25006" });
      } finally { await db.query("ROLLBACK"); await db.end(); }
    });

    await t.test("base ausente e fora do escopo reprovam", async () => {
      await c.query("CREATE TABLE public.ia_credito_franquias_ciclo (x int)");
      const r = await ler([]);
      assert.equal(r.resultado, "FALHA", comMotivos(r));
      assert.deepEqual(r.motivos, ["FORA_DO_ESCOPO_PRESENTE:ia_credito_franquias_ciclo"]);
      await c.query("DROP TABLE public.ia_credito_franquias_ciclo");
    });

    await t.test("regra de fechamento: tabela nova, em qualquer esquema, reprova", async () => {
      await c.query("CREATE TABLE public.assinatura_nova (x int)");
      await c.query("CREATE SCHEMA copia; CREATE TABLE copia.contratos (x int)");
      const r = await ler([]);
      assert.deepEqual(r.motivos, ["TABELA_FORA_DA_MATRIZ:copia.contratos", "TABELA_FORA_DA_MATRIZ:public.assinatura_nova"]);
      await c.query("DROP TABLE public.assinatura_nova; DROP SCHEMA copia CASCADE");
    });

    await t.test("parcial: tabela da 089 sem o resto reprova, declarada ou não", async () => {
      await c.query("CREATE TABLE public.assinatura_encerramentos (id uuid)");
      const r = await ler([]);
      assert.ok(r.motivos.includes("MIGRATION_089_PARCIAL_NAO_DECLARADA"), r.motivos.join());
      assert.ok(r.motivos.includes("OBJETO_NAO_DECLARADO:assinatura_encerramentos"), r.motivos.join());
      const declarada = await ler(["089"]);
      assert.ok(declarada.motivos.includes("MIGRATION_089_PARCIAL_ESPERADA"), declarada.motivos.join());
      await c.query("DROP TABLE public.assinatura_encerramentos");
    });

    await t.test("estrutura danificada com a tabela vazia: guarda desabilitada, trocada ou com outro corpo e coluna ausente reprovam", async () => {
      const reg = { ponto: CORTE, origem: "backup de teste" };
      const lerRestore = () => cg.conferir({ versao: 1, ponto: "R2", alvo: "isolado", corte_p1: CORTE, prefixo: { fonte: "restore", registro: reg, itens: [] }, barreira: barreira(), provedor, linha_base: LB_ZERO, cadastros_referencia: {} },
        { env: { DATABASE_URL: "postgresql://x@127.0.0.1:1/x" }, Client: clienteDescartavel() }) as Promise<Rel>;
      assert.equal((await ler([])).dominio.assinatura_isencoes.contagem, 0, "a contraprova vale com a tabela vazia");
      { const lido = await lerRestore(); assert.equal(lido.resultado, "CONFORME", comMotivos(lido)); }
      const reprova = async (migracao: string | null, item: string | string[], ancoras: string[], extra: Record<string, string[]> = {}) => {
        const itens = [item].flat();
        const r = await ler([]);
        const migs = [...(migracao ? [migracao] : []), ...Object.keys(extra)];
        const esperado = ordenados([...migs.map((m) => `MIGRATION_${m}_PARCIAL_ESPERADA`), ...ancoras.map((a) => `FORA_DO_PREFIXO:${a}`)]);
        assert.equal(r.resultado, "FALHA", comMotivos(r, itens.join()));
        assert.deepEqual(ordenados(r.motivos), esperado, itens.join());
        if (migracao) assert.deepEqual(r.estrutura_detalhe?.[migracao], itens);
        for (const [m, i] of Object.entries(extra)) assert.deepEqual(r.estrutura_detalhe?.[m], i, m);
        assert.equal(cg.CODIGO_DO_RESULTADO[r.resultado], 3);
        const restore = await lerRestore();
        assert.equal(restore.resultado, "INCONCLUSIVO", comMotivos(restore, itens.join()));
        assert.equal(restore.motivos[0], "RESTORE_DIVERGENTE");
        assert.deepEqual(ordenados(restore.motivos.slice(1)), esperado, itens.join());
        return r;
      };
      const reprovaGuarda = (id: string, tabela: string, g: string) => { const e = guardaDesligada(id, tabela, g); return reprova(id, e.itens, e.ancoras, e.extra); };
      // Contraprova 1 do Astra, e a mesma coisa em cada guarda da base.
      const daBase = Object.entries(cg.GATILHOS as Record<string, [string, string, string][]>).filter(([id]) => cg.BASE.includes(id));
      assert.ok(daBase.flatMap(([, g]) => g).length >= 20);
      for (const [id, guardas] of daBase) for (const [tabela, g] of guardas) {
        await c.query(`ALTER TABLE public.${tabela} DISABLE TRIGGER ${g}`);
        try { await reprovaGuarda(id, tabela, g); } finally { await c.query(`ALTER TABLE public.${tabela} ENABLE TRIGGER ${g}`); }
      }
      await c.query("ALTER TABLE public.assinatura_isencoes ENABLE REPLICA TRIGGER assinatura_isencoes_074_guarda");
      try { await reprovaGuarda("074a", "assinatura_isencoes", "assinatura_isencoes_074_guarda"); } finally { await c.query("ALTER TABLE public.assinatura_isencoes ENABLE TRIGGER assinatura_isencoes_074_guarda"); }
      // Guarda presa a outra função.
      await c.query("DROP TRIGGER assinatura_isencoes_074_guarda ON public.assinatura_isencoes");
      await c.query("CREATE TRIGGER assinatura_isencoes_074_guarda BEFORE INSERT OR UPDATE OR DELETE ON public.assinatura_isencoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_087_aviso_guarda()");
      await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]);
      await c.query("DROP TRIGGER assinatura_isencoes_074_guarda ON public.assinatura_isencoes");
      await c.query("CREATE TRIGGER assinatura_isencoes_074_guarda BEFORE INSERT OR UPDATE OR DELETE ON public.assinatura_isencoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_074_registro_guarda()");
      // Guarda habilitada, com o corpo trocado.
      const original = (await c.query<{ d: string }>("SELECT pg_get_functiondef('public.kidmais_074_registro_guarda()'::regprocedure) AS d")).rows[0].d;
      await c.query("CREATE OR REPLACE FUNCTION public.kidmais_074_registro_guarda() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$");
      try { await reprova("074a", "funcao_kidmais_074_registro_guarda", ["funcao:kidmais_074_registro_guarda"]); } finally { await c.query(original); }
      // R3-01: mesmo corpo, com SET search_path, SECURITY DEFINER ou outra volatilidade: outra função.
      for (const muda of ["SET search_path TO public, pg_catalog", "RESET search_path", "SECURITY DEFINER", "STABLE", "SET work_mem TO '1MB'"]) {
        await c.query(`ALTER FUNCTION public.kidmais_074_registro_guarda() ${muda}`);
        try { await reprova("074a", "funcao_kidmais_074_registro_guarda", ["funcao:kidmais_074_registro_guarda"]); } finally { await c.query(original); }
      }
      // Outra versão (sobrecarga) com o mesmo nome também muda a identidade.
      await c.query("CREATE FUNCTION public.kidmais_074_registro_guarda(x int) RETURNS int LANGUAGE sql AS 'SELECT 1'");
      try { await reprova("074a", "funcao_kidmais_074_registro_guarda", ["funcao:kidmais_074_registro_guarda"]); } finally { await c.query("DROP FUNCTION public.kidmais_074_registro_guarda(int)"); }
      assert.deepEqual((await ler([])).motivos, []);
      // R3-01: verificação de chave estrangeira desativada, em cada lado de cada FK das isenções, pela restrição (nunca pelo nome gerado).
      const internos = (await c.query<{ rel: string; tg: string; fn: string }>(`SELECT cl.relname AS rel, g.tgname AS tg, p.proname AS fn FROM pg_constraint r JOIN pg_trigger g ON g.tgconstraint = r.oid AND g.tgisinternal
        JOIN pg_class cl ON cl.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid WHERE r.conrelid = 'public.assinatura_isencoes'::regclass AND r.contype = 'f' ORDER BY 1, 3, 2`)).rows;
      assert.ok(internos.some((x) => x.fn === "RI_FKey_check_ins" && x.rel === "assinatura_isencoes"), "lado do referenciador");
      assert.ok(internos.some((x) => x.fn.startsWith("RI_FKey_") && x.rel !== "assinatura_isencoes"), "lado do referenciado");
      for (const { rel, tg } of internos) {
        await c.query(`ALTER TABLE public.${rel} DISABLE TRIGGER "${tg}"`);
        try {
          await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]);
        } finally { await c.query(`ALTER TABLE public.${rel} ENABLE TRIGGER "${tg}"`); }
      }
      assert.deepEqual((await ler([])).motivos, []);
      // R3-02: o CHECK que a 091 troca em solicitacoes_acesso_empresa, aplicado antes da 091.
      defSolicitacaoAntes = (await c.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'solicitacoes_documento_check' AND conrelid = 'public.solicitacoes_acesso_empresa'::regclass")).rows[0].d;
      await c.query("ALTER TABLE public.solicitacoes_acesso_empresa DROP CONSTRAINT solicitacoes_documento_check, ADD CONSTRAINT solicitacoes_documento_check CHECK (documento ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$')");
      try {
        const r = await reprova(null, [], ["relacao:solicitacoes_acesso_empresa"]);
        assert.ok((r.estrutura_divergente?.solicitacoes_acesso_empresa ?? []).some((l) => l.startsWith("restricao|solicitacoes_documento_check|c|")), "relata a estrutura da relação auxiliar");
      } finally { await c.query(`ALTER TABLE public.solicitacoes_acesso_empresa DROP CONSTRAINT solicitacoes_documento_check, ADD CONSTRAINT solicitacoes_documento_check ${defSolicitacaoAntes}`); }
      assert.deepEqual((await ler([])).motivos, []);
      // R2-01: nome, tabela, função e modo iguais, mas a guarda deixa de proteger o que devia.
      const GUARDA = "assinatura_isencoes_074_guarda";
      const defGuarda = (await c.query<{ d: string }>("SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = $1 AND tgrelid = 'public.assinatura_isencoes'::regclass", [GUARDA])).rows[0].d;
      for (const forma of ["BEFORE INSERT FOR EACH ROW", "BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW WHEN (false)", "BEFORE INSERT OR UPDATE OR DELETE FOR EACH STATEMENT", "AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW", "BEFORE INSERT OR DELETE OR UPDATE OF motivo FOR EACH ROW"]) {
        await c.query(`DROP TRIGGER ${GUARDA} ON public.assinatura_isencoes`);
        await c.query(`CREATE TRIGGER ${GUARDA} ${forma === "" ? "" : forma.split(" FOR EACH")[0]} ON public.assinatura_isencoes FOR EACH ${forma.split(" FOR EACH ")[1]} EXECUTE FUNCTION public.kidmais_074_registro_guarda()`);
        try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally {
          await c.query(`DROP TRIGGER ${GUARDA} ON public.assinatura_isencoes`);
          await c.query(defGuarda);
        }
      }
      // Gatilho a mais na tabela, com nome fora da lista.
      await c.query("CREATE TRIGGER intruso_antes_da_guarda BEFORE UPDATE ON public.assinatura_isencoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_087_aviso_guarda()");
      try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally { await c.query("DROP TRIGGER intruso_antes_da_guarda ON public.assinatura_isencoes"); }
      // R2-01: coluna fora das lidas, tipo, NOT NULL, CHECK e índice, com a tabela vazia.
      await c.query("ALTER TABLE public.assinatura_isencoes DROP COLUMN motivo");
      try {
        const r = await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]);
        const linhas = r.estrutura_divergente?.assinatura_isencoes ?? [];
        assert.ok(linhas.some((l) => l.startsWith("coluna|empresa_id|uuid|")), linhas.join());
        assert.ok(!linhas.some((l) => l.startsWith("coluna|motivo|")), linhas.join());
      } finally { await c.query("ALTER TABLE public.assinatura_isencoes ADD COLUMN motivo text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 500)"); }
      await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN concedida_em DROP DEFAULT, ALTER COLUMN concedida_em TYPE text USING concedida_em::text");
      try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally { await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN concedida_em TYPE timestamptz USING concedida_em::timestamptz, ALTER COLUMN concedida_em SET DEFAULT clock_timestamp()"); }
      await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN motivo DROP NOT NULL");
      try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally { await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN motivo SET NOT NULL"); }
      await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN concedida_em DROP DEFAULT");
      try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally { await c.query("ALTER TABLE public.assinatura_isencoes ALTER COLUMN concedida_em SET DEFAULT clock_timestamp()"); }
      await c.query("ALTER TABLE public.assinatura_isencoes DROP CONSTRAINT assinatura_isencoes_motivo_check");
      try { await reprova("074a", "estrutura_assinatura_isencoes", ["relacao:assinatura_isencoes"]); } finally { await c.query("ALTER TABLE public.assinatura_isencoes ADD CONSTRAINT assinatura_isencoes_motivo_check CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 500)"); }
      const defIndice = (await c.query<{ d: string }>("SELECT pg_get_indexdef('public.assinatura_avisos_087_fila_idx'::regclass) AS d")).rows[0].d;
      await c.query("DROP INDEX public.assinatura_avisos_087_fila_idx");
      await c.query("CREATE INDEX assinatura_avisos_087_fila_idx ON public.assinatura_avisos (id)");
      try { await reprova("087", "estrutura_assinatura_avisos", ["relacao:assinatura_avisos"]); } finally {
        await c.query("DROP INDEX public.assinatura_avisos_087_fila_idx");
        await c.query(defIndice);
      }
      // Contraprova 2 do Astra: coluna do hash ausente, literal.
      await c.query("ALTER TABLE public.assinatura_isencoes DROP COLUMN concedida_por");
      try {
        await reprova("074a", ["colunas_assinatura_isencoes", "estrutura_assinatura_isencoes"], ["relacao:assinatura_isencoes"]);
        assert.equal((await ler([])).dominio.assinatura_isencoes.hash, undefined, "sem a coluna não há hash a relatar, nem o da tabela vazia");
      } finally { await c.query("ALTER TABLE public.assinatura_isencoes ADD COLUMN concedida_por uuid NOT NULL REFERENCES public.usuarios_administrativos(id)"); }
      // Cada coluna lida de cada objeto da base.
      const objetosBase = (cg.MATRIZ as { objeto: string; migracao: string }[]).filter((m) => cg.BASE.includes(m.migracao));
      assert.ok(objetosBase.length >= 10);
      for (const { objeto, migracao } of objetosBase) for (const coluna of cg.colunasLidas(objeto) as string[]) {
        await c.query(`ALTER TABLE public.${objeto} RENAME COLUMN ${coluna} TO ${coluna}_x`);
        try {
          const r = await ler([]);
          assert.equal(r.resultado, "FALHA", comMotivos(r, `${objeto}.${coluna}`));
          assert.ok(r.motivos.includes(`MIGRATION_${migracao}_PARCIAL_ESPERADA`), `${objeto}.${coluna}: ${r.motivos.join()}`);
          assert.ok(r.motivos.includes(`FORA_DO_PREFIXO:relacao:${objeto}`), `${objeto}.${coluna}: ${r.motivos.join()}`);
          assert.ok(r.motivos.every((m) => /^MIGRATION_[0-9a]+_PARCIAL_ESPERADA$/.test(m) || m.startsWith("FORA_DO_PREFIXO:relacao:")), `${objeto}.${coluna}: ${r.motivos.join()}`); // coluna referenciada por FK muda também a relação que a referencia
          assert.deepEqual(r.estrutura_detalhe?.[migracao]?.filter((i) => i === `colunas_${objeto}` || i === `estrutura_${objeto}`), [`colunas_${objeto}`, `estrutura_${objeto}`], `${objeto}.${coluna}`);
          for (const itens of Object.values(r.estrutura_detalhe ?? {})) for (const i of itens) assert.match(i, /^(colunas|estrutura)_/, `${objeto}.${coluna}`);
        } finally { await c.query(`ALTER TABLE public.${objeto} RENAME COLUMN ${coluna}_x TO ${coluna}`); }
      }
      // Coluna fora do que o conferidor lê não muda o resultado: a assinatura é do que ele precisa.
      assert.deepEqual((await ler([])).motivos, []);
    });

    await t.test("declarada e não aplicada reprova; marcador falso não engana", async () => {
      const r = await ler(["089"]);
      assert.ok(r.motivos.includes("MIGRATION_089_AUSENTE_ESPERADA"), r.motivos.join());
      assert.ok(r.motivos.includes("OBJETO_AUSENTE:assinatura_encerramentos"), r.motivos.join());
      assert.equal(r.resultado, "FALHA", comMotivos(r));
    });

    await t.test("restore: catálogo diferente do prefixo registrado é INCONCLUSIVO; igual segue a régua normal", async () => {
      const reg = { ponto: CORTE, origem: "backup de teste" };
      const lerRestore = (ids: string[]) => cg.conferir({ versao: 1, ponto: "R2", alvo: "isolado", corte_p1: CORTE, prefixo: { fonte: "restore", registro: reg, itens: ids.map((migracao) => ({ migracao })) }, barreira: barreira(), provedor, linha_base: LB_ZERO, cadastros_referencia: {} },
        { env: { DATABASE_URL: "postgresql://x@127.0.0.1:1/x" }, Client: clienteDescartavel() }) as Promise<Rel>;
      const igual = await lerRestore([]);
      assert.deepEqual(igual.motivos, []);
      assert.equal(igual.resultado, "CONFORME", comMotivos(igual));
      const divergente = await lerRestore(["089"]);
      assert.equal(divergente.resultado, "INCONCLUSIVO", comMotivos(divergente));
      assert.deepEqual(divergente.motivos, ["RESTORE_DIVERGENTE", "MIGRATION_089_AUSENTE_ESPERADA", ...mudamEntre(0, 1).map((i) => `FORA_DO_PREFIXO:${i}`)]);
      assert.equal(cg.CODIGO_DO_RESULTADO[divergente.resultado], 1);
    });

    await t.test("R4-01: a base roda sem a guarda de teste do harness; com ela instalada, a assinatura das duas tabelas reprova", async () => {
      const fixture = async () => (await c.query<{ n: string }>("SELECT tgrelid::regclass::text || '.' || tgname AS n FROM pg_trigger WHERE tgname LIKE 'kidmais\\_teste\\_%' UNION ALL SELECT 'funcao.' || proname FROM pg_proc WHERE proname LIKE 'kidmais\\_teste\\_%' ORDER BY 1")).rows.map((r) => r.n);
      assert.deepEqual(await fixture(), [], "a suíte roda como production, sem a guarda de teste (semGuardaSalao)");
      await (exigir(join(raiz, "scripts/guarda-salao-harness.cjs")) as { instalar(c: Client): Promise<void> }).instalar(c);
      try {
        assert.deepEqual(await fixture(), ["fechamento_revisoes.kidmais_teste_salao_ins", "fechamento_revisoes.kidmais_teste_salao_upd", "fechamentos.kidmais_teste_salao_ins", "fechamentos.kidmais_teste_salao_upd", "funcao.kidmais_teste_guarda_salao"]);
        const p1 = await ler([]);
        assert.equal(p1.resultado, "FALHA", comMotivos(p1));
        assert.deepEqual(ordenados(p1.motivos), ["FORA_DO_PREFIXO:relacao:fechamento_revisoes", "FORA_DO_PREFIXO:relacao:fechamentos"]);
        const r2 = await lerRestoreEm([]);
        assert.equal(r2.resultado, "INCONCLUSIVO", comMotivos(r2));
        assert.deepEqual(ordenados(r2.motivos), ["FORA_DO_PREFIXO:relacao:fechamento_revisoes", "FORA_DO_PREFIXO:relacao:fechamentos", "RESTORE_DIVERGENTE"]);
      } finally {
        for (const tabela of ["fechamentos", "fechamento_revisoes"]) for (const g of ["kidmais_teste_salao_ins", "kidmais_teste_salao_upd"]) await c.query(`DROP TRIGGER IF EXISTS ${g} ON public.${tabela}`);
        await c.query("DROP FUNCTION IF EXISTS public.kidmais_teste_guarda_salao()");
      }
      assert.deepEqual(await fixture(), []);
      const p1 = await ler([]);
      assert.deepEqual(p1.motivos, []);
      assert.equal(p1.resultado, "PASS", comMotivos(p1));
    });

    await t.test("R4-02: restore fiel real no prefixo base (k=0), dois ciclos; mudança material de CHECK no restaurado continua reprovando", async () => {
      await restoreFiel(c, [], "k0");
      // Mesma sintaxe reanalisada, uma opção a mais (alarga, não viola as linhas do modelo): não é a forma medida.
      await materialReprova([], "precos_pacote", "precos_pacote_tipo_calculo_check", (d) => d.replace("('FIXO'::character varying)::text", "('FIXO'::character varying)::text, ('OUTRO'::character varying)::text"));
      await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`);
    });

    await t.test("RLS que induziria zero: há linha, o papel veria zero, e o conferidor não aceita", async () => {
      await c.query(`DROP ROLE IF EXISTS ${PAPEL_LEITOR}`);
      await c.query(`CREATE ROLE ${PAPEL_LEITOR} NOSUPERUSER NOBYPASSRLS`);
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL_LEITOR}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL_LEITOR}`);
      const limpo = await ler([], {}, { papel: PAPEL_LEITOR });
      assert.deepEqual(limpo.motivos, []);
      assert.equal(limpo.papel.current_user, PAPEL_LEITOR);
      await c.query("INSERT INTO public.cobranca_eventos (provedor, evento_id, tipo) VALUES ('ASAAS', 'rls-1', 'TESTE')");
      await c.query("ALTER TABLE public.cobranca_eventos ENABLE ROW LEVEL SECURITY");
      const contar = async () => Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM public.cobranca_eventos")).rows[0].n);
      assert.equal(await contar(), 1, "o papel de preparação vê a linha");
      await c.query(`SET ROLE ${PAPEL_LEITOR}`);
      try { assert.equal(await contar(), 0, "o papel restrito vê zero, sem erro: é o zero que não pode valer"); } finally { await c.query("RESET ROLE"); }
      const r = await ler([], {}, { papel: PAPEL_LEITOR });
      assert.deepEqual(r.motivos, ["RLS_PODE_INDUZIR_ZERO:cobranca_eventos"]);
      assert.equal(r.resultado, "FALHA", comMotivos(r));
      assert.equal(r.dominio.cobranca_eventos.contagem, undefined, "não pode ter lido zero");
      await c.query("ALTER TABLE public.cobranca_eventos DISABLE ROW LEVEL SECURITY");
      await c.query("SET session_replication_role = replica");
      try { await c.query("DELETE FROM public.cobranca_eventos"); } finally { await c.query("SET session_replication_role = origin"); }
      assert.deepEqual((await ler([])).motivos, []);
    });

    await t.test("falta de privilégio não vira zero", async () => {
      await c.query(`REVOKE SELECT ON public.assinatura_avisos FROM ${PAPEL_LEITOR}`);
      const r = await ler([], {}, { papel: PAPEL_LEITOR });
      assert.deepEqual(r.motivos, ["SEM_PRIVILEGIO:assinatura_avisos"]);
      assert.equal(r.dominio.assinatura_avisos.contagem, undefined);
      await c.query(`GRANT SELECT ON public.assinatura_avisos TO ${PAPEL_LEITOR}`);
      await c.query(`REVOKE SELECT ON public.auditoria FROM ${PAPEL_LEITOR}`);
      const a = await ler([], {}, { papel: PAPEL_LEITOR });
      assert.deepEqual(a.motivos, ["AUDITORIA_ILEGIVEL_OU_RLS"]);
      await c.query(`GRANT SELECT ON public.auditoria TO ${PAPEL_LEITOR}`);
    });

    await t.test("conexão derrubada no meio da leitura: INCONCLUSIVO, sem domínio e sem zero", async () => {
      const Cli = class {
        c: Client | null = null;
        n = 0;
        on() {}
        async connect() { this.c = await conectarDescartavel({ travar: false }); this.c.on("error", () => undefined); }
        async query(sql: string, params?: unknown[]) {
          if (sql === "SELECT count(*)::bigint AS n FROM public.assinatura_avisos") {
            this.n += 1;
            const pid = (await this.c!.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
            await c.query("SELECT pg_terminate_backend($1)", [pid]);
          }
          return this.c!.query(sql, params as never[]);
        }
        async end() { await this.c?.end().catch(() => undefined); }
      };
      const r = await cg.conferir({ versao: 1, ponto: "P1", alvo: "teste", corte_p1: CORTE, prefixo: prefixoDe([]), barreira: barreira(), provedor }, { env: {}, Client: Cli, lerMarcador, listarPasta: () => [] }) as Rel;
      assert.equal(r.resultado, "INCONCLUSIVO", comMotivos(r));
      assert.match(r.motivos[0], /^LEITURA_IMPOSSIVEL:/);
      assert.equal(r.dominio, undefined);
      assert.equal(cg.CODIGO_DO_RESULTADO[r.resultado], 1);
    });

    await t.test("prefixo sem marcador é INCONCLUSIVO e só relata o catálogo", async () => {
      const r = await cg.conferir({ versao: 1, ponto: "P1", alvo: "teste", corte_p1: CORTE, prefixo: { fonte: "indeclaravel" }, barreira: barreira(), provedor },
        { env: {}, Client: clienteDescartavel() }) as Rel & { catalogo_relatado: string[] };
      assert.equal(r.resultado, "INCONCLUSIVO", comMotivos(r));
      assert.ok(r.catalogo_relatado.includes("public.cobranca_eventos"));
    });

    // Dados reais sem depender dos gatilhos e das FKs da fixture: réplica só nesta sessão, removendo tudo no fim.
    const comoReplica = async (sql: string) => { await c.query("SET session_replication_role = replica"); try { await c.query(sql); } finally { await c.query("SET session_replication_role = origin"); } };
    const UM = "00000000-0000-4000-8000-000000000001";

    await t.test("classificados: isenção exige classificação e o hash pega a mudança; o documento não entra no hash", async () => {
      const DOIS = "00000000-0000-4000-8000-000000000002";
      await comoReplica(`INSERT INTO public.assinatura_isencoes (empresa_id, documento_verificado, motivo, concedida_por) VALUES ('${UM}', '12345678000199', 'isencao de teste', '${UM}'), ('${DOIS}', '12345678000288', 'isencao de teste', '${UM}')`);
      const p1 = await ler([]);
      assert.deepEqual(p1.motivos, ["CLASSIFICACAO_PENDENTE:assinatura_isencoes"]);
      const h = p1.dominio.assinatura_isencoes.hash!;
      assert.match(h, /^[0-9a-f]{64}$/);
      // O SELECT que o --plano entrega a quem classifica, com a preparação dele.
      await c.query("BEGIN"); await c.query("SET LOCAL TIME ZONE 'UTC'"); await c.query("SET LOCAL DateStyle = 'ISO, YMD'");
      const lidas = (await c.query<{ linha: string }>(cg.sqlLinhasClassificadas("assinatura_isencoes"))).rows.map((l) => l.linha);
      await c.query("COMMIT");
      assert.equal(lidas.length, 2);
      const uma = (linha: string, i: number) => ({ linha, classificacao: `linha ${i}, explicada por Felipe` });
      const cl = lidas.map(uma);
      const base = (hash: string, classificacoes: unknown = cl) => ({ ...LB_ZERO, assinatura_isencoes: { contagem: 2, hash, classificacoes } });
      // Contraprova do Astra: um texto único para o objeto não classifica cada linha.
      const textoUnico = { ...LB_ZERO, assinatura_isencoes: { contagem: 2, hash: h, classificacao: "texto unico para o objeto" } };
      assert.deepEqual((await ler([], { linha_base: textoUnico })).motivos, ["CLASSIFICACAO_PENDENTE:assinatura_isencoes"]);
      assert.deepEqual((await ler([], { linha_base: base(h, [cl[0]]) })).motivos, ["CLASSIFICACAO_DIVERGENTE:assinatura_isencoes"], "faltou uma linha");
      assert.deepEqual((await ler([], { linha_base: base(h, [cl[0], uma("0".repeat(64), 9)]) })).motivos, ["CLASSIFICACAO_DIVERGENTE:assinatura_isencoes"], "linha que não existe");
      assert.deepEqual((await ler([], { linha_base: base(h, [cl[0], { linha: cl[1].linha, classificacao: " " }]) })).motivos, ["CLASSIFICACAO_PENDENTE:assinatura_isencoes"], "sem texto");
      const classificado = await ler([], { linha_base: base(h) });
      assert.deepEqual(classificado.motivos, []);
      assert.equal(classificado.resultado, "PASS", comMotivos(classificado));
      assert.deepEqual(classificado.classificados?.assinatura_isencoes, { contagem: 2, linhas_classificadas: 2 });
      for (const l of lidas) assert.ok(!JSON.stringify(classificado).includes(l), "a saída fica agregada: a impressão da linha não sai");
      const p2 = await ler([], { ponto: "P2", linha_base: base(h) });
      assert.deepEqual(p2.motivos, []);
      assert.equal(p2.resultado, "PASS", comMotivos(p2));
      await comoReplica(`UPDATE public.assinatura_isencoes SET documento_verificado = '98765432000199' WHERE empresa_id = '${UM}'`);
      { const lido = await ler([], { ponto: "P2", linha_base: base(h) }); assert.equal(lido.resultado, "PASS", comMotivos(lido, "documento fora do hash")); }
      await comoReplica(`UPDATE public.assinatura_isencoes SET concedida_em = '2020-01-01T00:00:00Z'`);
      const mudou = await ler([], { ponto: "P2", linha_base: base(h) });
      assert.deepEqual(mudou.motivos, ["LINHA_DE_BASE_MUDOU:assinatura_isencoes", "CLASSIFICACAO_DIVERGENTE:assinatura_isencoes"]);
      assert.equal(mudou.resultado, "FALHA", comMotivos(mudou));
      assert.ok(!JSON.stringify(mudou).includes("98765432000199"));
      await comoReplica("DELETE FROM public.assinatura_isencoes");
      // Contraprova do Astra: as duas linhas somem; a referência original reprova, e omiti-la também.
      const sumiu = await ler([], { ponto: "P2", linha_base: base(h) });
      assert.deepEqual(sumiu.motivos, ["LINHA_DE_BASE_MUDOU:assinatura_isencoes"]);
      assert.equal(sumiu.resultado, "FALHA", comMotivos(sumiu));
      const omitida = await ler([], { ponto: "P2", linha_base: {} });
      assert.ok(omitida.motivos.includes("LINHA_DE_BASE_SEM_OBJETO:assinatura_isencoes"), omitida.motivos.join());
      assert.equal(omitida.resultado, "FALHA", comMotivos(omitida));
      assert.deepEqual((await ler([], { ponto: "P2", linha_base: LB_ZERO })).motivos, [], "referência vazia declarada, tabela vazia");
    });

    await t.test("exceções: vigente reprova; revogada, vencida e extensão de teste passam com classificação", async () => {
      const inserir = (tipo: string, ate: string, rev: boolean) => comoReplica(`INSERT INTO public.empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por, criado_em${rev ? ", revogada_em, revogada_por, motivo_revogacao" : ""}) VALUES ('${UM}', '${tipo}', ${ate}, 'motivo de teste', '${UM}', now() - interval '30 days'${rev ? `, now(), '${UM}', 'revogacao de teste'` : ""})`);
      await inserir("CORTESIA", "now() + interval '10 days'", false);
      assert.ok((await ler([])).motivos.includes("EXCECAO_VIGENTE_NAO_TERMINAL"));
      await comoReplica("DELETE FROM public.empresa_excecoes_comerciais");
      await inserir("CORTESIA", "now() + interval '10 days'", true);
      await inserir("ACESSO_TEMPORARIO", "now() - interval '1 day'", false);
      await inserir("EXTENSAO_TESTE", "now() + interval '10 days'", false);
      const r = await ler([]);
      assert.deepEqual(r.motivos, ["CLASSIFICACAO_PENDENTE:empresa_excecoes_comerciais"]);
      await comoReplica("DELETE FROM public.empresa_excecoes_comerciais");
    });

    await t.test("cadastros: PENDENTE válido só reprova do P3 em diante; contagem por situação não muda depois", async () => {
      const inserir = (situacao: string, expira: string) => comoReplica(`INSERT INTO public.cadastros_publicos (criado_em, email, nome, senha_hash, token_hash, situacao, expira_em, termos_versao, termos_hash, privacidade_versao, privacidade_hash)
        VALUES (${expira} - interval '1 hour', md5(random()::text) || '@exemplo.test', 'Nome de teste', ${situacao === "PENDENTE" ? "'scrypt$x'" : "NULL"}, md5(random()::text) || md5(random()::text), '${situacao}', ${expira}, '2026-01-01', repeat('a', 64), '2026-01-01', repeat('a', 64))`);
      await inserir("PENDENTE", "now() + interval '1 hour'");
      assert.deepEqual((await ler([], { ponto: "P1" })).motivos, []);
      const p3 = await ler([], { ponto: "P3", linha_base: { assinatura_isencoes: { contagem: 0 } } });
      assert.ok(p3.motivos.includes("CADASTRO_PENDENTE_NAO_EXPIRADO"), p3.motivos.join());
      await comoReplica("DELETE FROM public.cadastros_publicos");
      await inserir("PENDENTE", "now() - interval '1 hour'");
      await inserir("SUBSTITUIDO", "now() + interval '1 hour'");
      const expirado = await ler([], { ponto: "P1" });
      assert.deepEqual(expirado.cadastros, { por_situacao: { PENDENTE: 1, SUBSTITUIDO: 1 }, pendentes_nao_expirados: 0 });
      assert.ok(!JSON.stringify(expirado).includes("@exemplo.test"));
      await comoReplica("DELETE FROM public.cadastros_publicos");
    });

    await t.test("auditoria: só desde o corte; classes; login não reprova; origem COBRANCA fora das listas reprova", async () => {
      const aud = (acao: string, origem: string, quando = "now()") => comoReplica(`INSERT INTO public.auditoria (ator_tipo, acao, entidade_tipo, entidade_id, origem, criado_em) VALUES ('SISTEMA', '${acao}', 'TESTE', '${UM}', '${origem}', ${quando})`);
      await aud("LOGIN", "ADMIN");
      assert.deepEqual((await ler([])).motivos, [], "login não reprova");
      await aud("ASSINATURA_CRIADA", "ADMIN", "'2020-01-01T00:00:00Z'");
      assert.deepEqual((await ler([])).motivos, [], "antes do corte não conta");
      await aud("COBRANCA_WEBHOOK_RECUSADO", "COBRANCA");
      const r = await ler([]);
      assert.deepEqual(r.motivos, ["AUDITORIA_PROIBIDA"]);
      assert.equal(r.auditoria!.classes.TENTATIVA_RECUSADA, 1);
      assert.equal(r.auditoria!.classes.EFEITO_ACEITO, 0);
      assert.equal(r.auditoria!.linhas_origem_cobranca, 1);
      await comoReplica("DELETE FROM public.auditoria WHERE acao = 'COBRANCA_WEBHOOK_RECUSADO'");
      await aud("ALGO_NOVO", "COBRANCA");
      assert.deepEqual((await ler([])).motivos, ["AUDITORIA_COBRANCA_SEM_CLASSE"]);
      await comoReplica(`DELETE FROM public.auditoria WHERE entidade_id = '${UM}'`);
    });

    await t.test("LDT e resultados do ponto S: S-PASS, S-REG, S-HIST, S-FALHA e marcador que não sai", async () => {
      const referencia = await ler([]);
      const base = { assinatura_isencoes: { contagem: 0, hash: referencia.dominio.assinatura_isencoes.hash }, empresa_excecoes_comerciais: { contagem: 0, hash: referencia.dominio.empresa_excecoes_comerciais.hash }, cadastros_empresas: { contagem: 0, hash: referencia.dominio.cadastros_empresas.hash } };
      const coberto = { ponto_inicial: "P1", contencao_continua: true, houve_fc_ou_perda_de_barreira: false };
      const noS = { ponto: "S", linha_base: base, cadastros_referencia: {}, historico: coberto };
      const pass = await ler([], noS);
      assert.deepEqual(pass.motivos, []);
      assert.equal(pass.resultado, "S-PASS", comMotivos(pass));
      assert.equal(pass.base, "VAZIO");
      const hist = await ler([], { ...noS, historico: undefined });
      assert.equal(hist.resultado, "S-HIST", comMotivos(hist));
      assert.equal(hist.marcador_perda_nao_descartada, true);
      const depois = await ler([], { ponto: "P9", linha_base: base, cadastros_referencia: {}, leitura_anterior: { marcador_perda_nao_descartada: true } });
      assert.equal(depois.resultado, "CONFORME", comMotivos(depois));
      assert.equal(depois.marcador_perda_nao_descartada, true, "releitura não apaga");
      await comoReplica(`INSERT INTO public.assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem, estado, tentado_em, enviado_em, id_externo) VALUES ('${UM}', '${UM}', 'PAGAMENTO_PENDENTE', now(), '${UM}', jsonb_build_object('para', 'a@exemplo.test', 'assunto', 'a', 'texto', 't', 'html', 'h', 'idempotencia', 'kidmais-aviso-assinatura/${UM}'), 'ENVIADO', now(), now(), 'teste-1')`);
      const comLinha = await ler([], noS);
      assert.deepEqual(comLinha.motivos, ["OBJETO_COM_LINHA:assinatura_avisos"]);
      assert.equal(comLinha.resultado, "S-FALHA", comMotivos(comLinha));
      const e = comLinha.dominio.assinatura_avisos;
      assert.deepEqual(e.situacoes, { ENVIADO: 1 });
      const ldt = { td_concluido: true, td_id: "TD-1", guarda_demonstrada: true, objetos: { assinatura_avisos: { contagem: 1, hash: e.hash, situacoes: e.situacoes } }, auditoria: [] };
      const reg = await ler([], { ...noS, ldt, barreira: barreira("PROVADA_NO_ARTEFATO") });
      assert.deepEqual(reg.motivos, []);
      assert.equal(reg.resultado, "S-REG", comMotivos(reg));
      assert.equal(reg.base, "LDT");
      { const lido = await ler([], { ...noS, ldt, barreira: barreira("PROVADA_NO_ARTEFATO"), historico: undefined }); assert.equal(lido.resultado, "S-HIST", comMotivos(lido)); }
      const semGuarda = await ler([], { ...noS, ldt });
      assert.deepEqual(semGuarda.motivos, ["LDT_SEM_GUARDA_NO_ARTEFATO"]);
      assert.equal(semGuarda.resultado, "S-FALHA", comMotivos(semGuarda));
      await comoReplica("UPDATE public.assinatura_avisos SET estado = 'DEVOLVIDO'");
      const divergiu = await ler([], { ...noS, ldt, barreira: barreira("PROVADA_NO_ARTEFATO") });
      assert.deepEqual(divergiu.motivos, ["LDT_DIVERGENTE:assinatura_avisos"]);
      await comoReplica("DELETE FROM public.assinatura_avisos");
      // Ocorrência de auditoria: identificador, ação e hora da linha real, ligada ao TD (§9.2.5).
      await comoReplica(`INSERT INTO public.auditoria (ator_tipo, acao, entidade_tipo, entidade_id, origem, criado_em) VALUES ('SISTEMA', 'ASSINATURA_CRIADA', 'TESTE', '${UM}', 'COBRANCA', '2026-03-04 05:06:07.123456+00')`);
      const comOcorrencia = await ler([], noS);
      const [ocorrencia] = comOcorrencia.auditoria!.ocorrencias_nao_tratadas as { id: string; acao: string; hora: string }[];
      assert.equal(ocorrencia.hora, "2026-03-04T05:06:07.123456Z", "microssegundos, em UTC");
      const ldtAud = (o: Decl) => ({ td_concluido: true, td_id: "TD-1", guarda_demonstrada: true, objetos: {}, auditoria: [{ ...ocorrencia, td: "TD-1", ...o }] });
      const comBarreira = { ...noS, barreira: barreira("PROVADA_NO_ARTEFATO") };
      const tratada = await ler([], { ...comBarreira, ldt: ldtAud({}) });
      assert.deepEqual(tratada.motivos, []);
      assert.equal(tratada.resultado, "S-REG", comMotivos(tratada));
      assert.deepEqual((await ler([], { ...comBarreira, ldt: ldtAud({ hora: "2026-03-04T05:06:07.123457Z" }) })).motivos, ["AUDITORIA_PROIBIDA"]);
      assert.deepEqual((await ler([], { ...comBarreira, ldt: ldtAud({ hora: undefined }) })).motivos, ["LDT_AUDITORIA_INCOMPLETA", "AUDITORIA_PROIBIDA"]);
      assert.deepEqual((await ler([], { ...comBarreira, ldt: ldtAud({ td: "TD-2" }) })).motivos, ["LDT_AUDITORIA_SEM_VINCULO_TD"]);
      await comoReplica(`DELETE FROM public.auditoria WHERE entidade_id = '${UM}'`);
      // Mesma contagem e mesmas situações: só o hash vê o estado trocado entre duas linhas.
      const DOIS = "00000000-0000-4000-8000-000000000002";
      const aviso = (id: string, marco: string, estado: string) => `INSERT INTO public.assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem, estado, tentado_em, enviado_em, id_externo) VALUES ('${id}', '${UM}', 'PAGAMENTO_PENDENTE', '${marco}', '${UM}', jsonb_build_object('para', 'a@exemplo.test', 'assunto', 'a', 'texto', 't', 'html', 'h', 'idempotencia', 'kidmais-aviso-assinatura/${id}'), '${estado}', now(), now(), 'teste-${id}')`;
      await comoReplica(aviso(UM, "2026-01-01T00:00:00Z", "ENVIADO"));
      await comoReplica(aviso(DOIS, "2026-02-01T00:00:00Z", "DEVOLVIDO"));
      const duas = (await ler([], noS)).dominio.assinatura_avisos;
      assert.deepEqual(duas.situacoes, { DEVOLVIDO: 1, ENVIADO: 1 });
      const ldtDuas = { td_concluido: true, td_id: "TD-1", guarda_demonstrada: true, objetos: { assinatura_avisos: { contagem: 2, hash: duas.hash, situacoes: duas.situacoes } }, auditoria: [] };
      { const lido = await ler([], { ...noS, ldt: ldtDuas, barreira: barreira("PROVADA_NO_ARTEFATO") }); assert.equal(lido.resultado, "S-REG", comMotivos(lido)); }
      await comoReplica(`UPDATE public.assinatura_avisos SET estado = CASE id WHEN '${UM}' THEN 'DEVOLVIDO' ELSE 'ENVIADO' END`);
      const trocado = await ler([], { ...noS, ldt: ldtDuas, barreira: barreira("PROVADA_NO_ARTEFATO") });
      assert.deepEqual(trocado.dominio.assinatura_avisos.situacoes, duas.situacoes);
      assert.deepEqual(trocado.motivos, ["LDT_DIVERGENTE:assinatura_avisos"]);
      await comoReplica("DELETE FROM public.assinatura_avisos");
      await assert.rejects(cg.conferir({ versao: 1, ponto: "P3", alvo: "teste", corte_p1: CORTE, prefixo: prefixoDe([]), ldt }, { env: {}, Client: clienteDescartavel(), lerMarcador, listarPasta: () => [] }), { message: "LDT_ANTES_DO_S" });
    });

    await t.test("cada prefixo do runbook: não declarada reprova, declarada passa, até o fim da sequência", async () => {
      const aplicadas: string[] = [];
      // R3-02: o esquema inteiro antes e depois de cada migration. Só pode mudar o que está ancorado; o tipo de array implícito de uma
      // tabela nova e a sequência da coluna identity pertencem à relação (a coluna já está na estrutura dela).
      const esquema = async () => {
        await c.query("BEGIN"); await c.query("SET LOCAL search_path = pg_catalog");
        try {
          const linhas: Record<string, string[]> = {};
          for (const r of (await c.query<{ n: string; linha: string }>(`SELECT c.relname AS n, e.linha FROM pg_class c CROSS JOIN LATERAL (${cg.linhasEstrutura("c.oid")}) e
            WHERE c.relnamespace = to_regnamespace('public') AND c.relkind IN ('r','p')`)).rows) (linhas[r.n] ??= []).push(r.linha);
          const rels = new Map(Object.entries(linhas).map(([n, l]) => [`relacao:${n}`, cg.hashLinhas(l) as string]));
          const fns = new Map((await c.query<{ n: string; h: string }>(`SELECT p.proname AS n, encode(sha256(convert_to(string_agg(encode(sha256(convert_to(replace(pg_get_functiondef(p.oid), E'\\r', ''), 'UTF8')), 'hex'), E'\\n' ORDER BY pg_get_function_identity_arguments(p.oid) COLLATE "C"), 'UTF8')), 'hex') AS h
            FROM pg_proc p WHERE p.pronamespace = to_regnamespace('public') AND p.prokind <> 'a' GROUP BY p.proname`)).rows.map((r) => [`funcao:${r.n}`, r.h]));
          const outros = new Set((await c.query<{ n: string }>(`SELECT 'classe:' || c.relkind::text || ':' || c.relname AS n FROM pg_class c WHERE c.relnamespace = to_regnamespace('public') AND c.relkind NOT IN ('r','p','i')
            UNION ALL SELECT 'tipo:' || t.typtype::text || ':' || t.typname FROM pg_type t WHERE t.typnamespace = to_regnamespace('public') AND t.typtype IN ('d','e','r','m','b')
            UNION ALL SELECT 'agregado:' || p.proname FROM pg_proc p WHERE p.pronamespace = to_regnamespace('public') AND p.prokind = 'a'
            UNION ALL SELECT 'esquema:' || n.nspname FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
            UNION ALL SELECT 'extensao:' || e.extname FROM pg_extension e`)).rows.map((r) => r.n));
          return { itens: new Map([...rels, ...fns]), outros };
        } finally { await c.query("COMMIT"); }
      };
      const ancoradas = new Set(cg.ANCORAS as string[]);
      const pertence = (n: string) => { const a = /^tipo:b:_(.+)$/.exec(n); if (a) return ancoradas.has(`relacao:${a[1]}`); const q = /^classe:S:(.+)_id_seq$/.exec(n); return Boolean(q && ancoradas.has(`relacao:${q[1]}`)); };
      let antes = await esquema();
      // R5-01: restore no prefixo base e o resto da sequência no restaurado. Em k=2 a relação mistura a forma restaurada (CHECK da base) e a
      // da migration (CHECK recriada pela 092): as duas, mudadas em valor, reprovam; em k=10, o mesmo para a CHECK achatada da mcp_oauth.
      await restoreEAvanca(c, [], async (k, feitas, lido) => {
        if (k === 2) {
          const precos = lido.linhas.precos_pacote ?? [];
          assert.ok(precos.some((l) => l.startsWith("restricao|precos_pacote_categoria_check|") && l.includes("ANY (ARRAY[('GERAL'::character varying)::text")), "categoria na forma restaurada");
          assert.ok(precos.some((l) => l.startsWith("restricao|precos_pacote_tipo_calculo_check|") && l.includes("'PONTO'::character varying])::text[]")), "tipo na forma da migration");
          await materialReprova(feitas, "precos_pacote", "precos_pacote_categoria_check", (d) => d.replace("('NOBRE'::character varying)::text", "('NOBRE'::character varying)::text, ('OUTRO'::character varying)::text"));
          await materialReprova(feitas, "precos_pacote", "precos_pacote_tipo_calculo_check", (d) => d.replace("'PONTO'::character varying]", "'PONTO'::character varying, 'OUTRO'::character varying]"));
        }
        if (k === 10) await materialReprova(feitas, "mcp_oauth_concessoes", "mcp_oauth_concessoes_escopos_check", (d) => d.replace("<= 3", "<= 4"));
      });
      for (const id of SEQUENCIA) {
        await aplicarMigracoes(c, [id]);
        const depois = await esquema();
        const mudou = [...new Set([...antes.itens.keys(), ...depois.itens.keys()])].filter((k) => antes.itens.get(k) !== depois.itens.get(k)).sort();
        assert.deepEqual(mudou.filter((k) => !ancoradas.has(k)), [], `${id}: mudança fora das âncoras`);
        const k = aplicadas.length + 1;
        assert.deepEqual(mudou, mudamEntre(k - 1, k), `${id}: o que mudou é o que a trajetória medida diz`);
        assert.deepEqual([...depois.outros].filter((n) => !antes.outros.has(n) && !pertence(n)), [], `${id}: objeto novo fora das relações`);
        assert.deepEqual([...antes.outros].filter((n) => !depois.outros.has(n)), [], `${id}: objeto removido`);
        antes = depois;
        const naoDeclarada = await ler(aplicadas);
        assert.ok(naoDeclarada.motivos.some((m) => m.startsWith(`MIGRATION_${id}_COMPLETA_NAO_DECLARADA`)), `${id}: ${naoDeclarada.motivos.join()}`);
        assert.equal(naoDeclarada.resultado, "FALHA", comMotivos(naoDeclarada, id));
        aplicadas.push(id);
        const declarada = await ler(aplicadas);
        assert.deepEqual(declarada.motivos, [], `${id}: ${declarada.motivos.join()}`);
        assert.equal(declarada.resultado, "PASS", comMotivos(declarada, id));
        assert.equal(declarada.migracoes[id], "completa", id);
        // R4-02: restore fiel logo depois da 097 (k=8) e no fim (k=10); a CHECK achatada pela reanálise passa, outra definição não.
        if (aplicadas.length === 8) {
          assert.equal(id, "097");
          await restoreFiel(c, aplicadas, "k8");
          await materialReprova(aplicadas, "assinatura_arrependimentos", "assinatura_arrependimentos_restituicao_cobranca_ids_check", (d) => d.replace("<= 50", "<= 51"));
          await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`);
        }
        if (aplicadas.length === 10) {
          await restoreFiel(c, aplicadas, "k10");
          await materialReprova(aplicadas, "fechamentos", "fechamentos_buffet_status_check", (d) => d.replace("('DEFINIDO'::character varying)::text", "('DEFINIDO'::character varying)::text, ('OUTRO'::character varying)::text"));
          // Índice parcial e gatilho no restaurado também reprovam.
          const idx = (await noRollback("SELECT pg_get_indexdef('public.fechamento_revisoes_aberta_uk'::regclass) AS d")).rows[0].d;
          assert.notEqual(idx.replace(", ('CONGELADA'::character varying)::text", ""), idx, "forma restaurada do índice");
          await noRollback("DROP INDEX public.fechamento_revisoes_aberta_uk");
          await noRollback(idx.replace(", ('CONGELADA'::character varying)::text", "")); // parcial mais estreito: não viola unicidade
          const indice = await lerRestoreEm(aplicadas, ROLLBACK);
          assert.equal(indice.resultado, "INCONCLUSIVO", comMotivos(indice, "índice"));
          assert.ok(indice.motivos.includes("FORA_DO_PREFIXO:relacao:fechamento_revisoes"), comMotivos(indice, "índice"));
          await noRollback("DROP INDEX public.fechamento_revisoes_aberta_uk"); await noRollback(idx);
          const [gTabela, gNome] = (cg.GATILHOS as Record<string, [string, string, string][]>)["095"][0];
          await noRollback(`ALTER TABLE public.${gTabela} DISABLE TRIGGER ${gNome}`);
          const gatilho = await lerRestoreEm(aplicadas, ROLLBACK);
          assert.equal(gatilho.resultado, "INCONCLUSIVO", comMotivos(gatilho, "gatilho"));
          assert.ok(gatilho.motivos.includes(`FORA_DO_PREFIXO:relacao:${gTabela}`), comMotivos(gatilho, "gatilho"));
          await noRollback(`ALTER TABLE public.${gTabela} ENABLE TRIGGER ${gNome}`);
          assert.deepEqual((await lerRestoreEm(aplicadas, ROLLBACK)).motivos, [], "reposto");
          await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`);
        }
        // R5-01: restore neste prefixo e o resto da sequência no restaurado (j = 1..10; j = 0 antes do laço).
        await restoreEAvanca(c, aplicadas);
      }
      // A 100 sem a marca do corpo (094 ainda não trocada) é detectada pelo corpo real, já na leitura acima.
      const final = await ler(aplicadas);
      assert.deepEqual(final.motivos, []);
      assert.deepEqual(final.identidade.prefixo_declarado, SEQUENCIA);
    });

    await t.test("prefixo final: objetos da sequência com linha reprovam, crédito abre a causa", async () => {
      const referencia = await ler(SEQUENCIA);
      assert.equal(referencia.dominio.ia_credito_lotes.contagem, 0);
      // R4-04: a sequência identity do extrato da 095 entra na assinatura da relação. MAXVALUE 2 deixaria o terceiro nextval em 2200H.
      for (const [muda, volta] of [["MAXVALUE 2", "NO MAXVALUE"], ["INCREMENT BY 2", "INCREMENT BY 1"], ["CYCLE", "NO CYCLE"], ["CACHE 5", "CACHE 1"], ["MINVALUE 0", "MINVALUE 1"]]) {
        await c.query(`ALTER SEQUENCE public.ia_credito_lancamentos_id_seq ${muda}`);
        try {
          const r = await ler(SEQUENCIA);
          assert.equal(r.resultado, "FALHA", comMotivos(r, muda));
          assert.ok(r.motivos.includes("FORA_DO_PREFIXO:relacao:ia_credito_lancamentos"), comMotivos(r, muda));
          const r2 = await lerRestoreEm(SEQUENCIA);
          assert.equal(r2.resultado, "INCONCLUSIVO", comMotivos(r2, muda));
          assert.ok(r2.motivos.includes("RESTORE_DIVERGENTE") && r2.motivos.includes("FORA_DO_PREFIXO:relacao:ia_credito_lancamentos"), comMotivos(r2, muda));
        } finally { await c.query(`ALTER SEQUENCE public.ia_credito_lancamentos_id_seq ${volta}`); }
        assert.deepEqual((await ler(SEQUENCIA)).motivos, [], `${muda}: reposta`);
      }
      // Guardas da sequência, inclusive as 22 da 095: cada uma desabilitada reprova.
      for (const [id, guardas] of Object.entries(cg.GATILHOS as Record<string, [string, string, string][]>)) if (!cg.BASE.includes(id)) for (const [tabela, g] of guardas) {
        await c.query(`ALTER TABLE public.${tabela} DISABLE TRIGGER ${g}`);
        try {
          const r = await ler(SEQUENCIA);
          const e = guardaDesligada(id, tabela, g);
          assert.deepEqual(ordenados(r.motivos), ordenados([`MIGRATION_${id}_PARCIAL_ESPERADA`, ...Object.keys(e.extra).map((m) => `MIGRATION_${m}_PARCIAL_ESPERADA`), ...e.ancoras.map((a) => `FORA_DO_PREFIXO:${a}`)]), g);
          assert.deepEqual(r.estrutura_detalhe?.[id], e.itens, g);
        } finally { await c.query(`ALTER TABLE public.${tabela} ENABLE TRIGGER ${g}`); }
      }
      // Um gatilho da 095 habilitado, mas preso a outra função; depois movido para outra tabela: o total continua 22.
      const def095 = (await c.query<{ d: string }>("SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'ia_credito_lotes_095_guarda_trg' AND tgrelid = 'public.ia_credito_lotes'::regclass")).rows[0].d;
      const presoAOutra = def095.replace(/(public\.)?kidmais_095_guarda\(\)/, "public.kidmais_074_registro_guarda()");
      assert.notEqual(presoAOutra, def095);
      await c.query("DROP TRIGGER ia_credito_lotes_095_guarda_trg ON public.ia_credito_lotes");
      await c.query(presoAOutra);
      try {
        const r = await ler(SEQUENCIA);
        assert.deepEqual(r.motivos, ["MIGRATION_095_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:relacao:ia_credito_lotes"]);
        assert.deepEqual(r.estrutura_detalhe?.["095"], ["estrutura_ia_credito_lotes"]);
      } finally { await c.query("DROP TRIGGER ia_credito_lotes_095_guarda_trg ON public.ia_credito_lotes"); await c.query(def095); }
      await c.query("DROP TRIGGER ia_credito_lotes_095_guarda_trg ON public.ia_credito_lotes");
      await c.query("CREATE TRIGGER ia_credito_lotes_095_guarda_trg BEFORE INSERT ON public.ia_credito_pedidos FOR EACH ROW EXECUTE FUNCTION public.kidmais_095_guarda()");
      try {
        const r = await ler(SEQUENCIA);
        assert.deepEqual(r.motivos, ["MIGRATION_095_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:relacao:ia_credito_lotes", "FORA_DO_PREFIXO:relacao:ia_credito_pedidos"]);
        assert.deepEqual(r.estrutura_detalhe?.["095"], ["estrutura_ia_credito_lotes", "estrutura_ia_credito_pedidos", "gatilho_ia_credito_lotes_095_guarda_trg"]);
      } finally { await c.query("DROP TRIGGER ia_credito_lotes_095_guarda_trg ON public.ia_credito_pedidos"); await c.query(def095); }
      // Função auxiliar que a restrição da 091 chama, com o corpo trocado.
      const defAuxiliar = (await c.query<{ d: string }>("SELECT pg_get_functiondef('public.kidmais_091_documento_valido(text)'::regprocedure) AS d")).rows[0].d;
      await c.query("CREATE OR REPLACE FUNCTION public.kidmais_091_documento_valido(doc text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN true; END $f$");
      try {
        const r = await ler(SEQUENCIA);
        assert.deepEqual(r.motivos, ["MIGRATION_091_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:funcao:kidmais_091_documento_valido"]);
        assert.deepEqual(r.estrutura_detalhe?.["091"], ["funcao_kidmais_091_documento_valido"]);
      } finally { await c.query(defAuxiliar); }
      // R3-01, contraprova do Astra: mesmo corpo, com SET search_path e uma ascii(text) falsa em public.
      const lerRestoreFinal = () => cg.conferir({ versao: 1, ponto: "R2", alvo: "isolado", corte_p1: CORTE, prefixo: { fonte: "restore", registro: { ponto: CORTE, origem: "backup de teste" }, itens: SEQUENCIA.map((migracao) => ({ migracao })) }, barreira: barreira(), provedor, linha_base: LB_ZERO, cadastros_referencia: {} },
        { env: { DATABASE_URL: "postgresql://x@127.0.0.1:1/x" }, Client: clienteDescartavel() }) as Promise<Rel>;
      { const lido = await lerRestoreFinal(); assert.equal(lido.resultado, "CONFORME", comMotivos(lido)); }
      await c.query("CREATE FUNCTION public.ascii(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 48'");
      await c.query("ALTER FUNCTION public.kidmais_091_documento_valido(text) SET search_path TO public, pg_catalog");
      try {
        const r = await ler(SEQUENCIA);
        assert.equal(r.resultado, "FALHA", comMotivos(r));
        assert.deepEqual(r.motivos, ["MIGRATION_091_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:funcao:kidmais_091_documento_valido"]);
        assert.deepEqual(r.estrutura_detalhe?.["091"], ["funcao_kidmais_091_documento_valido"]);
        const restore = await lerRestoreFinal();
        assert.equal(restore.resultado, "INCONCLUSIVO", comMotivos(restore));
        assert.deepEqual(restore.motivos, ["RESTORE_DIVERGENTE", "MIGRATION_091_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:funcao:kidmais_091_documento_valido"]);
      } finally {
        await c.query(defAuxiliar);
        await c.query("DROP FUNCTION public.ascii(text)");
      }
      for (const muda of ["SECURITY DEFINER", "VOLATILE", "RESET search_path"]) {
        await c.query(`ALTER FUNCTION public.kidmais_091_documento_valido(text) ${muda}`);
        try { assert.deepEqual((await ler(SEQUENCIA)).motivos, ["MIGRATION_091_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:funcao:kidmais_091_documento_valido"], muda); } finally { await c.query(defAuxiliar); }
      }
      // Mesma semântica em outra linguagem: outra função.
      await c.query("CREATE OR REPLACE FUNCTION public.kidmais_091_documento_valido(doc text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT doc IS NOT NULL $f$");
      try { assert.deepEqual((await ler(SEQUENCIA)).motivos, ["MIGRATION_091_PARCIAL_ESPERADA", "FORA_DO_PREFIXO:funcao:kidmais_091_documento_valido"]); } finally { await c.query(defAuxiliar); }
      assert.deepEqual((await ler(SEQUENCIA)).motivos, []);
      // R3-02, contraprova do Astra: 091 declarada e aplicada, mas o CHECK da relação auxiliar revertido ao de antes da 091.
      assert.ok(defSolicitacaoAntes, "definição de antes da 091, lida na base");
      const defSolicitacaoDepois = (await c.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'solicitacoes_documento_check' AND conrelid = 'public.solicitacoes_acesso_empresa'::regclass")).rows[0].d;
      assert.notEqual(defSolicitacaoDepois, defSolicitacaoAntes);
      await c.query(`ALTER TABLE public.solicitacoes_acesso_empresa DROP CONSTRAINT solicitacoes_documento_check, ADD CONSTRAINT solicitacoes_documento_check ${defSolicitacaoAntes}`);
      try {
        const r = await ler(SEQUENCIA);
        assert.equal(r.resultado, "FALHA", comMotivos(r));
        assert.deepEqual(r.motivos, ["FORA_DO_PREFIXO:relacao:solicitacoes_acesso_empresa"]);
        assert.deepEqual(r.fora_do_prefixo?.map((f) => f.item), ["relacao:solicitacoes_acesso_empresa"]);
        const restore = await lerRestoreFinal();
        assert.equal(restore.resultado, "INCONCLUSIVO", comMotivos(restore));
        assert.deepEqual(restore.motivos, ["RESTORE_DIVERGENTE", "FORA_DO_PREFIXO:relacao:solicitacoes_acesso_empresa"]);
      } finally { await c.query(`ALTER TABLE public.solicitacoes_acesso_empresa DROP CONSTRAINT solicitacoes_documento_check, ADD CONSTRAINT solicitacoes_documento_check ${defSolicitacaoDepois}`); }
      // Prefixo reduzido: tudo aplicado, a 091 fora da declaração. Reprova pela migration e por cada âncora que a 091 muda; restore idem.
      const reduzido = await ler(SEQUENCIA.slice(0, 9));
      assert.equal(reduzido.resultado, "FALHA", comMotivos(reduzido));
      assert.deepEqual(reduzido.motivos, ["MIGRATION_091_COMPLETA_NAO_DECLARADA", ...mudamEntre(9, 10).map((i) => `FORA_DO_PREFIXO:${i}`), "OBJETO_NAO_DECLARADO:empresa_documento_continuidades"]);
      assert.ok(mudamEntre(9, 10).includes("relacao:solicitacoes_acesso_empresa"));
      const restoreReduzido = await (cg.conferir({ versao: 1, ponto: "R2", alvo: "isolado", corte_p1: CORTE, prefixo: { fonte: "restore", registro: { ponto: CORTE, origem: "backup de teste" }, itens: SEQUENCIA.slice(0, 9).map((migracao) => ({ migracao })) }, barreira: barreira(), provedor, linha_base: LB_ZERO, cadastros_referencia: {} },
        { env: { DATABASE_URL: "postgresql://x@127.0.0.1:1/x" }, Client: clienteDescartavel() }) as Promise<Rel>);
      assert.equal(restoreReduzido.resultado, "INCONCLUSIVO", comMotivos(restoreReduzido));
      assert.deepEqual(restoreReduzido.motivos, ["RESTORE_DIVERGENTE", "MIGRATION_091_COMPLETA_NAO_DECLARADA", ...mudamEntre(9, 10).map((i) => `FORA_DO_PREFIXO:${i}`)]);
      assert.deepEqual((await ler(SEQUENCIA)).motivos, []);
      // Cada coluna lida dos objetos da sequência, como na base.
      const objetosSeq = (cg.MATRIZ as { objeto: string; migracao: string }[]).filter((m) => !cg.BASE.includes(m.migracao));
      for (const { objeto, migracao } of objetosSeq) for (const coluna of cg.colunasLidas(objeto) as string[]) {
        await c.query(`ALTER TABLE public.${objeto} RENAME COLUMN ${coluna} TO ${coluna}_x`);
        try {
          const r = await ler(SEQUENCIA);
          assert.ok(r.motivos.includes(`MIGRATION_${migracao}_PARCIAL_ESPERADA`), `${objeto}.${coluna}: ${r.motivos.join()}`);
          assert.ok(r.motivos.includes(`FORA_DO_PREFIXO:relacao:${objeto}`), `${objeto}.${coluna}: ${r.motivos.join()}`);
          assert.ok(r.motivos.every((m) => /^MIGRATION_[0-9a]+_PARCIAL_ESPERADA$/.test(m) || m.startsWith("FORA_DO_PREFIXO:relacao:")), `${objeto}.${coluna}: ${r.motivos.join()}`); // coluna referenciada por FK muda também a relação que a referencia
          assert.deepEqual(r.estrutura_detalhe?.[migracao]?.filter((i) => i === `colunas_${objeto}` || i === `estrutura_${objeto}`), [`colunas_${objeto}`, `estrutura_${objeto}`], `${objeto}.${coluna}`);
        } finally { await c.query(`ALTER TABLE public.${objeto} RENAME COLUMN ${coluna}_x TO ${coluna}`); }
      }
      // Com linha na tabela: a coluna ausente continua motivo estrutural, não vira 42703 na leitura do hash ou da situação.
      await comoReplica(`INSERT INTO public.assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem, estado, tentado_em, enviado_em, id_externo) VALUES ('${UM}', '${UM}', 'PAGAMENTO_PENDENTE', now(), '${UM}', jsonb_build_object('para', 'a@exemplo.test', 'assunto', 'a', 'texto', 't', 'html', 'h', 'idempotencia', 'kidmais-aviso-assinatura/${UM}'), 'ENVIADO', now(), now(), 'teste-1')`);
      await c.query("ALTER TABLE public.assinatura_avisos RENAME COLUMN estado TO estado_x");
      try {
        const r = await ler(SEQUENCIA);
        const migracaoAvisos = (cg.MATRIZ as { objeto: string; migracao: string }[]).find((m) => m.objeto === "assinatura_avisos")!.migracao;
        assert.equal(r.resultado, "FALHA", comMotivos(r));
        assert.ok(r.motivos.includes(`MIGRATION_${migracaoAvisos}_PARCIAL_ESPERADA`), r.motivos.join());
        assert.equal(r.dominio.assinatura_avisos.contagem, 1);
        assert.equal(r.dominio.assinatura_avisos.hash, undefined);
        assert.equal(r.dominio.assinatura_avisos.situacoes, undefined);
      } finally { await c.query("ALTER TABLE public.assinatura_avisos RENAME COLUMN estado_x TO estado"); }
      await comoReplica("DELETE FROM public.assinatura_avisos");
      const lote = (origem: string, chave: string, pedido: string, preco: string) => comoReplica(`INSERT INTO public.ia_credito_lotes (empresa_id, recurso, origem, chave_origem, quantidade, disponivel, preco_centavos, pedido_id, vence_em) VALUES ('${UM}', 'CONVITES', '${origem}', '${chave}', 1, 1, ${preco}, ${pedido}, now() + interval '1 day')`);
      await lote("CORTESIA", "CORTESIA:1", "NULL", "NULL");
      assert.deepEqual((await ler(SEQUENCIA)).motivos, ["OBJETO_COM_LINHA:ia_credito_lotes", "CREDITO_BARREIRA_PERDIDA"]);
      await comoReplica("DELETE FROM public.ia_credito_lotes");
      await lote("COMPRA", "COMPRA:1", `'${UM}'`, "100");
      assert.deepEqual((await ler(SEQUENCIA)).motivos, ["OBJETO_COM_LINHA:ia_credito_lotes", "CREDITO_COM_DADOS"]);
      await comoReplica("DELETE FROM public.ia_credito_lotes");
      await comoReplica(`INSERT INTO public.empresa_documento_continuidades (empresa_id, tipo, documento_anterior, documento_novo, nome_novo, instrumento, evidencias, data_efetiva, condicoes, situacao, registrada_por)
        VALUES ('${UM}', 'CESSAO', '12345678909', '12345678000199', 'Nome novo', 'instrumento de teste', 'evidencias de teste', current_date, '{}', 'PENDENTE_PROVEDOR', '${UM}')`);
      const r = await ler(SEQUENCIA);
      assert.ok(r.motivos.includes("CONTINUIDADE_NAO_CONCLUIDA"), r.motivos.join());
      await comoReplica("DELETE FROM public.empresa_documento_continuidades");
      assert.deepEqual(semMigration((await ler(SEQUENCIA)).motivos), []);
    });
  } finally {
    await c.query(`DROP OWNED BY ${PAPEL_LEITOR}`).catch(() => undefined);
    await c.query(`DROP ROLE IF EXISTS ${PAPEL_LEITOR}`).catch(() => undefined);
    await c.query(`DROP DATABASE IF EXISTS ${ROLLBACK}`).catch(() => undefined);
    rmSync(pastaDumps, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
