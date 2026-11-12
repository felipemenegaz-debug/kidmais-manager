import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * 098 × 102 (plano S-A rev. 4, R4-4 e ressalva R4-P3-2 do parecer 8, 25/10/2026): no modelo 102 (sem a 098, com a 102),
 * o APLICADOR REAL da 098 (scripts/migration-098-staging.cjs) recusa nos três modos SEM enviar nenhum DDL/DML ao banco.
 * A prova não é só o inventário antes/depois (que não veria escrita desfeita): o cliente do aplicador REGISTRA cada
 * instrução enviada, e nenhuma é escrita. O marcador no disco pode existir (APLICAR), num diretório temporário.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
type Resultado = { resultado: string; motivo?: string; mensagem?: string; falha?: { etapa: string; mensagem: string }; retrato?: { estado: string } };
type Aplicador = { SQL_IDENTIDADE: string; retratar(o: unknown): Promise<Resultado>; conferir(o: unknown): Promise<Resultado>; executar(o: unknown): Promise<Resultado> };
const stg = exigir(join(raiz, "scripts/migration-098-staging.cjs")) as Aplicador;
const ENV_STG = { RENDER: "true", RENDER_SERVICE_ID: "srv-daif418ae00c73e8k2gg", KIDMAIS_DEPLOY_ENV: "staging", DATABASE_SSL: "false",
  DATABASE_URL: "postgresql://user:senha-ficticia-teste@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91" };
const IDENTIDADE = { db: "kidmais_staging_1z91", tls: false, servidor_privado: true };
/** Instrução de escrita no início de um comando (comentários removidos): DDL ou DML. */
const ESCRITA = /(^|;)\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|SET\s+ROLE)\b/i;
const semComentarios = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

function clienteRegistrado(registro: string[]) {
  return class {
    c: Client | null = null;
    on() {}
    async connect() { this.c = await conectarDescartavel({ travar: false }); this.c.on("error", () => undefined); }
    async query(sql: string) {
      registro.push(sql);
      return sql === stg.SQL_IDENTIDADE ? { rows: [IDENTIDADE] } : this.c!.query(sql);
    }
    async end() { if (this.c) await this.c.end(); }
  };
}

test("modelo 102: aplicador da 098 recusa em RETRATO, CONFERIR e APLICAR sem nenhum DDL/DML enviado", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  const dir = mkdtempSync(join(tmpdir(), "aplicador-098-com-102-"));
  try {
    assert.equal((await c.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NOT NULL AS ok`)).rows[0].ok, true, "modelo 102");
    const registro: string[] = [];
    const retrato = await stg.retratar({ env: ENV_STG, raiz, Client: clienteRegistrado(registro) });
    assert.equal(retrato.resultado, "RETRATO_DIVERGENTE", JSON.stringify(retrato));
    const conferencia = await stg.conferir({ env: ENV_STG, raiz, Client: clienteRegistrado(registro) });
    assert.equal(conferencia.resultado, "RECUSARIA", JSON.stringify(conferencia));
    assert.match(JSON.stringify(conferencia), /RETRATO_DIVERGENTE/);
    const aplicacao = await stg.executar({ env: ENV_STG, backup: "export teste 102", dir, raiz, disco: () => {}, Client: clienteRegistrado(registro) });
    assert.equal(aplicacao.resultado, "FALHA", JSON.stringify(aplicacao));
    assert.match(JSON.stringify(aplicacao), /RETRATO_DIVERGENTE/);
    assert.ok(registro.length > 0, "o aplicador consultou o banco");
    const escritas = registro.map(semComentarios).filter((sql) => ESCRITA.test(sql));
    assert.deepEqual(escritas, [], "nenhuma instrução de escrita enviada ao banco");
    // E o estado do banco segue sem nenhum objeto da 098.
    const r = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais098\\_%'`)).rows[0];
    assert.equal(r.n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await encerrarDescartavel(c);
  }
});
