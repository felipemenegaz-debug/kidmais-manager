import assert from "node:assert/strict";
import test from "node:test";
import { ARQUIVO, PAGINAS, campos } from "./apoio.test.ts";
import { EXTRACAO_JSON_SCHEMA, evidenciaConfere, extracaoSchema, extrairPorRegras, localizarEvidencia, normalizarTrecho, valorNoTrecho } from "./extracao.ts";
import { aplicarRevisao, dadosNormalizados, montarRevisao } from "./rascunho.ts";
import { parcelasConferem, validarCpf, validarData, validarDuracao, validarHorario, validarInteiro, validarParcela, validarTelefone, validarValor } from "./validadores.ts";

/** Mesmo contrato com entrada de R$ 1.900,00: entrada + parcelas (7.900) não fecham o total (8.900). */
const PAGINAS_DIVERGENTES = PAGINAS.map((p) => p.replace("Entrada de R$ 2.900,00", "Entrada de R$ 1.900,00"));

test("validadores determinísticos: CPF, data, horário, telefone, valor e parcelas", () => {
  assert.deepEqual(validarCpf("52998224725"), { ok: true, valor: "529.982.247-25" });
  assert.equal(validarCpf("529.982.247-26").ok, false);
  assert.equal(validarCpf("111.111.111-11").ok, false);
  assert.deepEqual(validarData("21/11/2019"), { ok: true, valor: "2019-11-21" });
  assert.deepEqual(validarData("5 de março de 2020"), { ok: true, valor: "2020-03-05" });
  assert.equal(validarData("31/02/2020").ok, false);
  assert.equal(validarData("29/02/2021").ok, false);
  assert.deepEqual(validarHorario("das 14h às 18h30"), { ok: true, valor: { inicio: "14:00", fim: "18:30" } });
  assert.equal(validarHorario("18:00 às 14:00").ok, false);
  assert.deepEqual(validarTelefone("+55 11 98765-4321"), { ok: true, valor: "(11) 98765-4321" });
  assert.deepEqual(validarValor("R$ 8.900,00"), { ok: true, valor: 890000 });
  assert.deepEqual(validarValor("8900"), { ok: true, valor: 890000 });
  assert.deepEqual(validarParcela("R$ 2.000,00 em 10/11/2019"), { ok: true, valor: { valor: 200000, vencimento: "2019-11-10" } });
  assert.equal(parcelasConferem({ valor: 290000, vencimento: "2019-09-03" }, [{ valor: 200000, vencimento: "2019-09-10" }, { valor: 200000, vencimento: "2019-10-10" }, { valor: 200000, vencimento: "2019-11-10" }], 890000, "2019-11-21").ok, true);
  assert.equal(parcelasConferem(null, [{ valor: 100, vencimento: "2019-12-10" }], 100, "2019-11-21").ok, false, "vencimento depois da festa");
});

test("H4: nenhuma normalização silenciosa — negativo, decimal ambíguo, minutos ≥ 60 e texto extra são recusados com estado", () => {
  const estado = (v: { ok: boolean; estado?: string }) => (v.ok ? "VALIDO" : v.estado);
  assert.equal(estado(validarValor("R$ -100,00")), "INVALIDO", "R$ -100,00 não vira 100");
  assert.equal(estado(validarValor("-100")), "INVALIDO");
  assert.equal(estado(validarValor("(R$ 100,00)")), "INVALIDO", "parênteses contábeis são negativo");
  assert.equal(estado(validarValor("123.45")), "AMBIGUO", "123.45 não vira R$ 123,00 nem R$ 12.345,00");
  assert.equal(estado(validarValor("R$ 8.900,00 e R$ 500,00")), "AMBIGUO");
  assert.equal(estado(validarValor("R$ 8.900,00 à vista")), "NAO_REPRESENTAVEL");
  assert.equal(estado(validarInteiro("-30 convidados", 1, 10000, "Convidados")), "INVALIDO", "-30 convidados não vira 30");
  assert.equal(estado(validarInteiro("30,5", 1, 10000, "Convidados")), "NAO_REPRESENTAVEL");
  assert.equal(estado(validarInteiro("30 a 40 convidados", 1, 10000, "Convidados")), "AMBIGUO");
  assert.equal(estado(validarInteiro("cerca de 80 convidados", 1, 10000, "Convidados")), "NAO_REPRESENTAVEL");
  assert.equal(estado(validarDuracao("4h90")), "INVALIDO", "4h90 não vira 4 horas");
  assert.equal(estado(validarDuracao("4,7 horas")), "NAO_REPRESENTAVEL", "4,7h não vira 7 horas nem 4h30");
  assert.deepEqual(validarDuracao("4,5 horas"), { ok: true, valor: 270 });
  assert.deepEqual(validarDuracao("3h30"), { ok: true, valor: 210 });
  assert.equal(estado(validarData("21/11/19")), "AMBIGUO", "ano com dois dígitos não é adivinhado");
  assert.equal(estado(validarData("Data: 21/11/2019 às 14h")), "NAO_REPRESENTAVEL");
  assert.equal(estado(validarCpf("529.982.247-26")), "INVALIDO");
  assert.equal(estado(validarParcela("R$ 2.000,00")), "NAO_REPRESENTAVEL", "parcela sem vencimento não é completada");
});

test("H4: bruto, normalizado e validação ficam separados na revisão; recusado não tem normalizado", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.valores.total = { valor: "R$ -8.900,00", pagina: 2, trecho: "Valor total: R$ 8.900,00" };
  lida.evento.duracao = { valor: "4h90", pagina: 1, trecho: "Duração: 4 horas" };
  lida.evento.convidados = { valor: "-80 convidados", pagina: 1, trecho: "80 convidados" };
  lida.valores.preco = { valor: "123.45", pagina: 2, trecho: "Valor do pacote: R$ 8.400,00" };
  const c = campos(montarRevisao(lida, PAGINAS, ARQUIVO));
  for (const [id, bruto, validacao] of [
    ["valores.total", "R$ -8.900,00", "INVALIDO"],
    ["evento.duracao", "4h90", "INVALIDO"],
    ["evento.convidados", "-80 convidados", "INVALIDO"],
    ["valores.preco", "123.45", "AMBIGUO"],
  ] as const) {
    assert.equal(c[id].bruto, bruto, id);
    assert.equal(c[id].valor, bruto, `${id}: exibe o bruto, não um valor parecido`);
    assert.equal(c[id].normalizado, null, id);
    assert.equal(c[id].validacao, validacao, id);
    assert.equal(c[id].estado, "PRECISA_REVISAO", id);
  }
  const dados = dadosNormalizados(Object.values(c));
  assert.equal(dados.valores.total, null);
  assert.equal(dados.evento.duracaoMinutos, null);
  assert.equal(dados.evento.convidados, null);
  // Válido: bruto preservado ao lado do normalizado.
  assert.deepEqual([c["valores.adicionais"].bruto, c["valores.adicionais"].normalizado, c["valores.adicionais"].validacao], ["R$ 500,00", "R$ 500,00", "VALIDO"]);
});

test("H4: valor recusado nunca é confirmado como está; conflito exige confirmar divergência (≠ aceitar conversão)", () => {
  const lida = extrairPorRegras(PAGINAS_DIVERGENTES);
  lida.contratante.cpf = { valor: "529.982.247-26", pagina: 1, trecho: "CPF 529.982.247-26" };
  const revisao = montarRevisao(lida, PAGINAS_DIVERGENTES, ARQUIVO);
  const confirmarInvalido = aplicarRevisao(revisao, [], { campoId: "contratante.cpf" });
  assert.ok("erro" in confirmarInvalido && /Corrija ou remova/.test(confirmarInvalido.erro), "CPF inválido confirmado não vira null em silêncio");
  // Entrada + parcelas não batem com o total: conflito entre valores válidos.
  const c = campos(revisao);
  assert.equal(c["pagamentos.entrada"].validacao, "PRECISA_REVISAO");
  assert.match(c["pagamentos.entrada"].conflito ?? "", /soma da entrada/);
  const semDeclarar = aplicarRevisao(revisao, [], { campoId: "pagamentos.entrada" });
  assert.ok("erro" in semDeclarar && /contrato histórico contém este valor divergente/.test(semDeclarar.erro));
  const declarado = aplicarRevisao(revisao, [], { campoId: "pagamentos.entrada", confirmarDivergencia: true });
  assert.ok(!("erro" in declarado));
  if (!("erro" in declarado)) {
    assert.deepEqual(declarado.revisados, ["pagamentos.entrada"]);
    assert.equal(campos(declarado.extracao)["pagamentos.entrada"].confirmacao?.tipo, "DIVERGENCIA");
  }
});

test("H4: revalidação completa depois de cada correção manual; confirmação cai quando o conflito some ou muda", () => {
  let revisao = montarRevisao(extrairPorRegras(PAGINAS_DIVERGENTES), PAGINAS_DIVERGENTES, ARQUIVO);
  const conflitantes = ["pagamentos.entrada", "pagamentos.parcela_1", "pagamentos.parcela_2", "pagamentos.parcela_3"];
  let revisados: string[] = [];
  for (const id of conflitantes) {
    const r = aplicarRevisao(revisao, revisados, { campoId: id, confirmarDivergencia: true });
    assert.ok(!("erro" in r), id);
    if ("erro" in r) return;
    revisao = r.extracao;
    revisados = r.revisados;
  }
  assert.deepEqual(revisados.sort(), [...conflitantes].sort());
  // Corrigir o total para 7.900 fecha a conta das parcelas: a revalidação alcança TODOS os campos.
  const total = aplicarRevisao(revisao, revisados, { campoId: "valores.total", valor: "R$ 7.900,00" });
  assert.ok(!("erro" in total));
  if ("erro" in total) return;
  const c = campos(total.extracao);
  for (const id of conflitantes) assert.equal(c[id].estado, "ENCONTRADO", id);
  assert.deepEqual(total.revisados, [], "confirmações antigas não sobrevivem ao fim do conflito");
  // O total novo cria outro conflito (pacote + adicionais ≠ total): pede revisão de novo.
  for (const id of ["valores.preco", "valores.adicionais", "valores.total"]) assert.equal(c[id].estado, "PRECISA_REVISAO", id);
  // Voltar a um total divergente das parcelas: o conflito reaparece e exige nova confirmação.
  const outro = aplicarRevisao(total.extracao, total.revisados, { campoId: "valores.total", valor: "R$ 9.500,00" });
  assert.ok(!("erro" in outro));
  if ("erro" in outro) return;
  assert.equal(campos(outro.extracao)["pagamentos.entrada"].estado, "PRECISA_REVISAO");
  assert.equal(outro.revisados.includes("pagamentos.entrada"), false);
});

test("H4: parcela inválida continua visível como pendência; remover é decisão explícita", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.pagamentoPrevisto.parcelas[1] = { numero: 2, valor: { valor: "R$ -2.000,00", pagina: 2, trecho: "Parcela 2 de R$ 2.000,00" }, vencimento: { valor: "10/10/2019", pagina: 2, trecho: "vencimento 10/10/2019" } };
  const revisao = montarRevisao(lida, PAGINAS, ARQUIVO);
  const c = campos(revisao);
  assert.equal(c["pagamentos.parcela_2"].estado, "PRECISA_REVISAO");
  assert.equal(c["pagamentos.parcela_2"].validacao, "INVALIDO");
  assert.equal(c["pagamentos.parcela_2"].bruto, "R$ -2.000,00 em 10/10/2019");
  assert.ok("erro" in aplicarRevisao(revisao, [], { campoId: "pagamentos.parcela_2" }));
  const removida = aplicarRevisao(revisao, [], { campoId: "pagamentos.parcela_2", valor: "" });
  assert.ok(!("erro" in removida));
  if (!("erro" in removida)) {
    const r = campos(removida.extracao)["pagamentos.parcela_2"];
    assert.deepEqual([r.estado, r.motivo, r.origem], ["NAO_ENCONTRADO", "Removido na revisão.", "Informado pelo operador"]);
  }
  const corrigida = aplicarRevisao(revisao, [], { campoId: "pagamentos.parcela_2", valor: "R$ 2.000,00 em 10/10/2019" });
  assert.ok(!("erro" in corrigida));
  const invalida = aplicarRevisao(revisao, [], { campoId: "pagamentos.parcela_2", valor: "dois mil" });
  assert.ok("erro" in invalida, "parcela digitada passa pelo validador de parcela, não de texto");
});

test("H5: evidência tipada — 100 ≠ 1000, 30 ≠ 130, CPF parcial, datas parecidas, texto como substring", () => {
  const n = normalizarTrecho;
  assert.equal(valorNoTrecho("R$ 100,00", n("Taxa: R$ 1.000,00"), "valor"), false, "100 vs 1000");
  assert.equal(valorNoTrecho("R$ 1.000,00", n("Taxa: R$ 1.000,00"), "valor"), true);
  assert.equal(valorNoTrecho("R$ 100,00", n("Taxa: R$ 100"), "valor"), true, "igualdade numérica, formato diferente");
  assert.equal(valorNoTrecho("R$ 8.900,00", n("Total R$ 8.900,50"), "valor"), false, "centavos contam");
  assert.equal(valorNoTrecho("30", n("130 convidados"), "convidados"), false, "30 vs 130");
  assert.equal(valorNoTrecho("30", n("30 convidados"), "convidados"), true);
  assert.equal(valorNoTrecho("30", n("3,30 convidados"), "convidados"), false, "30 não é a parte decimal de 3,30");
  assert.equal(valorNoTrecho("529.982.247-25", n("CPF 529.982.247-2"), "cpf"), false, "CPF parcial");
  assert.equal(valorNoTrecho("529.982.247-25", n("CPF 1529.982.247-25"), "cpf"), false, "CPF dentro de número maior");
  assert.equal(valorNoTrecho("529.982.247-25", n("CPF 52998224725"), "cpf"), true, "canônico");
  assert.equal(valorNoTrecho("21/11/2019", n("Data: 21/11/2018"), "data"), false, "datas parecidas");
  assert.equal(valorNoTrecho("21/11/2019", n("Data: 1/11/2019"), "data"), false);
  assert.equal(valorNoTrecho("21/11/2019", n("em 21 de novembro de 2019"), "data"), true, "mesma data em outro formato");
  assert.equal(valorNoTrecho("Ana", n("Contratante: Mariana"), "texto"), false, "texto como pedaço de palavra");
  assert.equal(valorNoTrecho("Ana", n("Contratante: Ana Lima"), "texto"), true);
  assert.equal(valorNoTrecho("(11) 98765-4321", n("Tel: 11 98765-4321"), "telefone"), true);
  assert.equal(valorNoTrecho("(11) 98765-4321", n("Tel: 11 98765-43210"), "telefone"), false);
});

test("H5: evidência com valor divergente do trecho não vira Encontrado", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.valores.adicionais = { valor: "R$ 50,00", pagina: 2, trecho: "Adicionais: R$ 500,00" };
  lida.evento.convidados = { valor: "8", pagina: 1, trecho: "80 convidados" };
  assert.equal(evidenciaConfere(lida.valores.adicionais, PAGINAS, "valor"), false);
  assert.equal(evidenciaConfere(lida.evento.convidados, PAGINAS, "convidados"), false);
  const c = campos(montarRevisao(lida, PAGINAS, ARQUIVO));
  assert.equal(c["valores.adicionais"].evidencia?.conferida, false);
  assert.equal(c["evento.convidados"].estado, "PRECISA_REVISAO");
});

test("JSON Schema do provedor e schema zod têm os mesmos campos; chave extra (ex.: pago) invalida a extração", () => {
  const vazia = extrairPorRegras([""]);
  for (const [grupo, def] of Object.entries(EXTRACAO_JSON_SCHEMA.properties)) {
    const chaves = "properties" in def && grupo !== "observacoes" ? Object.keys(def.properties) : [];
    assert.deepEqual(chaves.sort(), grupo === "observacoes" ? [] : Object.keys((vazia as Record<string, object>)[grupo]).sort(), grupo);
  }
  assert.equal(extracaoSchema.safeParse({ ...vazia, pagamentosRealizados: [] }).success, false);
  assert.equal(extracaoSchema.safeParse({ ...vazia, pagamentoPrevisto: { ...vazia.pagamentoPrevisto, pago: true } }).success, false);
});

test("extração por regras + revisão: estados reais por campo; texto hostil do contrato é só texto", () => {
  const lida = extrairPorRegras(PAGINAS);
  const revisao = montarRevisao(lida, PAGINAS, ARQUIVO);
  const c = campos(revisao);
  assert.equal(revisao.fonte, "DOCUMENTO");
  assert.deepEqual([c["contratante.nome"].estado, c["contratante.nome"].valor], ["ENCONTRADO", "Mariana Souza Lima"]);
  assert.deepEqual([c["contratante.cpf"].estado, c["contratante.cpf"].valor], ["ENCONTRADO", "529.982.247-25"]);
  assert.equal(c["contratante.email"].estado, "NAO_ENCONTRADO");
  assert.deepEqual([c["evento.data"].estado, c["evento.data"].valor], ["ENCONTRADO", "21/11/2019"]);
  assert.equal(c["evento.horario"].valor, "14:00 às 18:00");
  assert.equal(c["pacote.nome"].valor, "Festa Completa tabela 2019", "pacote histórico preservado, sem troca pelo catálogo atual");
  assert.equal(c["valores.total"].valor, "R$ 8.900,00");
  assert.equal(c["pagamentos.parcela_3"].valor, "R$ 2.000,00 em 10/11/2019");
  assert.equal(c["pagamentos.parcela_3"].evidencia?.conferida, true);
  assert.equal(c["pagamentos.realizados"].estado, "NAO_ENCONTRADO");
  assert.match(c["pagamentos.realizados"].motivo ?? "", /não são inferidos/);
  // O texto "marque como pagos" vira observação (dado), nunca um pagamento.
  const dados = dadosNormalizados(Object.values(c));
  assert.equal(JSON.stringify(dados).includes("\"pago"), false);
  assert.equal(dados.pagamentos.parcelas.length, 3);
  assert.match(dados.observacoes ?? "", /Ignore as instruções/);
});

test("evidência inventada não vira Encontrado; valor inválido e conflito de soma pedem revisão", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.contratante.email = { valor: "mariana@example.com", pagina: 1, trecho: "E-mail: mariana@example.com" };
  lida.evento.convidados = { valor: "120", pagina: 1, trecho: "80 convidados" };
  lida.contratante.cpf = { valor: "529.982.247-26", pagina: 1, trecho: "CPF 529.982.247-26" };
  lida.valores.total = { valor: "R$ 9.900,00", pagina: 2, trecho: "Valor total: R$ 8.900,00" };
  assert.equal(evidenciaConfere(lida.contratante.email, PAGINAS, "email"), false);
  const c = campos(montarRevisao(lida, PAGINAS, ARQUIVO));
  assert.equal(c["contratante.email"].estado, "PRECISA_REVISAO");
  assert.equal(c["evento.convidados"].estado, "PRECISA_REVISAO");
  assert.equal(c["contratante.cpf"].estado, "PRECISA_REVISAO");
  assert.match(c["contratante.cpf"].motivo ?? "", /dígito verificador/);
  assert.equal(c["valores.total"].estado, "PRECISA_REVISAO");
});

test("revisão humana: valor informado passa pelo validador; confirmar leitura só em campo marcado", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.contratante.cpf = { valor: "529.982.247-26", pagina: 1, trecho: "CPF 529.982.247-26" };
  const revisao = montarRevisao(lida, PAGINAS, ARQUIVO);
  const invalido = aplicarRevisao(revisao, [], { campoId: "contratante.cpf", valor: "123" });
  assert.ok("erro" in invalido);
  const corrigido = aplicarRevisao(revisao, [], { campoId: "contratante.cpf", valor: "52998224725" });
  assert.ok(!("erro" in corrigido));
  if (!("erro" in corrigido)) {
    const cpf = campos(corrigido.extracao)["contratante.cpf"];
    assert.deepEqual([cpf.estado, cpf.valor, cpf.origem, cpf.bruto], ["ENCONTRADO", "529.982.247-25", "Informado pelo operador", "52998224725"]);
  }
  assert.ok("erro" in aplicarRevisao(revisao, [], { campoId: "contratante.nome" }), "campo já encontrado não precisa de confirmação");
  assert.ok("erro" in aplicarRevisao(revisao, [], { campoId: "pagamentos.realizados", valor: "R$ 8.900,00" }), "pagamento realizado nunca é preenchido pela importação");
});

test("A3 (H4): a regra captura o token inteiro — sinal e escala chegam ao validador; nada vira valor parecido", () => {
  const paginas = PAGINAS.map((p) => p
    .replace("80 convidados", "-30 convidados")
    .replace("Valor total: R$ 8.900,00", "Valor total: R$ -100,00")
    .replace("Valor do pacote: R$ 8.400,00", "Valor do pacote: R$ 30 mil"));
  const lida = extrairPorRegras(paginas);
  assert.equal(lida.evento.convidados.valor, "-30");
  assert.equal(lida.valores.total.valor, "R$ -100,00");
  assert.equal(lida.valores.preco.valor, "R$ 30 mil");
  const c = campos(montarRevisao(lida, paginas, ARQUIVO));
  assert.deepEqual([c["evento.convidados"].bruto, c["evento.convidados"].validacao, c["evento.convidados"].normalizado], ["-30", "INVALIDO", null]);
  assert.deepEqual([c["valores.total"].bruto, c["valores.total"].validacao, c["valores.total"].normalizado], ["R$ -100,00", "INVALIDO", null]);
  assert.deepEqual([c["valores.preco"].bruto, c["valores.preco"].validacao, c["valores.preco"].normalizado], ["R$ 30 mil", "NAO_REPRESENTAVEL", null]);
  const dados = dadosNormalizados(Object.values(c));
  assert.equal(dados.evento.convidados, null, "nunca 30");
  assert.equal(dados.valores.total, null, "nunca 100");
  assert.equal(dados.valores.preco, null, "nunca 30");
});

test("A3 (H4): '30 mil convidados' e '30 k' não viram 30; só unidade conhecida é aceita", () => {
  const paginas = PAGINAS.map((p) => p.replace("80 convidados", "30 mil convidados"));
  const lida = extrairPorRegras(paginas);
  assert.equal(lida.evento.convidados.valor, "30 mil");
  assert.equal(campos(montarRevisao(lida, paginas, ARQUIVO))["evento.convidados"].validacao, "NAO_REPRESENTAVEL");
  for (const texto of ["30 mil", "30 k", "30 milhões"]) assert.equal(validarInteiro(texto, 1, 10000, "Convidados").ok, false, texto);
  assert.deepEqual(validarInteiro("80 convidados", 1, 10000, "Convidados"), { ok: true, valor: 80 });
  assert.deepEqual(validarInteiro("6 anos", 0, 120, "Idade"), { ok: true, valor: 6 });
});

test("A4 (H5): trecho recortado da página no meio de um token nunca prova o valor", () => {
  const pagina = ["Taxa de decoração: R$ 1000", "Contratante: Mariana Lima", "CPF 529.982.247-25", "Convidados: -30 convidados"].join("\n");
  const p = [pagina];
  assert.equal(localizarEvidencia({ valor: "R$ 100", pagina: 1, trecho: "Taxa de decoração: R$ 100" }, p, "valor"), null);
  assert.equal(localizarEvidencia({ valor: "Ana", pagina: 1, trecho: "ana Lima" }, p, "texto"), null, "trecho começa no meio de Mariana");
  assert.equal(localizarEvidencia({ valor: "Ana", pagina: 1, trecho: "Ana" }, p, "texto"), null);
  assert.equal(localizarEvidencia({ valor: "529.982.247-25", pagina: 1, trecho: "CPF 529.982.247-2" }, p, "cpf"), null);
  assert.equal(localizarEvidencia({ valor: "30", pagina: 1, trecho: "30 convidados" }, p, "convidados"), null, "sinal pertence ao número");
  // Evidência legítima: localizada com offsets na página original.
  const ok = localizarEvidencia({ valor: "R$ 1.000,00", pagina: 1, trecho: "Taxa de decoração: R$ 1000" }, p, "valor");
  assert.ok(ok);
  assert.equal(pagina.slice(ok!.inicio, ok!.fim), "Taxa de decoração: R$ 1000");
  const nome = localizarEvidencia({ valor: "Mariana Lima", pagina: 1, trecho: "Contratante: Mariana Lima" }, p, "texto");
  assert.equal(pagina.slice(nome!.inicio, nome!.fim), "Contratante: Mariana Lima");
});

test("A4 (H5): a revisão guarda os offsets da evidência e não confere trecho truncado", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.valores.adicionais = { valor: "R$ 50,00", pagina: 2, trecho: "Adicionais: R$ 50" };
  const c = campos(montarRevisao(lida, PAGINAS, ARQUIVO));
  assert.equal(c["valores.adicionais"].evidencia?.conferida, false, "R$ 50 recortado de R$ 500,00");
  const cpf = c["contratante.cpf"].evidencia!;
  assert.equal(cpf.conferida, true);
  assert.equal(PAGINAS[0].slice(cpf.inicio!, cpf.fim!), "CPF 529.982.247-25");
});
