import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { erroConvidadosFechamento } from '../fechamentos/convidados.ts';
import {
  pacoteCodigoContratavelV1,
  pacoteIdContratavelV1,
  PACOTES_CONTRATAVEIS_V1,
} from "./pacotes-v1.ts";

test("fechamento apresenta os sete pacotes comerciais", () => {
  assert.deepEqual(
    PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.id),
    ["pocket", "mini", "compacta", "essencial", "completa", "premium", "pizza_party_scienza"],
  );
  for (const pacote of PACOTES_CONTRATAVEIS_V1) {
    assert.equal(pacoteIdContratavelV1(pacote.id), true);
    assert.equal(pacoteCodigoContratavelV1(pacote.codigo), true);
  }
});

test("catálogo recusa somente pacotes desconhecidos", () => {
  for (const id of ["outro", ""]) {
    assert.equal(pacoteIdContratavelV1(id), false);
  }
  for (const codigo of ["OUTRO", ""]) {
    assert.equal(pacoteCodigoContratavelV1(codigo), false);
  }
});

test("catálogo público lista os sete e a API valida o código antes de qualquer operação", () => {
  const wizard = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8");
  const admin = readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  const route = readFileSync("app/api/fechamentos/route.ts", "utf8");
  const service = readFileSync(
    "lib/fechamentos/services/fechamento-publico.service.ts",
    "utf8",
  );

  assert.match(wizard, /PACOTES_FECHAMENTO_V1\.map/);
  assert.match(wizard, /O Pizza Party está sob consulta/);
  assert.match(wizard, /erroConvidadosFechamento\(convidados, pacote\)/);
  assert.match(erroConvidadosFechamento(41, { id: 'compacta', nome: 'Compacta', minPagantes: 40, maxPagantes: 150 })!, /Festa Compacta possui valor automático somente para 40 convidados/);
  assert.equal(erroConvidadosFechamento(40, { id: 'compacta', nome: 'Compacta', minPagantes: 40, maxPagantes: 150 }), null);
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
