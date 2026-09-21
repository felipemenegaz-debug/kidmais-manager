import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("rotas administrativas de aniversariante preservam autenticação, CSRF e vínculo pelo Cliente", () => {
  const criar = readFileSync("app/api/admin/clientes/[id]/aniversariantes/route.ts", "utf8");
  const editar = readFileSync("app/api/admin/clientes/[id]/aniversariantes/[aniversarianteId]/route.ts", "utf8");
  for (const rota of [criar, editar]) {
    assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/);
    assert.match(rota, /contextoCrmDaRequest\(request\)/);
  }
  assert.match(criar, /cadastrarAniversarianteInterno\(clienteId\.data/);
  assert.match(editar, /editarAniversarianteInterno\(clienteId\.data, aniversarianteId\.data/);
});

test("criação no CRM e no Fechamento compartilham bloqueio e recusa de duplicidade por nome", () => {
  const repository = readFileSync("lib/clientes/repositories/aniversariante.repository.ts", "utf8");
  const crm = readFileSync("lib/clientes/services/aniversariante.service.ts", "utf8");
  const fechamento = readFileSync("lib/fechamentos/services/fechamento-publico.service.ts", "utf8");

  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /lower\(btrim\(nome\)\) = lower\(btrim\(\$2\)\)/);
  assert(crm.indexOf("bloquearNomeAniversariante") < crm.indexOf("buscarAniversarianteAtivoPorNome"));
  const resolver = fechamento.indexOf("async function resolverAniversariante");
  assert(fechamento.indexOf("bloquearNomeAniversariante", resolver) < fechamento.indexOf("buscarAniversarianteAtivoPorNome", resolver));
});
