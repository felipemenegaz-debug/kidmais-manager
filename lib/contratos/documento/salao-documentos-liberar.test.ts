import assert from "node:assert/strict";
import test from "node:test";
import { gerarPdfContratoOficial, gerarPdfDocumentoContrato, renderizarContratoOficial, renderizarDocumentoContrato } from "./index.ts";
import type { ContratoSnapshot } from "../repositories/models.ts";
import { renderizarModeloEmpresa } from "../modelo-empresa/renderizar.ts";
import type { ConteudoModelo } from "../modelo-empresa/conteudo.ts";
import { extrairTextoPdf } from "../../importacao-contrato/pdf-texto.ts";
import { criarPdfResumo } from "../../../components/admin/resumo-pdf.ts";
import { montarResumo, type PainelResumo } from "../../../components/admin/resumo-contratacao.ts";
import { SNAP_V3_SEM_SALAO } from "./salao-snapshots.test-apoio.ts";

/**
 * Plano "liberar agenda com mais de um salão" (bateria A): o nome do salão congelado na versão aparece no CONTEÚDO
 * extraído dos PDFs (leitor de PDF do próprio produto, `extrairTextoPdf`), não só no JSON ou num hash diferente:
 * contrato oficial V5, Resumo da Contratação público, modelo da empresa (bloco fixo, campo no título e no preâmbulo) e
 * resumo do painel. Nome longo, com acentos, aspas, "&", travessão e de salão combinado (rótulo inteiro, sem corte).
 */
const hash = "a".repeat(64);
const COMBINADO = "Jardim das Borboletas & Castelo \"Encantado\" — Ala Ônix/Ação (Principal + Anexo)";
const comSalao = (nome: string): ContratoSnapshot => ({ ...structuredClone(SNAP_V3_SEM_SALAO), evento: { ...structuredClone(SNAP_V3_SEM_SALAO.evento), salao: { id: "salao-combinado", nome } } });
const SNAP = comSalao(COMBINADO);
/** O gerador de PDF troca o travessão por hífen (mapeamento de caracteres do PDF); o resto do nome segue igual. */
const NO_PDF = COMBINADO.replace("—", "-");

/** Texto do PDF pelo leitor do produto, com as quebras de linha e espaços colapsados (o nome longo pode quebrar). */
const lido = (pdf: Uint8Array) => {
  const t = extrairTextoPdf(pdf);
  assert.equal(t.interrompido, null);
  return t.paginas.join(" ").replace(/\s+/g, " ");
};
const semEspaco = (s: string) => s.replace(/\s+/g, "");
const contem = (texto: string, trecho: string) => semEspaco(texto).includes(semEspaco(trecho));

test("A: contrato oficial V5 com salão combinado de nome longo e especial: o nome inteiro está no texto do PDF", () => {
  const d = renderizarContratoOficial({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash, geradoEm: "2026-10-27T12:00:00Z" });
  assert.ok(d);
  const texto = lido(gerarPdfContratoOficial(d));
  assert.ok(contem(texto, `no salão ${NO_PDF}.`), texto.slice(0, 600));
  assert.equal(semEspaco(texto).split(semEspaco(NO_PDF)).length - 1, 1, "nomeado uma vez");
});

test("A: Resumo da Contratação público: a linha do salão com o nome inteiro no texto do PDF", () => {
  const r = renderizarDocumentoContrato({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash });
  assert.ok(r.linhas.some((l) => l.texto === `Salão: ${COMBINADO}`));
  const texto = lido(gerarPdfDocumentoContrato(r));
  assert.ok(contem(texto, NO_PDF), texto.slice(0, 600));
  assert.equal(contem(lido(gerarPdfDocumentoContrato(renderizarDocumentoContrato({ snapshot: SNAP_V3_SEM_SALAO, numeroVersao: 1, snapshotHash: hash }))), "Borboletas"), false);
});

const MODELO: ConteudoModelo = {
  titulo: "Contrato de Festa",
  contratada: { nome: "Buffet Alegria Ltda", documento: "12.345.678/0001-90", endereco: "Rua das Flores, 100 - Goiânia/GO", representante: "João Souza, sócio" },
  preambulo: ["As partes acima têm, entre si, justo e contratado o seguinte."],
  clausulas: [
    { titulo: "Objeto", texto: "Festa {{festa.pacote}} no dia {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, para {{festa.convidados}} convidados." },
    { titulo: null, texto: "O valor total é de {{valor.total}}, pago por {{pagamento.forma}}. Contratante: {{contratante.nome}}, CPF {{contratante.cpf}}." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia/GO",
};
const empresa = (conteudo: ConteudoModelo, snapshot: ContratoSnapshot = SNAP) =>
  renderizarModeloEmpresa({ id: "11111111-2222-4333-8444-555555555555", versao: 3, conteudo }, { snapshot, numeroVersao: 2, snapshotHash: hash, geradoEm: "2026-10-07T12:00:00Z" });
const pdfEmpresa = (d: ReturnType<typeof empresa>) => lido(gerarPdfContratoOficial(d, { logo: false }));

test("A: modelo da empresa: sem o campo, o bloco fixo \"Local da festa\" no PDF; com o campo no título ou no preâmbulo, o nome ali e sem bloco", () => {
  const fixo = pdfEmpresa(empresa(MODELO));
  assert.ok(contem(fixo, `Local da festa: ${NO_PDF}.`), fixo.slice(0, 800));
  const noTitulo = empresa({ ...MODELO, titulo: "Contrato de Festa no salão {{festa.salao}}" });
  assert.equal(noTitulo.titulo, `Contrato de Festa no salão ${COMBINADO}`);
  const tituloPdf = pdfEmpresa(noTitulo);
  assert.equal(contem(tituloPdf, "Local da festa"), false, "campo no título: sem o bloco fixo");
  assert.ok(contem(tituloPdf.toLocaleUpperCase("pt-BR"), NO_PDF.toLocaleUpperCase("pt-BR")) || contem(tituloPdf, NO_PDF), tituloPdf.slice(0, 400));
  const noPreambulo = pdfEmpresa(empresa({ ...MODELO, preambulo: ["A festa acontece no salão {{festa.salao}}."] }));
  assert.ok(contem(noPreambulo, `A festa acontece no salão ${NO_PDF}.`), noPreambulo.slice(0, 800));
  assert.equal(contem(noPreambulo, "Local da festa"), false, "campo no preâmbulo: sem o bloco fixo");
  assert.equal(contem(pdfEmpresa(empresa(MODELO, SNAP_V3_SEM_SALAO)), "Local da festa"), false, "sem salão: sem bloco");
});

test("A: resumo do painel (impressão e PDF baixado): linha Salão com o nome inteiro da versão selecionada", () => {
  const versao = (id: string, n: number, snapshot: ContratoSnapshot) => ({ id, numero_versao: n, status: "ASSINADA", estado_edicao: "CONCLUIDA", snapshot });
  const painel = { contrato: { id: "contrato", fechamento_id: SNAP.fechamento.id, status: "ASSINADO" }, fluxo: { versao_vigente_id: "v2", versao_em_preparacao_id: null },
    versoes: [versao("v1", 1, SNAP_V3_SEM_SALAO), versao("v2", 2, SNAP)], assinaturas: [], financeiro: [] } as unknown as PainelResumo;
  const vigente = montarResumo(painel);
  assert.deepEqual(vigente.secoes.find((s) => s.titulo === "Festa")!.linhas.find(([r]) => r === "Salão"), ["Salão", COMBINADO], "impressão (HTML) usa estas linhas");
  const texto = lido(criarPdfResumo(vigente));
  assert.ok(contem(texto, NO_PDF) || contem(texto, COMBINADO), texto.slice(0, 600));
  assert.equal(contem(lido(criarPdfResumo(montarResumo(painel, "v1"))), "Borboletas"), false, "versão sem salão: sem a linha");
});
