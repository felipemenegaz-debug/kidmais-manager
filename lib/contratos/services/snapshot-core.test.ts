import test from "node:test";
import assert from "node:assert/strict";
import { hashSnapshotContrato, valorFinalContrato } from "./snapshot-core.ts";

test("hash do snapshot é estável mesmo com chaves em ordens diferentes", () => {
  const a = {
    schemaVersao: 1,
    contratante: { nome: "Cliente", cpf: "123" },
    comercial: { valor: 100, parcelas: [1, 2, 3] },
  };

  const b = {
    comercial: { parcelas: [1, 2, 3], valor: 100 },
    contratante: { cpf: "123", nome: "Cliente" },
    schemaVersao: 1,
  };

  assert.equal(hashSnapshotContrato(a), hashSnapshotContrato(b));
  assert.match(hashSnapshotContrato(a), /^[0-9a-f]{64}$/);
});

test("alteração material no snapshot muda o hash", () => {
  const base = {
    schemaVersao: 1,
    contratante: { cpf: "123" },
    comercial: { valorFinalContrato: 100 },
  };

  const alterado = {
    schemaVersao: 1,
    contratante: { cpf: "123" },
    comercial: { valorFinalContrato: 101 },
  };

  assert.notEqual(hashSnapshotContrato(base), hashSnapshotContrato(alterado));
});

test("valor aprovado prevalece sobre valor de tabela", () => {
  assert.equal(
    valorFinalContrato({ valorAprovado: 950, valorTabela: 1000 }),
    950,
  );
});

test("valor de tabela é usado quando não existe aprovação", () => {
  assert.equal(
    valorFinalContrato({ valorAprovado: null, valorTabela: 1000 }),
    1000,
  );
});
