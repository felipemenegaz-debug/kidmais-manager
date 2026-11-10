import assert from "node:assert/strict";
import test from "node:test";
import { contratantePjSnapshot } from "../../clientes/cadastro-contratual.ts";
import { formatarCnpj } from "../documento/contratante-pj.ts";
import { renderizarContratoOficial } from "../documento/oficial/registry.ts";
import { renderizarContratoTemplateV1 } from "../documento/template-v1.ts";
import type { ContratoSnapshot } from "../repositories/models.ts";
import { preencher } from "./campos.ts";
import { sugerirConversaoConteudoPj, sugerirConversaoPj, trechosIncompativeisPj } from "./compatibilidade-pj.ts";
import type { ConteudoModelo } from "./conteudo.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";

/**
 * Entrega B (112) — contratante PJ no contrato (plano R2-2 e R21-2). A prova de que o PF não mudou um byte compara a
 * base com o código novo (117 saídas, ver o pacote); aqui ficam as regras de PJ e o texto PF fixado.
 */
const PF = SNAPSHOT_EXEMPLO;
const PJ: ContratoSnapshot = {
  ...PF,
  contratante: {
    ...PF.contratante, nomeCompleto: "Escola Pequeno Saber Ltda", cpf: "", rg: null,
    ...contratantePjSnapshot({ tipoPessoa: "PJ", cnpj: "11222333000181", razaoSocial: "Escola Pequeno Saber Ltda", nomeFantasia: "Pequeno Saber",
      representanteNome: "Ana Diretora", representanteCpf: "11144477735" }),
  },
};
const LEGADO: ConteudoModelo = {
  titulo: "Contrato de Prestação de Serviços de Festa",
  contratada: { nome: "Buffet Alegria Ltda", documento: "12.345.678/0001-90", endereco: "Rua das Flores, 100", representante: "João Souza" },
  preambulo: ["{{contratante.nome}}, brasileiro(a), estado civil ____, portador do CPF nº {{contratante.cpf}}, RG {{contratante.rg}}, contrata a festa."],
  clausulas: [
    { titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados." },
    { titulo: "Preço", texto: "Valor {{valor.total}}, {{pagamento.condicao}}. O CONTRATANTE, CPF: {{contratante.cpf}}, declara ciência." },
    { titulo: "Foro", texto: "Fica eleito o foro de Goiânia; a CONTRATADA é empresa brasileira." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia",
};
const render = (conteudo: ConteudoModelo, snapshot: ContratoSnapshot) =>
  renderizarModeloEmpresa({ id: "00000000-0000-4000-8000-000000000009", versao: 2, conteudo }, { snapshot, numeroVersao: 1, snapshotHash: "a".repeat(64), geradoEm: "2026-11-01T10:00:00Z" });
const texto = (d: ReturnType<typeof render>) => [...d.contratante, ...d.preambulo, ...d.clausulas.map((c) => c.texto), ...d.observacoes, ...d.assinatura].join("\n");

test("snapshot: PF não ganha chave nenhuma (hash igual ao de antes); PJ leva CNPJ, razão social, fantasia e representante", () => {
  assert.deepEqual(contratantePjSnapshot({}), {});
  assert.deepEqual(contratantePjSnapshot({ tipoPessoa: "PF", cnpj: "11222333000181" }), {});
  assert.deepEqual(contratantePjSnapshot({ tipoPessoa: "PJ", cnpj: "12ABC34501DE35", razaoSocial: "X Ltda", nomeFantasia: "", representanteNome: null }),
    { tipoPessoa: "PJ", cnpj: "12ABC34501DE35", razaoSocial: "X Ltda", nomeFantasia: null, representante: null });
  assert.equal(formatarCnpj("12ABC34501DE35"), "12.ABC.345/01DE-35");
  assert.equal(formatarCnpj("11222333000181"), "11.222.333/0001-81");
});

test("bloco fixo do modelo da empresa: PF exatamente como antes; PJ com razão social, CNPJ e representante, sem RG", () => {
  const pf = render({ ...LEGADO, preambulo: [], clausulas: LEGADO.clausulas.slice(0, 1) }, PF);
  assert.equal(pf.contratante[0], "CONTRATANTE: Maria da Silva (exemplo), CPF 123.456.789-09, RG 1.234.567, telefone (61) 99999-0000, e-mail maria@exemplo.com, endereço SQN 100 Bloco A, 10 - Asa Norte, Brasília/DF - CEP 70000-000.");
  const pj = render({ ...LEGADO, preambulo: [], clausulas: LEGADO.clausulas.slice(0, 1) }, PJ);
  assert.equal(pj.contratante[0], "CONTRATANTE: Escola Pequeno Saber Ltda, inscrita no CNPJ nº 11.222.333/0001-81, nome fantasia Pequeno Saber, neste ato representada por Ana Diretora, CPF 111.444.777-35, telefone (61) 99999-0000, e-mail maria@exemplo.com, endereço SQN 100 Bloco A, 10 - Asa Norte, Brasília/DF - CEP 70000-000.");
  assert.equal(pj.assinatura.at(-1), "CONTRATANTE: Escola Pequeno Saber Ltda");
});

test("campos novos: documento e tipo valem para PF e PJ; representante vazio na PF; {{contratante.cpf}} nunca recebe CNPJ", () => {
  const p = (t: string, s: ContratoSnapshot) => preencher(t, s, { dataContrato: "2026-11-01" });
  assert.equal(p("{{contratante.tipo_documento}} {{contratante.documento}}", PF), "CPF 123.456.789-09");
  assert.equal(p("{{contratante.tipo_documento}} {{contratante.documento}}", PJ), "CNPJ 11.222.333/0001-81");
  assert.equal(p("[{{contratante.representante}}]", PF), "[]");
  assert.equal(p("{{contratante.representante}}", PJ), "Ana Diretora, CPF 111.444.777-35");
  assert.equal(p("{{contratante.representante}}", { ...PJ, contratante: { ...PJ.contratante, representante: null } }), "Não informado");
  assert.throws(() => p("CPF {{contratante.cpf}}", PJ), /MODELO_INCOMPATIVEL_PJ/);
  assert.equal(p("CPF {{contratante.cpf}}", PF), "CPF 123.456.789-09");
});

test("modelo legado: trechos de qualificação PF listados com local; literais sem campo do contratante não contam", () => {
  const t = trechosIncompativeisPj(LEGADO);
  const pares = t.map((x) => `${x.local}|${x.motivo}`);
  for (const esperado of [
    "Preâmbulo 1|usa {{contratante.cpf}}", "Preâmbulo 1|“portador do CPF” é qualificação de pessoa física",
    "Preâmbulo 1|nacionalidade é qualificação de pessoa física", "Preâmbulo 1|estado civil é qualificação de pessoa física",
    "Preâmbulo 1|RG não se aplica a pessoa jurídica", "Cláusula 2|usa {{contratante.cpf}}",
  ]) assert(pares.includes(esperado), esperado);
  assert(!pares.some((p) => p.startsWith("Cláusula 3")), "“empresa brasileira” sem campo do contratante não é qualificação");
  assert(t.every((x) => x.trecho.length <= 140));
  assert.deepEqual(trechosIncompativeisPj({ ...LEGADO, preambulo: [], clausulas: LEGADO.clausulas.slice(0, 1) }), []);
});

test("conversão sugerida troca a expressão inteira: PF continua “CPF <cpf>”, PJ vira “CNPJ <cnpj>”, nunca “CPF <cnpj>”", () => {
  for (const [antes, depois] of [
    ["CPF {{contratante.cpf}}", "{{contratante.tipo_documento}} {{contratante.documento}}"],
    ["CPF nº {{contratante.cpf}}", "{{contratante.tipo_documento}} {{contratante.documento}}"],
    ["CPF: {{contratante.cpf}}", "{{contratante.tipo_documento}} {{contratante.documento}}"],
    ["inscrito no CPF sob o nº {{contratante.cpf}}", "{{contratante.tipo_documento}} {{contratante.documento}}"],
    ["portadora do CPF {{ contratante.cpf }}", "{{contratante.tipo_documento}} {{contratante.documento}}"],
    ["documento {{contratante.cpf}}", "documento {{contratante.documento}}"],
  ]) assert.equal(sugerirConversaoPj(antes), depois, antes);
  // Identidade PF vale para a forma "CPF {{contratante.cpf}}" (R21-2); variações como "CPF:" viram "CPF" na sugestão,
  // que o usuário revisa antes de publicar.
  const modelo: ConteudoModelo = { ...LEGADO, preambulo: ["{{contratante.nome}}, CPF {{contratante.cpf}}, contrata a festa."],
    clausulas: [LEGADO.clausulas[0], { titulo: "Preço", texto: "Valor {{valor.total}}, {{pagamento.condicao}}. O CONTRATANTE, CPF {{contratante.cpf}}, declara ciência." }] };
  const convertido = sugerirConversaoConteudoPj(modelo);
  assert.deepEqual(trechosIncompativeisPj(convertido), []);
  assert.equal(texto(render(convertido, PF)), texto(render(modelo, PF)), "PF: texto idêntico ao do modelo antigo");
  const pj = texto(render(convertido, PJ));
  assert.match(pj, /Escola Pequeno Saber Ltda, CNPJ 11\.222\.333\/0001-81, contrata a festa\./);
  assert.match(pj, /O CONTRATANTE, CNPJ 11\.222\.333\/0001-81, declara/);
  assert.doesNotMatch(pj, /CPF 11\.222|CPF 112223/);
});

test("contratos oficiais e resumo: PJ com CNPJ e representante; PF sem mudança de texto", () => {
  const completa = (s: ContratoSnapshot) => ({ ...s, evento: { ...s.evento, pacote: { ...s.evento.pacote, codigo: "COMPLETA" } } }) as ContratoSnapshot;
  for (const v of [1, 5] as const) {
    const pj = renderizarContratoOficial({ snapshot: completa(PJ), numeroVersao: 1, snapshotHash: "a".repeat(64), templateVersao: v, geradoEm: "2026-11-01T10:00:00Z" })!;
    assert.match(pj.contratante[0], /^CONTRATANTE: Escola Pequeno Saber Ltda, inscrita no CNPJ nº 11\.222\.333\/0001-81, nome fantasia Pequeno Saber, neste ato representada por Ana Diretora, CPF 111\.444\.777-35, telefone/);
    assert.doesNotMatch(pj.contratante[0], /RG /);
    assert(pj.assinatura.includes("CONTRATANTE: Escola Pequeno Saber Ltda - CNPJ 11.222.333/0001-81"), `v${v}`);
    const pf = renderizarContratoOficial({ snapshot: completa(PF), numeroVersao: 1, snapshotHash: "a".repeat(64), templateVersao: v, geradoEm: "2026-11-01T10:00:00Z" })!;
    assert(pf.assinatura.includes("CONTRATANTE: Maria da Silva (exemplo) - CPF 123.456.789-09"), `v${v}`);
  }
  const resumo = renderizarContratoTemplateV1({ snapshot: PJ, numeroVersao: 1, snapshotHash: "a".repeat(64), templateVersao: 1 });
  const linhas = resumo.linhas.map((l) => l.texto);
  for (const l of ["Razão social: Escola Pequeno Saber Ltda", "CNPJ: 11.222.333/0001-81", "Nome fantasia: Pequeno Saber", "Representante: Ana Diretora, CPF 111.444.777-35"]) assert(linhas.includes(l), l);
  assert(!linhas.some((l) => l.startsWith("CPF:") || l.startsWith("RG:")));
});
