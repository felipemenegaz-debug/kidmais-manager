import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { paginaPublica } from "../fechamentos/rota-publica.ts";

// Empresa nova não herda documentos nem o endereço público da Kidmais (dona da agenda pública): o PDF de pacotes da
// instalação e a tela "Ver tela do cliente" só valem para a dona; as demais veem o próprio endereço e nenhum PDF.

test("agenda: 'Ver tela do cliente' leva ao endereço público da empresa ativa, nunca ao da Kidmais", () => {
  const rota = readFileSync("app/api/admin/disponibilidade/route.ts", "utf8");
  assert.match(rota, /telaDoCliente: configuracaoComercial \? "\/disponibilidade" : await telaDoClienteDaEmpresa\(tx, empresaComprovada\)/);
  assert.match(rota, /SELECT codigo FROM empresas WHERE id = \$1::uuid/);
  assert.equal(paginaPublica("/disponibilidade", "buffet-novo"), "/b/buffet-novo/disponibilidade");
  const tela = readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  assert.doesNotMatch(tela, /href="\/disponibilidade"/, "sem endereço fixo da Kidmais");
  assert.match(tela, /\{telaDoCliente && <div className=\{styles\.contentActions\}><a className=\{styles\.clientView\} href=\{telaDoCliente\}>/);
  assert.equal((tela.match(/setTelaDoCliente\(dados\.telaDoCliente\);/g) ?? []).length, 2, "carga inicial e recarga");
});

test("PDF de pacotes: só a dona vê e substitui o documento da instalação; empresa nova vê 'Nenhuma tabela publicada'", () => {
  const rota = readFileSync("app/api/admin/configuracoes/tabela-pacotes/route.ts", "utf8");
  assert.match(rota, /ehDonaDaConfigLegada\(tx, tenant\.empresaComprovada\)/);
  const get = rota.slice(rota.indexOf("export async function GET"), rota.indexOf("export async function POST"));
  assert.ok(get.indexOf("daDona(") < get.indexOf("documentoVigente("), "confere a dona antes de ler o documento");
  assert.match(get, /data: null, daInstalacao: false/);
  const post = rota.slice(rota.indexOf("export async function POST"));
  assert.ok(post.indexOf("daDona(") > -1 && post.indexOf("daDona(") < post.indexOf("publicarPdf("), "recusa antes de publicar");
  const tela = readFileSync("components/admin/TabelaPacotesPdf.tsx", "utf8");
  assert.match(tela, /daInstalacao===false\?<section/);
  assert.match(tela, /\{daInstalacao&&<form/, "sem formulário de envio para outra empresa");
  const publico = readFileSync("app/api/fechamentos/tabela-pacotes/route.ts", "utf8");
  assert.match(publico, /searchParams\.has\('empresa'\)/, "endereço de outra empresa continua sem o PDF da instalação");
});
