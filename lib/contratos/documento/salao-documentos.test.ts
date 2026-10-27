import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  gerarPdfContratoOficial,
  gerarPdfDocumentoContrato,
  hashPdfContrato,
  hashPdfContratoOficial,
  renderizarContratoOficial,
  renderizarDocumentoContrato,
  type ContratoOficialTemplateVersao,
} from "./index.ts";
import type { ContratoSnapshot } from "../repositories/models.ts";
import { CAMPOS_CONTRATO, CAMPOS_OBRIGATORIOS, preencher } from "../modelo-empresa/campos.ts";
import { problemasDoConteudo, type ConteudoModelo } from "../modelo-empresa/conteudo.ts";
import { INSTRUCAO_LEITURA_CONTRATO } from "../modelo-empresa/leitura.ts";
import { renderizarModeloEmpresa } from "../modelo-empresa/renderizar.ts";
import { SNAP_V1, SNAP_V2, SNAP_V3_COM_SALAO, SNAP_V3_PACOTE_CONGELADO, SNAP_V3_SEM_SALAO } from "./salao-snapshots.test-apoio.ts";

/**
 * S-E (plano S-E/S-D rev. 4.1): salão fixado nos documentos. Os hashes "ANTES" foram gerados com o código de HEAD
 * (89605f55, antes do S-E) sobre os mesmos snapshots: V1–V4, o resumo e o modelo da empresa sem salão não podem mudar
 * nem um byte (documento assinado re-renderiza na versão registrada e confere o hash do PDF).
 */
const hash = "a".repeat(64);
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const SNAPS: Record<string, ContratoSnapshot> = { V1: SNAP_V1, V2: SNAP_V2, V3_SEM_SALAO: SNAP_V3_SEM_SALAO, V3_COM_SALAO: SNAP_V3_COM_SALAO };

// JSON do documento renderizado + hash do PDF, por snapshot e versão do modelo oficial (gerados com HEAD 89605f55).
const ANTES_OFICIAL: Record<string, string> = {
  "V1.v1": "0901230649603848c5a825654133c8ab4b743974346f49a65dcacf304392dd8e 7193ffa16b1907e749044a962ae8d4ccd69774a5eff69066d98235e8d53d4562",
  "V1.v2": "376c7d27cb36984a90a38918df75a4980892409d245aa130a5b0baae617d0d76 64831a217697bea0f5af0408e90d5a838aa7746363bdb2863e086f7d54e1b0ca",
  "V1.v3": "7146b659d73cb0b868d3d5e18ac5415abe2a207280d4f8a87edc2600a83a00f3 3ef9186120ffae0fb29e176945848425a9f55350b10f24d1f6df6f11ae513e70",
  "V1.v4": "020bf1c808655581b01055c809e1252ab0cf472d2f4f0980332ef463aa43e1da 8f753a967aea4f1441616cae23fa6c80c378230d3a196ecdb5be9eab5f4cb5e1",
  "V2.v1": "69de22d62ddd77ddf65088a7dc7e8443eb731d1a40408b5681d26c6c4edda8e2 e815201ea7cb4c9ec4b74626732ffdbde570bca2e1f4aff3ddfe0c7969d31855",
  "V2.v2": "aa25c35ba16c8450e7be4e8fdd427a36e784de68ea086e4d0e71e2ac6939597f 09e7b2553aab0df19cd62f46bf42f1678292be5b9d9ffa8cedaa8d3b862006ae",
  "V2.v3": "9f3fbd2a3ebd43d73676d03f55251a72ecb89c53e04ab2c3d9275d888b10592a fa42804cc58d1c4a9e3ecbb98ef47662ce6a9330459b5e0da7d28fdd29097162",
  "V2.v4": "475507e73db12cdb7528d635be085583f9c5611ff8e14c0364531b3e557dfe10 296b6c1bf9b6ac0ab962e28289f75b51e72c34dba197e56f6b53cb2dc6756eda",
};
// V3 (com ou sem salão) nas versões 1–4: igual ao V1, nada do salão entra.
for (const v of [1, 2, 3, 4]) ANTES_OFICIAL[`V3_SEM_SALAO.v${v}`] = ANTES_OFICIAL[`V3_COM_SALAO.v${v}`] = ANTES_OFICIAL[`V1.v${v}`];

const ANTES_RESUMO: Record<string, string> = {
  V1: "f3a3480d07aafcf54101f0e90a16b7fcdda2e945b737f2503adf254ebc8e8e64 e34a420043447f7639b6d23e655b37ba54a47514c6546b10fa0dc03381922424",
  V2: "8bc9762268e432b920e84c591f6e5321910d3ead088e87fd0bf3603c9976baee a25a4dd2413e1e43a945a6a56b03b80b10c5c42e2acdca9c7f24657c4da9a477",
  V3_SEM_SALAO: "f3a3480d07aafcf54101f0e90a16b7fcdda2e945b737f2503adf254ebc8e8e64 e34a420043447f7639b6d23e655b37ba54a47514c6546b10fa0dc03381922424",
};

const oficial = (snapshot: ContratoSnapshot, templateVersao?: ContratoOficialTemplateVersao) => {
  const d = renderizarContratoOficial({ snapshot, numeroVersao: 1, snapshotHash: hash, geradoEm: "2026-10-27T12:00:00Z", templateVersao });
  assert.ok(d);
  return d;
};
const impressao = (d: ReturnType<typeof oficial>) => `${sha(JSON.stringify(d))} ${hashPdfContratoOficial(gerarPdfContratoOficial(d))}`;
const semVersao = (d: ReturnType<typeof oficial>) => ({ ...d, modeloCodigo: d.modeloCodigo.replace(/_V\d$/, ""), templateVersao: 0 });

test("modelo oficial V1–V4: idêntico ao de antes (V1, V2 e V3 com/sem salão)", () => {
  for (const [nome, snapshot] of Object.entries(SNAPS)) {
    for (const v of [1, 2, 3, 4] as const) assert.equal(impressao(oficial(snapshot, v)), ANTES_OFICIAL[`${nome}.v${v}`], `${nome} na V${v}`);
  }
});

test("modelo oficial V5: padrão para documento novo; sem salão o texto é o da V4; com salão, nomeado uma vez na Cláusula 1", () => {
  for (const snapshot of [SNAP_V1, SNAP_V2, SNAP_V3_SEM_SALAO]) {
    const v5 = oficial(snapshot);
    assert.equal(v5.templateVersao, 5);
    assert.equal(v5.modeloCodigo, "FESTA_COMPLETA_V5");
    assert.deepEqual(semVersao(v5), semVersao(oficial(snapshot, 4)));
    assert.doesNotMatch(JSON.stringify(v5), /salão/i);
  }
  const v4 = oficial(SNAP_V3_COM_SALAO, 4);
  const v5 = oficial(SNAP_V3_COM_SALAO, 5);
  assert.equal(v5.clausulas[0].texto, `${v4.clausulas[0].texto.slice(0, -1)}, no salão Jardim.`);
  assert.equal(v5.clausulas[0].texto.split("Jardim").length - 1, 1);
  assert.equal(JSON.stringify(v5).split("Jardim").length - 1, 2, "texto + destaque da Cláusula 1, nada mais");
  assert.deepEqual(v5.clausulas[0].destaques, [...(v4.clausulas[0].destaques ?? []), "salão Jardim"]);
  assert.deepEqual({ ...semVersao(v5), clausulas: v5.clausulas.slice(1) }, { ...semVersao(v4), clausulas: v4.clausulas.slice(1) });
  const pdf = gerarPdfContratoOficial(v5);
  assert.deepEqual(pdf, gerarPdfContratoOficial(oficial(SNAP_V3_COM_SALAO, 5)), "determinístico");
  assert.notEqual(hashPdfContratoOficial(pdf), hashPdfContratoOficial(gerarPdfContratoOficial(v4)));
});

test("V3 com fotografia do pacote: nome congelado (não o do catálogo) nas versões 2–5", () => {
  for (const v of [2, 3, 4, 5] as const) {
    const d = oficial(SNAP_V3_PACOTE_CONGELADO, v);
    assert.equal(d.pacoteNome, "Completa congelada V3");
    assert.equal(d.subtitulo, "COMPLETA CONGELADA V3");
    assert.match(d.clausulas[0].texto, /Completa congelada V3/);
    assert.equal(d.clausulas[0].texto.includes("Festa Completa"), false);
    assert.equal(d.clausulas[0].destaques?.[0], "Completa congelada V3");
  }
  assert.match(oficial(SNAP_V3_PACOTE_CONGELADO, 5).clausulas[0].texto, /, no salão Jardim\.$/);
});

test("Resumo da Contratação: sem salão, os mesmos bytes de antes; com salão, a linha \"Salão:\" no item 2", () => {
  const resumo = (snapshot: ContratoSnapshot) => renderizarDocumentoContrato({ snapshot, numeroVersao: 1, snapshotHash: hash });
  for (const [nome, antes] of Object.entries(ANTES_RESUMO)) {
    const r = resumo(SNAPS[nome]);
    assert.equal(`${sha(JSON.stringify(r))} ${hashPdfContrato(gerarPdfDocumentoContrato(r))}`, antes, nome);
  }
  const com = resumo(SNAP_V3_COM_SALAO);
  const sem = resumo(SNAP_V3_SEM_SALAO);
  const linhas = com.linhas.map((l) => l.texto);
  assert.equal(linhas.filter((t) => t === "Salão: Jardim").length, 1);
  assert.equal(linhas.indexOf("Salão: Jardim"), linhas.findIndex((t) => t.startsWith("Pacote:")) - 1);
  assert.deepEqual(com.linhas.filter((l) => l.texto !== "Salão: Jardim"), sem.linhas);
  const pdf = gerarPdfDocumentoContrato(com);
  assert.deepEqual(pdf, gerarPdfDocumentoContrato(resumo(SNAP_V3_COM_SALAO)), "determinístico");
  assert.ok(pdf.toString("latin1").includes("(SAL"), "rótulo SALÃO no PDF");
  assert.equal(gerarPdfDocumentoContrato(sem).toString("latin1").includes("(SAL"), false);
  assert.notEqual(hashPdfContrato(pdf), hashPdfContrato(gerarPdfDocumentoContrato(sem)));
});

const MODELO: ConteudoModelo = {
  titulo: "Contrato de Prestação de Serviços de Festa",
  contratada: { nome: "Buffet Alegria Ltda", documento: "12.345.678/0001-90", endereco: "Rua das Flores, 100 - Goiânia/GO", representante: "João Souza, sócio" },
  preambulo: ["As partes acima têm, entre si, justo e contratado o seguinte."],
  clausulas: [
    { titulo: "Objeto", texto: "Festa {{festa.pacote}} no dia {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, para {{festa.convidados}} convidados." },
    { titulo: null, texto: "O valor total é de {{valor.total}}, pago por {{pagamento.forma}}. Contratante: {{contratante.nome}}, CPF {{contratante.cpf}}." },
    { titulo: "Foro", texto: "Fica eleito o foro de Goiânia/GO." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia/GO",
};
const ANTES_EMPRESA: Record<string, string> = {
  V1: "65e02b679b0ff82136f513af8eccc10645e2c2faf6fd69e382b02f6c903768a9 f6dd472fe7357d3a8ade256d479992d40844d21ac922b71fa87bfe63207cae48",
  V2: "a03f0c8177ab402b405eebd60e69e293b0bed1689f1db99d5a3762f658afd3ad 5d7425e46d7a1f8d81de6f5f19ce4e7da5ed28915a42f91a9b48e19c9f836847",
  V3_SEM_SALAO: "65e02b679b0ff82136f513af8eccc10645e2c2faf6fd69e382b02f6c903768a9 f6dd472fe7357d3a8ade256d479992d40844d21ac922b71fa87bfe63207cae48",
};
const empresa = (snapshot: ContratoSnapshot, conteudo: ConteudoModelo = MODELO) =>
  renderizarModeloEmpresa({ id: "11111111-2222-4333-8444-555555555555", versao: 3, conteudo }, { snapshot, numeroVersao: 2, snapshotHash: hash, geradoEm: "2026-10-07T12:00:00Z" });

test("modelo da empresa (072): {{festa.salao}} na lista fechada, opcional, preenchido pelo snapshot; desconhecido segue recusado", () => {
  const campo = CAMPOS_CONTRATO.find((c) => c.chave === "festa.salao");
  assert.equal(campo?.grupo, "Festa");
  assert.equal((CAMPOS_OBRIGATORIOS as readonly string[]).includes("festa.salao"), false);
  assert.ok(INSTRUCAO_LEITURA_CONTRATO.includes("{{festa.salao}}"), "lista da leitura por IA");
  const extra = { dataContrato: "2026-10-07" };
  assert.equal(preencher("Local: {{festa.salao}}.", SNAP_V3_COM_SALAO, extra), "Local: Jardim.");
  for (const s of [SNAP_V1, SNAP_V2, SNAP_V3_SEM_SALAO]) assert.equal(preencher("[{{festa.salao}}]", s, extra), "[]");
  assert.throws(() => preencher("{{festa.salao_id}}", SNAP_V3_COM_SALAO, extra), /desconhecido/);
  assert.deepEqual(problemasDoConteudo({ ...MODELO, preambulo: ["No salão {{festa.salao}}."] }), []);
  assert.ok(problemasDoConteudo({ ...MODELO, preambulo: ["{{festa.configuracao}}"] }).some((p) => p.includes("{{festa.configuracao}} não existe")));
});

test("modelo da empresa (R-E5): bloco fixo \"Local da festa\" só com salão e sem o campo no texto; sem salão, bytes de antes", () => {
  for (const [nome, antes] of Object.entries(ANTES_EMPRESA)) {
    const d = empresa(SNAPS[nome]);
    assert.equal(`${sha(JSON.stringify(d))} ${hashPdfContratoOficial(gerarPdfContratoOficial(d, { logo: false }))}`, antes, nome);
  }
  const semCampo = empresa(SNAP_V3_COM_SALAO);
  const base = empresa(SNAP_V3_SEM_SALAO);
  assert.equal(JSON.stringify(semCampo).split("Local da festa").length - 1, 1);
  assert.deepEqual(semCampo.contratante, [...base.contratante, "Local da festa: Jardim."]);
  assert.deepEqual({ ...semCampo, contratante: [] }, { ...base, contratante: [] }, "cláusulas e demais blocos iguais");
  const comCampo = { ...MODELO, clausulas: [{ titulo: "Local", texto: "A festa será no salão {{festa.salao}}." }, ...MODELO.clausulas] };
  const d = empresa(SNAP_V3_COM_SALAO, comCampo);
  assert.doesNotMatch(JSON.stringify(d), /Local da festa/);
  assert.equal(d.clausulas[0].texto, "Local. A festa será no salão Jardim.");
  assert.equal(JSON.stringify(d).split("Jardim").length - 1, 1, "sem duplicar");
  assert.equal(empresa(SNAP_V3_COM_SALAO, { ...MODELO, observacoes: ["Salão: {{ festa.salao }}"] }).contratante.length, base.contratante.length);
});
