import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chaveIdempotenciaNoPagamento } from "./idempotencia.ts";

/** E2 — idempotência de recebimento/estorno tenant-safe (escopo empresa + pagamento + operação). */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PAG_A = "00000000-0000-4000-8000-00000000000a";
const PAG_A2 = "00000000-0000-4000-8000-0000000000a2";
const PAG_B = "00000000-0000-4000-8000-00000000000b";

test("E2: a mesma chave só é a mesma dentro de (empresa, pagamento, operação); cabe na coluna e não carrega a chave crua", () => {
  const k = "pedido-1234";
  const base = chaveIdempotenciaNoPagamento(A, PAG_A, "estorno", k);
  assert.ok(base && /^v2:[0-9a-f]{64}$/.test(base) && base.length <= 160);
  assert.equal(chaveIdempotenciaNoPagamento(A.toUpperCase(), PAG_A.toUpperCase(), "estorno", `  ${k} `), base, "replay: UUID em outra caixa e espaços não mudam a chave");
  assert.notEqual(chaveIdempotenciaNoPagamento(A, PAG_A2, "estorno", k), base, "outro pagamento");
  assert.notEqual(chaveIdempotenciaNoPagamento(B, PAG_B, "estorno", k), base, "outra empresa");
  assert.notEqual(chaveIdempotenciaNoPagamento(B, PAG_A, "estorno", k), base, "mesmo pagamento com outra empresa (nunca colide)");
  assert.notEqual(chaveIdempotenciaNoPagamento(A, PAG_A, "recebimento", k), base, "operação separada");
  assert.equal(base.includes(k), false);
  for (const vazia of [null, undefined, "", "   "]) assert.equal(chaveIdempotenciaNoPagamento(A, PAG_A, "estorno", vazia), null);
});

function repositorio() {
  const exports: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  const js = ts.transpileModule(readFileSync("lib/pagamentos/repositories/pagamento.repository.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", js)((id: string) => { assert.equal(id, "../../db/postgres"); return { db: () => { throw new Error("db() global proibido"); } }; }, exports);
  return exports;
}

test("E2: as quatro consultas (chave e referência, recebimento e estorno) exigem o pagamento provado no WHERE", async () => {
  const repo = repositorio();
  const vistos: Array<{ sql: string; v: unknown[] }> = [];
  const tx = { query: async (sql: string, v: unknown[] = []) => { vistos.push({ sql: sql.replace(/\s+/g, " "), v }); return { rows: [], rowCount: 0 }; } };
  assert.equal(await repo.buscarRecebimentoPorIdempotencia("v2:x", PAG_A, tx, "legada-123"), null);
  assert.equal(await repo.buscarEstornoPorIdempotencia("v2:x", PAG_A, tx, null), null);
  assert.equal(await repo.buscarRecebimentoPorReferencia("PSP", "ref-1", PAG_A, tx), null);
  assert.equal(await repo.buscarEstornoPorReferencia("PSP", "ref-1", PAG_A, tx), null);
  assert.equal(vistos.length, 4);
  assert.match(vistos[0].sql, /FROM pagamento_recebimentos WHERE pagamento_id = \$2::uuid AND \(chave_idempotencia = \$1 OR \(\$3::text IS NOT NULL AND chave_idempotencia = \$3\)\)/);
  assert.deepEqual(vistos[0].v, ["v2:x", PAG_A, "legada-123"]);
  assert.match(vistos[1].sql, /FROM pagamento_estornos WHERE recebimento_id IN \(SELECT id FROM pagamento_recebimentos WHERE pagamento_id = \$2::uuid\)/);
  assert.match(vistos[2].sql, /WHERE provedor_codigo=\$1 AND referencia_externa=\$2 AND pagamento_id=\$3::uuid/);
  assert.match(vistos[3].sql, /recebimento_id IN \(SELECT id FROM pagamento_recebimentos WHERE pagamento_id=\$3::uuid\)/);
  for (const { v } of vistos) assert.ok(v.includes(PAG_A), "o pagamento provado é parâmetro de toda consulta");
});

test("E2: serviço consulta só no pagamento provado e não tem mais o oráculo 'outro Pagamento'; rotas escopam a chave pelo tenant", () => {
  const svc = readFileSync("lib/pagamentos/services/pagamento.service.ts", "utf8");
  assert.doesNotMatch(svc, /já utilizada em outro Pagamento/);
  assert.match(svc, /buscarRecebimentoPorIdempotencia\(chaveIdempotencia, pagamento\.id, tx, input\.chaveIdempotenciaLegada\?\.trim\(\) \|\| null\)/);
  assert.match(svc, /buscarEstornoPorIdempotencia\(chaveIdempotencia, pagamento\.id, tx, input\.chaveIdempotenciaLegada\?\.trim\(\) \|\| null\)/);
  assert.match(svc, /buscarRecebimentoPorReferencia\(input\.provedorCodigo\.trim\(\), input\.referenciaExterna\.trim\(\), pagamento\.id, tx\)/);
  assert.match(svc, /buscarEstornoPorReferencia\(input\.provedorCodigo\.trim\(\), input\.referenciaExterna\.trim\(\), pagamento\.id, tx\)/);
  for (const [rota, op] of [["estornos", "estorno"], ["recebimentos", "recebimento"]] as const) {
    const fonte = readFileSync(`app/api/admin/pagamentos/[pagamentoId]/${rota}/route.ts`, "utf8");
    assert.match(fonte, new RegExp(`\\(tx, tenant\\) => registrar\\w+Pagamento\\([\\s\\S]*chaveIdempotencia: chaveIdempotenciaNoPagamento\\(tenant\\.empresaComprovada, pagamentoId, "${op}", parsed\\.data\\.chaveIdempotencia\\), chaveIdempotenciaLegada: parsed\\.data\\.chaveIdempotencia \\?\\? null`), rota);
  }
});
