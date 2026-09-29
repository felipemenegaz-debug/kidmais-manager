import assert from "node:assert/strict";
import test from "node:test";
import { ARQUIVO, PAGINAS, campos } from "./apoio.test.ts";
import { extrairPorRegras } from "./extracao.ts";
import { classificarMatch, montarPlano } from "./plano.ts";
import { aplicarRevisao, dadosNormalizados, montarRevisao } from "./rascunho.ts";

test("match de cliente: CPF existente, contato, nome parecido, novo e sem contato", () => {
  const dados = dadosNormalizados(Object.values(campos(montarRevisao(extrairPorRegras(PAGINAS), PAGINAS, ARQUIVO))));
  assert.equal(classificarMatch(dados, { cpfExistente: { clienteId: "c1", nomeCompleto: "Mariana" }, possiveisDuplicidades: [] }).estado, "CLIENTE_EXISTENTE");
  assert.equal(classificarMatch(dados, { cpfExistente: { clienteId: "c1", nomeCompleto: "Mariana", status: "INATIVO" }, possiveisDuplicidades: [] }).estado, "PRECISA_REVISAO");
  assert.equal(classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [{ clienteId: "c2", nomeCompleto: "Mari", motivos: ["TELEFONE_IGUAL"] }] }).estado, "POSSIVEL_MATCH");
  assert.equal(classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [{ clienteId: "c3", nomeCompleto: "Mariana S.", motivos: ["NOME_SEMELHANTE"] }] }).estado, "POSSIVEL_MATCH");
  assert.equal(classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [] }).estado, "NOVO_CLIENTE");
  assert.equal(classificarMatch({ ...dados, contratante: { ...dados.contratante, telefone: null, whatsapp: null } }, { cpfExistente: null, possiveisDuplicidades: [] }).estado, "PRECISA_REVISAO");
  assert.equal(classificarMatch(dados, null).estado, "PRECISA_REVISAO");
});

test("plano: bloqueia com revisão pendente; cria ou vincula; festa fica pendente do Core; previsto nunca vira pago", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.evento.idade = { valor: "6 anos", pagina: 1, trecho: "Idade: seis anos" };
  const revisao = montarRevisao(lida, PAGINAS, ARQUIVO);
  const dados = dadosNormalizados(revisao.secoes.flatMap((s) => s.campos));
  const novo = classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [] });
  const bloqueado = montarPlano(revisao, [], novo, null);
  assert.equal(bloqueado.pronto, false);
  assert.match(bloqueado.bloqueios[0], /Revise 1 campo/);
  // A lista gravada não basta: a confirmação precisa estar no campo, amarrada ao valor visto.
  assert.equal(montarPlano(revisao, ["evento.idade"], novo, null).pronto, false, "revisados forjados não liberam o plano");
  const revisado = aplicarRevisao(revisao, [], { campoId: "evento.idade" });
  assert.ok(!("erro" in revisado));
  if ("erro" in revisado) return;
  const plano = montarPlano(revisado.extracao, revisado.revisados, novo, null);
  assert.equal(plano.pronto, true, JSON.stringify(plano.bloqueios));
  assert.deepEqual(plano.passos.map((p) => `${p.tipo}:${p.acao}`), ["CLIENTE:CRIAR", "CONTRATO_HISTORICO:REGISTRAR_SNAPSHOT", "FESTA:PENDENTE_CORE", "PAGAMENTOS_PREVISTOS:REGISTRAR_NO_SNAPSHOT"]);
  assert.equal(plano.snapshot.pagamentosPrevistos.natureza, "PREVISTO");
  assert.equal(plano.snapshot.valores.total, 890000);
  assert.ok(plano.avisos.some((a) => a.includes("Nenhum pagamento é marcado como recebido")));
  assert.equal(/"(pago|pagos|recebido|recebidoEm|pagoEm)"\s*:/.test(JSON.stringify(plano)), false);

  const possivel = classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [{ clienteId: "c2", nomeCompleto: "Mari", motivos: ["WHATSAPP_IGUAL"] }] });
  assert.equal(montarPlano(revisado.extracao, [], possivel, null).pronto, false, "possível match exige decisão do operador");
  assert.deepEqual(montarPlano(revisado.extracao, [], possivel, { tipo: "VINCULAR", clienteId: "c2" }).passos[0], { tipo: "CLIENTE", acao: "VINCULAR", clienteId: "c2", motivo: "Escolhido pelo operador." });
  assert.equal(montarPlano(revisado.extracao, [], possivel, { tipo: "VINCULAR", clienteId: "outro-tenant" }).pronto, false, "só candidatos da própria análise");
});

test("H4: plano nunca fica pronto com perda silenciosa (CPF inválido, parcela inválida, valor negativo)", () => {
  const lida = extrairPorRegras(PAGINAS);
  lida.contratante.cpf = { valor: "529.982.247-26", pagina: 1, trecho: "CPF 529.982.247-26" };
  lida.pagamentoPrevisto.parcelas[1] = { numero: 2, valor: { valor: "R$ -2.000,00", pagina: 2, trecho: "Parcela 2 de R$ 2.000,00" }, vencimento: { valor: "10/10/2019", pagina: 2, trecho: "vencimento 10/10/2019" } };
  let revisao = montarRevisao(lida, PAGINAS, ARQUIVO);
  const match = classificarMatch(dadosNormalizados(revisao.secoes.flatMap((s) => s.campos)), { cpfExistente: null, possiveisDuplicidades: [] });
  // Confirma tudo o que é confirmável: os recusados continuam bloqueando.
  for (const c of revisao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    const r = aplicarRevisao(revisao, [], { campoId: c.id, confirmarDivergencia: true });
    if (!("erro" in r)) revisao = r.extracao;
  }
  const plano = montarPlano(revisao, [], match, null);
  assert.equal(plano.pronto, false);
  assert.ok(plano.bloqueios.some((b) => b.startsWith("CPF:")), JSON.stringify(plano.bloqueios));
  assert.ok(plano.bloqueios.some((b) => b.startsWith("Parcela 2 prevista:")), "parcela inválida é pendência visível, não some");
  assert.equal(plano.bloqueios.join(" ").includes("529.982.247-26"), false, "bloqueio não repete o dado lido");
  // O snapshot nunca contém a parcela com valor adivinhado.
  assert.equal(plano.snapshot.pagamentosPrevistos.parcelas.some((p) => p.numero === 2), false);
});

test("A3 (H4): plano não fica pronto se o texto do contrato tinha sinal ou escala que o parser não representa", () => {
  const paginas = PAGINAS.map((p) => p.replace("80 convidados", "-30 convidados").replace("Valor total: R$ 8.900,00", "Valor total: R$ -100,00"));
  let revisao = montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO);
  const match = classificarMatch(dadosNormalizados(revisao.secoes.flatMap((s) => s.campos)), { cpfExistente: null, possiveisDuplicidades: [] });
  for (const c of revisao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    const r = aplicarRevisao(revisao, [], { campoId: c.id, confirmarDivergencia: true });
    if (!("erro" in r)) revisao = r.extracao;
  }
  const plano = montarPlano(revisao, [], match, null);
  assert.equal(plano.pronto, false);
  assert.ok(plano.bloqueios.some((b) => b.startsWith("Convidados:")));
  assert.ok(plano.bloqueios.some((b) => b.startsWith("Valor contratado:")));
});
