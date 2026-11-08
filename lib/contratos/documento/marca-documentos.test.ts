import { larguraTextoPdf, limparNomePdf, nomeNoEspacoPdf } from "./nome-empresa-pdf.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gerarPdfContratoOficial, gerarPdfDocumentoContrato, hashPdfContrato, hashPdfContratoOficial, renderizarContratoOficial, renderizarDocumentoContrato } from "./index.ts";
import { renderizarModeloEmpresa } from "../modelo-empresa/renderizar.ts";
import type { ConteudoModelo } from "../modelo-empresa/conteudo.ts";
import { extrairTextoPdf } from "../../importacao-contrato/pdf-texto.ts";
import { SNAP_V3_SEM_SALAO } from "./salao-snapshots.test-apoio.ts";

/**
 * Marca nos documentos: PDF da empresa que não é a Kidmais não mostra a Kidmais (texto nem logo), e o da Kidmais fica
 * igual byte a byte. O PDF oficial assinado é regenerado e conferido com o hash guardado; o resumo não tem hash guardado.
 * O teste lê o PDF pelo leitor do próprio produto, não só pelas strings do gerador.
 */
const hash = "a".repeat(64);
const SNAP = structuredClone(SNAP_V3_SEM_SALAO);
const BUFFET = { kidmais: false, nome: "Buffet Estrela Encantada" };
const KIDMAIS = { kidmais: true, nome: "Kidmais" };
const SEM_NOME = { kidmais: false, nome: null };

const lido = (pdf: Uint8Array) => {
  const t = extrairTextoPdf(pdf);
  assert.equal(t.interrompido, null);
  return t.paginas.join(" ").replace(/\s+/g, " ");
};
const temLogo = (pdf: Buffer) => pdf.toString("latin1").includes("/Subtype /Image");
const semKidmais = (texto: string) => assert.doesNotMatch(texto, /kidmais/i, texto.slice(0, 300));

const MODELO: ConteudoModelo = {
  titulo: "Contrato de Festa",
  contratada: { nome: "Estrela Encantada Eventos LTDA", documento: "00.000.000/0001-00", endereco: "Rua Um, 1", representante: null },
  preambulo: ["Contrato entre as partes."],
  clausulas: [{ titulo: "Objeto", texto: "Festa no pacote {{festa.pacote}}." }],
  observacoes: [],
  cidadeAssinatura: "Brasília",
} as unknown as ConteudoModelo;
const empresa = () => renderizarModeloEmpresa({ id: "11111111-2222-4333-8444-555555555555", versao: 3, conteudo: MODELO }, { snapshot: SNAP, numeroVersao: 2, snapshotHash: hash, geradoEm: "2026-10-07T12:00:00Z" });
const resumo = (marca?: typeof BUFFET | typeof SEM_NOME) => renderizarDocumentoContrato({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash, marca });

test("contrato no modelo da empresa: nome do buffet no topo, iA.Fest no rodapé, sem Kidmais e sem logo", () => {
  const pdf = gerarPdfContratoOficial({ ...empresa(), marca: BUFFET }, { logo: false });
  const texto = lido(pdf);
  assert.match(texto, /Buffet Estrela Encantada/);
  assert.match(texto, /iA\.Fest/);
  semKidmais(texto);
  assert.equal(temLogo(pdf), false);
});

test("modelo da empresa sem prova de quem é: nenhuma marca no topo, nunca a Kidmais", () => {
  for (const d of [empresa(), { ...empresa(), marca: SEM_NOME }]) {
    const texto = lido(gerarPdfContratoOficial(d, { logo: false }));
    semKidmais(texto);
    assert.match(texto, /iA\.Fest/);
  }
});

test("a própria Kidmais com modelo próprio publicado continua com o topo e o rodapé de antes", () => {
  const texto = lido(gerarPdfContratoOficial({ ...empresa(), marca: KIDMAIS }, { logo: false }));
  assert.match(texto, /KIDMAIS/);
  assert.match(texto, /Kidmais Manager/);
  assert.doesNotMatch(texto, /iA\.Fest/);
});

test("contrato oficial da Kidmais: mesmo hash de sempre, porque o assinado é regenerado e conferido", () => {
  const d = renderizarContratoOficial({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash, geradoEm: "2026-10-27T12:00:00Z" });
  assert.ok(d);
  assert.equal("marca" in d, false, "o oficial não recebe marca: nada muda nos bytes");
  const pdf = gerarPdfContratoOficial(d);
  assert.equal(temLogo(pdf), true);
  assert.equal(hashPdfContratoOficial(pdf), hashPdfContratoOficial(gerarPdfContratoOficial(d, {})));
});

test("resumo de outra empresa: nome do buffet e iA.Fest, sem Kidmais e sem logo", () => {
  const pdf = gerarPdfDocumentoContrato(resumo(BUFFET));
  const texto = lido(pdf);
  assert.match(texto, /Buffet Estrela Encantada/);
  assert.match(texto, /Documento gerado pelo iA\.Fest/);
  semKidmais(texto);
  assert.equal(temLogo(pdf), false);
  assert.equal(resumo(BUFFET).titulo, "Resumo da Contratação");
});

test("resumo sem nome confirmado: neutro", () => {
  const pdf = gerarPdfDocumentoContrato(resumo(SEM_NOME));
  semKidmais(lido(pdf));
  assert.equal(temLogo(pdf), false);
});

test("resumo da Kidmais: marca informada e documento histórico geram os mesmos bytes", () => {
  const historico = gerarPdfDocumentoContrato(renderizarDocumentoContrato({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash }));
  const kidmais = gerarPdfDocumentoContrato(renderizarDocumentoContrato({ snapshot: SNAP, numeroVersao: 1, snapshotHash: hash, marca: KIDMAIS }));
  assert.equal(hashPdfContrato(kidmais), hashPdfContrato(historico));
  assert.equal(temLogo(kidmais), true);
});

test("comprovante: outra empresa sem Kidmais; quem gera precisa informar a marca e a parte não aparece como KIDMAIS", () => {
  const texto = lido(gerarPdfDocumentoContrato({ cabecalhoRotulo: "COMPROVANTE DE ASSINATURA", templateVersao: 1, homologadoParaProducao: true, titulo: "Comprovante", marca: BUFFET,
    linhas: [{ texto: "Comprovante de assinatura eletrônica", estilo: "titulo" }, { texto: "Parte: BUFFET", estilo: "corpo" }] }));
  semKidmais(texto);
  const servico = readFileSync(new URL("../services/administrativo.service.ts", import.meta.url), "utf8");
  assert.match(servico, /marca: MarcaContrato;/);
  assert.match(servico, /input\.parte === 'KIDMAIS' && !input\.marca\.kidmais \? 'BUFFET'/);
  assert.match(servico, /metodo: marcaAssinatura\.kidmais \? 'Sessão reautenticada — Kidmais Manager' : 'Sessão reautenticada — iA\.Fest', marca: marcaAssinatura/);
  assert.match(readFileSync(new URL("../services/fluxo-publico.ts", import.meta.url), "utf8"), /metodo: 'OTP', marca: await marcaDoContratoNaTransacao\(tx, v\.contratoId\)/);
});

test("todo gerador de resumo recebe a marca: nenhuma chamada sem ela nos serviços", () => {
  const publico = readFileSync(new URL("../services/contrato-publico.service.ts", import.meta.url), "utf8");
  const chamadas = publico.match(/gerarResumoContratacaoPdfDaVersao\([^)]*\)/g) ?? [];
  assert.equal(chamadas.length, 3);
  for (const c of chamadas) assert.match(c, /, (dados\.)?marca\)$/);
  assert.match(readFileSync(new URL("../services/documento.service.ts", import.meta.url), "utf8"), /gerarResumoContratacaoPdfDaVersao\(versao: ContratoVersaoRecord, marca: MarcaContrato\)/);
});

test("nome do buffet nos PDFs: cabe no espaço pela largura real e sem caractere fora da fonte", () => {
  assert.equal(limparNomePdf("Festa 🎉 da (Ana) \\ Ção"), "Festa da (Ana) \\ Ção");
  assert.equal(nomeNoEspacoPdf("🎉🎉", 13, 300), null);
  assert.equal(limparNomePdf("Cœur € Š"), "Coeur EUR S");
  assert.equal(larguraTextoPdf("@", 1000), 1015, "@ medido pela regular, a mais larga");
  assert.equal(nomeNoEspacoPdf("Buffet Curto", 13, 300), "Buffet Curto");
  for (const nome of ["W".repeat(40), "Buffet Encantado das Estrelas e dos Sonhos de Todas as Crianças da Região Metropolitana"]) {
    const ajustado = nomeNoEspacoPdf(nome, 15, 327) as string;
    assert.ok(ajustado.endsWith("..."));
    assert.ok(larguraTextoPdf(ajustado, 15) <= 327);
  }
});

test("resumo em papel: conferência sem nome da Kidmais para outra empresa, igual para a Kidmais", () => {
  const SNAP_PAPEL = { ...SNAP, origem: { tipo: "IMPORTACAO_HISTORICA" } } as never;
  const texto = (marca?: { kidmais: boolean; nome: string | null }) => renderizarDocumentoContrato({ snapshot: SNAP_PAPEL, numeroVersao: 1, snapshotHash: "a".repeat(64), marca }).linhas.map((l) => l.texto).join(" ");
  assert.match(texto({ kidmais: false, nome: "Buffet Estrela" }), /conferido pelo buffet na importação/);
  assert.match(texto({ kidmais: true, nome: "Kidmais" }), /conferido pela Kidmais na importação/);
  assert.match(texto(), /conferido pela Kidmais na importação/);
});
