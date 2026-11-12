import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";

/**
 * Parecer do Astra de 26/10/2026 (P3-1 da composição; R4-6 do plano): a 102 e a 100 nas DUAS ordens suportadas, com os
 * verificadores de cada uma — 100_postcheck, 100_integridade e 094_integridade_apos_100, além da integridade da 102.
 *   * modelo 097 (staging antes da 100): 094 + 102 → 100 + 102 (precheck/migration/postcheck da 102, depois os da 100);
 *   * modelo 102 (receita: 100 aplicada antes da 102): 094 + 100 → 102, só conferência dos verificadores.
 * O precheck da 100 depois da 100 instalada recusa por desenho (exige o corpo da 094); isso não é regressão da 102.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const M100 = "database/migrations/20261025_100_agenda_um_salao.sql";
const PRE100 = "database/checks/20261025_100_precheck.sql";
const POS100 = "database/checks/20261025_100_postcheck.sql";
const INT100 = "database/checks/20261025_100_integridade.sql";
const INT094 = "database/checks/20261025_094_integridade_apos_100.sql";
const M102 = "database/migrations/20261025_102_saloes_apresentacao.sql";
const PRE102 = "database/checks/20261025_102_precheck.sql";
const POS102 = "database/checks/20261025_102_postcheck.sql";
const INT102 = "database/checks/20261025_102_integridade.sql";
let a: Client;

const instalada102 = async () => (await a.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NOT NULL AS ok`)).rows[0].ok;
const corpo100 = async () => (await a.query<{ h: string | null }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc
  WHERE oid = to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)')`)).rows[0]?.h;
const H100 = "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb";

async function verificadoresDasDuas() {
  await a.query(arquivo(POS100));
  assert.equal((await a.query<{ integra_100: boolean }>(arquivo(INT100))).rows[0].integra_100, true, "100_integridade");
  await a.query(arquivo(INT094));
  await a.query(arquivo(POS102));
  assert.equal((await a.query<{ integra_102: boolean }>(arquivo(INT102))).rows[0].integra_102, true, "102_integridade");
}

test.before(async () => { a = await conectarDescartavel(); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("ordem 094 + 102 → 100 + 102 (modelo 097) ou 094 + 100 → 102 (modelo 102): verificadores das duas passam", async () => {
  if (!(await instalada102())) {
    // Modelo 097: a 100 ainda não está; aplica 102 e depois a 100, cada uma com seus checks.
    assert.notEqual(await corpo100(), H100, "a 100 ainda não está instalada no modelo 097");
    await a.query(arquivo(PRE102));
    await a.query(arquivo(M102));
    await a.query(arquivo(POS102));
    await a.query(arquivo(PRE100));
    await a.query(arquivo(M100));
  }
  assert.equal(await corpo100(), H100, "corpo da 100 instalado");
  await verificadoresDasDuas();
  // Por desenho, o precheck da 100 recusa depois dela instalada (exige o corpo da 094).
  await assert.rejects(a.query(arquivo(PRE100)));
  await a.query("ROLLBACK").catch(() => undefined);
});
