import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, IDS, MARCADOR_B, PII, type OpcoesAmbiente } from "../../../scripts/ia-benchmark/ambiente.ts";
import type { AIResponse, EntidadeRef, RespostaLeitura } from "../contratos.ts";
import { Circuito } from "../modelos/circuito.ts";
import { criarProvedorFake, respostaFake } from "../modelos/fake.ts";
import { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } from "../modelos/orcamento.ts";
import { RoteadorModelos, politicaDoAmbiente } from "../modelos/roteador.ts";
import type { AdaptadorProvedor, PedidoModelo } from "../modelos/tipos.ts";
import { compor, faltando, fatosSolicitados } from "./composicao.ts";
import { validarPlano } from "./plano.ts";

/**
 * AI V1.1 — PR 6.4: resultados conservados e resposta de leitura composta DETERMINISTICAMENTE (sem modelo).
 * Os fatos pedidos têm de vir do Core, da MESMA festa/contrato; resposta parcial nunca é sucesso.
 */
const HOJE = "2026-09-30";
const FRASE_CLIENTE_PAGO = "me diz o cliente e se o contrato da festa que vem aí está pago";
const FRASE_SITUACAO_PAGAMENTO = "quero saber a situação do contrato e o pagamento do próximo evento";

type Amb = ReturnType<typeof criarAmbiente>;
function comModelo(amb: Amb, plano: unknown) {
  const provedor = criarProvedorFake({ id: "OPENAI", roteiro: (p: PedidoModelo<unknown>) => respostaFake(JSON.stringify(p.workload === "PLANEJAR" ? plano : { capacidade: "nenhuma", dia: null })) });
  let n = 0;
  amb.deps.roteador = new RoteadorModelos({
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_MODEL_MAX_RETRIES: "0" }),
    adaptadores: new Map([["OPENAI", provedor as AdaptadorProvedor]]), precos: null,
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 } }) }),
    registro: criarRegistroUsoEmMemoria(), circuito: new Circuito(), agora: () => new Date(`${HOJE}T15:00:00Z`), relogio: () => 0,
    novoId: () => `${String(++n).padStart(8, "0")}-0000-4000-8000-0000000000aa`,
  });
  return provedor;
}
async function perguntar(texto: string, opcoes: OpcoesAmbiente = {}, plano?: unknown) {
  const amb = criarAmbiente(opcoes);
  if (plano) comModelo(amb, plano);
  const [o] = await amb.conversar({ id: "composicao", categoria: "multi_tool", turnos: [{ texto }], esperado: { entendimento: "EXECUTADO" }, pr: "PR6" });
  return { o, amb };
}
const dados = (r: AIResponse | null) => (r as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
const textos = (d: RespostaLeitura) => d.fatos.map((f) => `${f.natureza}:${f.texto}`);
const passos = (o: Awaited<ReturnType<typeof perguntar>>["o"]) => o.rastro?.plano?.passos.map((p) => p.capacidade);

const nulos = { parametros: null, selecao: null, resposta: null };
const ancora = { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: null, selecao: "PRIMEIRA", resposta: null };
/** Plano do modelo para a frase 1: cliente (relações, na resposta) + posição financeira oficial (final). */
const PLANO_CLIENTE_PAGO = {
  objetivo: "CONSULTAR:PAGAMENTO", recursoFinal: null,
  passos: [
    ancora,
    { id: "p2", capacidade: "relacoes_festa", ...nulos, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, resposta: true },
    { id: "p3", capacidade: "saldo_contrato", ...nulos, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } },
  ],
};

/** O que NUNCA pode aparecer: o outro contrato da empresa (Pedro/Carla, em aberto) e dados da outra empresa. */
function semContratoErrado(d: RespostaLeitura) {
  const tudo = JSON.stringify(d);
  for (const proibido of ["Carla Souza", "R$ 5.000,00", "R$ 2.500,00", MARCADOR_B, IDS.CONTRATO_PEDRO, IDS.FESTA_PEDRO, IDS.CLIENTE_CARLA, IDS.FESTA_B, IDS.CLIENTE_B]) {
    assert.equal(tudo.includes(proibido), false, `fato de outro contrato/empresa: ${proibido}`);
  }
  // Mesma âncora: uma festa, um contrato, um cliente — os da próxima festa.
  const ids = (tipo: EntidadeRef["tipo"]) => [...new Set((d.entidades ?? []).filter((e) => e.tipo === tipo).map((e) => e.id))];
  assert.deepEqual(ids("CONTRATO"), [IDS.CONTRATO_MARIA]);
  assert.deepEqual(ids("CLIENTE").length <= 1 && (ids("CLIENTE")[0] ?? IDS.CLIENTE_ANA), IDS.CLIENTE_ANA);
}

// ---------------------------------------------------------------- frase 1 (Planner por modelo), três posições financeiras

test("frase 1, parcialmente pago: cliente das relações + posição oficial do MESMO contrato; estado atenção; nada do outro contrato", async () => {
  const { o, amb } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: "PARCIAL" }, PLANO_CLIENTE_PAGO);
  const d = dados(o.resposta);
  assert.deepEqual(passos(o), ["proximas_festas", "relacoes_festa", "saldo_contrato"]);
  assert.deepEqual([o.rastro?.plano?.origem, o.rastro?.plano?.parada, o.rastro?.plano?.motivoParada], ["MODELO", "FIM", null]);
  assert.deepEqual(o.rastro?.plano?.composicao, { leituras: 2, solicitados: ["CLIENTE", "POSICAO_FINANCEIRA"], faltando: [] });
  const f = textos(d);
  for (const esperado of ["FATO:Cliente: Ana Oliveira.", "FATO:Valor contratado: R$ 4.500,00.", "FATO:Valor pago (líquido): R$ 3.300,00.", "CALCULO:Em aberto: R$ 1.200,00, em 1 parcela.", "FATO:Situação: Em aberto."]) assert.ok(f.includes(esperado), esperado);
  assert.equal(d.estado, "atencao");
  assert.match(d.resumo, /Cliente: Ana Oliveira\./);
  assert.match(d.resumo, /Falta pagar R\$ 1\.200,00 de R\$ 4\.500,00/);
  semContratoErrado(d);
  assert.deepEqual(amb.violacoes.crossTenant, []);
});

test("frase 1, quitado: 'Situação: Quitado.' da posição oficial; nenhum 'em aberto' do outro contrato da empresa", async () => {
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: "QUITADO" }, PLANO_CLIENTE_PAGO);
  const d = dados(o.resposta);
  const f = textos(d);
  for (const esperado of ["FATO:Cliente: Ana Oliveira.", "FATO:Valor pago (líquido): R$ 4.500,00.", "CALCULO:Em aberto: R$ 0,00, em 0 parcelas.", "FATO:Situação: Quitado."]) assert.ok(f.includes(esperado), esperado);
  assert.equal(f.some((x) => /Situação: Em aberto/.test(x)), false);
  assert.notEqual(d.estado, "atencao");
  semContratoErrado(d);
});

test("frase 1, sem posição financeira: ausência explícita na resposta composta (nunca 'pago'); estado sem_dados", async () => {
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: "SEM_POSICAO" }, PLANO_CLIENTE_PAGO);
  const d = dados(o.resposta);
  const f = textos(d);
  assert.ok(f.includes("AUSENCIA:Contrato sem obrigação financeira criada."));
  assert.ok(f.includes("FATO:Cliente: Ana Oliveira."));
  assert.match(d.resumo, /ainda não há plano financeiro registrado/);
  assert.equal(d.estado, "sem_dados");
  assert.equal(/quitad|Situação: /i.test(f.join(" ")), false, "sem posição oficial, nada sugere pago");
  semContratoErrado(d);
});

test("frase 1, financeiro negado pela Policy: a execução para fail-closed; o cliente já lido NÃO vira resposta de sucesso", async () => {
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: "NEGADO" }, PLANO_CLIENTE_PAGO);
  assert.equal(o.resposta, null, "erro fail-closed (403), sem resposta parcial");
  assert.equal(o.status, 403);
  assert.notEqual(o.rastro?.plano?.resultadoFinal, "SUCESSO");
});

// ---------------------------------------------------------------- frase 2 (Planner por regras), três posições financeiras

test("frase 2 (regras): situação do contrato E posição oficial, do mesmo contrato da próxima festa — parcial, quitado e sem posição", async () => {
  const esperado = {
    PARCIAL: { situacao: "FATO:Situação: Em aberto.", estado: "atencao" },
    QUITADO: { situacao: "FATO:Situação: Quitado.", estado: "informativo" },
    SEM_POSICAO: { situacao: "AUSENCIA:Contrato sem obrigação financeira criada.", estado: "sem_dados" },
  } as const;
  for (const [cenario, e] of Object.entries(esperado) as Array<[keyof typeof esperado, (typeof esperado)[keyof typeof esperado]]>) {
    const { o } = await perguntar(FRASE_SITUACAO_PAGAMENTO, { financeiroProximaFesta: cenario });
    const d = dados(o.resposta);
    assert.deepEqual(passos(o), ["proximas_festas", "relacoes_festa", "resumir_contrato", "saldo_contrato"], cenario);
    assert.equal(o.rastro?.plano?.origem, "REGRAS");
    assert.deepEqual(o.rastro?.plano?.composicao, { leituras: 2, solicitados: ["SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"], faltando: [] }, cenario);
    const f = textos(d);
    assert.ok(f.includes("FATO:Contrato assinado, versão vigente V2."), `${cenario}: situação contratual (resumir_contrato)`);
    assert.ok(f.includes(e.situacao), `${cenario}: ${e.situacao}`);
    // Estado = o mais restritivo entre as leituras: em aberto ⇒ atenção; sem posição ⇒ sem_dados; quitado não é "em_dia"
    // se o resumo do contrato é só informativo. Nunca "em_dia" com dado faltando.
    assert.equal(d.estado, e.estado, cenario);
    semContratoErrado(d);
  }
});

// ---------------------------------------------------------------- completude: a marca não basta; o que conta é o que o Core devolveu

test("completude: sem a relação na resposta, o cliente falta ⇒ ausência explícita, estado atenção, INCOMPLETO", async () => {
  const semMarca = { ...PLANO_CLIENTE_PAGO, passos: PLANO_CLIENTE_PAGO.passos.map((p) => ({ ...p, resposta: null })) };
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, {}, semMarca);
  const d = dados(o.resposta);
  assert.ok(textos(d).includes("AUSENCIA:Não consegui obter: cliente."));
  assert.equal(textos(d).some((x) => x.startsWith("FATO:Cliente:")), false);
  assert.equal(d.estado, "atencao");
  assert.deepEqual([o.rastro?.plano?.motivoParada, o.rastro?.plano?.composicao?.faltando], ["INCOMPLETO", ["CLIENTE"]]);
});

test("completude: proxima_parcela NÃO comprova quitação; relação com CONTRATO NÃO cobre a situação contratual", async () => {
  const comParcela = { ...PLANO_CLIENTE_PAGO, passos: [PLANO_CLIENTE_PAGO.passos[0], PLANO_CLIENTE_PAGO.passos[1], { ...PLANO_CLIENTE_PAGO.passos[2], capacidade: "proxima_parcela" }] };
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, {}, comParcela);
  assert.deepEqual(o.rastro?.plano?.composicao?.faltando, ["POSICAO_FINANCEIRA"]);
  assert.ok(textos(dados(o.resposta)).includes("AUSENCIA:Não consegui obter: posição financeira (pago, saldo, em aberto)."));
  // "o contrato e o cliente": a relação devolve "Contrato V2 assinado.", mas isso não é a situação contratual.
  const soRelacao = { objetivo: "CONSULTAR:CONTRATO", recursoFinal: null, passos: [ancora, { id: "p2", capacidade: "relacoes_festa", ...nulos, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" } }] };
  const r = await perguntar("me mostra o contrato e o cliente da festa que vem aí", {}, soRelacao);
  assert.deepEqual(r.o.rastro?.plano?.composicao?.faltando, ["SITUACAO_CONTRATO"]);
  assert.equal(dados(r.o.resposta).estado, "atencao");
});

test("fatos pedidos: o texto decide (cliente, situação, posição); contrato só como âncora não pede situação", () => {
  assert.deepEqual(fatosSolicitados(FRASE_CLIENTE_PAGO), ["CLIENTE", "POSICAO_FINANCEIRA"]);
  assert.deepEqual(fatosSolicitados(FRASE_SITUACAO_PAGAMENTO), ["SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"]);
  assert.deepEqual(fatosSolicitados("qual é a próxima parcela do último contrato?"), []);
  assert.deepEqual(fatosSolicitados("o contrato da próxima festa está quitado?"), ["POSICAO_FINANCEIRA"]);
  assert.deepEqual(fatosSolicitados("qual o contrato dela?"), ["SITUACAO_CONTRATO"]);
});

// ---------------------------------------------------------------- contratos preservados: navegação, Human Gate, paradas

test("navegação no fim: o contrato de navegação é mantido (nada é composto), mesmo com leitura marcada antes", async () => {
  const abrir = { objetivo: "ABRIR:CONTRATO", recursoFinal: "CONTRATO", passos: [ancora, { id: "p2", capacidade: "relacoes_festa", ...nulos, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, resposta: true }, { id: "p3", capacidade: "abrir_tela", ...nulos, parametros: { ordem: null, limite: null, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } }] };
  const { o } = await perguntar("me leva para o contrato e o cliente da festa que vem aí", {}, abrir);
  assert.equal(o.resposta?.tipo, "navegacao", "o contrato de navegação é mantido");
  assert.equal((o.resposta as { destino?: string }).destino, `/admin/contratos?contratoId=${IDS.CONTRATO_MARIA}`);
  assert.equal(o.rastro?.plano?.composicao, null, "nada é composto em navegação");
});

test("validação (6.4.1): `resposta` vale só em leitura intermediária com entrada da cadeia; no fim ou em listagem é IGNORADA", () => {
  const cat = [{ id: "proximas_festas", descricao: "", tipo: "leitura" as const }, { id: "relacoes_festa", descricao: "", tipo: "leitura" as const }, { id: "saldo_contrato", descricao: "", tipo: "leitura" as const }];
  const p = (passos: unknown[]) => validarPlano({ objetivo: "CONSULTAR:PAGAMENTO", recursoFinal: null, passos }, cat);
  const p1 = { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2 }, selecao: "PRIMEIRA" };
  const p2 = { id: "p2", capacidade: "relacoes_festa", entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" } };
  const p3 = { id: "p3", capacidade: "saldo_contrato", entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } };
  const marcas = (v: ReturnType<typeof p>) => (v.ok ? v.plano.passos.map((x) => x.resposta === true) : v.motivo);
  assert.deepEqual(marcas(p([p1, { ...p2, resposta: true }, p3])), [false, true, false]);
  // Antes (6.4): RESPOSTA_INVALIDA e o plano inteiro era descartado (smoke de staging). Agora a marca é normalizada:
  // a listagem nunca entra e o final sempre entra — nenhum fato é acrescentado.
  assert.deepEqual(marcas(p([{ ...p1, resposta: true }, p2, p3])), [false, false, false], "listagem de âncora");
  assert.deepEqual(marcas(p([p1, p2, { ...p3, resposta: true }])), [false, false, false], "passo final");
  assert.deepEqual(marcas(p([{ ...p1, resposta: true }, { ...p2, resposta: true }, { ...p3, resposta: true }])), [false, true, false], "todas marcadas");
});

test("staging (6.4.1): modelo que marca TODOS os passos ⇒ plano aceito; só a relação e o final entram; fatos corretos", async () => {
  const tudoMarcado = { ...PLANO_CLIENTE_PAGO, passos: PLANO_CLIENTE_PAGO.passos.map((p) => ({ ...p, resposta: true })) };
  const { o } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: "PARCIAL" }, tudoMarcado);
  assert.notEqual(o.rastro?.plano?.parada, "REJEITADO:RESPOSTA_INVALIDA", "antes: plano rejeitado");
  assert.deepEqual([o.rastro?.plano?.origem, o.rastro?.plano?.parada, o.rastro?.plano?.motivoParada], ["MODELO", "FIM", null]);
  assert.deepEqual(o.rastro?.plano?.composicao, { leituras: 2, solicitados: ["CLIENTE", "POSICAO_FINANCEIRA"], faltando: [] });
  const d = dados(o.resposta);
  const f = textos(d);
  for (const esperado of ["FATO:Cliente: Ana Oliveira.", "FATO:Valor pago (líquido): R$ 3.300,00.", "FATO:Situação: Em aberto."]) assert.ok(f.includes(esperado), esperado);
  // A listagem de âncora (proximas_festas, com 2 festas) não entrou: nada da festa do Pedro/Carla.
  assert.equal(f.some((x) => x.includes("Carla Souza")), false);
  semContratoErrado(d);
});

// ---------------------------------------------------------------- limites e mesma âncora (unidade)

const leitura = (capacidade: string, extra: Partial<RespostaLeitura> = {}): RespostaLeitura => ({
  capacidade, estado: "informativo", resumo: "ok", fatos: [], itens: [], evidencias: [], referencia: { hoje: HOJE, geradoEm: `${HOJE}T00:00:00Z`, fontes: [capacidade] }, ...extra,
});
const contratoRef = (id: string): EntidadeRef => ({ tipo: "CONTRATO", id, rotulo: "Contrato", tela: "contrato" });

test("limites: composta acima do schema (fatos > 60, resumo > 2000) é RECUSADA inteira — nada é cortado em silêncio", () => {
  const muitos = Array.from({ length: 31 }, (_, i) => ({ natureza: "FATO" as const, texto: `Fato ${i}.`, fonte: "x" }));
  const r = compor([{ passoId: "p2", capacidade: "relacoes_festa", dados: leitura("relacoes_festa", { fatos: muitos }) }, { passoId: "p3", capacidade: "saldo_contrato", dados: leitura("saldo_contrato", { fatos: muitos }) }], []);
  assert.deepEqual(r, { ok: false, motivo: "COMPOSICAO_LIMITE" });
  const longo = "a".repeat(1500);
  const r2 = compor([{ passoId: "p2", capacidade: "relacoes_festa", dados: leitura("relacoes_festa", { resumo: longo }) }, { passoId: "p3", capacidade: "saldo_contrato", dados: leitura("saldo_contrato", { resumo: longo }) }], []);
  assert.deepEqual(r2, { ok: false, motivo: "COMPOSICAO_LIMITE" });
  // No limite exato (30 + 30 = 60 fatos) compõe, com TODOS os fatos e fontes.
  const exatos = muitos.slice(0, 30);
  const ok = compor([{ passoId: "p2", capacidade: "relacoes_festa", dados: leitura("relacoes_festa", { fatos: exatos }) }, { passoId: "p3", capacidade: "saldo_contrato", dados: leitura("saldo_contrato", { fatos: exatos }) }], []);
  assert.equal(ok.ok && ok.dados.fatos.length, 60);
  assert.deepEqual(ok.ok && ok.dados.referencia.fontes, ["relacoes_festa", "saldo_contrato"]);
});

test("mesma âncora: leituras de contratos diferentes nunca se juntam (ANCORA_DIVERGENTE)", () => {
  const r = compor([
    { passoId: "p2", capacidade: "resumir_contrato", dados: leitura("resumir_contrato", { entidades: [contratoRef(IDS.CONTRATO_MARIA)] }) },
    { passoId: "p3", capacidade: "saldo_contrato", dados: leitura("saldo_contrato", { entidades: [contratoRef(IDS.CONTRATO_PEDRO)] }) },
  ], ["SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"]);
  assert.deepEqual(r, { ok: false, motivo: "ANCORA_DIVERGENTE" });
  assert.deepEqual(faltando(["POSICAO_FINANCEIRA"], [{ capacidade: "proxima_parcela", dados: leitura("proxima_parcela") }]), ["POSICAO_FINANCEIRA"]);
});

test("trace da composição: só códigos e contagens — sem id, nome, valor ou texto", async () => {
  for (const cenario of ["PARCIAL", "QUITADO", "SEM_POSICAO"] as const) {
    const { o } = await perguntar(FRASE_CLIENTE_PAGO, { financeiroProximaFesta: cenario }, PLANO_CLIENTE_PAGO);
    const plano = JSON.stringify(o.rastro?.plano);
    for (const proibido of [...Object.values(IDS), ...PII, "Ana Oliveira", "R$", "4.500", "1.200", FRASE_CLIENTE_PAGO]) assert.equal(plano.includes(proibido), false, `${cenario}: ${proibido}`);
    const r2 = await perguntar(FRASE_SITUACAO_PAGAMENTO, { financeiroProximaFesta: cenario });
    const plano2 = JSON.stringify(r2.o.rastro?.plano);
    for (const proibido of [...Object.values(IDS), "Ana Oliveira", "R$", FRASE_SITUACAO_PAGAMENTO]) assert.equal(plano2.includes(proibido), false, `${cenario}: ${proibido}`);
  }
});
