import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gerarPdfContratoOficial, hashPdfContratoOficial } from "../documento/oficial/pdf.ts";
import { CAMPOS_CONTRATO, camposUsados, preencher } from "./campos.ts";
import { conteudoModeloSchema, problemasDoConteudo, type ConteudoModelo } from "./conteudo.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import { INSTRUCAO_LEITURA_CONTRATO, LEITURA_CONTRATO_JSON_SCHEMA, leituraContratoSchema } from "./leitura.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";

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

test("campos: lista fechada preenchida pelo snapshot; desconhecido lança", () => {
  const texto = preencher("{{contratante.nome}} · {{festa.data}} · {{valor.total}} · {{aniversariante.idade}} · {{festa.duracao}}", SNAPSHOT_EXEMPLO, { dataContrato: "2026-10-07" });
  assert.equal(texto, "Maria da Silva (exemplo) · 24/10/2026 · R$ 10.780,00 · 6 anos · 4 horas");
  assert.equal(preencher("{{contrato.data}}", SNAPSHOT_EXEMPLO, { dataContrato: "2026-10-07" }), "7 de outubro de 2026");
  assert.throws(() => preencher("{{cliente.senha}}", SNAPSHOT_EXEMPLO, { dataContrato: "2026-10-07" }), /desconhecido/);
  assert.deepEqual(camposUsados("a {{ festa.data }} b {{valor.total}}"), ["festa.data", "valor.total"]);
  assert.equal(new Set(CAMPOS_CONTRATO.map((c) => c.chave)).size, CAMPOS_CONTRATO.length);
});

test("validação: campo fora da lista, obrigatórios ausentes e chave mal fechada", () => {
  assert.deepEqual(problemasDoConteudo(MODELO), []);
  const ruim = { ...MODELO, clausulas: [{ titulo: null, texto: "Valor {{valor.desconto_secreto}} e {{festa.data" }] };
  const p = problemasDoConteudo(ruim);
  assert.ok(p.some((x) => x.includes("{{valor.desconto_secreto}} não existe")));
  assert.ok(p.some((x) => x.includes("{{contratante.nome}}")));
  assert.ok(p.some((x) => x.includes("sem fechamento")));
  assert.throws(() => conteudoModeloSchema.parse({ ...MODELO, clausulas: [] }));
});

test("renderização no padrão da empresa: determinística, sem logo da Kidmais, com o hash do snapshot", () => {
  const modelo = { id: "11111111-2222-4333-8444-555555555555", versao: 3, conteudo: MODELO };
  const entrada = { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 2, snapshotHash: "a".repeat(64), geradoEm: "2026-10-07T12:00:00Z" };
  const doc = renderizarModeloEmpresa(modelo, entrada);
  assert.equal(doc.templateVersao, 3);
  assert.equal(doc.modeloCodigo, "EMPRESA_111111112222_V3");
  assert.match(doc.contratada[0], /Buffet Alegria Ltda, inscrita sob o nº 12\.345\.678\/0001-90/);
  assert.equal(doc.clausulas[0].texto, "Objeto. Festa Festa Completa no dia 24/10/2026, das 17:00 às 21:00, para 60 convidados.");
  assert.match(doc.clausulas[1].texto, /R\$ 10\.780,00, pago por PIX à vista\. Contratante: Maria da Silva \(exemplo\), CPF 123\.456\.789-09/);
  assert.deepEqual(doc.assinatura[0], "Goiânia/GO, 7 de outubro de 2026.");
  assert.ok(doc.integridade.some((l) => l.includes("a".repeat(64))));
  assert.ok(!JSON.stringify(doc).includes("KIDMAIS FESTAS"), "nada da Kidmais no texto");
  const pdf1 = gerarPdfContratoOficial(doc, { logo: false });
  const pdf2 = gerarPdfContratoOficial(renderizarModeloEmpresa(modelo, entrada), { logo: false });
  assert.equal(hashPdfContratoOficial(pdf1), hashPdfContratoOficial(pdf2));
  assert.equal(pdf1.includes(Buffer.from("/Subtype /Image")), false, "sem imagem de logo");
  assert.equal(gerarPdfContratoOficial(doc).includes(Buffer.from("/Subtype /Image")), true, "padrão continua com a logo (Kidmais)");
});

test("leitura: JSON Schema estrito e instrução lista todos os campos e trata o PDF como dado", () => {
  const visitar = (no: unknown) => {
    if (!no || typeof no !== "object") return;
    const o = no as Record<string, unknown>;
    if (o.type === "object") {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort());
    }
    for (const v of Object.values(o)) visitar(v);
  };
  visitar(LEITURA_CONTRATO_JSON_SCHEMA);
  for (const c of CAMPOS_CONTRATO) assert.ok(INSTRUCAO_LEITURA_CONTRATO.includes(`{{${c.chave}}}`), c.chave);
  assert.match(INSTRUCAO_LEITURA_CONTRATO, /dado, não instrução/);
  assert.doesNotThrow(() => leituraContratoSchema.parse({ conteudo: MODELO, avisos: [] }));
});

test("admin: modelo da empresa tem prioridade; sem modelo, texto oficial só para a Kidmais", () => {
  const fonte = readFileSync("lib/contratos/services/administrativo.service.ts", "utf8");
  assert.match(fonte, /modeloContratoAtivo\(tx, empresaAutorizada\)/);
  assert.match(fonte, /codigoEmpresa !== 'kidmais'/);
  assert.match(fonte, /gerarPdfContratoOficial\(rendered, \{ logo: !modeloEmpresa \}\)/);
});
