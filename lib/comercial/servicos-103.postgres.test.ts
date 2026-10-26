import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { cenario } from "../../scripts/integracao-importados-test-support.ts";

/**
 * 103 (categoria global "Serviços") no PostgreSQL DESCARTÁVEL:
 *   * modelo 102 (sem a 103): precheck → migration → postcheck; reexecução idempotente (mesma linha);
 *     categoria SERVICOS divergente, inativa ou arquivada recusada; rollback recusado com adicional que a usa
 *     (inclusive inativo) e aceito sem nenhum;
 *   * modelo 103: a categoria existe exatamente como esperada.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const MIGRATION = "database/migrations/20261025_103_adicionais_servicos.sql";
const PRECHECK = "database/checks/20261025_103_precheck.sql";
const POSTCHECK = "database/checks/20261025_103_postcheck.sql";
const ROLLBACK = "database/rollback/20261025_103_adicionais_servicos_down.sql";
let a: Client;
let com103 = false;

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
  await a.query("ROLLBACK").catch(() => undefined);
}
const linhas = async () => (await a.query<{ codigo: string; nome: string; ativo: boolean }>(
  `SELECT codigo, nome, ativo FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows;

test.before(async () => {
  a = await conectarDescartavel();
  com103 = (await linhas()).length > 0;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("modelo 103: SERVICOS presente, ativa e com o nome esperado (postcheck)", async (t) => {
  if (!com103) { t.skip("só no modelo 103"); return; }
  await a.query(arquivo(POSTCHECK));
  assert.deepEqual(await linhas(), [{ codigo: "SERVICOS", nome: "Serviços", ativo: true }]);
});

test("modelo 102: aplica, reexecuta sem duplicar, recusa divergente; rollback recusado com adicional e aceito sem", async (t) => {
  if (com103) { t.skip("só no modelo 102"); return; }
  await recusa(a.query(arquivo(POSTCHECK)), /103 postcheck: categoria SERVICOS ausente ou divergente/);
  await a.query(arquivo(PRECHECK));
  await a.query(arquivo(MIGRATION));
  await a.query(arquivo(POSTCHECK));
  // Reexecução: a mesma linha é aceita e nada duplica.
  await a.query(arquivo(PRECHECK));
  await a.query(arquivo(MIGRATION));
  assert.equal((await linhas()).length, 1);
  // Divergente (nome, inativa): precheck e migration recusam; nada muda.
  for (const ajuste of ["nome = 'Servicos'", "ativo = false"]) {
    await a.query("BEGIN");
    await a.query(`UPDATE adicional_categorias SET ${ajuste} WHERE codigo = 'SERVICOS'`);
    await assert.rejects(a.query(arquivo(PRECHECK).replace(/^/, "")), /103 precheck: categoria SERVICOS divergente/);
    await a.query("ROLLBACK");
  }
  // Rollback recusado com adicional na categoria (mesmo inativo).
  const c = await cenario(a, 0);
  const categoria = (await a.query<{ id: string }>(`SELECT id::text FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows[0].id;
  await a.query(`INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao, ativo)
                 VALUES ($1::uuid, 'SERVICO_MONITORES', 'Monitores', 'SERVICOS', $2::uuid, 'PACOTE', 1, false)`, [c.empresa, categoria]);
  await recusa(a.query(arquivo(ROLLBACK)), /103 rollback: há adicionais na categoria SERVICOS/);
  assert.equal((await linhas()).length, 1);
  // Sem adicional na categoria, o rollback é aceito (adicional removido só para provar o caminho; FK impede antes).
  await a.query(`DELETE FROM adicionais WHERE empresa_id = $1::uuid AND codigo = 'SERVICO_MONITORES'`, [c.empresa]);
  await a.query(arquivo(ROLLBACK));
  assert.equal((await linhas()).length, 0);
  await recusa(a.query(arquivo(ROLLBACK)), /103 rollback: categoria SERVICOS ausente/);
});
