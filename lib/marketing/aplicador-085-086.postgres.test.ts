import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";

/**
 * OBS-2 da revisão de f9d8a63 — o APLICADOR REAL de staging (scripts/migration-085-086-staging.cjs) no PostgreSQL
 * descartável, modelo 084 (083 + 084 de Convites, sem Marketing). Só pelo check:v1:postgres com
 * KIDMAIS_POSTGRES_DESCARTAVEL.
 *
 * Única substituição: o cliente do aplicador conecta ao cluster descartável (identidade provada por
 * conectarDescartavel) e responde à consulta de identidade de staging como o banco de staging responderia. A trava
 * de alvo e a identidade de staging são provadas pelos testes sem banco (migration-085-086-staging.test.cjs); aqui
 * se provam as fases com SQL REAL: estado, privilégios, trava consultiva, migrations, postchecks, retomada.
 * Ordem (o banco de trabalho guarda o que o aplicador commitar; o runner restaura o modelo antes da suíte):
 *   1. conferência só leitura; 2. instalação parcial recusada; 3. trava concorrente recusada; 4. sem CREATE recusado;
 *   5. falha injetada na 086 → 085 commitada e registrada; retomada aplica só a 086; 6. nova execução só confere;
 *   7. downs 086 → 085 sem dados funcionam (transação desfeita).
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; arquivo: string; plano?: string[]; falha?: { etapa: string; mensagem: string }; migracoesCommitadas?: string[];
  verificacoes?: Array<{ nome: string; ok: boolean }>; estado?: Record<string, unknown> };
type Opcoes = { env: Record<string, string>; dir: string; raiz: string; disco: () => void; Client: new (opts: unknown) => unknown; retomar?: boolean };
const aplicador = exigir(join(raiz, "scripts/migration-085-086-staging.cjs")) as {
  ETAPAS: ReadonlyArray<readonly [string, string, string]>; TRAVA: readonly [number, number];
  conferir(o: Opcoes): Promise<Resultado>; executar(o: Opcoes): Promise<Resultado>;
};
const { SQL_IDENTIDADE } = exigir(join(raiz, "scripts/conexao-staging.cjs")) as { SQL_IDENTIDADE: string };
// Configuração FICTÍCIA de staging: só satisfaz a trava de alvo; a URL nunca é usada (o cliente abaixo a ignora).
const ENV: Record<string, string> = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", ASAAS_AMBIENTE: "sandbox",
  ASSINATURA_PLANOS_ATIVOS: "true", DATABASE_SSL: "false", DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const SQL_MIGRATION_086 = readFileSync(join(raiz, "database/migrations/20261018_086_marketing_automacoes.sql"), "utf8").replace(/\r\n/g, "\n");
const DOWN085 = readFileSync(join(raiz, "database/rollback/20261018_085_marketing_base_down.sql"), "utf8");
const DOWN086 = readFileSync(join(raiz, "database/rollback/20261018_086_marketing_automacoes_down.sql"), "utf8");
const PAPEL_SEM_CREATE = "kidmais_teste_aplicador_sem_create";

/** Cliente do aplicador sobre o cluster descartável; `papel` troca o usuário efetivo; `falharEm` injeta falha antes de enviar um SQL. */
function clienteDescartavel(cfg: { papel?: string; falharEm?: string } = {}) {
  return class {
    // Sem construtor próprio: as opções (URL fictícia de staging) que o aplicador passa são ignoradas.
    c: Client | null = null;
    async connect() {
      this.c = await conectarDescartavel({ travar: false });
      if (cfg.papel) await this.c.query(`SET ROLE ${cfg.papel}`);
    }
    async query(sql: string) {
      if (sql === SQL_IDENTIDADE) return { rows: [{ db: "kidmais_staging_1z91", tls: false, servidor_privado: true }] };
      if (cfg.falharEm && sql === cfg.falharEm) throw new Error("falha injetada pelo teste antes de enviar o SQL");
      return this.c!.query(sql);
    }
    async end() { if (this.c) await this.c.end(); }
  };
}
const contar = async (c: Client) => (await c.query<{ t085: number; t086: number }>(`SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[]))::int AS t085,
  (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('marketing_automacao_regras','marketing_automacao_execucoes','marketing_automacao_eventos',
    'marketing_contato_preferencias','marketing_contato_preferencias_eventos','marketing_contato_autorizacoes','marketing_tarefas','marketing_transporte_simulado'))::int AS t086`,
  [["marketing_membership_capacidades", "marketing_origens_opcoes", "marketing_sites", "marketing_site_versoes", "marketing_site_imagens", "marketing_dominios",
    "marketing_dns_simulado", "marketing_campanhas", "marketing_contatos", "marketing_atribuicoes", "marketing_eventos"]])).rows[0];

test("aplicador 085/086 real no modelo 084: conferência, recusas, falha e retomada, idempotência e downs", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const dirs: string[] = [];
  const novoDir = () => { const d = mkdtempSync(join(tmpdir(), "aplicador-085-086-")); dirs.push(d); return d; };
  const base = (dir: string, Client: Opcoes["Client"], extra: Partial<Opcoes> = {}) => ({ env: ENV, dir, raiz, disco: () => {}, Client, ...extra });
  try {
    assert.deepEqual(await contar(c), { t085: 0, t086: 0 }, "modelo 084: sem Marketing");

    // 1. Conferência: só leitura; 083 e 084 presentes; plano completo; só o precheck 085 roda.
    const conf = await aplicador.conferir(base(novoDir(), clienteDescartavel()));
    assert.equal(conf.resultado, "CONFERIDO", JSON.stringify(conf));
    assert.deepEqual(conf.verificacoes, [{ nome: "precheck 085", ok: true }]);
    assert.deepEqual(await contar(c), { t085: 0, t086: 0 });

    // 2. Instalação parcial (uma tabela da 085 criada à mão): recusada antes de qualquer migration.
    await c.query("CREATE TABLE marketing_dns_simulado (x int)");
    const parcial = await aplicador.executar(base(novoDir(), clienteDescartavel()));
    assert.equal(parcial.resultado, "FALHA"); assert.match(parcial.falha!.mensagem, /INSTALACAO_PARCIAL 085/);
    assert.deepEqual(await contar(c), { t085: 1, t086: 0 });
    await c.query("DROP TABLE marketing_dns_simulado");

    // 3. Outra sessão segura a trava consultiva do aplicador: recusa sem SQL de migration.
    const outra = await conectarDescartavel({ travar: false });
    try {
      await outra.query("SELECT pg_advisory_lock($1::int, $2::int)", [...aplicador.TRAVA]);
      const conc = await aplicador.executar(base(novoDir(), clienteDescartavel()));
      assert.equal(conc.resultado, "FALHA"); assert.match(conc.falha!.mensagem, /EXECUCAO_CONCORRENTE/);
      assert.deepEqual(await contar(c), { t085: 0, t086: 0 });
    } finally { await outra.end(); }

    // 4. Papel sem CREATE em public: recusa antes de escrever (has_schema_privilege real).
    await c.query(`DROP ROLE IF EXISTS ${PAPEL_SEM_CREATE}`);
    await c.query(`CREATE ROLE ${PAPEL_SEM_CREATE} NOLOGIN`);
    try {
      await c.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL_SEM_CREATE}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PAPEL_SEM_CREATE}`);
      const semCreate = await aplicador.executar(base(novoDir(), clienteDescartavel({ papel: PAPEL_SEM_CREATE })));
      assert.equal(semCreate.resultado, "FALHA"); assert.match(semCreate.falha!.mensagem, /SEM_PRIVILEGIO 085/);
      assert.deepEqual(await contar(c), { t085: 0, t086: 0 });
    } finally {
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL_SEM_CREATE}`);
      await c.query(`REVOKE USAGE ON SCHEMA public FROM ${PAPEL_SEM_CREATE}`);
      await c.query(`DROP ROLE ${PAPEL_SEM_CREATE}`);
    }

    // 5. Falha injetada antes de enviar a 086: a 085 fica commitada e registrada; a retomada aplica só a 086.
    const dirFalha = novoDir();
    const falha = await aplicador.executar(base(dirFalha, clienteDescartavel({ falharEm: SQL_MIGRATION_086 })));
    assert.equal(falha.resultado, "FALHA"); assert.equal(falha.falha!.etapa, "migration 086");
    assert.deepEqual(falha.migracoesCommitadas, ["migration 085"]);
    assert.deepEqual(await contar(c), { t085: 11, t086: 0 }, "085 commitada; 086 ausente");
    const retomada = await aplicador.executar(base(dirFalha, clienteDescartavel(), { retomar: true }));
    assert.equal(retomada.resultado, "PASS", JSON.stringify(retomada));
    assert.deepEqual(retomada.plano, ["postcheck 085", "precheck 086", "migration 086", "postcheck 086"]);
    assert.deepEqual(readdirSync(dirFalha).sort(), ["migration-085-086.json", "migration-085-086.tentativa-2.json"]);
    assert.deepEqual(await contar(c), { t085: 11, t086: 8 });

    // 6. Nova execução (outro registro): estado completo → só postchecks.
    const denovo = await aplicador.executar(base(novoDir(), clienteDescartavel()));
    assert.equal(denovo.resultado, "PASS"); assert.deepEqual(denovo.plano, ["postcheck 085", "postcheck 086"]);

    // 7. Downs 086 → 085 sem dados, numa transação desfeita: funcionam e o schema volta.
    await c.query("BEGIN");
    await c.query(semTransacaoExplicita(DOWN086));
    await c.query(semTransacaoExplicita(DOWN085));
    assert.deepEqual(await contar(c), { t085: 0, t086: 0 });
    await c.query("ROLLBACK");
    assert.deepEqual(await contar(c), { t085: 11, t086: 8 });
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
