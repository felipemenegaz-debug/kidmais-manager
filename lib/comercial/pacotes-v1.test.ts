import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { erroConvidadosFechamento } from '../fechamentos/convidados.ts';
import {
  codigoDoPacoteDaTela,
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

test("id da tela → código: endereço atual só os sete; /b e agenda das empresas também o código do pacote (P_…)", () => {
  for (const { id, codigo } of PACOTES_CONTRATAVEIS_V1) {
    assert.equal(codigoDoPacoteDaTela(id, false), codigo);
    assert.equal(codigoDoPacoteDaTela(id, true), codigo, "id V1 continua aceito em /b (compatibilidade)");
  }
  const livre = "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A";
  assert.equal(codigoDoPacoteDaTela(livre, true), livre);
  assert.equal(codigoDoPacoteDaTela("POCKET", true), "POCKET");
  assert.equal(codigoDoPacoteDaTela(livre, false), null, "endereço atual (dona): só os sete");
  assert.equal(codigoDoPacoteDaTela("POCKET", false), null, "endereço atual: o id é o V1, não o código");
  for (const invalido of ["", "outro", "p_abc", " POCKET", "POCKET ", "P", "P-1", "../POCKET", "POCKET;DROP", "__proto__", "A".repeat(51), "Ç_1"])
    assert.equal(codigoDoPacoteDaTela(invalido, true), null, JSON.stringify(invalido));
  assert.equal(codigoDoPacoteDaTela("A".repeat(50), true), "A".repeat(50), "até 50 caracteres (pacotes.codigo varchar(50))");
});

test("catálogo público lista os sete e a API valida o código antes de qualquer operação", () => {
  const wizard = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8");
  const admin = readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  const route = readFileSync("app/api/fechamentos/route.ts", "utf8");
  const service = readFileSync(
    "lib/fechamentos/services/fechamento-publico.service.ts",
    "utf8",
  );

  // Endereço atual: os sete do catálogo (pacotesExibidos com a marca Kidmais); outra empresa: só os dela.
  assert.match(wizard, /pacotesExibidos\(marca\.kidmais, PACOTES_FECHAMENTO_V1, fatosPacote\)/);
  assert.match(wizard, /O Pizza Party está sob consulta/);
  assert.match(wizard, /erroConvidadosFechamento\(convidados, pacote\)/);
  assert.match(erroConvidadosFechamento(41, { id: 'compacta', nome: 'Compacta', minPagantes: 40, maxPagantes: 150 })!, /Festa Compacta possui valor automático somente para 40 convidados/);
  assert.equal(erroConvidadosFechamento(40, { id: 'compacta', nome: 'Compacta', minPagantes: 40, maxPagantes: 150 }), null);
  // Disponibilidade: a dona da agenda pública vê os sete; outra empresa, só os pacotes que criou (nova = nenhum).
  assert.match(admin, /const opcoesPacote = pacotesEmpresa \?\? PACOTES;/);
  assert.match(admin, /opcoesPacote\.map/);
  // Pacote validado pelo endereço (sem banco) antes de qualquer operação: escopo, unidade e horário vêm depois.
  const validacao = route.indexOf("const codigoPacote = codigoDoPacoteDaTela(dados.data.pacote, enderecoDaEmpresa);");
  assert(validacao > 0);
  assert(validacao < route.indexOf("escopo = await escopoCotacaoPublica("));
  assert(validacao < route.indexOf("revalidarHorarioSelecionado({"));
  assert(
    service.indexOf("const pacoteV1 = await buscarPacoteAtivoPorId") <
      service.indexOf(
        "let cliente: ClienteRecord",
        service.indexOf("const pacoteV1 = await buscarPacoteAtivoPorId"),
      ),
  );
});
