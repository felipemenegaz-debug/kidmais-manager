import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  pacoteCodigoContratavelV1,
  pacoteIdContratavelV1,
  PACOTES_CONTRATAVEIS_V1,
} from "./pacotes-v1.ts";

test("V1 permite fechamento somente de Essencial, Completa e Premium", () => {
  assert.deepEqual(
    PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.id),
    ["essencial", "completa", "premium"],
  );
  for (const pacote of PACOTES_CONTRATAVEIS_V1) {
    assert.equal(pacoteIdContratavelV1(pacote.id), true);
    assert.equal(pacoteCodigoContratavelV1(pacote.codigo), true);
  }
});

test("V1 recusa pacotes sem contrato oficial e valores desconhecidos", () => {
  for (const id of ["pocket", "mini", "compacta", "pizza_party_scienza", "outro", ""]) {
    assert.equal(pacoteIdContratavelV1(id), false);
  }
  for (const codigo of ["POCKET", "MINI_FESTA", "COMPACTA", "PIZZA_PARTY", "OUTRO", ""]) {
    assert.equal(pacoteCodigoContratavelV1(codigo), false);
  }
});

test("catálogo público filtra a interface e a API recusa antes de qualquer operação", () => {
  const wizard = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8");
  const admin = readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  const route = readFileSync("app/api/fechamentos/route.ts", "utf8");
  const service = readFileSync(
    "lib/fechamentos/services/fechamento-publico.service.ts",
    "utf8",
  );

  assert.match(wizard, /PACOTES_FECHAMENTO_V1\.map/);
  assert.match(admin, /PACOTES\.map/);
  assert(
    route.indexOf("if (!pacoteIdContratavelV1") <
      route.indexOf("revalidarHorarioSelecionado({"),
  );
  assert(
    service.indexOf("const pacoteV1 = await buscarPacoteAtivoPorId") <
      service.indexOf(
        "let cliente: ClienteRecord",
        service.indexOf("const pacoteV1 = await buscarPacoteAtivoPorId"),
      ),
  );
});
