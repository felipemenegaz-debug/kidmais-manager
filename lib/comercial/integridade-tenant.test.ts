import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { empresasDistintas, exigirVinculoNaEmpresa, sqlPacoteAdicionalMesmaEmpresa, sqlPrecoAdicionalMesmaEmpresa, sqlPrecoPacoteMesmaEmpresa } from "./integridade-tenant.ts";
import { incluirPrecoPacoteAdmin } from "./tabelas-preco-admin.ts";

const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";
const tabelaA = "33333333-3333-4333-8333-333333333333";
const pacoteB = "44444444-4444-4444-8444-444444444444";
const adicionalB = "55555555-5555-4555-8555-555555555555";

function txDivergente(esquerda: string | null, direita: string | null) {
  const chamadas: string[] = [];
  const executor: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      return { rows: [{ esquerda, direita } as Row], rowCount: 1 };
    },
  };
  return { executor, chamadas };
}

test("tabela da empresa A não recebe pacote da empresa B", async () => {
  const chamadas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      return { rows: [{ esquerda: empresaA, direita: empresaB } as Row], rowCount: 1 };
    },
  };
  await assert.rejects(
    () => incluirPrecoPacoteAdmin(tx, {
      empresaId: empresaA,
      tabelaId: tabelaA,
      pacoteId: pacoteB,
      convidadosMin: 40,
      convidadosMax: 80,
      tipoCalculo: "FIXO",
      valor: "10.00",
      categoriaHorario: "PADRAO",
    }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE" && error.httpStatus === 403,
  );
  assert.equal(chamadas.some((sql) => sql.includes("INSERT INTO precos_pacote") || sql.includes("INSERT INTO auditoria")), false);
});

test("pacote da empresa A não recebe adicional da empresa B nem adicional sem empresa", async () => {
  for (const direita of [empresaB, null]) {
    const { executor, chamadas } = txDivergente(empresaA, direita);
    await assert.rejects(
      () => exigirVinculoNaEmpresa(executor, empresaA, { sql: sqlPacoteAdicionalMesmaEmpresa(), params: [tabelaA, adicionalB] }),
      (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 403,
    );
    assert.equal(chamadas.some((sql) => sql.includes("INSERT")), false);
  }
});

test("preço de adicional também recusa tabela e adicional de empresas diferentes", async () => {
  const { executor } = txDivergente(empresaA, empresaB);
  await assert.rejects(
    () => exigirVinculoNaEmpresa(executor, empresaA, { sql: sqlPrecoAdicionalMesmaEmpresa(), params: [tabelaA, adicionalB] }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE",
  );
});

test("a mesma empresa passa e o par legado nulo não é tratado como duas empresas", async () => {
  const { executor } = txDivergente(empresaA, empresaA);
  await exigirVinculoNaEmpresa(executor, empresaA, { sql: sqlPrecoPacoteMesmaEmpresa(), params: [tabelaA, pacoteB] });
  assert.equal(empresasDistintas(null, null), false);
  assert.equal(empresasDistintas(empresaA, empresaB), true);
  assert.equal(empresasDistintas(empresaA, null), true);
});

test("a migration 034 recusa os três vínculos cruzados e não copia a fundação", () => {
  const migration = readFileSync("database/migrations/20260926_034_integridade_tenant_comercial.sql", "utf8");
  const pre = readFileSync("database/checks/20260926_034_precheck.sql", "utf8");
  const pos = readFileSync("database/checks/20260926_034_postcheck.sql", "utf8");
  const down = readFileSync("database/rollback/20260926_034_integridade_tenant_comercial_down.sql", "utf8");
  for (const nome of ["precos_pacote_empresa_trg", "pacote_adicionais_empresa_trg", "precos_adicional_empresa_trg"]) {
    assert.match(migration, new RegExp(nome));
  }
  assert.match(migration, /IS DISTINCT FROM/);
  assert.match(pre, /vínculo cruzado já existe/);
  assert.equal(/UPDATE (pacotes|tabelas_preco|adicionais|precos_pacote|pacote_adicionais)/.test(migration), false);
  assert.equal(migration.includes("memberships"), false);
  assert.equal(migration.includes("20260923_020"), false);
  assert.match(pre, /Não corrigir daqui/);
  assert.match(pos, /kidmais_034_recusar_empresa_distinta/);
  assert.match(down, /DROP TRIGGER IF EXISTS precos_pacote_empresa_trg/);
  assert.equal(/DELETE FROM|UPDATE (pacotes|tabelas_preco|adicionais|precos_pacote)/.test(down), false);
});
