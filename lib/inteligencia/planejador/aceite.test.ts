import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, EMPRESA_B, IDS, MARCADOR_B, PII, type OpcoesAmbiente } from "../../../scripts/ia-benchmark/ambiente.ts";
import type { AIResponse, EntidadeRef, RespostaLeitura } from "../contratos.ts";
import { Circuito } from "../modelos/circuito.ts";
import { criarProvedorFake, respostaFake } from "../modelos/fake.ts";
import { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } from "../modelos/orcamento.ts";
import { RoteadorModelos, politicaDoAmbiente } from "../modelos/roteador.ts";
import type { AdaptadorProvedor, PedidoModelo } from "../modelos/tipos.ts";

/**
 * MATRIZ DE ACEITE das consultas compostas (AI V1.1, PR 6.4.3).
 *
 * Fixture isolada (Core falso do benchmark): a próxima festa é a da Ana (contrato Maria); a empresa tem OUTRO contrato
 * (Pedro/Carla, em aberto) e há dados de OUTRA empresa (marcados). Sucesso = os fatos pedidos vêm do Core, da âncora
 * certa e sem nada faltando. Uma ausência apontada corretamente é SEGURA, mas não conta como sucesso quando os dados e
 * as capacidades existem.
 */
const HOJE = "2026-09-30";
type Fato = "CLIENTE" | "SITUACAO_CONTRATO" | "POSICAO_FINANCEIRA";
type Cenario = NonNullable<OpcoesAmbiente["financeiroProximaFesta"]>;

function comModelo(amb: ReturnType<typeof criarAmbiente>, plano: unknown) {
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

type Pedido = { texto: string; cenario?: Cenario; plano?: unknown; foco?: { entidades: Array<{ tipo: string; id: string }>; principal?: number }; contexto?: { tela: "festa" | "cliente" | "contrato"; entidadeId: string }; empresa?: string };
async function perguntar(p: Pedido) {
  const amb = criarAmbiente({ financeiroProximaFesta: p.cenario ?? "PARCIAL" });
  const provedor = p.plano ? comModelo(amb, p.plano) : null;
  const { atenderConversa } = await import("../conversa.ts");
  const r = await atenderConversa({ lerCorpo: async () => ({ texto: p.texto, ...(p.foco ? { foco: p.foco } : {}), ...(p.contexto ? { contexto: p.contexto } : {}) }), empresaSolicitada: p.empresa ?? null }, amb.deps);
  const data = (r.corpo as { data?: AIResponse }).data ?? null;
  return { status: r.status, data, rastro: amb.rastros.at(-1)!, amb, provedor };
}
const dados = (r: AIResponse | null) => (r as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
const textos = (d: RespostaLeitura) => d.fatos.map((f) => `${f.natureza}:${f.texto}`);

/** Fatos que provam cada fato pedido, por cenário financeiro (todos da posição/relações/resumo OFICIAIS). */
const PROVA: Record<Fato, (c: Cenario) => string[]> = {
  CLIENTE: () => ["FATO:Cliente: Ana Oliveira."],
  SITUACAO_CONTRATO: () => ["FATO:Contrato assinado, versão vigente V2."],
  POSICAO_FINANCEIRA: (c) => (c === "QUITADO" ? ["FATO:Valor pago (líquido): R$ 4.500,00.", "FATO:Situação: Quitado."]
    : c === "SEM_POSICAO" ? ["AUSENCIA:Contrato sem obrigação financeira criada."]
    : ["FATO:Valor pago (líquido): R$ 3.300,00.", "CALCULO:Em aberto: R$ 1.200,00, em 1 parcela.", "FATO:Situação: Em aberto."]),
};

/** Sucesso: resposta de leitura com os fatos pedidos, nada faltando, só a âncora certa, nada de outro contrato/empresa. */
function sucesso(r: Awaited<ReturnType<typeof perguntar>>, fatos: readonly Fato[], cenario: Cenario, rotulo: string) {
  assert.equal(r.data?.tipo, "resposta", `${rotulo}: resposta de leitura`);
  const d = dados(r.data);
  const f = textos(d);
  for (const fato of fatos) {
    // Cliente: pelas relações ("Cliente: Ana Oliveira.") ou pelo resumo do cliente (nome no resumo, entidade CLIENTE da âncora).
    if (fato === "CLIENTE" && !f.includes(PROVA.CLIENTE(cenario)[0])) {
      assert.ok(d.capacidade === "resumir_cliente" || f.length, rotulo);
      assert.match(d.resumo, /Ana Oliveira/, `${rotulo}: cliente`);
      assert.ok((d.entidades ?? []).some((e) => e.tipo === "CLIENTE" && e.id === IDS.CLIENTE_ANA), `${rotulo}: entidade do cliente`);
      continue;
    }
    for (const prova of PROVA[fato](cenario)) assert.ok(f.includes(prova), `${rotulo}: falta ${prova}`);
  }
  assert.equal(f.some((x) => x.startsWith("AUSENCIA:Não consegui obter")), false, `${rotulo}: ausência apontada com dados disponíveis`);
  if (r.rastro.plano) {
    assert.deepEqual(r.rastro.plano.composicao?.faltando ?? [], [], `${rotulo}: faltando`);
    assert.equal(r.rastro.plano.complemento?.impossivel ?? null, null, `${rotulo}: complemento impossível`);
  }
  // Âncora certa: só o contrato da próxima festa; nada do outro contrato da empresa nem da outra empresa.
  const ids = (tipo: EntidadeRef["tipo"]) => [...new Set((d.entidades ?? []).filter((e) => e.tipo === tipo).map((e) => e.id))];
  if (ids("CONTRATO").length) assert.deepEqual(ids("CONTRATO"), [IDS.CONTRATO_MARIA], `${rotulo}: contrato errado`);
  if (ids("CLIENTE").length) assert.deepEqual(ids("CLIENTE"), [IDS.CLIENTE_ANA], `${rotulo}: cliente errado`);
  const tudo = JSON.stringify(d);
  for (const proibido of ["Carla Souza", "R$ 5.000,00", "R$ 2.500,00", MARCADOR_B, IDS.CONTRATO_PEDRO, IDS.FESTA_B, IDS.CLIENTE_B]) assert.equal(tudo.includes(proibido), false, `${rotulo}: ${proibido}`);
  // Trace sem PII, nomes, valores, ids do Core ou texto do pedido.
  const traco = JSON.stringify(r.rastro.plano ?? null);
  for (const proibido of [...PII, "Ana Oliveira", "R$", ...Object.values(IDS)]) assert.equal(traco.includes(proibido), false, `${rotulo}: trace contém ${proibido}`);
  assert.deepEqual(r.amb.violacoes.crossTenant, []);
}

// ---------------------------------------------------------------- planos do modelo (provedor fake roteirizado)

const nulos = { parametros: null, selecao: null, resposta: null };
const p1 = { id: "p1", capacidade: "proximas_festas", parametros: { ordem: "ASC", limite: 2, inicio: null, fim: null, dia: null, incluirCancelados: null }, entradaDe: null, selecao: "PRIMEIRA", resposta: null };
const rel = (resposta: boolean | null = null) => ({ id: "p2", capacidade: "relacoes_festa", ...nulos, entradaDe: { de: "PASSO", passo: "p1", entidade: "FESTA" }, resposta });
const doContrato = (id: string, capacidade: string) => ({ id, capacidade, ...nulos, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } });
const plano = (objetivo: string, passos: unknown[]) => ({ objetivo, recursoFinal: null, passos });

/** Planos do modelo: completos e INCOMPLETOS (o complemento determinístico tem de fechar a lacuna). */
const PLANOS = {
  completoClientePago: plano("CONSULTAR:PAGAMENTO", [p1, rel(true), doContrato("p3", "saldo_contrato")]),
  soListagem: plano("CONSULTAR:FESTA", [p1]),
  soRelacoes: plano("CONSULTAR:FESTA", [p1, rel()]),
  semMarcaNoCliente: plano("CONSULTAR:PAGAMENTO", [p1, rel(), doContrato("p3", "saldo_contrato")]),
  parcelaEmVezDeSaldo: plano("CONSULTAR:PAGAMENTO", [p1, rel(true), doContrato("p3", "proxima_parcela")]),
  soResumoContrato: plano("CONSULTAR:CONTRATO", [p1, rel(), doContrato("p3", "resumir_contrato")]),
};

const VARIANTES_MODELO = [
  { texto: "me diz o cliente e se o contrato da comemoração que vem aí está pago", fatos: ["CLIENTE", "POSICAO_FINANCEIRA"] as Fato[] },
  { texto: "da comemoração que vem aí, quero o cliente e o contrato", fatos: ["CLIENTE", "SITUACAO_CONTRATO"] as Fato[] },
  { texto: "me mostra o contrato e o cliente da comemoração que vem aí", fatos: ["CLIENTE", "SITUACAO_CONTRATO"] as Fato[] },
  { texto: "qual a situação do contrato da comemoração que vem aí e se já foi pago", fatos: ["SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"] as Fato[] },
  { texto: "o cliente, a situação do contrato e o pagamento da comemoração que vem aí", fatos: ["CLIENTE", "SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"] as Fato[] },
];

test("aceite — MODELO: variações × planos completos e incompletos × quitado/parcial/sem posição ⇒ todos os fatos, âncora certa", async () => {
  for (const v of VARIANTES_MODELO) {
    for (const [nome, p] of Object.entries(PLANOS)) {
      for (const cenario of ["PARCIAL", "QUITADO", "SEM_POSICAO"] as const) {
        const rotulo = `${v.texto} · ${nome} · ${cenario}`;
        const r = await perguntar({ texto: v.texto, cenario, plano: p });
        assert.equal(r.rastro.plano?.origem, "MODELO", `${rotulo}: caminho do modelo`);
        sucesso(r, v.fatos, cenario, rotulo);
        const chamadas = (r.rastro.orquestracao?.passos ?? []).filter((x) => ["JULGAMENTO_JEV_MODELO", "INTENCAO_MODELO", "COMPLEMENTO_MODELO", "PLANO_MODELO"].includes(x.tipo)).length;
        assert.ok(chamadas <= 2, `${rotulo}: no máximo 2 passos com modelo`);
        assert.ok((r.rastro.plano?.quantidadePassos ?? 0) <= 5, `${rotulo}: limite de passos`);
      }
    }
  }
});

test("aceite — MODELO: o complemento é registrado no trace (o que foi acrescentado ou marcado), só códigos", async () => {
  const casos: Array<[keyof typeof PLANOS, string, { adicionados: string[]; marcados: string[] } | null]> = [
    ["completoClientePago", VARIANTES_MODELO[0].texto, null],
    ["soListagem", VARIANTES_MODELO[0].texto, { adicionados: ["relacoes_festa", "saldo_contrato"], marcados: [] }],
    ["semMarcaNoCliente", VARIANTES_MODELO[0].texto, { adicionados: [], marcados: ["relacoes_festa"] }],
    ["parcelaEmVezDeSaldo", VARIANTES_MODELO[0].texto, { adicionados: ["saldo_contrato"], marcados: [] }],
    // A relação era a leitura final original (sempre na resposta): não precisa ser "marcada".
    ["soRelacoes", VARIANTES_MODELO[1].texto, { adicionados: ["resumir_contrato"], marcados: [] }],
    ["soListagem", VARIANTES_MODELO[4].texto, { adicionados: ["relacoes_festa", "resumir_contrato", "saldo_contrato"], marcados: [] }],
  ];
  for (const [nome, texto, esperado] of casos) {
    const r = await perguntar({ texto, plano: PLANOS[nome] });
    const c = r.rastro.plano?.complemento;
    assert.deepEqual(c ? { adicionados: c.adicionados, marcados: c.marcados } : null, esperado, `${nome}: ${texto}`);
  }
});

test("aceite — MODELO: o modelo recebe os fatos pedidos e quais capacidades os fornecem", async () => {
  const r = await perguntar({ texto: VARIANTES_MODELO[4].texto, plano: PLANOS.completoClientePago });
  const pedido = r.provedor!.chamadas.find((c) => c.workload === "PLANEJAR")!;
  const corpo = JSON.parse(pedido.mensagens[1].conteudo) as { fatosPedidos: Array<{ fato: string; capacidades: string[] }> };
  assert.deepEqual(corpo.fatosPedidos, [
    { fato: "CLIENTE", capacidades: ["relacoes_festa", "relacoes_contrato", "resumir_cliente"] },
    { fato: "SITUACAO_CONTRATO", capacidades: ["resumir_contrato"] },
    { fato: "POSICAO_FINANCEIRA", capacidades: ["saldo_contrato"] },
  ]);
  assert.match(pedido.mensagens[0].conteudo, /relações não dão a situação do contrato; proxima_parcela não comprova quitação/);
});

// ---------------------------------------------------------------- regras: frases exatas do smoke + variações, fatos juntos e separados

const FRASES_REGRAS: Array<{ texto: string; fatos: Fato[] }> = [
  // As três frases exatas do smoke em staging.
  { texto: "me diz o cliente e se o contrato da festa que vem aí está pago", fatos: ["CLIENTE", "POSICAO_FINANCEIRA"] },
  { texto: "quero saber a situação do contrato e o pagamento do próximo evento", fatos: ["SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"] },
  { texto: "da festa que vem aí, quero o cliente e o contrato", fatos: ["CLIENTE", "SITUACAO_CONTRATO"] },
  // Variações de redação.
  { texto: "me mostra o contrato e o cliente da festa que vem por aí", fatos: ["CLIENTE", "SITUACAO_CONTRATO"] },
  { texto: "o contrato do próximo evento já está pago?", fatos: ["POSICAO_FINANCEIRA"] },
  { texto: "me fala o cliente, a situação do contrato e o pagamento da próxima festa", fatos: ["CLIENTE", "SITUACAO_CONTRATO", "POSICAO_FINANCEIRA"] },
  // Fatos separados.
  { texto: "quem é o cliente da próxima festa?", fatos: ["CLIENTE"] },
  { texto: "qual a situação do contrato da próxima festa?", fatos: ["SITUACAO_CONTRATO"] },
  { texto: "quanto falta pagar na próxima festa?", fatos: ["POSICAO_FINANCEIRA"] },
  { texto: "a próxima festa está quitada?", fatos: ["POSICAO_FINANCEIRA"] },
];

test("aceite — REGRAS: frases do smoke, variações e fatos separados × quitado/parcial/sem posição ⇒ todos os fatos, âncora certa", async () => {
  for (const f of FRASES_REGRAS) {
    for (const cenario of ["PARCIAL", "QUITADO", "SEM_POSICAO"] as const) {
      const rotulo = `${f.texto} · ${cenario}`;
      const r = await perguntar({ texto: f.texto, cenario });
      assert.equal(r.rastro.plano?.origem, "REGRAS", `${rotulo}: regras (sem modelo)`);
      assert.equal(r.rastro.chamadasModelo, 0, `${rotulo}: 0 chamadas de modelo`);
      sucesso(r, f.fatos, cenario, rotulo);
    }
  }
});

test("aceite — foco: 'o cliente e o contrato dela' e 'está pago?' com a festa em foco usam a MESMA festa", async () => {
  const foco = { entidades: [{ tipo: "FESTA", id: IDS.FESTA_MARIA }], principal: 0 };
  sucesso(await perguntar({ texto: "qual o cliente e o contrato dela?", foco }), ["CLIENTE", "SITUACAO_CONTRATO"], "PARCIAL", "foco cliente+contrato");
  sucesso(await perguntar({ texto: "o contrato dela está pago?", foco, cenario: "QUITADO" }), ["POSICAO_FINANCEIRA"], "QUITADO", "foco pago");
});

// ---------------------------------------------------------------- ambiguidade, ausência, recusa, isolamento — paradas seguras

test("aceite — ambiguidade: duas festas candidatas ⇒ pergunta qual (AMBIGUO), sem compor nem escolher", async () => {
  const dois = { ...PLANOS.completoClientePago, passos: [{ ...p1, selecao: "UNICA" }, rel(true), doContrato("p3", "saldo_contrato")] };
  const m = await perguntar({ texto: VARIANTES_MODELO[0].texto, plano: dois });
  assert.equal(m.data?.tipo, "nao_suportado");
  assert.equal(m.rastro.plano?.motivoParada, "AMBIGUO");
  const foco = { entidades: [{ tipo: "FESTA", id: IDS.FESTA_MARIA }, { tipo: "FESTA", id: IDS.FESTA_PEDRO }] };
  const r = await perguntar({ texto: "qual o cliente e o contrato dela?", foco });
  assert.equal(r.data?.entendimento, "AMBIGUO");
  assert.equal(r.rastro.plano, null, "sem âncora única, nenhum plano executa");
});

test("aceite — ausência: sem festa no período / no dia ⇒ 'não encontrei' (EXECUTADO), sem inventar e sem pedir dado", async () => {
  const semFestas = { ...PLANOS.completoClientePago, passos: [{ ...p1, parametros: { ...p1.parametros, inicio: "2030-01-01", fim: "2030-01-31" } }, rel(true), doContrato("p3", "saldo_contrato")] };
  const m = await perguntar({ texto: VARIANTES_MODELO[0].texto, plano: semFestas });
  assert.deepEqual([m.data?.entendimento, (m.data as { mensagem?: string })?.mensagem], ["EXECUTADO", "Não encontrei no sistema os dados pedidos para esta consulta."]);
  const r = await perguntar({ texto: "qual o cliente e o contrato da festa de 25/12?" });
  assert.equal(r.data?.entendimento, "EXECUTADO");
  assert.match((r.data as { mensagem: string }).mensagem, /^Não encontrei a festa de 25\/12 registrada/);
});

test("aceite — recusa: Policy nega o financeiro ⇒ fail-closed (403); cliente já lido não vira sucesso parcial", async () => {
  for (const p of [{ texto: FRASES_REGRAS[0].texto }, { texto: VARIANTES_MODELO[0].texto, plano: PLANOS.completoClientePago }]) {
    const r = await perguntar({ ...p, cenario: "NEGADO" });
    assert.equal(r.status, 403, p.texto);
    assert.equal(r.data, null, p.texto);
    assert.notEqual(r.rastro.plano?.resultadoFinal, "SUCESSO", p.texto);
  }
});

test("aceite — isolamento: festa de outra empresa no foco ⇒ negada; empresa não comprovada ⇒ recusa; nada da empresa B", async () => {
  const foco = { entidades: [{ tipo: "FESTA", id: IDS.FESTA_B }], principal: 0 };
  const r = await perguntar({ texto: "qual o cliente e o contrato dela?", foco });
  assert.equal(r.data?.entendimento, "NEGADO_POLITICA");
  assert.equal(JSON.stringify(r.data).includes(MARCADOR_B), false);
  assert.deepEqual(r.amb.violacoes.crossTenant, []);
  const outra = await perguntar({ texto: FRASES_REGRAS[0].texto, empresa: EMPRESA_B });
  assert.ok(outra.status >= 400, "empresa sem membership não é atendida");
  assert.equal(JSON.stringify(outra).includes(MARCADOR_B), false);
});

// ---------------------------------------------------------------- não é possível completar com segurança ⇒ ausência explícita (segura, não sucesso)

test("aceite — sem fonte inequívoca: cliente em tela sem festa/contrato na cadeia ⇒ NÃO completa; ausência explícita", async () => {
  const soCliente = plano("CONSULTAR:CLIENTE", [{ id: "p1", capacidade: "resumir_cliente", ...nulos, entradaDe: { de: "CONTEXTO", passo: null, entidade: "CLIENTE" } }]);
  const r = await perguntar({ texto: "me diz o cliente e se o contrato desta comemoração está pago", plano: soCliente, contexto: { tela: "cliente", entidadeId: IDS.CLIENTE_ANA } });
  assert.deepEqual(r.rastro.plano?.complemento, { adicionados: [], marcados: [], impossivel: "SEM_FONTE" });
  assert.deepEqual(r.rastro.plano?.composicao?.faltando, ["POSICAO_FINANCEIRA"]);
  assert.ok(textos(dados(r.data)).includes("AUSENCIA:Não consegui obter: posição financeira (pago, saldo, em aberto)."));
});

test("aceite — completar estouraria o limite de 5 passos ⇒ NÃO completa (LIMITE_PASSOS); ausência explícita", async () => {
  const longo = plano("CONSULTAR:FESTA", [p1, rel(), { id: "p3", capacidade: "relacoes_contrato", ...nulos, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } }, { id: "p4", capacidade: "resumir_cliente", ...nulos, entradaDe: { de: "PASSO", passo: "p3", entidade: "CLIENTE" } }, { id: "p5", capacidade: "resumir_festa", ...nulos, entradaDe: { de: "PASSO", passo: "p3", entidade: "FESTA" } }]);
  const r = await perguntar({ texto: VARIANTES_MODELO[4].texto, plano: longo });
  assert.equal(r.rastro.plano?.complemento?.impossivel, "LIMITE_PASSOS");
  assert.ok(r.rastro.plano?.composicao?.faltando.length, "o que faltou fica explícito");
  assert.equal(r.data?.tipo, "resposta");
  assert.ok(textos(dados(r.data)).some((x) => x.startsWith("AUSENCIA:Não consegui obter")));
});

test("aceite — navegação no fim: nada é acrescentado depois dela (NAVEGACAO_OU_ACAO); a navegação segue", async () => {
  const abrir = plano("ABRIR:CONTRATO", [p1, rel(), { id: "p3", capacidade: "abrir_tela", ...nulos, entradaDe: { de: "PASSO", passo: "p2", entidade: "CONTRATO" } }]);
  const r = await perguntar({ texto: "me leva para o contrato e o cliente da comemoração que vem aí", plano: abrir });
  assert.equal(r.data?.tipo, "navegacao");
  assert.equal(r.rastro.plano?.complemento?.impossivel, "NAVEGACAO_OU_ACAO");
});

test("aceite — JEV: 'está quitada?' é CONSULTA; 'quite a parcela' / 'registre o pagamento' continuam mutação financeira", async () => {
  const { lerSinais } = await import("../jev/v1/regras.ts");
  for (const consulta of ["a próxima festa está quitada?", "o contrato já foi quitado?", "me diz se está quitado"]) assert.equal(lerSinais(consulta).mutacaoFinanceira, false, consulta);
  for (const acao of ["quite a parcela da próxima festa", "quitar o contrato da Ana", "registre o pagamento da parcela", "estorne o pagamento"]) assert.equal(lerSinais(acao).mutacaoFinanceira, true, acao);
});
