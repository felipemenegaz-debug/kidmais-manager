import assert from "node:assert/strict";
import test from "node:test";
import { modoEmpresaPublicaLegada } from "./empresa-publica-legada.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CODIGO = "kidmais";
const ambiente = { AGENDA_PUBLICA_EMPRESA_CODIGO: CODIGO, AGENDA_PUBLICA_EMPRESA_ID: ID };
const ativa = { id: ID, status: "ATIVA" };

test("sem código configurado válido e idêntico ao da rota, o fluxo normal segue sem consulta", async () => {
  let consultas = 0;
  const consultar = async () => { consultas++; return ativa; };
  for (const codigo of [undefined, "", " ", "KIDMAIS", " kidmais ", "kidmais/agenda"]) {
    const env = { ...ambiente, AGENDA_PUBLICA_EMPRESA_CODIGO: codigo };
    assert.equal(await modoEmpresaPublicaLegada(codigo ?? CODIGO, env, consultar), "NAO_E_LEGADA");
  }
  assert.equal(await modoEmpresaPublicaLegada("outro-buffet", ambiente, consultar), "NAO_E_LEGADA");
  assert.equal(consultas, 0);
});

test("o código reservado abre o legado quando a empresa ativa tem o UUID configurado", async () => {
  const consultar = async (codigo: string) => {
    assert.equal(codigo, CODIGO);
    return ativa;
  };
  assert.equal(await modoEmpresaPublicaLegada(CODIGO, ambiente, consultar), "LEGADA");
  const env = { ...ambiente, AGENDA_PUBLICA_EMPRESA_ID: ` ${ID.toUpperCase()} ` };
  assert.equal(await modoEmpresaPublicaLegada(CODIGO, env, consultar), "LEGADA");
});

test("o código reservado é recusado se a consulta ou a configuração não confirma a empresa ativa", async () => {
  for (const empresa of [undefined, { ...ativa, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { ...ativa, status: "INATIVA" }]) {
    assert.equal(await modoEmpresaPublicaLegada(CODIGO, ambiente, async () => empresa), "RECUSADA");
  }
  assert.equal(await modoEmpresaPublicaLegada(CODIGO, ambiente, async () => { throw new Error("banco indisponível"); }), "RECUSADA");
  for (const id of [undefined, " ", "id-inválido"]) {
    const env = { ...ambiente, AGENDA_PUBLICA_EMPRESA_ID: id };
    assert.equal(await modoEmpresaPublicaLegada(CODIGO, env, async () => ativa), "RECUSADA");
  }
});
