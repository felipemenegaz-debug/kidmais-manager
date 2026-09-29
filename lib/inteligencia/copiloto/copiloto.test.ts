import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import type { AIResponse, ComplementoCopiloto, IdProvedor, RespostaLeitura } from "../contratos.ts";
import { atenderConversa, type DependenciasConversa } from "../conversa.ts";
import { criarDemerzel } from "../demerzel/orquestradora.ts";
import type { PortaModeloClassificacao, SkillAplicavel } from "../extensoes.ts";
import { interpretarDeterministico } from "../intencao.ts";
import { TEMAS_NAVEGACAO } from "../leituras/navegacao.ts";
import { Circuito } from "../modelos/circuito.ts";
import { criarProvedorFake, respostaFake } from "../modelos/fake.ts";
import { criarRegistroUsoEmMemoria, orcamentoDoAmbiente } from "../modelos/orcamento.ts";
import { RoteadorModelos, politicaDoAmbiente } from "../modelos/roteador.ts";
import type { AdaptadorProvedor, PedidoModelo } from "../modelos/tipos.ts";
import type { RastreioInteligencia } from "../rastreio.ts";
import { criarCatalogoSkills, repositorioSemSkillsDeEmpresa } from "../skills/catalogo.ts";
import { SKILLS_PLATAFORMA } from "../skills/plataforma.ts";
import { construirContextoAutorizado, construirContextoModelo } from "../contexto/construtor.ts";
import { criarComplementador, validarExplicacao } from "./complementador.ts";

const raiz = join(import.meta.dirname, "..", "..", "..");
const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";
const festaId = "33333333-3333-4333-8333-333333333333";
const contratoId = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------- perguntas por tela

test("Copiloto por tela: as perguntas do produto chegam à leitura certa (ou pedem contexto)", () => {
  const alvo = (texto: string, contexto: Parameters<typeof interpretarDeterministico>[1]) => {
    const i = interpretarDeterministico(texto, contexto);
    return i.tipo === "leitura" || i.tipo === "precisa_contexto" || i.tipo === "acao" ? `${i.tipo}:${i.capacidade}` : i.tipo;
  };
  const casos: Array<[string, Parameters<typeof interpretarDeterministico>[1], string]> = [
    ["O que está pendente nesta festa?", { tela: "festa", entidadeId: festaId }, "leitura:pendencias_da_festa"],
    ["Este contrato já está assinado?", { tela: "contrato", entidadeId: contratoId }, "leitura:resumir_contrato"],
    ["Este contrato já está assinado?", { tela: "dashboard" }, "precisa_contexto:resumir_contrato"],
    ["Qual pagamento está atrasado?", { tela: "financeiro" }, "leitura:analisar_recebiveis"],
    ["O que preciso resolver hoje?", { tela: "dashboard" }, "leitura:atencao_hoje"],
    ["Explique estes números", { tela: "financeiro" }, "leitura:analisar_recebiveis"],
    ["Explique estes números", { tela: "dashboard" }, "leitura:atencao_hoje"],
    ["Onde eu cadastro um pacote?", null, "leitura:onde_encontrar"],
    ["Como importo um contrato antigo?", null, "leitura:onde_encontrar"],
    ["Como está a agenda de hoje?", null, "leitura:agenda_do_dia"],
    ["Crie um pacote Festa Top", null, "acao:criar_pacote"],
    ["Registre o pagamento da parcela 2", null, "acao:mutacao_nao_suportada"],
  ];
  for (const [texto, contexto, esperado] of casos) assert.equal(alvo(texto, contexto), esperado, `${texto} @ ${contexto?.tela ?? "-"}`);
});

test("navegação: todo destino aponta para uma tela que existe (menu do Admin ou rota em app/)", () => {
  const menu = readFileSync(join(raiz, "lib", "admin", "navegacao.ts"), "utf8");
  for (const [tema, alvo] of Object.entries(TEMAS_NAVEGACAO)) {
    const noMenu = menu.includes(`href: '${alvo.destino}'`);
    const rota = existsSync(join(raiz, "app", ...alvo.destino.split("/").filter(Boolean), "page.tsx"));
    assert.ok(noMenu || rota, `${tema} → ${alvo.destino}`);
  }
});

// ---------------------------------------------------------------- complementador

const procedimentos: SkillAplicavel = (() => {
  const s = SKILLS_PLATAFORMA.find((x) => x.id === "procedimentos_operacionais")!;
  return { id: s.id, versao: s.versao, hash: s.hash, nivel: "PLATAFORMA", cadeia: [], conteudo: s.conteudo, restricoes: s.restricoes };
})();

const leitura = (estado: RespostaLeitura["estado"], capacidade = "contratos_pendentes"): RespostaLeitura => ({
  capacidade, estado, resumo: "x", fatos: [{ natureza: "FATO", texto: "2 contratos aguardando assinatura.", fonte: "contratos" }],
  itens: [{ id: "c1", prioridade: "alta", titulo: "Contrato 12", detalhe: "Falta assinatura", destino: "/admin/contratos?contratoId=x" }],
  evidencias: [{ fonte: "contratos", rotulo: "Aguardando", valor: "2" }],
  referencia: { hoje: "2026-09-29", geradoEm: "2026-09-29T15:00:00Z", fontes: ["contratos"] },
});

test("próxima ação: procedimento da skill só quando a leitura pede atenção; é sugestão com fonte e destino da leitura", async () => {
  const c = criarComplementador();
  const r = (await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("atencao"), contextoModelo: null, procedimento: procedimentos, explicar: false, modelo: null }))!;
  assert.equal(r.proximaAcao?.titulo, "Contrato aguardando assinatura");
  assert.ok(r.proximaAcao!.passos.length >= 1);
  assert.equal(r.proximaAcao?.destino, "/admin/contratos?contratoId=x");
  assert.match(r.proximaAcao!.fonte, /^skill:procedimentos_operacionais@/);
  assert.equal(r.explicacao, null);
  assert.equal(await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("em_dia"), contextoModelo: null, procedimento: procedimentos, explicar: false, modelo: null }), null);
  assert.equal(await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("atencao"), contextoModelo: null, procedimento: null, explicar: false, modelo: null }), null);
  assert.equal(await c.complementar({ capacidade: "agenda_do_dia", dados: leitura("atencao", "agenda_do_dia"), contextoModelo: null, procedimento: procedimentos, explicar: false, modelo: null }), null);
});

test("explicação: números e datas só dos dados; id, e-mail, link, CPF ou ação alegada ⇒ recusada", () => {
  const ctx = JSON.stringify({ dados: [{ fatos: [{ texto: "Saldo em aberto somado: R$ 8.500,00." }, { texto: "Maior atraso: 42 dias em 29/09/2026." }] }] });
  assert.equal(validarExplicacao(["Há R$ 8.500,00 em aberto; o maior atraso é de 42 dias."], ctx), null);
  assert.equal(validarExplicacao(["Há R$ 8500,00 em aberto."], ctx), null, "sem separador de milhar vale o mesmo número");
  assert.equal(validarExplicacao(["Há R$ 9.100,00 em aberto."], ctx), "NUMERO_INVENTADO");
  assert.equal(validarExplicacao(["Vence em 30/09/2026."], ctx), "NUMERO_INVENTADO");
  assert.equal(validarExplicacao([`Veja ${empresaA}.`], ctx), "IDENTIFICADOR");
  assert.equal(validarExplicacao(["Fale com a@b.co."], ctx), "IDENTIFICADOR");
  assert.equal(validarExplicacao(["Já registrei o pagamento."], ctx), "ACAO_ALEGADA");
});

function portaModelo(resposta: (pedido: PedidoModelo<unknown>) => string): PortaModeloClassificacao & { pedidos: PedidoModelo<unknown>[] } {
  const pedidos: PedidoModelo<unknown>[] = [];
  return {
    pedidos,
    disponivel: () => true,
    async executar<T>(pedido: PedidoModelo<T>) {
      pedidos.push(pedido as PedidoModelo<unknown>);
      try {
        return { ok: true as const, valor: pedido.validar(resposta(pedido as PedidoModelo<unknown>)), usos: [], provedor: "FAKE" as IdProvedor, modelo: "f" };
      } catch {
        return { ok: false as const, causa: "RESPOSTA_INVALIDA" as const, usos: [] };
      }
    },
  };
}

test("explicação por modelo: só com pedido de explicação e contexto; saída inválida ⇒ sem explicação (dados continuam)", async () => {
  const contexto = { contexto: {} as never, json: JSON.stringify({ fatos: [{ texto: "2 contratos aguardando assinatura." }] }) };
  const c = criarComplementador();
  const boa = portaModelo(() => JSON.stringify({ frases: ["Há 2 contratos aguardando assinatura."] }));
  const r = (await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("atencao"), contextoModelo: contexto, procedimento: null, explicar: true, modelo: boa }))!;
  assert.deepEqual(r.explicacao?.frases, ["Há 2 contratos aguardando assinatura."]);
  assert.equal(r.explicacao?.origem, "MODELO");
  assert.equal(boa.pedidos[0].mensagens[1].conteudo, contexto.json, "o modelo recebe só o JSON do Context Builder");
  const naoPedida = portaModelo(() => "{}");
  await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("atencao"), contextoModelo: contexto, procedimento: null, explicar: false, modelo: naoPedida });
  assert.equal(naoPedida.pedidos.length, 0);
  for (const ruim of [JSON.stringify({ frases: ["Há 7 contratos pendentes."] }), JSON.stringify({ frases: ["Enviei o lembrete."] }), "não é json", JSON.stringify({ frases: [], extra: 1 })]) {
    const x = await c.complementar({ capacidade: "contratos_pendentes", dados: leitura("em_dia"), contextoModelo: contexto, procedimento: null, explicar: true, modelo: portaModelo(() => ruim) });
    assert.equal(x, null, ruim);
  }
});

// ---------------------------------------------------------------- ponta a ponta

const membershipA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: empresaA };
function bancoFalso() {
  const consultas: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push(sql);
      const r = (rows: object[]) => ({ rows, rowCount: rows.length }) as { rows: Row[]; rowCount: number };
      if (sql.includes("FROM pagamento_parcelas")) {
        return r(values[0] === empresaA ? [
          { id: "p1", pagamento_id: "pg1", numero: 1, valor: "3000.00", vencimento: "2026-09-01", status_gravado: "PENDENTE", cliente: "Mariana Souza 123.456.789-00", festa_id: null, pacote: "P", data_evento: "2026-10-10", recebido: "0", forma: "PIX" },
          { id: "p2", pagamento_id: "pg2", numero: 2, valor: "5500.00", vencimento: "2026-10-20", status_gravado: "PENDENTE", cliente: "Mariana Souza", festa_id: null, pacote: "P", data_evento: "2026-10-10", recebido: "0", forma: "PIX" },
        ] : []);
      }
      if (sql.includes("FROM financeiro_entradas_manuais")) return r([]);
      if (sql.includes("m.status AS membership")) return r(values[0] === membershipA.id ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r([{ id: empresaA }]);
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r([{ papel: "ADMINISTRATIVO", ...membershipA }]);
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  return { tx, consultas };
}

function conversaCopiloto(opcoes: { roteiro: (pedido: PedidoModelo<unknown>) => string; modeloLigado?: boolean }) {
  const banco = bancoFalso();
  const rastros: RastreioInteligencia[] = [];
  const provedor = criarProvedorFake({ id: "OPENAI", roteiro: (pedido) => respostaFake(opcoes.roteiro(pedido)) });
  let id = 0;
  const roteador = new RoteadorModelos({
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_MODEL_MAX_RETRIES: "0" }),
    adaptadores: new Map([["OPENAI", provedor as AdaptadorProvedor]]),
    precos: null,
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 } }) }),
    registro: criarRegistroUsoEmMemoria(), circuito: new Circuito(), agora: () => new Date("2026-09-29T15:00:00Z"), relogio: () => performance.now(),
    novoId: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-00000000000c`,
  });
  const deps: DependenciasConversa = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", AI_DEMERZEL_ENABLED: "true", ...(opcoes.modeloLigado === false ? {} : { AI_COPILOTO_MODEL_ENABLED: "true" }) },
    autenticar: async () => ({ id: "s", usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "J", cargo: null, papel: "ADMINISTRATIVO", autenticado_em: "", expira_em: "", csrf_hash: "" }) as SessaoParaTenant,
    withTenantTransaction: (s, empresa, work) => executarNoTenant(banco.tx, s, empresa, work),
    agora: () => new Date("2026-09-29T15:00:00Z"), requestId: () => "req-c", registrar: (r) => rastros.push({ ...r }), relogio: () => performance.now(),
    portas: { festas: null, clientes: null }, acoes: null, roteador, orquestrador: criarDemerzel(),
    skills: criarCatalogoSkills({ plataforma: SKILLS_PLATAFORMA, repositorio: repositorioSemSkillsDeEmpresa }),
    copiloto: criarComplementador(),
  };
  const perguntar = async (texto: string, contexto: { tela: "financeiro" | "dashboard" } | null = { tela: "financeiro" }, empresa: string | null = null) => {
    const r = await atenderConversa({ lerCorpo: async () => ({ texto, ...(contexto ? { contexto } : {}) }), empresaSolicitada: empresa }, deps);
    return { status: r.status, data: (r.corpo as { data?: AIResponse }).data };
  };
  return { perguntar, provedor, rastros, banco };
}

/** "Modelo" bem-comportado: usa só o primeiro valor em reais que recebeu. */
const explicaComDados = (pedido: PedidoModelo<unknown>) => {
  const valor = pedido.mensagens[1].conteudo.match(/R\$\s?[\d.,]+\d/)?.[0] ?? "R$ 0";
  return JSON.stringify({ frases: [`O saldo em aberto soma ${valor}.`] });
};

test("ponta a ponta: 'Explique estes números' → leitura autorizada → contexto minimizado → modelo → explicação validada + próxima ação", async () => {
  const c = conversaCopiloto({ roteiro: explicaComDados });
  const r = await c.perguntar("Explique estes números");
  assert.equal(r.status, 200);
  const resposta = r.data as { tipo: string; complemento?: ComplementoCopiloto };
  assert.equal(resposta.tipo, "resposta");
  assert.match(resposta.complemento!.explicacao!.frases[0], /^O saldo em aberto soma R\$ /);
  assert.equal(resposta.complemento!.proximaAcao?.titulo, "Valor em atraso");
  // O que foi ao modelo: sem nome do cliente, CPF, ids, empresa ou links internos.
  const enviado = JSON.stringify(c.provedor.chamadas[0].mensagens);
  for (const proibido of ["Mariana", "Souza", "123.456.789-00", empresaA, "contas-receber", "/admin/"]) assert.equal(enviado.includes(proibido), false, proibido);
  const rastro = c.rastros.at(-1)!;
  assert.ok(rastro.orquestracao!.passos.some((p) => p.tipo === "COMPLEMENTO_MODELO" && p.resultado === "EXPLICACAO"));
  assert.equal(rastro.chamadasModelo, 1);
});

test("ponta a ponta: modelo que inventa número ⇒ sem explicação, dados e próxima ação continuam; sem flag ⇒ nenhuma chamada", async () => {
  const inventor = conversaCopiloto({ roteiro: () => JSON.stringify({ frases: ["O saldo em aberto soma R$ 99.999,00."] }) });
  const r = await inventor.perguntar("Explique estes números");
  const resposta = r.data as { tipo: string; complemento?: ComplementoCopiloto };
  assert.equal(resposta.tipo, "resposta");
  assert.equal(resposta.complemento?.explicacao ?? null, null);
  assert.equal(resposta.complemento?.proximaAcao?.titulo, "Valor em atraso");
  const semFlag = conversaCopiloto({ roteiro: explicaComDados, modeloLigado: false });
  await semFlag.perguntar("Explique estes números");
  assert.equal(semFlag.provedor.chamadas.length, 0);
  const semExplicar = conversaCopiloto({ roteiro: explicaComDados });
  await semExplicar.perguntar("Qual pagamento está atrasado?");
  assert.equal(semExplicar.provedor.chamadas.length, 0, "sem pedido de explicação, sem modelo");
});

test("ponta a ponta: outra empresa pelo seletor é recusada antes de ler, complementar ou chamar modelo", async () => {
  const c = conversaCopiloto({ roteiro: explicaComDados });
  const r = await c.perguntar("Explique estes números", { tela: "financeiro" }, empresaB);
  assert.notEqual(r.status, 200);
  assert.equal(c.provedor.chamadas.length, 0);
  assert.ok(!c.banco.consultas.some((sql) => sql.includes("FROM pagamento_parcelas")));
});

test("ponta a ponta: Copiloto nunca executa — mutação continua recusada; navegação não lê dado de negócio", async () => {
  const c = conversaCopiloto({ roteiro: explicaComDados });
  const mutacao = await c.perguntar("Registre o pagamento da parcela 2", null);
  assert.equal((mutacao.data as { tipo: string }).tipo, "nao_suportado");
  const nav = await c.perguntar("Onde eu cadastro um pacote?", null);
  const dados = (nav.data as { dados: RespostaLeitura }).dados;
  assert.equal(dados.capacidade, "onde_encontrar");
  assert.equal(dados.itens[0].destino, "/admin/configuracoes/pacotes");
  assert.ok(!c.banco.consultas.some((sql) => sql.includes("FROM pagamento_parcelas")));
});

test("A1 ponta a ponta: conversa → Demerzel → intenção por modelo e explicação do Copiloto — o provedor nunca recebe CPF, e-mail, telefone ou nome", async () => {
  const roteiro = (pedido: PedidoModelo<unknown>) => (pedido.workload === "CLASSIFICAR_INTENCAO" ? JSON.stringify({ capacidade: "nenhuma", dia: null }) : explicaComDados(pedido));
  const c = conversaCopiloto({ roteiro });
  const zw = String.fromCharCode(0x200b);
  // Sem rota por regras ⇒ a Demerzel consulta o modelo de intenção (o caminho que o auditor reproduziu).
  await c.perguntar(`hmm, e aquele assunto${zw} da cliente, CPF 123.456.789-09, ana.lima@example.com, (11) 98765-4321?`, null);
  // Explicação do Copiloto sobre dados que contêm nome e CPF de cliente (Mariana Souza 123.456.789-00).
  await c.perguntar("Explique estes números");
  const workloads = c.provedor.chamadas.map((p) => p.workload);
  assert.ok(workloads.includes("CLASSIFICAR_INTENCAO"), "a intenção por modelo foi de fato chamada");
  assert.ok(workloads.includes("TEXTO_CURTO"), "a explicação foi de fato chamada");
  const enviado = JSON.stringify(c.provedor.chamadas.map((p) => p.mensagens));
  for (const proibido of ["123.456.789-09", "123.456.789-00", "ana.lima@example.com", "98765-4321", "Mariana", "Souza", zw]) {
    assert.equal(enviado.includes(proibido), false, proibido);
  }
});

// ---------------------------------------------------------------- A1 (reauditoria): U+2066 e RG em todos os caminhos

const LRI = String.fromCharCode(0x2066);
const PROIBIDOS_REAUDITORIA = [LRI, "123.456.789-09", "ana.lima", "example.com", "12.345.678-9", "23.456.789-X"];
const semReauditoria = (enviado: string, onde: string) => { for (const p of PROIBIDOS_REAUDITORIA) assert.equal(enviado.includes(p), false, `${onde}: ${JSON.stringify(p)}`); };

test("A1 reauditoria ponta a ponta: conversa → Demerzel → intenção por modelo com U+2066 no CPF/e-mail e RG pontuado — provedor recebe redigido", async () => {
  const roteiro = (pedido: PedidoModelo<unknown>) => (pedido.workload === "CLASSIFICAR_INTENCAO" ? JSON.stringify({ capacidade: "nenhuma", dia: null }) : explicaComDados(pedido));
  const c = conversaCopiloto({ roteiro });
  await c.perguntar(`hmm, aquele assunto: CPF 123${LRI}.456.789-09, ana${LRI}.lima@example.com, RG 12.345.678-9 e 23.456.789-X?`, null);
  assert.ok(c.provedor.chamadas.some((p) => p.workload === "CLASSIFICAR_INTENCAO"), "a intenção por modelo foi chamada");
  semReauditoria(JSON.stringify(c.provedor.chamadas.map((p) => p.mensagens)), "intenção");
});

test("A1 reauditoria: conteúdo ARMAZENADO hostil (fato com U+2066 no CPF, RG e instrução) vai ao provedor do Copiloto redigido", async () => {
  const tenant = { empresaComprovada: empresaA, membershipId: "m", usuarioId: "u", papelAtual: "ADMINISTRATIVO" } as never;
  const autorizado = construirContextoAutorizado({ sessao: { usuario_id: "u" }, tenant, contexto: null, capacidades: ["contratos_pendentes"] });
  const dados = leitura("atencao");
  const envenenado = { ...dados, fatos: [{ natureza: "FATO" as const, texto: `cliente cpf 123${LRI}.456.789-09, rg 12.345.678-9, e-mail ana${LRI}.lima@example.com`, fonte: "contratos" }] };
  const { json } = construirContextoModelo(autorizado, [{ empresaId: empresaA, capacidade: "contratos_pendentes", resposta: envenenado }], { finalidade: "EXPLICAR_DADOS" });
  const provedor = criarProvedorFake({ id: "OPENAI", roteiro: () => respostaFake(JSON.stringify({ frases: ["ok"] })) });
  let n = 0;
  const roteador = new RoteadorModelos({
    politica: politicaDoAmbiente({ AI_PROVIDER_PRIMARY: "OPENAI", AI_MODEL_MAX_RETRIES: "0" }), adaptadores: new Map([["OPENAI", provedor as AdaptadorProvedor]]), precos: null,
    orcamento: orcamentoDoAmbiente({ AI_BUDGET_JSON: JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 } }) }), registro: criarRegistroUsoEmMemoria(), circuito: new Circuito(),
    agora: () => new Date("2026-09-29T15:00:00Z"), relogio: () => performance.now(), novoId: () => `${String(++n).padStart(8, "0")}-0000-4000-8000-00000000000d`,
  });
  await roteador.executar({ workload: "TEXTO_CURTO", mensagens: [{ papel: "system", conteudo: "explique" }, { papel: "user", conteudo: json }], esquema: { nome: "x", schema: {} }, maxTokensSaida: 10, validar: (t) => JSON.parse(t) },
    { empresaId: empresaA, capacidade: "copiloto_explicar", correlationId: "c", hoje: "2026-09-29" });
  assert.equal(provedor.chamadas.length, 1);
  semReauditoria(JSON.stringify(provedor.chamadas[0].mensagens), "Copiloto (conteúdo armazenado)");
});
