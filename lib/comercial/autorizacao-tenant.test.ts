import test from "node:test";
import assert from "node:assert/strict";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { recusarTenantNaoComprovado } from "./autorizacao-tenant.ts";

const sessao = { usuario_id: "usuario-a", papel: "REPRESENTANTE_AUTORIZADO" };
const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";

test("sem empresa comprovada a operação responde 403 e ignora o id do cliente", () => {
  assert.throws(
    () => recusarTenantNaoComprovado(sessao, empresaB),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "TENANT_NAO_COMPROVADO" && error.httpStatus === 403,
  );
  assert.throws(
    () => recusarTenantNaoComprovado(sessao),
    (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 403,
  );
});

test("empresa comprovada na sessão é devolvida e um pedido de outra empresa continua 403", () => {
  const provada = { ...sessao, empresaComprovada: empresaA };
  assert.equal(recusarTenantNaoComprovado(provada), empresaA);
  assert.equal(recusarTenantNaoComprovado(provada, empresaA), empresaA);
  assert.throws(
    () => recusarTenantNaoComprovado(provada, empresaB),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "TENANT_NAO_COMPROVADO" && error.httpStatus === 403,
  );
});
