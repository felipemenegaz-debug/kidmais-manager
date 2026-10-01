import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, EMPRESA_B, IDS, PII } from "../../../scripts/ia-benchmark/ambiente.ts";
import type { AIResponse, EntidadeRef, RespostaLeitura } from "../contratos.ts";
import { criarDemerzel } from "../demerzel/orquestradora.ts";
import type { PortaPlanejador, PortasOrquestracao } from "../extensoes.ts";
import { ferramentaRegistrada } from "../ferramentas.ts";
import type { CapacidadeCatalogo, Intencao } from "../intencao.ts";
import { interpretarDeterministico } from "../intencao.ts";
import { Circuito } from "../modelos/circuito.ts";
import { criarProvedorFake, respostaFake } from "../modelos/fake.ts";
import { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } from "../modelos/orcamento.ts";
import { RoteadorModelos, TIERS_PADRAO, politicaDoAmbiente } from "../modelos/roteador.ts";
import type { AdaptadorProvedor, PedidoModelo } from "../modelos/tipos.ts";
import { InteligenciaError } from "../politica.ts";
import { detectarReferencia } from "../referencias.ts";
import { executarPlano, type DependenciasExecutor } from "./executor.ts";
import { LIMITES_PLANO, OBJETIVOS_PLANO, planoSchema, validarPlano, type Plano } from "./plano.ts";
import { planejarPorRegras } from "./regras.ts";

/** AI V1.1 — PR 6: Planner + Multi-tool Executor (plano fechado, Policy por passo, sem id do modelo, Human Gate). */
const HOJE = "2026-09-30";
type Turno = { texto: string; contexto?: { tela: "festa" | "cliente" | "contrato"; entidade: keyof typeof IDS } };

async function conversa(turnos: Turno[], preparar?: (amb: ReturnType<typeof criarAmbiente>) => void) {
  const amb = criarAmbiente();
  preparar?.(amb);
  const obs = await amb.conversar({ id: "plano-teste", categoria: "multi_tool", turnos, esperado: { entendimento: "EXECUTADO" }, pr: "PR6" });
  return { obs, ultima: obs.at(-1)!, amb };
}
const dados = (r: AIResponse | null) => (r as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
const passos = (o: { rastro: { plano: { passos: Array<{ capacidade: string; origemEntrada: string; resultado: string }> } | null } | null }) =>
  o.rastro?.plano?.passos.map((p) => [p.capacidade, p.origemEntrada, p.resultado]);

const CATALOGO: CapacidadeCatalogo[] = [
  // produz: os mesmos tipos declarados no registro (PR 6.4.2).
  { id: "proximas_festas", descricao: "", tipo: "leitura", produz: ["FESTA"] },
  { id: "relacoes_festa", descricao: "", tipo: "leitura", entidade: "festa", produz: ["FESTA", "CLIENTE", "CONTRATO"] },
  { id: "resumir_contrato", descricao: "", tipo: "leitura", entidade: "contrato", produz: ["CONTRATO"] },
  { id: "saldo_contrato", descricao: "", tipo: "leitura", entidade: "contrato", produz: ["CONTRATO"] },
  { id: "abrir_tela", descricao: "", tipo: "leitura" },
  { id: "criar_pacote", descricao: "", tipo: "acao" },
];
const PLANO_OK = {
  objetivo: "ABRIR:CONTRATO", recursoFinal: "CONTRATO",
  passos: [
    { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2 }, selecao: "PRIMEIRA" },
    { id: "p2", capacidade: "relacoes_festa", entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" } },
    { id: "p3", capacidade: "abrir_tela", parametros: { tela: "contrato" }, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } },
  ],
};

// ---------------------------------------------------------------- 1. schema e validação

test("validação: plano bem formado passa; tool inventada, campo extra e referência para frente são rejeitados (casos 7)", () => {
  assert.equal(validarPlano(PLANO_OK, CATALOGO).ok, true);
  const com = (mudar: (p: typeof PLANO_OK) => unknown) => validarPlano(mudar(structuredClone(PLANO_OK)), CATALOGO);
  assert.deepEqual(com((p) => { p.passos[1].capacidade = "executar_sql"; return p; }), { ok: false, motivo: "TOOL_DESCONHECIDA" });
  assert.deepEqual(com((p) => { p.passos[1].capacidade = "listar_segredos"; return p; }), { ok: false, motivo: "TOOL_DESCONHECIDA" });
  assert.deepEqual(com((p) => ({ ...p, extra: true })), { ok: false, motivo: "CAMPO_EXTRA" });
  assert.deepEqual(com((p) => { (p.passos[0] as Record<string, unknown>).comentario = "x"; return p; }), { ok: false, motivo: "CAMPO_EXTRA" });
  assert.deepEqual(com((p) => { p.passos[1].entradaDe = { de: "PASSO", passo: "p3", entidade: "FESTA" }; return p; }), { ok: false, motivo: "REFERENCIA_INVALIDA" });
  assert.deepEqual(com((p) => { p.passos[1].id = "p3"; return p; }), { ok: false, motivo: "REFERENCIA_INVALIDA" });
  assert.deepEqual(com((p) => { p.passos = [p.passos[2], p.passos[0]].map((x, i) => ({ ...x, id: `p${i + 1}` })) as never; return p; }), { ok: false, motivo: "NAVEGACAO_FORA_DO_FIM" });
  assert.deepEqual(com((p) => { p.passos[0] = { ...p.passos[0], capacidade: "criar_pacote" }; return p; }), { ok: false, motivo: "ACAO_FORA_DO_FIM" });
  assert.deepEqual(validarPlano({ objetivo: "CONSULTAR:NADA", recursoFinal: null, passos: [{ id: "p1", capacidade: "proximas_festas" }] }, CATALOGO), { ok: false, motivo: "SCHEMA" });
  assert.deepEqual(validarPlano(null, CATALOGO), { ok: false, motivo: "SCHEMA" });
});

test("validação: id literal em qualquer lugar ⇒ plano rejeitado (caso 8)", () => {
  const uuid = IDS.CONTRATO_MARIA;
  const com = (mudar: (p: typeof PLANO_OK) => unknown) => validarPlano(mudar(structuredClone(PLANO_OK)), CATALOGO).ok === false && (validarPlano(mudar(structuredClone(PLANO_OK)), CATALOGO) as { motivo: string }).motivo;
  assert.equal(com((p) => { (p.passos[2].parametros as Record<string, unknown>).contratoId = uuid; return p; }), "ID_LITERAL");
  assert.equal(com((p) => { (p.passos[2].parametros as Record<string, unknown>).id = uuid; return p; }), "ID_LITERAL");
  assert.equal(com((p) => { p.passos[0].parametros = { ordem: uuid, limite: 1 } as never; return p; }), "ID_LITERAL");
  assert.equal(com((p) => { p.passos[0].id = uuid; return p; }), "ID_LITERAL");
  assert.equal(com((p) => { (p.passos[0].parametros as Record<string, unknown>).termo = "cliente 12345678"; return p; }), "ID_LITERAL");
  for (const chave of ["empresaId", "tenantId", "unidadeId", "estabelecimento", "sql", "url"]) {
    assert.equal(com((p) => { (p.passos[0].parametros as Record<string, unknown>)[chave] = "a"; return p; }), "ID_LITERAL", chave);
  }
});

test("validação: mais passos que o limite ⇒ rejeitado (caso 9); limite é 5", () => {
  assert.equal(LIMITES_PLANO.maxPassos, 5);
  const muitos = { objetivo: "CONSULTAR:FESTA", recursoFinal: "FESTA", passos: Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}`, capacidade: "proximas_festas" })) };
  assert.deepEqual(validarPlano(muitos, CATALOGO), { ok: false, motivo: "LIMITE_PASSOS" });
  assert.deepEqual(validarPlano({ ...muitos, passos: muitos.passos.slice(0, 5) }, CATALOGO).ok, true);
});

// ---------------------------------------------------------------- 2. Planner por regras

test("regras: os planos dos casos obrigatórios (âncora → relação do Core → final), nenhum id no plano", () => {
  const plano = (texto: string, ancora: EntidadeRef | null = null) => {
    const r = planejarPorRegras(detectarReferencia(texto, HOJE)!, texto, ancora);
    return r?.plano.passos.map((p) => [p.capacidade, p.entradaDe ? (p.entradaDe.de === "PASSO" ? `${p.entradaDe.passo}:${p.entradaDe.entidade}` : `CONTEXTO:${p.entradaDe.entidade}`) : "-"]);
  };
  assert.deepEqual(plano("abra o contrato da próxima festa"), [["proximas_festas", "-"], ["relacoes_festa", "p1:FESTA"], ["abrir_tela", "p2:CONTRATO"]]);
  assert.deepEqual(plano("quem é o cliente da próxima festa?"), [["proximas_festas", "-"], ["relacoes_festa", "p1:FESTA"], ["resumir_cliente", "p2:CLIENTE"]]);
  assert.deepEqual(plano("quanto falta pagar na próxima festa?"), [["proximas_festas", "-"], ["relacoes_festa", "p1:FESTA"], ["saldo_contrato", "p2:CONTRATO"]]);
  assert.deepEqual(plano("qual é a próxima parcela do último contrato?"), [["ultimo_contrato", "-"], ["proxima_parcela", "p1:CONTRATO"]]);
  assert.deepEqual(plano("abra o cliente da próxima festa"), [["proximas_festas", "-"], ["relacoes_festa", "p1:FESTA"], ["abrir_tela", "p2:CLIENTE"]]);
  const festa: EntidadeRef = { tipo: "FESTA", id: IDS.FESTA_MARIA, rotulo: "Festa", tela: "festa" };
  assert.deepEqual(plano("qual o contrato dela?", festa), [["relacoes_festa", "CONTEXTO:FESTA"], ["resumir_contrato", "p1:CONTRATO"]]);
  // Mutação nunca é planejada por regra (segue o Human Gate/indisponível atual).
  assert.equal(planejarPorRegras(detectarReferencia("cancele o contrato da próxima festa", HOJE)!, "cancele o contrato da próxima festa", null), null);
  for (const texto of ["abra o contrato da próxima festa", "qual é a próxima parcela do último contrato?"]) {
    const r = planejarPorRegras(detectarReferencia(texto, HOJE)!, texto, null)!;
    assert.equal(JSON.stringify(r.plano).match(/[0-9a-f]{8}-[0-9a-f]{4}/), null, "nenhum id no plano");
  }
});

// ---------------------------------------------------------------- 3. executor (portas espiãs)

const festaA: EntidadeRef = { tipo: "FESTA", id: IDS.FESTA_MARIA, rotulo: "Festa de Ana — 01/10/2026 às 14:00", tela: "festa" };
const contratoA: EntidadeRef = { tipo: "CONTRATO", id: IDS.CONTRATO_MARIA, rotulo: "Contrato V2", tela: "contrato" };
const resposta = (entidades: EntidadeRef[]): AIResponse => ({ tipo: "resposta", dados: { capacidade: "x", estado: "informativo", resumo: "ok", fatos: [], itens: [], evidencias: [], referencia: { hoje: HOJE, geradoEm: `${HOJE}T00:00:00Z`, fontes: [] }, entidades } });

function executor(ler: (capacidade: string, parametros: Record<string, unknown>) => Promise<AIResponse>, ancoraContexto: EntidadeRef | null = null) {
  const lidas: Array<[string, Record<string, unknown>]> = [];
  const deps: DependenciasExecutor = {
    ler: async (c, p) => { lidas.push([c, p]); return ler(c, p); },
    ancoraContexto, catalogo: CATALOGO, entradaDe: (c) => ferramentaRegistrada(c)?.entrada ?? null, origem: "INTENCAO_DETERMINISTICA", relogio: () => 0,
  };
  return { deps, lidas };
}
const plano = (bruto: unknown) => { const v = validarPlano(bruto, CATALOGO); assert.equal(v.ok, true); return (v as { plano: Plano }).plano; };

test("executor: saída estruturada de um passo alimenta o seguinte; id e tela só da entidade do Core; o final vira intenção", async () => {
  const { deps, lidas } = executor(async (c) => (c === "proximas_festas" ? resposta([festaA]) : resposta([festaA, contratoA])));
  const r = await executarPlano(plano(PLANO_OK), deps);
  assert.equal(r.estado, "FINAL");
  assert.deepEqual(lidas, [["proximas_festas", { ordem: "ASC", limite: 2 }], ["relacoes_festa", { id: IDS.FESTA_MARIA }]]);
  assert.deepEqual((r as { intencao: Intencao }).intencao, { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "contrato", id: IDS.CONTRATO_MARIA }, origem: "INTENCAO_DETERMINISTICA" });
});

test("executor: entidade de outra empresa ⇒ o gateway nega ⇒ para fail-closed, nada depois executa (caso 10)", async () => {
  // O passo 1 devolve uma entidade cujo id não é da empresa comprovada: a leitura seguinte (gateway) responde 404.
  const intrusa: EntidadeRef = { ...festaA, id: IDS.FESTA_B };
  const { deps, lidas } = executor(async (c, p) => {
    if (c === "proximas_festas") return resposta([intrusa]);
    if (p.id === IDS.FESTA_B) throw new InteligenciaError("NAO_ENCONTRADO", "Festa não encontrada.", 404);
    return resposta([contratoA]);
  });
  const r = await executarPlano(plano(PLANO_OK), deps);
  assert.equal(r.estado, "NEGADO");
  assert.deepEqual(lidas.map(([c]) => c), ["proximas_festas", "relacoes_festa"]);
  assert.deepEqual(r.passos.map((p) => p.resultado), ["SUCESSO", "NEGADO"]);
});

test("executor: Policy nega o passo 2 ⇒ o passo 3 nunca executa (caso 11); erro intermediário para tudo (caso 13)", async () => {
  const tres = plano({
    objetivo: "CONSULTAR:PAGAMENTO", recursoFinal: "CONTRATO",
    passos: [
      { id: "p1", capacidade: "proximas_festas", parametros: { limite: 2 }, selecao: "PRIMEIRA" },
      { id: "p2", capacidade: "relacoes_festa", entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" } },
      { id: "p3", capacidade: "resumir_contrato", entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } },
      { id: "p4", capacidade: "saldo_contrato", entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } },
    ],
  });
  const negar = executor(async (c) => { if (c === "relacoes_festa") throw new InteligenciaError("PAPEL_SEM_PERMISSAO", "Sem permissão.", 403); return resposta([festaA, contratoA]); });
  const negado = await executarPlano(tres, negar.deps);
  assert.equal(negado.estado, "NEGADO");
  assert.deepEqual(negar.lidas.map(([c]) => c), ["proximas_festas", "relacoes_festa"], "resumir_contrato e saldo_contrato nunca executam");

  const falhar = executor(async (c) => { if (c === "relacoes_festa") throw new Error("banco fora"); return resposta([festaA, contratoA]); });
  await assert.rejects(executarPlano(tres, falhar.deps), /banco fora/);
  assert.deepEqual(falhar.lidas.map(([c]) => c), ["proximas_festas", "relacoes_festa"]);

  // Saída sem a entidade pedida ⇒ SEM_DADOS; duas candidatas com UNICA ⇒ AMBIGUO (nunca escolhe).
  const vazio = await executarPlano(tres, executor(async (c) => (c === "proximas_festas" ? resposta([festaA]) : resposta([festaA]))).deps);
  assert.deepEqual([vazio.estado, vazio.passos.at(-1)!.capacidade], ["SEM_DADOS", "resumir_contrato"]);
  const outro: EntidadeRef = { ...contratoA, id: IDS.CONTRATO_PEDRO };
  const ambiguo = await executarPlano(tres, executor(async (c) => (c === "proximas_festas" ? resposta([festaA]) : resposta([contratoA, outro]))).deps);
  assert.deepEqual([ambiguo.estado, (ambiguo as { candidatos: EntidadeRef[] }).candidatos.length], ["AMBIGUO", 2]);
  // PRIMEIRA com empate real (mesma data e hora) ⇒ AMBIGUO.
  const gemea: EntidadeRef = { ...festaA, id: IDS.FESTA_PEDRO, rotulo: "Festa de Carla — 01/10/2026 às 14:00" };
  const empate = await executarPlano(tres, executor(async () => resposta([festaA, gemea])).deps);
  assert.equal(empate.estado, "AMBIGUO");
});

test("executor (PR 15): passo de composição sem entidades na saída (ex.: contratos_pendentes) não derruba o plano; quem depende dele para em SEM_DADOS", async () => {
  // Homologação em staging: "Quais contratos estão pendentes e quanto recebemos este mês?" — o passo 1 é uma leitura que
  // devolve fatos e itens, mas nenhuma `entidades`; o executor exigia o campo e o plano inteiro virava ERRO.
  const semEntidades: AIResponse = { tipo: "resposta", dados: { capacidade: "proximas_festas", estado: "atencao", resumo: "1 item.", fatos: [{ natureza: "FATO", texto: "1 item.", fonte: "x" }], itens: [], evidencias: [], referencia: { hoje: HOJE, geradoEm: `${HOJE}T00:00:00Z`, fontes: [] } } };
  const composicao = plano({ objetivo: "CONSULTAR:CONTRATO", recursoFinal: null, passos: [
    { id: "p1", capacidade: "proximas_festas", parametros: { limite: 2 }, resposta: true },
    { id: "p2", capacidade: "abrir_tela", parametros: { tela: "catalogo" } },
  ] });
  const r = await executarPlano(composicao, executor(async () => semEntidades).deps);
  assert.equal(r.estado, "FINAL");
  assert.deepEqual(r.passos.map((p) => p.resultado), ["SUCESSO", "NAO_EXECUTADO"], "o passo sem entidades não é ERRO");
  // Um passo que precisa da entidade do anterior continua parando (nunca inventa entrada).
  const dependente = await executarPlano(plano(PLANO_OK), executor(async () => semEntidades).deps);
  assert.deepEqual([dependente.estado, dependente.passos.at(-1)!.capacidade], ["SEM_DADOS", "relacoes_festa"]);
});

test("executor: ação no fim vira intenção de proposta — nunca é executada pelo executor (caso 12)", async () => {
  const comAcao = plano({ objetivo: "CRIAR:PACOTE", recursoFinal: null, passos: [{ id: "p1", capacidade: "proximas_festas", parametros: { limite: 2 }, selecao: "PRIMEIRA" }, { id: "p2", capacidade: "criar_pacote" }] });
  const { deps, lidas } = executor(async () => resposta([festaA]));
  const r = await executarPlano(comAcao, deps);
  assert.deepEqual((r as { intencao: Intencao }).intencao, { tipo: "acao", capacidade: "criar_pacote", origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(lidas.map(([c]) => c), ["proximas_festas"]);
});

test("Demerzel: plano que termina em ação CONFIRM para no Human Gate (rascunho); o pedido não confirma nada (caso 12)", async () => {
  const propostas: string[] = [];
  const planejador: PortaPlanejador = {
    planejar: async () => ({ intencao: { tipo: "acao", capacidade: "criar_pacote", origem: "INTENCAO_DETERMINISTICA" } }),
    pedeComposicao: () => false, planejarComModelo: async () => null, concluir: (r) => r,
  };
  const portas = {
    catalogo: [], interpretar: () => ({ tipo: "nenhuma" }) as Intencao, sugerirRota: async () => null, interpretarComModelo: async () => null, portaModelo: async () => null,
    ler: async () => { throw new Error("não deve ler"); },
    propor: async (capacidade: string) => { propostas.push(capacidade); return { tipo: "rascunho", rascunho: { operacaoId: "op", capacidade, titulo: "t", campos: [], pendentes: [], avisos: [] } } as unknown as AIResponse; },
    descreverAcao: () => ({ capacidade: "criar_pacote", ferramenta: "pacotes.criar", classe: "CONFIRM", grupo: "ADMIN_ACTIONS", papeis: [], descricao: "c", origem: "CONVERSA" }),
    usosDeModelo: () => [], registrarResumo: () => {}, skill: async () => null, complementar: async (r: AIResponse) => r, agentes: null, marcadores: async () => ({}), relogio: () => 0, planejador,
  } as unknown as PortasOrquestracao;
  const { resposta: r, resumo } = await criarDemerzel().atender({ texto: "crie um pacote para a próxima festa", contexto: null }, portas);
  assert.equal(r.tipo, "rascunho");
  assert.deepEqual(propostas, ["criar_pacote"]);
  assert.equal(resumo.parada, "PROPOSTA");
  assert.ok(resumo.passos.some((p) => p.tipo === "PROPOSTA_ACAO"));
});

// ---------------------------------------------------------------- 4. ponta a ponta (fake Core do benchmark)

test("caso 1: 'abra o contrato da próxima festa' ⇒ proximas_festas → relacoes_festa → navegação do contrato", async () => {
  const { ultima } = await conversa([{ texto: "abra o contrato da próxima festa" }]);
  assert.equal(ultima.resposta?.tipo, "navegacao");
  assert.equal((ultima.resposta as { destino: string }).destino, `/admin/contratos?contratoId=${IDS.CONTRATO_MARIA}`);
  assert.deepEqual(passos(ultima), [["proximas_festas", "PARAMETROS", "SUCESSO"], ["relacoes_festa", "PASSO", "SUCESSO"], ["abrir_tela", "PASSO", "SUCESSO"]]);
  assert.deepEqual([ultima.rastro?.plano?.origem, ultima.rastro?.plano?.parada, ultima.rastro?.plano?.resultadoFinal], ["REGRAS", "FIM", "SUCESSO"]);
});

test("casos 2, 3 e 5: cliente, saldo e abrir cliente da próxima festa", async () => {
  const cliente = await conversa([{ texto: "quem é o cliente da próxima festa?" }]);
  assert.equal(dados(cliente.ultima.resposta).capacidade, "resumir_cliente");
  assert.deepEqual(passos(cliente.ultima)?.map(([c]) => c), ["proximas_festas", "relacoes_festa", "resumir_cliente"]);
  const saldo = await conversa([{ texto: "quanto falta pagar na próxima festa?" }]);
  assert.match(dados(saldo.ultima.resposta).resumo, /^Falta pagar R\$ 1\.200,00 de R\$ 4\.500,00/);
  assert.deepEqual(passos(saldo.ultima)?.map(([c]) => c), ["proximas_festas", "relacoes_festa", "saldo_contrato"]);
  const abrir = await conversa([{ texto: "abra o cliente da próxima festa" }]);
  assert.equal((abrir.ultima.resposta as { destino: string }).destino, `/clientes/${IDS.CLIENTE_ANA}`);
  assert.deepEqual(passos(abrir.ultima)?.map(([c]) => c), ["proximas_festas", "relacoes_festa", "abrir_tela"]);
});

test("caso 4: 'qual é a próxima parcela do último contrato?' ⇒ ultimo_contrato → proxima_parcela (do contrato, não da empresa)", async () => {
  const { ultima } = await conversa([{ texto: "qual é a próxima parcela do último contrato?" }]);
  assert.match(dados(ultima.resposta).resumo, /^A próxima parcela a vencer é a 2ª, em 02\/10\/2026, de R\$ 2\.500,00/);
  assert.deepEqual(passos(ultima), [["ultimo_contrato", "PARAMETROS", "SUCESSO"], ["proxima_parcela", "PASSO", "SUCESSO"]]);
  assert.equal(ultima.rastro?.plano?.motivo, "ULTIMO_CONTRATO");
  // Sem outro recurso, "qual é o último contrato?" continua a leitura direta (sem plano).
  const direto = await conversa([{ texto: "qual é o último contrato?" }]);
  assert.equal(dados(direto.ultima.resposta).capacidade, "ultimo_contrato");
  assert.equal(direto.ultima.rastro?.plano, null);
});

test("caso 6 e foco: 'qual o contrato dela?' com Festa em foco; 'quanto falta pagar?' sem repetir a festa", async () => {
  const dela = await conversa([{ texto: "Qual é a próxima festa?" }, { texto: "qual o contrato dela?" }]);
  assert.equal(dados(dela.ultima.resposta).capacidade, "resumir_contrato");
  assert.deepEqual(passos(dela.ultima), [["relacoes_festa", "CONTEXTO", "SUCESSO"], ["resumir_contrato", "PASSO", "SUCESSO"]]);
  const saldo = await conversa([{ texto: "Qual é a próxima festa?" }, { texto: "quanto falta pagar?" }]);
  assert.match(dados(saldo.ultima.resposta).resumo, /^Falta pagar R\$ 1\.200,00/);
  assert.deepEqual(passos(saldo.ultima)?.map(([c]) => c), ["relacoes_festa", "saldo_contrato"]);
  // Revalidar a âncora e ler as relações dela é UMA leitura (memoizada), não duas.
  assert.equal(saldo.ultima.rastro?.leituras.filter((l) => l.capacidade === "relacoes_festa").length, 1);
});

test("foco adulterado com festa de outra empresa ⇒ negado antes de qualquer plano; nada de outra empresa", async () => {
  const amb = criarAmbiente();
  const { atenderConversa } = await import("../conversa.ts");
  const r = await atenderConversa({ lerCorpo: async () => ({ texto: "quanto falta pagar dela?", foco: { entidades: [{ tipo: "FESTA", id: IDS.FESTA_B }], principal: 0 } }), empresaSolicitada: null }, amb.deps);
  const data = (r.corpo as { data?: AIResponse }).data!;
  assert.equal(data.entendimento, "NEGADO_POLITICA");
  assert.equal(amb.rastros.at(-1)?.plano, null, "sem âncora válida, nenhum plano executa");
  assert.equal(JSON.stringify(data).includes("Lucas"), false);
  assert.deepEqual(amb.violacoes.crossTenant, []);
  void EMPRESA_B;
});

test("trace do plano: só códigos, contagens e durações — nenhum id, nome, valor ou texto (caso 14)", async () => {
  const { obs } = await conversa([
    { texto: "abra o contrato da próxima festa" }, { texto: "quanto falta pagar na próxima festa?" }, { texto: "qual é a próxima parcela do último contrato?" },
    { texto: "Qual é a próxima festa?" }, { texto: "qual o contrato dela?" },
  ]);
  for (const o of obs) {
    const plano = JSON.stringify(o.rastro?.plano ?? null);
    for (const proibido of [...PII, "Ana Oliveira", "Carla Souza", "R$", "1.200", "2.500", "próxima", "contrato da", ...Object.values(IDS)]) {
      assert.equal(plano.includes(proibido), false, `plano contém ${proibido}`);
    }
    if (o.rastro?.plano) assert.deepEqual(Object.keys(o.rastro.plano).sort(), ["complemento", "composicao", "duracaoMs", "motivo", "motivoParada", "objetivo", "origem", "parada", "passos", "quantidadePassos", "resultadoFinal", "usoModelo", "versao"]);
    const trace = JSON.stringify(o.rastro);
    for (const proibido of [...PII, "Ana Oliveira", "Carla Souza", "R$"]) assert.equal(trace.includes(proibido), false, proibido);
  }
});

// ---------------------------------------------------------------- 5. Planner por modelo (provedor fake roteirizado; nada live)

function comModelo(roteiro: (pedido: PedidoModelo<unknown>) => unknown) {
  return (amb: ReturnType<typeof criarAmbiente>) => {
    const provedor = criarProvedorFake({ id: "OPENAI", roteiro: (pedido) => respostaFake(JSON.stringify(roteiro(pedido))) });
    let n = 0;
    amb.deps.roteador = new RoteadorModelos({
      politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_MODEL_MAX_RETRIES: "0" }),
      adaptadores: new Map([["OPENAI", provedor as AdaptadorProvedor]]), precos: null,
      orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 } }) }),
      registro: criarRegistroUsoEmMemoria(), circuito: new Circuito(), agora: () => new Date(`${HOJE}T15:00:00Z`), relogio: () => 0,
      novoId: () => `${String(++n).padStart(8, "0")}-0000-4000-8000-0000000000aa`,
    });
    (amb as unknown as { provedor: typeof provedor }).provedor = provedor;
  };
}
const TEXTO_COMPOSTO = "o contrato e o cliente da festa do Pedro";
const PLANO_MODELO = {
  objetivo: "CONSULTAR:CONTRATO", recursoFinal: "CONTRATO",
  passos: [
    { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: null, selecao: "PRIMEIRA" },
    // PR 6.4: o pedido ("o contrato e o cliente") pede o cliente — a relação entra na resposta.
    { id: "p2", capacidade: "relacoes_festa", parametros: null, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, selecao: null, resposta: true },
    { id: "p3", capacidade: "resumir_contrato", parametros: null, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" }, selecao: null, resposta: null },
  ],
};

test("modelo: tier ECONOMY no workload PLANEJAR (auditado: JSON pequeno, enum fechado, revalidado)", () => {
  assert.equal(TIERS_PADRAO.PLANEJAR, "ECONOMY");
  assert.equal(interpretarDeterministico(TEXTO_COMPOSTO, null).tipo, "nenhuma", "pré-condição: regras não resolvem");
});

test("modelo: plano válido ⇒ executado pelas mesmas portas; 1 chamada; trace MODELO sem texto; modelo não recebe id", async () => {
  const { ultima, amb } = await conversa([{ texto: TEXTO_COMPOSTO }], comModelo((p) => (p.workload === "PLANEJAR" ? PLANO_MODELO : { capacidade: "nenhuma", dia: null })));
  const provedor = (amb as unknown as { provedor: ReturnType<typeof criarProvedorFake> }).provedor;
  assert.deepEqual(provedor.chamadas.map((c) => c.workload), ["PLANEJAR"]);
  const enviado = provedor.chamadas[0].mensagens.map((m) => m.conteudo).join(" ");
  for (const proibido of Object.values(IDS)) assert.equal(enviado.includes(proibido), false, "modelo nunca recebe id");
  assert.equal(dados(ultima.resposta).capacidade, "resumir_contrato");
  assert.deepEqual([ultima.rastro?.plano?.origem, ultima.rastro?.plano?.usoModelo, ultima.rastro?.plano?.motivo], ["MODELO", true, "COMPOSICAO"]);
  assert.deepEqual(passos(ultima)?.map(([c, , r]) => [c, r]), [["proximas_festas", "SUCESSO"], ["relacoes_festa", "SUCESSO"], ["resumir_contrato", "SUCESSO"]]);
  assert.ok((ultima.rastro?.orquestracao?.passos ?? []).some((p) => p.tipo === "PLANO_MODELO"));
  assert.equal(JSON.stringify(ultima.rastro?.plano).includes("Pedro"), false);
});

test("modelo: tool inventada, id inventado ou passos demais ⇒ plano rejeitado, nenhuma leitura, resposta honesta", async () => {
  const casos: Array<[string, unknown]> = [
    ["TOOL_DESCONHECIDA", { ...PLANO_MODELO, passos: [{ ...PLANO_MODELO.passos[0], capacidade: "exportar_banco" }] }],
    ["ID_LITERAL", { ...PLANO_MODELO, passos: [PLANO_MODELO.passos[0], PLANO_MODELO.passos[1], { ...PLANO_MODELO.passos[2], entradaDe: null, parametros: { contratoId: IDS.CONTRATO_PEDRO } }] }],
    ["LIMITE_PASSOS", { ...PLANO_MODELO, passos: Array.from({ length: 6 }, (_, i) => ({ ...PLANO_MODELO.passos[0], id: `p${i + 1}` })) }],
    ["CAMPO_EXTRA", { ...PLANO_MODELO, sql: null, comando: "rm -rf" }],
  ];
  for (const [motivo, bruto] of casos) {
    const { ultima } = await conversa([{ texto: TEXTO_COMPOSTO }], comModelo((p) => (p.workload === "PLANEJAR" ? bruto : { capacidade: "nenhuma", dia: null })));
    assert.equal(ultima.rastro?.plano?.parada, `REJEITADO:${motivo}`, motivo);
    assert.deepEqual(ultima.rastro?.leituras, [], `${motivo}: nenhuma leitura`);
    assert.equal(ultima.resposta?.tipo, "nao_suportado");
  }
});

test("modelo: no máximo 2 passos com modelo por pedido; sem provedor, nenhum plano por modelo (CI sem chamada live)", async () => {
  const semProvedor = await conversa([{ texto: TEXTO_COMPOSTO }]);
  assert.equal(semProvedor.ultima.rastro?.plano, null);
  assert.equal(semProvedor.ultima.rastro?.chamadasModelo, 0);
  const { ultima } = await conversa([{ texto: TEXTO_COMPOSTO }], comModelo((p) => (p.workload === "PLANEJAR" ? PLANO_MODELO : { capacidade: "nenhuma", dia: null })));
  const comModeloPassos = (ultima.rastro?.orquestracao?.passos ?? []).filter((p) => ["JULGAMENTO_JEV_MODELO", "INTENCAO_MODELO", "COMPLEMENTO_MODELO", "PLANO_MODELO"].includes(p.tipo));
  assert.ok(comModeloPassos.length <= 2);
  assert.equal((ultima.rastro?.orquestracao?.passos ?? []).some((p) => p.tipo === "INTENCAO_MODELO"), false, "o plano substitui a interpretação por modelo");
});

// ---------------------------------------------------------------- 6. PR 6.1: correção do Planner por modelo (smoke de staging, caso 8)

/** Texto exato do caso 8 do smoke em staging. */
// Variação sem "festa" (as regras não resolvem): mantém estes testes no caminho do Planner por MODELO (PR 6.4.3).
const TEXTO_SMOKE = "me mostra o contrato e o cliente da comemoração que vem aí";
const PLANO_DOIS_RECURSOS = {
  // Pedido com dois recursos: o modelo responde `recursoFinal: null` — chave obrigatória, valor explicitamente nulo.
  objetivo: "CONSULTAR:CONTRATO", recursoFinal: null,
  passos: [
    { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: null, selecao: "PRIMEIRA" },
    { id: "p2", capacidade: "relacoes_festa", parametros: null, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, selecao: null, resposta: true },
    { id: "p3", capacidade: "resumir_contrato", parametros: null, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" }, selecao: null },
  ],
};

test("hipótese 1 (smoke): `recursoFinal: null` do modelo NÃO é descartado antes da validação ⇒ plano aceito e executado", async () => {
  const { ultima, amb } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => (p.workload === "PLANEJAR" ? PLANO_DOIS_RECURSOS : { capacidade: "nenhuma", dia: null })));
  const provedor = (amb as unknown as { provedor: ReturnType<typeof criarProvedorFake> }).provedor;
  assert.deepEqual(provedor.chamadas.map((c) => c.workload), ["PLANEJAR"]);
  assert.notEqual(ultima.rastro?.plano?.parada, "REJEITADO:SCHEMA", "antes da correção: REJEITADO:SCHEMA");
  assert.deepEqual([ultima.rastro?.plano?.origem, ultima.rastro?.plano?.parada, ultima.rastro?.plano?.resultadoFinal], ["MODELO", "FIM", "SUCESSO"]);
  assert.deepEqual(passos(ultima)?.map(([c]) => c), ["proximas_festas", "relacoes_festa", "resumir_contrato"]);
  assert.equal(dados(ultima.resposta).capacidade, "resumir_contrato");
  // Validação direta: com a chave explicitamente nula o plano é válido; sem a chave, continua inválido (obrigatória).
  const catalogo = [...CATALOGO, { id: "resumir_cliente", descricao: "", tipo: "leitura" as const, produz: ["CLIENTE" as const] }];
  const limpo = {
    objetivo: "CONSULTAR:CONTRATO", recursoFinal: null,
    passos: [
      { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2 }, selecao: "PRIMEIRA" },
      { id: "p2", capacidade: "relacoes_festa", entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" } },
      { id: "p3", capacidade: "resumir_contrato", entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } },
    ],
  };
  assert.equal(validarPlano(limpo, catalogo).ok, true);
  const { recursoFinal: _omitido, ...semChave } = limpo;
  void _omitido;
  assert.deepEqual(validarPlano(semChave, catalogo), { ok: false, motivo: "SCHEMA" });
});

test("hipótese 2 (smoke): `objetivo` no schema do provedor é o MESMO conjunto fechado do planoSchema; fora dele ⇒ rejeitado sem leitura", async () => {
  const capturado: Array<PedidoModelo<unknown>> = [];
  const { amb } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => { capturado.push(p); return p.workload === "PLANEJAR" ? PLANO_DOIS_RECURSOS : { capacidade: "nenhuma", dia: null }; }));
  void amb;
  const schema = capturado.find((p) => p.workload === "PLANEJAR")!.esquema.schema as { properties: { objetivo: { type: string; enum?: string[] } } };
  assert.deepEqual(schema.properties.objetivo.enum, [...OBJETIVOS_PLANO], "geração e validação usam o mesmo enum");
  // Todo valor do enum é aceito pela validação; nada fora dele é.
  for (const objetivo of OBJETIVOS_PLANO) assert.equal(planoSchema.shape.objetivo.safeParse(objetivo).success, true, objetivo);
  for (const objetivo of ["CONSULTAR:CONTRATO,CLIENTE", "consultar contrato e cliente", "CONSULTAR:CONTRATO:CLIENTE", "CONSULTAR", "", "LER:CONTRATO"]) {
    assert.equal(planoSchema.shape.objetivo.safeParse(objetivo).success, false, objetivo);
  }
  // Provedor que ignore o enum: o plano é rejeitado inteiro (SCHEMA) e NENHUMA leitura acontece (fail-closed).
  for (const objetivo of ["CONSULTAR:CONTRATO,CLIENTE", "consultar contrato e cliente"]) {
    const { ultima } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => (p.workload === "PLANEJAR" ? { ...PLANO_DOIS_RECURSOS, objetivo } : { capacidade: "nenhuma", dia: null })));
    assert.equal(ultima.rastro?.plano?.parada, "REJEITADO:SCHEMA", objetivo);
    assert.deepEqual(ultima.rastro?.leituras, [], `${objetivo}: nenhuma leitura`);
    assert.equal(ultima.resposta?.tipo, "nao_suportado");
  }
});

test("composição com dois recursos (contrato → cliente) pelo modelo: cadeia de 4 passos + situação do contrato completada (6.4.3); ids só do Core", async () => {
  const plano = {
    objetivo: "CONSULTAR:CLIENTE", recursoFinal: null,
    passos: [
      { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: null, selecao: "PRIMEIRA" },
      { id: "p2", capacidade: "relacoes_festa", parametros: null, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, selecao: null },
      { id: "p3", capacidade: "relacoes_contrato", parametros: null, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" }, selecao: null },
      { id: "p4", capacidade: "resumir_cliente", parametros: null, entradaDe: { de: "PASSO", passo: "p3", entidade: "CLIENTE" }, selecao: null },
    ],
  };
  const { ultima, amb } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => (p.workload === "PLANEJAR" ? plano : { capacidade: "nenhuma", dia: null })));
  // "o contrato e o cliente": o modelo terminou no cliente; a situação do contrato é acrescentada antes de executar.
  assert.deepEqual(passos(ultima)?.map(([c, , r]) => [c, r]), [["proximas_festas", "SUCESSO"], ["relacoes_festa", "SUCESSO"], ["relacoes_contrato", "SUCESSO"], ["resumir_cliente", "SUCESSO"], ["resumir_contrato", "SUCESSO"]]);
  assert.deepEqual(ultima.rastro?.plano?.complemento?.adicionados, ["resumir_contrato"]);
  assert.deepEqual(ultima.rastro?.plano?.composicao?.faltando, []);
  assert.equal(dados(ultima.resposta).capacidade, "resumir_contrato");
  assert.match(dados(ultima.resposta).resumo, /^Ana Oliveira/);
  const traco = JSON.stringify(ultima.rastro?.plano);
  for (const proibido of [...Object.values(IDS), "Ana Oliveira", ...PII]) assert.equal(traco.includes(proibido), false, proibido);
  assert.deepEqual(amb.violacoes.crossTenant, []);
});

// ---------------------------------------------------------------- 7. PR 6.2: CONTEXTO só com contexto real (smoke de staging, caso 8 após o #44)

const PLANO_COM_CONTEXTO = {
  objetivo: "CONSULTAR:CONTRATO", recursoFinal: null,
  passos: [
    { id: "p1", capacidade: "relacoes_festa", parametros: null, entradaDe: { de: "CONTEXTO", passo: null, entidade: "FESTA" }, selecao: null },
    { id: "p2", capacidade: "resumir_contrato", parametros: null, entradaDe: { de: "PASSO", passo: "p1", entidade: "CONTRATO" }, selecao: null },
  ],
};
type SchemaPlano = { properties: { passos: { items: { properties: { entradaDe: { anyOf: Array<{ properties?: { de: { enum: string[] } } }> } } } } } };
const opcoesDe = (p: PedidoModelo<unknown>) => (p.esquema.schema as SchemaPlano).properties.passos.items.properties.entradaDe.anyOf[0].properties!.de.enum;

test("staging (6.2): sem tela e sem foco, o schema e a instrução NÃO oferecem CONTEXTO; o modelo ancora em proximas_festas ASC e o plano vai até FIM", async () => {
  // Provedor que reproduz o modelo de staging: se CONTEXTO for opção, ele escolhe CONTEXTO; se não, a âncora temporal.
  const vistos: Array<PedidoModelo<unknown>> = [];
  const { ultima } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => {
    if (p.workload !== "PLANEJAR") return { capacidade: "nenhuma", dia: null };
    vistos.push(p);
    return opcoesDe(p).includes("CONTEXTO") ? PLANO_COM_CONTEXTO : PLANO_DOIS_RECURSOS;
  }));
  assert.equal(vistos.length, 1);
  assert.deepEqual(opcoesDe(vistos[0]), ["PASSO"], "sem tela/foco, CONTEXTO não é opção no schema");
  const sistema = vistos[0].mensagens[0].conteudo;
  assert.match(sistema, /Não há registro na tela nem no foco/);
  assert.match(sistema, /proximas_festas com ordem ASC/);
  assert.match(vistos[0].mensagens[1].conteudo, /"contextoDisponivel":\[\]/);
  assert.deepEqual([ultima.rastro?.plano?.origem, ultima.rastro?.plano?.parada, ultima.rastro?.plano?.motivoParada, ultima.rastro?.plano?.resultadoFinal], ["MODELO", "FIM", null, "SUCESSO"]);
  assert.deepEqual(passos(ultima), [["proximas_festas", "PARAMETROS", "SUCESSO"], ["relacoes_festa", "PASSO", "SUCESSO"], ["resumir_contrato", "PASSO", "SUCESSO"]]);
  assert.equal(dados(ultima.resposta).capacidade, "resumir_contrato");
});

test("staging (6.2, negativo): modelo que gera CONTEXTO sem tela/foco ⇒ plano rejeitado (CONTEXTO_INDISPONIVEL) antes de qualquer leitura", async () => {
  const { ultima } = await conversa([{ texto: TEXTO_SMOKE }], comModelo((p) => (p.workload === "PLANEJAR" ? PLANO_COM_CONTEXTO : { capacidade: "nenhuma", dia: null })));
  assert.deepEqual([ultima.rastro?.plano?.origem, ultima.rastro?.plano?.parada, ultima.rastro?.plano?.motivoParada], ["MODELO", "REJEITADO:CONTEXTO_INDISPONIVEL", "CONTEXTO_INDISPONIVEL"]);
  assert.deepEqual(ultima.rastro?.leituras, [], "nenhuma leitura");
  assert.equal(ultima.resposta?.tipo, "nao_suportado");
  // Camada da validação, isolada: CONTEXTO de tipo ausente é recusado; de tipo presente, aceito.
  const catalogo = [...CATALOGO];
  const limpo = { objetivo: "CONSULTAR:CONTRATO", recursoFinal: null, passos: [{ id: "p1", capacidade: "relacoes_festa", entradaDe: { de: "CONTEXTO", entidade: "FESTA" } }, { id: "p2", capacidade: "resumir_contrato", entradaDe: { de: "PASSO", passo: "p1", entidade: "CONTRATO" } }] };
  assert.deepEqual(validarPlano(limpo, catalogo, { contexto: [] }), { ok: false, motivo: "CONTEXTO_INDISPONIVEL" });
  assert.deepEqual(validarPlano(limpo, catalogo, { contexto: ["CLIENTE"] }), { ok: false, motivo: "CONTEXTO_INDISPONIVEL" });
  assert.equal(validarPlano(limpo, catalogo, { contexto: ["FESTA"] }).ok, true);
});

test("staging (6.2): com festa na tela, CONTEXTO volta a ser opção e o plano usa a festa aberta", async () => {
  const vistos: Array<PedidoModelo<unknown>> = [];
  const { ultima } = await conversa([{ texto: TEXTO_SMOKE, contexto: { tela: "festa", entidade: "FESTA_MARIA" } }], comModelo((p) => {
    if (p.workload !== "PLANEJAR") return { capacidade: "nenhuma", dia: null };
    vistos.push(p);
    return PLANO_COM_CONTEXTO;
  }));
  assert.equal(vistos.length, 1, "as regras não resolvem este texto: o Planner por modelo é chamado");
  assert.deepEqual(opcoesDe(vistos[0]), ["PASSO", "CONTEXTO"]);
  assert.match(vistos[0].mensagens[1].conteudo, /"contextoDisponivel":\["FESTA"\]/);
  assert.deepEqual(passos(ultima), [["relacoes_festa", "CONTEXTO", "SUCESSO"], ["resumir_contrato", "PASSO", "SUCESSO"]]);
  assert.equal(ultima.rastro?.plano?.origem, "MODELO");
});

test("trace (6.2): parada antes da primeira leitura (âncora do foco negada) registra plano, sequência e motivo — sem id/PII", async () => {
  const amb = criarAmbiente();
  comModelo((p) => (p.workload === "PLANEJAR" ? PLANO_COM_CONTEXTO : { capacidade: "nenhuma", dia: null }))(amb);
  const { atenderConversa } = await import("../conversa.ts");
  // Foco adulterado com festa de OUTRA empresa: o tipo existe (CONTEXTO é oferecido), mas a revalidação no Core nega.
  const r = await atenderConversa({ lerCorpo: async () => ({ texto: TEXTO_SMOKE, foco: { entidades: [{ tipo: "FESTA", id: IDS.FESTA_B }], principal: 0 } }), empresaSolicitada: null }, amb.deps);
  const data = (r.corpo as { data?: AIResponse }).data!;
  assert.equal(data.entendimento, "NEGADO_POLITICA");
  const plano = amb.rastros.at(-1)!.plano!;
  assert.deepEqual([plano.origem, plano.objetivo, plano.quantidadePassos, plano.parada, plano.motivoParada, plano.resultadoFinal], ["MODELO", "CONSULTAR:CONTRATO", 2, "p1", "CONTEXTO_NEGADA", "NEGADO"]);
  assert.deepEqual(plano.passos.map((p) => [p.capacidade, p.origemEntrada, p.resultado]), [["relacoes_festa", "CONTEXTO", "NEGADO"], ["resumir_contrato", "PASSO", "NAO_EXECUTADO"]]);
  assert.equal(amb.rastros.at(-1)!.leituras.some((l) => l.capacidade === "resumir_contrato"), false, "o passo seguinte nunca executa");
  const traco = JSON.stringify(plano);
  for (const proibido of [...Object.values(IDS), ...PII, "Lucas", TEXTO_SMOKE, "festa que vem"]) assert.equal(traco.includes(proibido), false, proibido);
  assert.deepEqual(amb.violacoes.crossTenant, []);
});

// ---------------------------------------------------------------- 8. PR 6.3: composição chega ao Planner; "evento" é temporal (smoke de staging)

const TEXTO_AUXILIAR = "me diz o cliente e se o contrato da comemoração que vem aí está pago";

test("staging (6.3): pedido composto vai ao Planner por modelo ANTES do auxiliar legado (que responderia só uma leitura)", async () => {
  const vistos: string[] = [];
  const { ultima } = await conversa([{ texto: TEXTO_AUXILIAR }], comModelo((p) => { vistos.push(p.workload); return p.workload === "PLANEJAR" ? PLANO_DOIS_RECURSOS : { capacidade: "nenhuma", dia: null }; }));
  const tipos = (ultima.rastro?.orquestracao?.passos ?? []).map((p) => p.tipo);
  assert.ok(tipos.includes("PLANO_MODELO"), "o Planner por modelo foi chamado");
  assert.equal(tipos.includes("SUGESTAO_AUXILIAR"), false, "o auxiliar legado não intercepta o pedido composto");
  assert.ok(tipos.indexOf("PLANO_MODELO") < (tipos.indexOf("SUGESTAO_AUXILIAR") === -1 ? Infinity : tipos.indexOf("SUGESTAO_AUXILIAR")));
  assert.deepEqual(vistos, ["PLANEJAR"]);
  assert.equal(ultima.rastro?.plano?.origem, "MODELO");
  // Só ROTEAMENTO (escopo do 6.3): o pedido não é respondido pelo resumo de recebíveis da empresa inteira e o plano
  // ancora na festa. Completude (cliente + quitação pela posição oficial) é verificada no PR 6.4.
  assert.notEqual(ultima.resposta?.tipo === "resposta" ? dados(ultima.resposta).capacidade : null, "analisar_recebiveis");
  assert.equal(passos(ultima)?.[0]?.[0], "proximas_festas");
});

test("staging (6.3): sem modelo disponível, o caminho de antes continua (auxiliar → interpretação), sem Planner por modelo", async () => {
  const { ultima } = await conversa([{ texto: TEXTO_AUXILIAR }]);
  const tipos = (ultima.rastro?.orquestracao?.passos ?? []).map((p) => p.tipo);
  assert.equal(tipos.includes("PLANO_MODELO"), false);
  assert.ok(tipos.includes("SUGESTAO_AUXILIAR"));
  assert.equal(ultima.rastro?.chamadasModelo, 0);
});

test("staging (6.3): 'próximo evento' / 'último evento' são âncora temporal ⇒ plano por REGRAS (sem 'precisa contexto')", async () => {
  assert.deepEqual(detectarReferencia("qual o contrato do próximo evento?", HOJE)?.temporal?.seletor, "PROXIMA");
  assert.deepEqual(detectarReferencia("quem foi o cliente do último evento?", HOJE)?.temporal?.seletor, "ULTIMA");
  assert.equal(detectarReferencia("me fale do evento de amanhã", HOJE)?.temporal?.seletor, "DIA");
  const { ultima } = await conversa([{ texto: "quero saber a situação do contrato e o pagamento do próximo evento" }]);
  assert.notEqual(ultima.resposta?.tipo, "precisa_contexto", "antes: 'Abra o contrato e pergunte por ali'");
  assert.equal(ultima.rastro?.plano?.origem, "REGRAS");
  // Só ROTEAMENTO (escopo do 6.3): âncora temporal na próxima festa e relação do Core. Os fatos pedidos (situação E
  // pagamento) são exigidos no PR 6.4 — aqui não se afirma que a resposta está completa.
  assert.deepEqual(passos(ultima)?.slice(0, 2).map(([c]) => c), ["proximas_festas", "relacoes_festa"]);
  const parcela = await conversa([{ texto: "quanto falta pagar no próximo evento?" }]);
  assert.deepEqual(passos(parcela.ultima)?.map(([c]) => c), ["proximas_festas", "relacoes_festa", "saldo_contrato"]);
});
