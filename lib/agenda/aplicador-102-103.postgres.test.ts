import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 27/10/2026 — APLICADOR REAL da 102/103 (scripts/migration-102-103-staging.cjs) no PostgreSQL descartável (parecer do
 * Astra da mesma data, P2-5). Modelo 097 com a 100 aplicada aqui (o estado do staging: 093–097 e 100, sem a 098, sem a
 * 102/103) e modelo 098 (recusa). Única substituição: o cliente do aplicador conecta ao cluster descartável e responde à
 * consulta de identidade como o banco de staging. Toda recusa compara a IMPRESSÃO do schema public e dos dados globais
 * tocados (antes = depois). Casos no modelo 097 + 100:
 *   1. conferência só leitura → PRONTA, versão 18, nada muda;
 *   2. 021 "ausente" (adicional_categorias renomeada) → RECUSARIA nomeada (código 3), não erro de SQL;
 *   3. 102 parcial (uma coluna da 102 criada à mão) → RECUSARIA/FALHA sem escrever;
 *   4. papel NÃO superusuário com exatamente o mínimo (dono de agenda_saloes, USAGE/CREATE em public, REFERENCES em
 *      usuarios_administrativos, SELECT/INSERT/UPDATE em adicional_categorias): cada privilégio retirado ISOLADAMENTE
 *      gera a recusa nomeada dele; outro papel sem ser dono → DONO; com o mínimo, APLICA as duas;
 *   5. down das duas (só no descartável) volta ao estado inicial;
 *   6. falha REAL da 103 depois do COMMIT da 102 (adicional_categorias travada por outra sessão → lock_timeout): 102
 *      CONFIRMADO, 103 NAO_COMMITADA; segunda tentativa recusa pelo marcador; marcador renomeado → retomada aplica só a 103;
 *   7. deriva SEMÂNTICA com as mesmas contagens (CHECK da 102 trocado por CHECK(true), mesmo nome, validado) →
 *      conferência RECUSARIA (INTEGRIDADE_102 false); definição restaurada → JA_APLICADA;
 *   8. SERVICOS divergente com a 102 completa → RECUSARIA.
 * Evidências (opcional): KIDMAIS_APLICADOR_102_103_EVIDENCIAS=<pasta> recebe os marcadores, a versão e o hash do retrato.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; etapas?: string[];
  estado?: Record<string, unknown>; checks?: Record<string, string>; commits?: Record<string, string>; commitadas?: string[]; marcador?: string };
type Aplicador = { SQL_IDENTIDADE: string; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-102-103-staging.cjs")) as Aplicador;
// Configuração FICTÍCIA: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
const MINIMO = "kidmais_teste_minimo_102_103", OUTRO = "kidmais_teste_outro_102_103";
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const M100 = "database/migrations/20261025_100_agenda_um_salao.sql";
const DOWN102 = "database/rollback/20261025_102_saloes_apresentacao_down.sql";
const DOWN103 = "database/rollback/20261025_103_adicionais_servicos_down.sql";
const RETRATO = "database/checks/20261025_102_retrato.sql";

function clienteDescartavel(cfg: { papel?: string } = {}) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      this.c.on("error", () => undefined);
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(q: string) { return q === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(q); }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("aplicador 102/103 real: recusas nomeadas, papel mínimo não superusuário, falha da 103 após a 102, retomada, deriva semântica", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const evid = process.env.KIDMAIS_APLICADOR_102_103_EVIDENCIAS;
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-102-103-")); dirs.push(d); return d; };
  const guardar = (nome: string, d: string) => {
    if (!evid) return;
    mkdirSync(join(evid, nome), { recursive: true });
    for (const f of readdirSync(d)) copyFileSync(join(d, f), join(evid, nome, f));
  };
  const BACKUP = "export 2026-10-27T12:00Z teste";
  const executar = (dir = novoDir(), papel?: string) => stg.executar({ env: ENV_STG, backup: BACKUP, dir, raiz, disco: () => {}, Client: clienteDescartavel({ papel }) });
  const conferir = (papel?: string) => stg.conferir({ env: ENV_STG, raiz, Client: clienteDescartavel({ papel }) });
  /**
   * Impressão do schema public (tabelas/colunas/constraints/gatilhos/funções e donos) e dos dados globais tocados. Sem ACL:
   * o aplicador nunca concede nem revoga, e os GRANT/REVOKE do caso 4 deixam ACL explícita equivalente ao padrão.
   */
  const impressao = async () => {
    const cat = (await c.query<{ ok: boolean }>("SELECT to_regclass('public.adicional_categorias') IS NOT NULL AS ok")).rows[0].ok ? "adicional_categorias" : "adicional_categorias_fora_102_103";
    return (await c.query<{ h: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', cl.relname, cl.relkind, pg_get_userbyid(cl.relowner)), ',' ORDER BY cl.relname)
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', cl.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY cl.relname, a.attname)
         FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT string_agg(concat_ws(':', conname, pg_get_constraintdef(k.oid)), ',' ORDER BY conname, k.oid)
         FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', tgname, pg_get_triggerdef(tg.oid)), ',' ORDER BY tgname) FROM pg_trigger tg WHERE NOT tgisinternal),
      (SELECT string_agg(concat_ws(':', p.proname, md5(p.prosrc), pg_get_userbyid(p.proowner)), ',' ORDER BY p.proname, p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      (SELECT string_agg(concat_ws(':', codigo, nome, ativo, arquivado_em), ',' ORDER BY codigo)
         FROM ${cat}),
      (SELECT count(*) FROM agenda_saloes))) AS h`)).rows[0].h;
  };
  const objetos = async () => (await c.query<{ fotos: boolean; servicos: number }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NOT NULL AS fotos,
    (SELECT count(*)::int FROM adicional_categorias WHERE codigo = 'SERVICOS') AS servicos`)).rows[0];
  /** Recusa: conferência código 3 com o motivo e aplicação FALHA sem commit; a impressão não muda. */
  const recusa = async (motivo: RegExp, papel?: string) => {
    const antes = await impressao();
    const r = await conferir(papel);
    assert.equal(r.resultado, "RECUSARIA", JSON.stringify(r)); assert.match(r.motivo!, motivo);
    const e = await executar(novoDir(), papel);
    assert.equal(e.resultado, "FALHA", JSON.stringify(e)); assert.match(e.falha!.mensagem, motivo); assert.deepEqual(e.commitadas, []);
    assert.equal(await impressao(), antes, "nada mudou: " + motivo.source);
  };
  const admin = (await c.query<{ u: string }>("SELECT current_user AS u")).rows[0].u.replace(/"/g, '""');
  try {
    const com098 = (await c.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_hoje()') IS NOT NULL AS ok`)).rows[0].ok;
    if (com098) { await recusa(/COM_098_102/); return; }
    await c.query(sql(M100));
    assert.deepEqual(await objetos(), { fotos: false, servicos: 0 }, "102 e 103 ausentes");
    if (evid) { mkdirSync(evid, { recursive: true }); writeFileSync(join(evid, "versao.txt"), (await c.query<{ v: string }>("SELECT version() AS v")).rows[0].v + "\n"); }

    // 1. Conferência só leitura.
    const antes = await impressao();
    const conf = await conferir();
    assert.equal(conf.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(conf));
    assert.deepEqual(conf.checks, { "precheck 102": "PASS", "precheck 103": "PASS" });
    assert.equal(Math.floor(Number(conf.estado!.versao_pg) / 10000), 18, "cluster descartável na versão maior 18");
    assert.equal(await impressao(), antes);

    // 2. 021 "ausente": a guarda do catálogo recusa nomeada (antes, a consulta quebrava ao ler a tabela).
    await c.query("ALTER TABLE adicional_categorias RENAME TO adicional_categorias_fora_102_103");
    try { await recusa(/DEPENDENCIA_AUSENTE_103 021/); }
    finally { await c.query("ALTER TABLE adicional_categorias_fora_102_103 RENAME TO adicional_categorias"); }

    // 3. 102 parcial.
    await c.query("ALTER TABLE agenda_saloes ADD COLUMN frase text");
    try { await recusa(/APLICACAO_PARCIAL_102/); }
    finally { await c.query("ALTER TABLE agenda_saloes DROP COLUMN frase"); }
    assert.equal(await impressao(), antes, "estado inicial restaurado");

    // 4. Papel mínimo não superusuário; cada privilégio retirado isoladamente.
    for (const p of [MINIMO, OUTRO]) await c.query(`DROP ROLE IF EXISTS ${p}`);
    await c.query(`CREATE ROLE ${MINIMO} NOLOGIN NOSUPERUSER`);
    await c.query(`CREATE ROLE ${OUTRO} NOLOGIN NOSUPERUSER`);
    try {
      for (const p of [MINIMO, OUTRO]) {
        await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${p}`);
        await c.query(`GRANT REFERENCES ON usuarios_administrativos TO ${p}`);
        await c.query(`GRANT SELECT, INSERT, UPDATE ON adicional_categorias TO ${p}`);
      }
      await c.query(`GRANT SELECT, TRIGGER, REFERENCES ON agenda_saloes TO ${OUTRO}`);
      await c.query(`ALTER TABLE agenda_saloes OWNER TO ${MINIMO}`);
      const pronta = await conferir(MINIMO);
      assert.equal(pronta.resultado, "PRONTA_PARA_APLICAR", JSON.stringify(pronta));
      assert.equal(pronta.estado!.papel_trocado, true);
      await recusa(/SEM_PRIVILEGIO_102 DONO$/, OUTRO);
      for (const [revogar, conceder, motivo] of [
        [`REVOKE TRIGGER ON agenda_saloes FROM ${MINIMO}`, `GRANT TRIGGER ON agenda_saloes TO ${MINIMO}`, /SEM_PRIVILEGIO_102 TRIGGER$/],
        [`REVOKE REFERENCES ON agenda_saloes FROM ${MINIMO}`, `GRANT REFERENCES ON agenda_saloes TO ${MINIMO}`, /SEM_PRIVILEGIO_102 REFERENCES$/],
        [`REVOKE REFERENCES ON usuarios_administrativos FROM ${MINIMO}`, `GRANT REFERENCES ON usuarios_administrativos TO ${MINIMO}`, /SEM_PRIVILEGIO_102 REFERENCES$/],
        [`REVOKE CREATE ON SCHEMA public FROM ${MINIMO}`, `GRANT CREATE ON SCHEMA public TO ${MINIMO}`, /SEM_PRIVILEGIO_102 CREATE$/],
        [`REVOKE SELECT ON adicional_categorias FROM ${MINIMO}`, `GRANT SELECT ON adicional_categorias TO ${MINIMO}`, /SEM_PRIVILEGIO_103 SELECT$/],
        [`REVOKE INSERT ON adicional_categorias FROM ${MINIMO}`, `GRANT INSERT ON adicional_categorias TO ${MINIMO}`, /SEM_PRIVILEGIO_103 INSERT$/],
        [`REVOKE UPDATE ON adicional_categorias FROM ${MINIMO}`, `GRANT UPDATE ON adicional_categorias TO ${MINIMO}`, /SEM_PRIVILEGIO_103 LOCK$/],
      ] as const) {
        await c.query(revogar);
        try { await recusa(motivo, MINIMO); } finally { await c.query(conceder); }
      }
      // Com o mínimo, o papel não superusuário aplica as duas.
      const dirMin = novoDir();
      const ap = await executar(dirMin, MINIMO);
      assert.equal(ap.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(ap));
      assert.deepEqual(ap.commits, { 102: "CONFIRMADO", 103: "CONFIRMADO" });
      guardar("4-papel-minimo", dirMin);
      assert.equal((await conferir(MINIMO)).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
      if (evid) writeFileSync(join(evid, "retrato-102.txt"), (await c.query<{ hash_102: string }>(sql(RETRATO))).rows[0].hash_102 + "\n");
      // 5. Down das duas (só no descartável): volta ao estado inicial.
      await c.query(sql(DOWN103));
      await c.query(sql(DOWN102));
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query(`ALTER TABLE agenda_saloes OWNER TO "${admin}"`);
      for (const p of [MINIMO, OUTRO]) {
        await c.query(`REASSIGN OWNED BY ${p} TO "${admin}"`); await c.query(`DROP OWNED BY ${p}`); await c.query(`DROP ROLE ${p}`);
      }
    }
    assert.deepEqual(await objetos(), { fotos: false, servicos: 0 }, "downs voltaram ao estado inicial");
    assert.equal(await impressao(), antes, "impressão inicial depois dos downs");

    // 6. Falha real da 103 depois do COMMIT da 102: outra sessão segura adicional_categorias.
    const trava = await conectarDescartavel({ travar: false });
    const dirFalha = novoDir();
    try {
      await trava.query("BEGIN");
      // ROW EXCLUSIVE: leituras seguem (conferência, precheck), mas o LOCK … SHARE ROW EXCLUSIVE da 103 espera e estoura o lock_timeout.
      await trava.query("LOCK TABLE adicional_categorias IN ROW EXCLUSIVE MODE");
      const f = await executar(dirFalha);
      assert.equal(f.resultado, "FALHA", JSON.stringify(f));
      assert.deepEqual(f.commits, { 102: "CONFIRMADO", 103: "NAO_COMMITADA" }); assert.equal(f.falha!.etapa, "migration 103");
      await trava.query("ROLLBACK");
    } finally { await trava.query("ROLLBACK").catch(() => undefined); await encerrarDescartavel(trava); }
    assert.deepEqual(await objetos(), { fotos: true, servicos: 0 }, "102 confirmada, 103 ausente");
    guardar("6-falha-103", dirFalha);
    await assert.rejects(executar(dirFalha), /TENTATIVA_ANTERIOR_REVISAR/);
    renameSync(join(dirFalha, "migration-102-103.json"), join(dirFalha, "migration-102-103.2026-10-27T13-00.json"));
    const retomada = await executar(dirFalha);
    assert.equal(retomada.resultado, "APLICADA_POSTCHECK_PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.etapas, ["integridade 102", "precheck 103", "migration 103", "postcheck 103"]); assert.deepEqual(retomada.commits, { 103: "CONFIRMADO" });
    guardar("6-retomada", dirFalha);
    assert.deepEqual(await objetos(), { fotos: true, servicos: 1 });

    // 7. Deriva semântica com as mesmas contagens: o CHECK da frase vira CHECK(true), mesmo nome, validado.
    // Restauração com o TEXTO ORIGINAL da migration: pg_get_constraintdef não faz ida e volta exata (o BETWEEN volta com
    // os AND reagrupados e o retrato muda) — mesma razão pela qual uma restauração por dump lógico mudaria o retrato.
    const def = /ADD CONSTRAINT agenda_saloes_102_frase_ck (CHECK \(.*\)),$/m.exec(sql("database/migrations/20261025_102_saloes_apresentacao.sql"))![1];
    await c.query("ALTER TABLE agenda_saloes DROP CONSTRAINT agenda_saloes_102_frase_ck, ADD CONSTRAINT agenda_saloes_102_frase_ck CHECK (true)");
    try {
      const d = await conferir();
      assert.equal(d.resultado, "RECUSARIA", JSON.stringify(d)); assert.match(d.motivo!, /INTEGRIDADE_102 false/);
    } finally { await c.query(`ALTER TABLE agenda_saloes DROP CONSTRAINT agenda_saloes_102_frase_ck, ADD CONSTRAINT agenda_saloes_102_frase_ck ${def}`); }
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS", "definição restaurada");

    // 8. SERVICOS divergente com a 102 completa.
    await c.query("UPDATE adicional_categorias SET nome = 'Serviços extras' WHERE codigo = 'SERVICOS'");
    try { await recusa(/CATEGORIA_DIVERGENTE_103/); }
    finally { await c.query("UPDATE adicional_categorias SET nome = 'Serviços' WHERE codigo = 'SERVICOS'"); }
    assert.equal((await conferir()).resultado, "JA_APLICADA_INTEGRIDADE_PASS");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
