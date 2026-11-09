import test from "node:test";
import assert from "node:assert/strict";
import { aniversarianteDoCliente } from "./repositorio.ts";

// Forma da consulta (a prova do comportamento é a suíte PostgreSQL ao lado): nome igual primeiro, equivalente só se único.
test("aniversarianteDoCliente: nome igual continua valendo; equivalente sem acento só vincula quando é o único", async () => {
  const chamadas: { sql: string; params: unknown[] }[] = [];
  const tx = { query: async (sql: string, params: unknown[]) => { chamadas.push({ sql, params }); return { rows: [] }; } };
  const nfd = "João".normalize("NFD");
  const id = await aniversarianteDoCliente(tx as never, "cliente-1", nfd);
  assert.equal(id, null);
  const { sql, params } = chamadas[0];
  assert.deepEqual(params, ["cliente-1", nfd, "João"], "comparação antiga recebe o nome como veio; a equivalência, o composto (NFC)");
  assert.match(sql, /cliente_id = \$1::uuid AND ativo/);
  assert.match(sql, /lower\(btrim\(nome\)\) = lower\(btrim\(\$2::text\)\) AS exato/);
  assert.match(sql, /translate\(regexp_replace\(btrim\(nome\)/);
  assert.match(sql, /translate\(regexp_replace\(btrim\(\$3::text\)/);
  assert.doesNotMatch(sql, /btrim\(\$2::text\), '/, "o nome original não entra na equivalência");
  assert.match(sql, /WHERE exato OR \(SELECT count\(\*\) FROM equivalentes\) = 1/);
  assert.match(sql, /ORDER BY exato DESC, criado_em LIMIT 1/);
});
