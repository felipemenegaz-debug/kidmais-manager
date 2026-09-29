import assert from "node:assert/strict";
import test from "node:test";
import type { TenantComprovado } from "../../saas/provar-tenant.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta } from "../ferramentas.ts";
import { montarResumoCliente } from "../leituras/resumir-cliente.ts";
import { construirContextoAutorizado, construirContextoModelo } from "./construtor.ts";
import { ContextoRecusado, type BlocoDados, type ContextoAutorizado } from "./contrato.ts";
import { mencionaCrianca, redigir, temIdentificadorResidual } from "./redacao.ts";

const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";
const usuario = "aaaaaaaa-0000-4000-8000-000000000001";
const clienteId = "cccccccc-0000-4000-8000-000000000009";
const tenantA = { empresaComprovada: empresaA, membershipId: "m-a", usuarioId: usuario, papelAtual: "ADMINISTRATIVO" } as TenantComprovado;
const CAPACIDADES = ["atencao_hoje", "analisar_recebiveis", "resumir_cliente", "resumir_festa"];

const autorizado = (contexto: Parameters<typeof construirContextoAutorizado>[0]["contexto"] = { tela: "cliente", entidadeId: clienteId }): ContextoAutorizado =>
  construirContextoAutorizado({ sessao: { usuario_id: usuario }, tenant: tenantA, contexto, capacidades: CAPACIDADES });

const ctxFerramenta: ContextoFerramenta = { hoje: "2026-09-29", geradoEm: "2026-09-29T15:00:00Z", portas: { festas: null, clientes: null } };

/** Saída REAL da leitura `resumir_cliente`: nome completo do cliente, nomes e aniversários de crianças, link com id. */
function resumoCliente(): RespostaLeitura {
  return montarResumoCliente({
    cliente: { nomeCompleto: "Mariana Souza Lima", status: "ATIVO", criadoEm: "2026-02-10T12:00:00Z" },
    aniversariantes: [{ nome: "Lara", dataNascimento: "2020-11-03", ativo: true }, { nome: "Theo Lima", dataNascimento: "2022-01-15", ativo: true }],
    responsaveis: [{}],
    cadastro: { completoParaContrato: false, camposFaltantes: [{ campo: "cpf", label: "CPF" }, { campo: "endereco", label: "Endereço" }] },
  }, clienteId, ctxFerramenta);
}

const recebiveis = (capacidade = "analisar_recebiveis"): RespostaLeitura => ({
  capacidade,
  estado: "atencao",
  resumo: "R$ 8.500,00 em aberto.",
  fatos: [{ natureza: "CALCULO", texto: "R$ 3.000,00 vencidos há mais de 30 dias.", fonte: "financeiro.recebiveis" }, { natureza: "FATO", texto: "Nenhum recebível vence hoje.", fonte: "financeiro.recebiveis" }],
  itens: [{ id: "i1", prioridade: "alta", titulo: "Recebíveis vencidos", detalhe: "Cliente Alfa 123.456.789-09", destino: `/admin/financeiro/contas-receber?id=${clienteId}` }],
  evidencias: [{ fonte: "financeiro.recebiveis", rotulo: "Em aberto", valor: "R$ 8.500,00" }, { fonte: "financeiro.recebiveis", rotulo: "Vencidos", valor: "2" }],
  referencia: { hoje: "2026-09-29", geradoEm: "2026-09-29T15:00:00Z", fontes: ["financeiro.recebiveis"] },
});

const bloco = (resposta: RespostaLeitura, empresaId = empresaA): BlocoDados => ({ empresaId, capacidade: resposta.capacidade, resposta });

// ---------------------------------------------------------------- contexto autorizado

test("autorizado: vem só da sessão e do tenant comprovado (empresa, papel da membership); entidade só em tela de entidade", () => {
  const a = autorizado();
  assert.deepEqual([a.empresaId, a.papel, a.estabelecimentoId, a.tela], [empresaA, "ADMINISTRATIVO", null, "cliente"]);
  assert.deepEqual(a.entidade, { tipo: "cliente", id: clienteId });
  assert.equal(autorizado({ tela: "dashboard", entidadeId: clienteId }).entidade, null, "id numa tela sem entidade é ignorado");
  assert.equal(autorizado(null).tela, "geral");
  assert.throws(() => construirContextoAutorizado({ sessao: { usuario_id: "outro-usuario" }, tenant: tenantA, contexto: null, capacidades: [] }), ContextoRecusado);
  assert.ok(Object.isFrozen(a));
});

// ---------------------------------------------------------------- minimização

test("modelo: sem ids, sem links, sem nome do cliente, sem dados de criança; só o necessário, redigido", () => {
  const { contexto, json } = construirContextoModelo(autorizado(), [bloco(resumoCliente())], { finalidade: "RESUMIR" });
  for (const proibido of ["Mariana", "Souza", "Lima", "Lara", "Theo", clienteId, empresaA, usuario, "/clientes/", "2020-11-03", "03/11", "15/01"]) {
    assert.equal(json.includes(proibido), false, proibido);
  }
  assert.equal(contexto.entidade?.tipo, "cliente");
  assert.equal("id" in (contexto.entidade ?? {}), false);
  // Leitura de UMA pessoa: nenhum texto livre; só evidências com valor seguro (e sem dado de criança).
  assert.deepEqual(contexto.dados[0].fatos, []);
  assert.deepEqual(contexto.dados[0].itens, []);
  assert.deepEqual(contexto.dados[0].evidencias.map((e) => [e.rotulo, e.valor]), [["Cadastro completo para contrato", "Não"], ["Responsáveis adicionais", "1"]]);
  assert.ok(contexto.minimizacao.removidos >= 3);
});

test("modelo: nome gravado em minúsculas numa leitura de pessoa também não chega ao modelo", () => {
  const r = montarResumoCliente({
    cliente: { nomeCompleto: "mariana souza", status: "ATIVO", criadoEm: "2026-02-10T12:00:00Z" },
    aniversariantes: [{ nome: "lara", dataNascimento: "2020-11-03", ativo: true }],
    responsaveis: [],
    cadastro: { completoParaContrato: true, camposFaltantes: [] },
  }, clienteId, ctxFerramenta);
  const { json } = construirContextoModelo(autorizado(), [bloco(r)], { finalidade: "RESUMIR" });
  for (const proibido of ["mariana", "souza", "lara"]) assert.equal(json.toLowerCase().includes(proibido), false, proibido);
});

test("modelo: agregados financeiros seguem úteis (valores e contagens), detalhe/link/CPF do item nunca", () => {
  const { contexto, json } = construirContextoModelo(autorizado({ tela: "financeiro" }), [bloco(recebiveis())], { finalidade: "EXPLICAR_DADOS" });
  assert.deepEqual(contexto.dados[0].evidencias.map((e) => [e.rotulo, e.valor]), [["Em aberto", "R$ 8.500,00"], ["Vencidos", "2"]]);
  assert.match(json, /R\$ 3\.000,00 vencidos há mais de 30 dias/);
  for (const proibido of ["Cliente Alfa", "123.456.789-09", "contas-receber", "R$ 8.500,00 em aberto."]) assert.equal(json.includes(proibido), false, proibido);
  assert.deepEqual(contexto.dados[0].itens, [{ prioridade: "alta", titulo: "Recebíveis vencidos" }]);
});

// ---------------------------------------------------------------- cross-tenant e autorização

test("cross-tenant: bloco lido em OUTRA empresa recusa o contexto inteiro (nunca segue 'sem aquele bloco')", () => {
  assert.throws(() => construirContextoModelo(autorizado(), [bloco(recebiveis(), empresaB)], { finalidade: "EXPLICAR_DADOS" }), (e: unknown) => e instanceof ContextoRecusado && e.motivo === "OUTRA_EMPRESA");
  assert.throws(() => construirContextoModelo(autorizado(), [bloco(recebiveis()), bloco(recebiveis(), empresaB)], { finalidade: "EXPLICAR_DADOS" }), ContextoRecusado);
});

test("cross-tenant: capacidade fora das autorizadas ou rótulo de bloco trocado ⇒ recusa", () => {
  const naoAutorizada = recebiveis("analisar_pagamentos");
  assert.throws(() => construirContextoModelo(autorizado(), [bloco(naoAutorizada)], { finalidade: "EXPLICAR_DADOS" }), (e: unknown) => e instanceof ContextoRecusado && e.motivo === "CAPACIDADE_NAO_AUTORIZADA");
  const trocado: BlocoDados = { empresaId: empresaA, capacidade: "atencao_hoje", resposta: recebiveis("analisar_pagamentos") };
  assert.throws(() => construirContextoModelo(autorizado(), [trocado], { finalidade: "EXPLICAR_DADOS" }), ContextoRecusado);
});

test("cross-tenant: id de outra empresa escrito num texto vira [id]; id na fonte (fora da redação) é barrado no fim", () => {
  const comId = { ...recebiveis(), fatos: [{ natureza: "FATO" as const, texto: `Veja a festa ${empresaB} de outra empresa.`, fonte: "financeiro.recebiveis" }] };
  const { json } = construirContextoModelo(autorizado(), [bloco(comId)], { finalidade: "EXPLICAR_DADOS" });
  assert.equal(json.includes(empresaB), false);
  assert.match(json, /\[id\]/);
  const fonteComId = { ...recebiveis(), fatos: [{ natureza: "FATO" as const, texto: "x", fonte: `financeiro.${empresaB}` }] };
  assert.throws(() => construirContextoModelo(autorizado(), [bloco(fonteComId)], { finalidade: "EXPLICAR_DADOS" }), (e: unknown) => e instanceof ContextoRecusado && e.motivo === "IDENTIFICADOR_RESIDUAL");
});

test("cross-tenant: contexto não carrega empresa, usuário nem papel; mesma pergunta em duas empresas não mistura dados", () => {
  const a = construirContextoModelo(autorizado(), [bloco(recebiveis())], { finalidade: "EXPLICAR_DADOS" });
  const tenantB = { ...tenantA, empresaComprovada: empresaB };
  const autB = construirContextoAutorizado({ sessao: { usuario_id: usuario }, tenant: tenantB, contexto: null, capacidades: CAPACIDADES });
  const dadosB = { ...recebiveis(), evidencias: [{ fonte: "financeiro.recebiveis", rotulo: "Em aberto", valor: "R$ 1,00" }] };
  const b = construirContextoModelo(autB, [bloco(dadosB, empresaB)], { finalidade: "EXPLICAR_DADOS" });
  assert.equal(a.json.includes("R$ 1,00"), false);
  assert.equal(b.json.includes("R$ 8.500,00"), false);
  for (const j of [a.json, b.json]) assert.doesNotMatch(j, /empresa|usuario|ADMINISTRATIVO|papel/i);
  assert.throws(() => construirContextoModelo(autB, [bloco(recebiveis(), empresaA)], { finalidade: "EXPLICAR_DADOS" }), ContextoRecusado);
});

// ---------------------------------------------------------------- limites

test("limites: blocos, fatos e bytes têm teto; o que passa do teto é cortado e marcado", () => {
  const muitos = { ...recebiveis(), fatos: Array.from({ length: 30 }, (_, i) => ({ natureza: "FATO" as const, texto: `Fato número ${i} do financeiro com texto razoavelmente longo para ocupar espaço.`, fonte: "financeiro.recebiveis" })) };
  const { contexto, json } = construirContextoModelo(autorizado(), [bloco(muitos), bloco(recebiveis()), bloco(recebiveis()), bloco(recebiveis())], { finalidade: "EXPLICAR_DADOS", limites: { maxBytes: 1_500 } });
  assert.ok(contexto.dados.length <= 3);
  assert.ok(contexto.dados[0].fatos.length <= 8);
  assert.ok(new TextEncoder().encode(json).length <= 1_500);
  assert.equal(contexto.minimizacao.truncado, true);
  assert.ok(contexto.minimizacao.removidos > 0);
});

// ---------------------------------------------------------------- redação

test("redação: nomes próprios (inclusive no começo da frase e após ':') viram [nome]; vocabulário do sistema fica", () => {
  assert.equal(redigir("Mariana Souza: cadastro completo.").texto, "[nome]: cadastro completo.");
  assert.equal(redigir("Próximo aniversário: Lara, em 03/11/2026.").texto, "Próximo aniversário: [nome], em 03/11/2026.");
  assert.equal(redigir("Contrato de João da Silva assinado.").texto, "Contrato de [nome] da [nome] assinado.");
  assert.equal(redigir("Cliente ativo, cadastrado em 10/02/2026.").texto, "Cliente ativo, cadastrado em 10/02/2026.");
  assert.equal(redigir("Nenhum pagamento vencido hoje.").texto, "Nenhum pagamento vencido hoje.");
  assert.equal(redigir("festa com Ana", { sensiveis: ["Ana"] }).texto, "festa com [nome]");
});

test("redação: PII, links internos e caracteres ocultos saem; texto longo é cortado", () => {
  const r = redigir(`mari@x.com, (61) 99999-0000, CPF 123.456.789-00, veja /clientes/${clienteId} e https://x.invalid/a, oi${String.fromCharCode(0x200b)}!`);
  for (const pii of ["mari@x.com", "99999-0000", "123.456.789-00", clienteId, "https://", "/clientes/"]) assert.equal(r.texto.includes(pii), false, pii);
  assert.equal(r.texto.includes(String.fromCharCode(0x200b)), false);
  assert.ok(r.redacoes >= 5);
  assert.ok(redigir("a ".repeat(400), { maxCaracteres: 50 }).texto.length <= 50);
});

test("sinais: dado de criança é reconhecido; barreira final detecta id, e-mail, CPF e link", () => {
  for (const t of ["Próximo aniversário em março", "Data de nascimento", "Idade da criança", "3 aniversariantes ativos"]) assert.equal(mencionaCrianca(t), true, t);
  assert.equal(mencionaCrianca("Recebíveis vencidos"), false);
  for (const t of [empresaA, "a@b.co", "111.222.333-44", "http://x"]) assert.equal(temIdentificadorResidual(JSON.stringify({ t })), true, t);
  assert.equal(temIdentificadorResidual(JSON.stringify({ t: "R$ 8.500,00 em 29/09/2026" })), false);
});
