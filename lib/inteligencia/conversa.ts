import { z } from "zod";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { AtencaoHoje } from "./atencao-hoje.ts";
import type { AcaoObjetivo, AIResponse, ContextoTela, ModelUsage, OrigemChamada, RecursoObjetivo, RespostaLeitura } from "./contratos.ts";
import type { CatalogoSkills, ClassificadorAuxiliar, Complementador, ContextoExtensao, FinalidadeSkill, ModuloAcoes, NivelSkill, Orquestrador, PortaModeloClassificacao, PortasOrquestracao, RegistroAgentes } from "./extensoes.ts";
import { construirContextoAutorizado, construirContextoModelo } from "./contexto/construtor.ts";
import { ContextoRecusado } from "./contexto/contrato.ts";
import { ferramentaRegistrada, ferramentas } from "./ferramentas.ts";
import { copilotoModeloAtivo, skillsEmpresaAtivas, demerzelAtivo, grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva, jevAtivo, jevModeloAtivo } from "./flags.ts";
import {
  classificar, comEstabelecimento, executarLeitura, exigirGrupoNaEmpresa, pedidoInvalido, recursoDesativado, unidadeDe,
  type DependenciasGateway, type PedidoGateway, type RespostaGateway,
} from "./gateway.ts";
import { explicarResposta, mensagemIndisponivel, mensagemNavegacaoSemDestino, mensagemPrecisaContexto, objetivoDaCapacidade, objetivoDoTexto } from "./entendimento.ts";
import { interpretarComModelo, interpretarDeterministico, pedeAutonomia, type CapacidadeCatalogo, type Intencao } from "./intencao.ts";
import type { RoteadorModelos } from "./modelos/roteador.ts";
import { avaliarPolitica } from "./politica.ts";
import { decidirPolitica } from "./politica-v1.ts";
import { SUGESTAO_POR_FINALIDADE, manifestoAcao, manifestoLeitura, manifestoSugestao } from "./registro-ferramentas.ts";
import { normalizar } from "./texto-pt.ts";
import { TELAS_NAVEGACAO, destinoSeguro, type TelaNavegacao } from "./rotas-navegacao.ts";
import { anotarOrquestracao, anotarSkill, anotarUsoModelo, novoRastreio, type RastreioInteligencia } from "./rastreio.ts";

/**
 * Orquestrador do drawer "Perguntar ao Kidmais".
 *
 * texto → intenção (regras; modelo só como fallback) → capacidade registrada → política →
 *   READ: mesma execução do gateway;
 *   CONFIRM: rascunho sob Human Gate, pelo módulo de ações (feature ACTIONS), que nunca executa aqui;
 *   DENY / sem capacidade / sem módulo de ações: resposta honesta, sem inventar ferramenta.
 *
 * Com uma orquestradora registrada (Demerzel) e AI_DEMERZEL_ENABLED=true, a decisão do caminho é dela, mas a
 * execução continua AQUI, pelas mesmas funções (portas): ela não recebe banco, tenant nem sessão.
 *
 * O CORE não importa a feature de ações: recebe um `ModuloAcoes` opcional por dependência.
 * Estado da conversa: só o rascunho persistido (Kidmais controla); nenhuma memória do modelo.
 */
export const LIMITE_TEXTO = 300;

const contextoSchema = z.object({
  tela: z.enum(["dashboard", "festa", "cliente", "contrato", "financeiro", "pacotes", "agenda", "configuracoes", "geral"]),
  entidadeId: z.string().uuid().optional(),
}).strict();

const pedidoSchema = z.object({
  texto: z.string().trim().min(1).max(LIMITE_TEXTO),
  contexto: contextoSchema.optional(),
  operacaoId: z.string().uuid().optional(),
}).strict();

export type DependenciasConversa = DependenciasGateway & {
  /** Null quando a feature de ações não está instalada: pedidos de ação respondem "ainda não". */
  acoes: ModuloAcoes | null;
  /** Null quando não há provedor configurado: só regras determinísticas. */
  roteador: RoteadorModelos | null;
  /** Classificador auxiliar (JEV), opcional: só sugere rota; indisponível ⇒ roteamento normal. */
  classificador?: ClassificadorAuxiliar | null;
  /** Orquestradora (Demerzel), opcional: decide o caminho com as mesmas portas; exige AI_DEMERZEL_ENABLED. */
  orquestrador?: Orquestrador | null;
  /** Catálogo de skills (playbooks), opcional: só forma e atendimento; resolvido com o tenant comprovado. */
  skills?: CatalogoSkills | null;
  /** Copiloto (próxima ação e explicação validada), opcional; só complementa leituras já autorizadas. */
  copiloto?: Complementador | null;
  /** Agentes (planos fechados sobre as mesmas portas), opcional. */
  agentes?: RegistroAgentes | null;
};

/** Teto de espera pelo classificador auxiliar: nunca atrasa a resposta além disso. */
export const LIMITE_AUXILIAR_MS = 800;

const MENSAGEM_FALLBACK = "Não foi possível responder agora. O restante do sistema continua disponível.";

/**
 * Papel para a política: o da membership comprovada nesta transação (UX/056, F1) — nunca o papel global da
 * sessão, que não é autoridade de empresa. Sem o Tenant Context do UX (estágio CORE sozinho), o da sessão.
 */
function papelParaPolitica(sessao: SessaoParaTenant, tenant: TenantComprovado): string {
  let papel = sessao.papel;
  papel = tenant.papelAtual; // @pr:UX
  return papel;
}

/** Catálogo que o operador pode usar agora: filtra por papel e flags; ações de tela ficam fora. */
export function catalogoDisponivel(env: DependenciasGateway["env"], papel: string, acoes: ModuloAcoes | null): CapacidadeCatalogo[] {
  const leituras = Object.values(ferramentas)
    .filter((f) => !SO_POR_REGRA.has(f.capacidade) && manifestoLeitura(f) !== null && grupoAtivo(env, f.grupo) && avaliarPolitica({ papel }, f, "LEITURA") === "PERMITIDO")
    .map((f): CapacidadeCatalogo => ({ id: f.capacidade, descricao: f.descricao, tipo: "leitura", ...(f.entidade ? { entidade: f.entidade } : {}) }));
  const doModulo = (acoes?.todas() ?? [])
    .filter((a) => a.origem !== "TELA" && manifestoAcao(a) !== null)
    .filter((a) => a.classe === "DENY" || (grupoAtivo(env, a.grupo) && avaliarPolitica({ papel }, a, "HUMAN_GATE") === "PERMITIDO"))
    .map((a): CapacidadeCatalogo => ({ id: a.capacidade, descricao: a.descricao, tipo: "acao" }));
  return [...leituras, ...doModulo];
}

/**
 * Navegação só por regra determinística (comando explícito + destino da lista fechada): nunca oferecida ao modelo
 * de intenção nem ao classificador auxiliar, que não escolhem tela.
 */
const CAPACIDADES_NAVEGACAO: ReadonlySet<string> = new Set(["abrir_tela", "abrir_festa"]);
/** Buscas com parâmetro extraído do texto (PR 4): só por regra; o modelo de intenção não as preenche. */
const SO_POR_REGRA: ReadonlySet<string> = new Set([...CAPACIDADES_NAVEGACAO, "buscar_clientes", "buscar_catalogo"]);

const SUGESTOES_PADRAO = ["O que precisa da minha atenção hoje?", "Quais contratos estão pendentes?", "Como está a agenda de hoje?", "Quanto recebemos este mês?"];

function naoSuportado(mensagem: string): AIResponse {
  return { tipo: "nao_suportado", mensagem, sugestoes: SUGESTOES_PADRAO };
}


/**
 * Regras → classificador auxiliar (JEV) → modelo. A sugestão do auxiliar só vale se for uma LEITURA do
 * catálogo que o operador pode usar agora (papel + flags) ou um encaminhamento a atendimento humano.
 * Sugestão de ação, capacidade fora do catálogo, erro ou demora ⇒ ignorada (fail-safe).
 */
async function consultarAuxiliar(texto: string, contexto: ContextoTela | null, sessao: SessaoParaTenant, deps: DependenciasConversa): Promise<Intencao | null> {
  const auxiliar = deps.classificador;
  if (!auxiliar || !jevAtivo(deps.env)) return null;
  const catalogo = catalogoDisponivel(deps.env, sessao.papel, deps.acoes).map((c) => ({ id: c.id, tipo: c.tipo }));
  const controle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<null>((ok) => { timer = setTimeout(() => { controle.abort(); ok(null); }, LIMITE_AUXILIAR_MS); });
  let resultado: Awaited<ReturnType<ClassificadorAuxiliar["sugerirRota"]>>;
  try {
    resultado = await Promise.race([auxiliar.sugerirRota(texto.slice(0, LIMITE_TEXTO), catalogo, controle.signal), limite]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const sugestao = resultado?.sugestao;
  if (!sugestao) return null;
  if (sugestao.tipo === "HUMANO") return { tipo: "revisao_humana" };
  if (sugestao.tipo !== "LEITURA") return null;
  const ferramenta = ferramentaRegistrada(sugestao.capacidade);
  if (!ferramenta || !catalogo.some((c) => c.id === sugestao.capacidade && c.tipo === "leitura")) return null;
  const origem = "INTENCAO_JEV" as const;
  if (ferramenta.entidade) {
    if (contexto?.tela === ferramenta.entidade && contexto.entidadeId) return { tipo: "leitura", capacidade: sugestao.capacidade, parametros: { id: contexto.entidadeId }, origem };
    return { tipo: "precisa_contexto", capacidade: sugestao.capacidade, entidade: ferramenta.entidade };
  }
  return { tipo: "leitura", capacidade: sugestao.capacidade, parametros: {}, origem };
}

/** Tenant comprovado numa transação curta, para chamadas de modelo (orçamento/uso por empresa), FORA de transação. */
async function tenantParaModelo(sessao: SessaoParaTenant, pedido: PedidoGateway, deps: DependenciasConversa, rastreio: RastreioInteligencia) {
  const tenant = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (_tx, comprovado) => comprovado);
  rastreio.empresaId = tenant.empresaComprovada;
  if (!grupoAtivoParaEmpresa(deps.env, "READ", tenant.empresaComprovada)) recursoDesativado();
  return tenant;
}

async function interpretarPorModelo(texto: string, contexto: ContextoTela | null, sessao: SessaoParaTenant, pedido: PedidoGateway, deps: DependenciasConversa, rastreio: RastreioInteligencia, usos: ModelUsage[]): Promise<Intencao | null> {
  if (!deps.roteador?.disponivelPara("CLASSIFICAR_INTENCAO")) return null;
  const tenant = await tenantParaModelo(sessao, pedido, deps, rastreio);
  const { intencao, roteado } = await interpretarComModelo(texto, contexto, catalogoDisponivel(deps.env, papelParaPolitica(sessao, tenant), deps.acoes), deps.roteador, {
    empresaId: tenant.empresaComprovada,
    estabelecimentoId: unidadeDe(tenant),
    capacidade: "classificar_intencao",
    correlationId: rastreio.correlationId ?? rastreio.requestId,
    hoje: hojeBrasilia(deps.agora()),
  });
  anotarUsoModelo(rastreio, roteado.usos);
  usos.push(...roteado.usos);
  return intencao;
}

async function resolverIntencao(texto: string, contexto: ContextoTela | null, sessao: SessaoParaTenant, pedido: PedidoGateway, deps: DependenciasConversa, rastreio: RastreioInteligencia): Promise<Intencao> {
  const deterministica = interpretarDeterministico(texto, contexto);
  if (deterministica.tipo !== "nenhuma") return deterministica;
  const auxiliar = await consultarAuxiliar(texto, contexto, sessao, deps);
  if (auxiliar) {
    rastreio.intencao = "INTENCAO_JEV";
    return auxiliar;
  }
  return (await interpretarPorModelo(texto, contexto, sessao, pedido, deps, rastreio, [])) ?? deterministica;
}

type Execucao = {
  texto: string;
  sessao: SessaoParaTenant;
  pedido: PedidoGateway;
  deps: DependenciasConversa;
  rastreio: RastreioInteligencia;
  contextoExtensao: (tx: ContextoExtensao["tx"], tenant: ContextoExtensao["tenant"]) => ContextoExtensao;
  contexto: ContextoTela | null;
  /** Comando de navegação sem destino único (PR 3), visto pelas regras: a finalização diz por quê. */
  navegacaoPendente?: Extract<Intencao, { tipo: "navegacao_sem_destino" }>;
};

/** Leitura pelo caminho único do gateway: registro fechado → flag → Policy → Tenant Context → serviço de domínio. */
async function responderLeitura(capacidade: string, parametros: Record<string, unknown>, origem: OrigemChamada, e: Execucao): Promise<AIResponse> {
  e.rastreio.intencao = origem;
  const ferramenta = ferramentaRegistrada(capacidade);
  if (!ferramenta) return naoSuportado("Essa análise ainda não está disponível no Kidmais.");
  const tela = CAPACIDADES_NAVEGACAO.has(capacidade) ? (capacidade === "abrir_festa" ? "festa" : String(parametros.tela ?? "")) as TelaNavegacao : null;
  let dados: Awaited<ReturnType<typeof executarLeitura>>;
  try {
    dados = await executarLeitura(ferramenta, parametros, e.sessao, e.pedido.empresaSolicitada, e.deps, e.rastreio);
  } catch (erro) {
    // Entidade de outra empresa / Policy: navegação negada (fail-closed); o erro segue o tratamento da conversa.
    if (tela) e.rastreio.navegacao = { recurso: TELAS_NAVEGACAO[tela]?.recurso ?? null, tela, resultado: "NEGADO", motivo: null };
    throw erro;
  }
  if (tela) return respostaDeNavegacao(tela, dados as unknown as RespostaLeitura, e.rastreio);
  return { tipo: "resposta", dados: dados as unknown as RespostaLeitura | AtencaoHoje };
}

/**
 * Leitura de navegação ⇒ resposta de navegação. O destino é REVALIDADO contra a lista fechada: qualquer coisa fora
 * dela (esquema, host, "..", rota desconhecida) é descartada e a resposta vira recusa, sem navegar.
 */
function respostaDeNavegacao(tela: TelaNavegacao, dados: RespostaLeitura, rastreio: RastreioInteligencia): AIResponse {
  const destino = dados.itens[0]?.destino;
  const alvo = TELAS_NAVEGACAO[tela];
  if (!alvo || !destinoSeguro(destino)) {
    rastreio.navegacao = { recurso: alvo?.recurso ?? null, tela: alvo ? tela : null, resultado: "DESTINO_INVALIDO", motivo: null };
    return naoSuportado("Não consegui abrir essa tela com segurança agora.");
  }
  rastreio.navegacao = { recurso: alvo.recurso, tela, resultado: "NAVEGADO", motivo: null };
  return { tipo: "navegacao", tela, recurso: alvo.recurso, destino, rotulo: alvo.rotulo, entendimento: "EXECUTADO", objetivo: `ABRIR:${alvo.recurso}` };
}

/** Ação: DENY/TELA/flag respondem honestamente; CONFIRM só abre rascunho sob Human Gate (nunca executa aqui). */
async function responderAcao(capacidade: string, origem: OrigemChamada, e: Execucao): Promise<AIResponse> {
  const { deps, rastreio } = e;
  rastreio.intencao = origem;
  rastreio.capacidade = capacidade;
  const acoes = deps.acoes;
  const acao = acoes?.descrever(capacidade) ?? null;
  let resposta: AIResponse;
  // Ação sem manifesto no Tool Registry não é oferecida (fail-closed), mesmo que o módulo a tenha registrado.
  if (!acoes || !acao || !manifestoAcao(acao)) {
    resposta = naoSuportado("Essa ação ainda não está disponível no Kidmais.");
  } else if (acao.origem === "TELA") {
    resposta = naoSuportado("Essa ação começa pela tela própria (por exemplo, Contratos › Importar contrato antigo).");
  } else if (acao.classe === "DENY") {
    rastreio.politica = "NEGADO_DENY";
    rastreio.humanGate = "RECUSADO";
    if (acao.indisponivel && !pedeAutonomia(normalizar(e.texto))) {
      // Entendido, mas o assistente ainda não faz: diz o que entendeu (nunca "não entendi"). Continua DENY.
      const doTexto = objetivoDoTexto(e.texto);
      const objetivo = objetivoDaCapacidade(capacidade);
      const [acaoCap, recursoCap] = (objetivo?.split(":") ?? []) as [AcaoObjetivo?, RecursoObjetivo?];
      const alvo = acaoCap && recursoCap && !doTexto.recurso ? { ...doTexto, acao: acaoCap, recurso: recursoCap } : doTexto;
      resposta = { ...naoSuportado(mensagemIndisponivel(alvo, acao.mensagemNegada ?? null)), entendimento: "CAPACIDADE_INDISPONIVEL" };
    } else if (pedeAutonomia(normalizar(e.texto))) {
      resposta = { ...naoSuportado("Nada é confirmado sozinho: toda ação do Kidmais passa pela sua confirmação na tela."), entendimento: "NEGADO_POLITICA" };
    } else {
      resposta = { ...naoSuportado(acao.mensagemNegada ?? "Essa ação não é feita pelo Kidmais."), entendimento: "NEGADO_POLITICA" };
    }
  } else if (!grupoAtivo(deps.env, acao.grupo)) {
    rastreio.politica = "NEGADO_FLAG";
    resposta = naoSuportado("Criar e alterar cadastros pelo Kidmais ainda não está liberado. Use a tela correspondente.");
  } else {
    rastreio.ferramenta = acao.ferramenta;
    rastreio.ferramentasSolicitadas = [...rastreio.ferramentasSolicitadas, acao.ferramenta];
    resposta = await deps.withTenantTransaction(e.sessao, e.pedido.empresaSolicitada, async (tx, tenant) => {
      rastreio.empresaId = tenant.empresaComprovada;
      rastreio.politica = avaliarPolitica({ papel: papelParaPolitica(e.sessao, tenant) }, acao, "HUMAN_GATE");
      if (!grupoAtivoParaEmpresa(deps.env, acao.grupo, tenant.empresaComprovada)) {
        return naoSuportado("Criar e alterar cadastros pelo Kidmais ainda não está liberado para esta empresa.");
      }
      return (await acoes.iniciar(acao.capacidade, e.texto, e.contextoExtensao(tx, tenant))).resposta;
    });
    rastreio.humanGate = resposta.tipo === "preview" ? "PREVIEW" : resposta.tipo === "rascunho" ? "RASCUNHO" : null;
    if (rastreio.humanGate) rastreio.propostaAcao = acao.capacidade;
  }
  rastreio.estado = resposta.tipo;
  return resposta;
}

/**
 * Estado de entendimento + objetivo em TODA resposta e no trace (inclusive pedido de contexto e recusa). Só troca o
 * "não sei" genérico pelo que foi entendido; nunca cria rota, leitura ou ação.
 */
/** Resposta honesta a um comando de abrir sem destino único. Nunca escolhe um destino por conta própria. */
function semDestino(n: Extract<Intencao, { tipo: "navegacao_sem_destino" }>): AIResponse {
  return {
    ...naoSuportado(mensagemNavegacaoSemDestino(n.recurso, n.motivo)),
    entendimento: n.motivo === "AMBIGUO" ? "AMBIGUO" : "CAPACIDADE_INDISPONIVEL",
    objetivo: `ABRIR:${n.recurso}`,
  };
}

function finalizar(resposta: AIResponse, texto: string, rastreio: RastreioInteligencia, pendente?: Execucao["navegacaoPendente"]): AIResponse {
  // Demerzel devolveu o "não sei" genérico para um comando de abrir já entendido pelas regras.
  if (pendente && resposta.tipo === "nao_suportado" && !resposta.entendimento) resposta = semDestino(pendente);
  const capacidade = rastreio.capacidade
    ?? (resposta.tipo === "resposta" && "capacidade" in resposta.dados ? resposta.dados.capacidade : null)
    ?? (resposta.tipo === "rascunho" || resposta.tipo === "preview" ? resposta.rascunho.capacidade : null);
  const final = explicarResposta(resposta, texto, capacidade, { parada: rastreio.orquestracao?.parada ?? null, politica: rastreio.politica });
  rastreio.entendimento = final.entendimento ?? null;
  rastreio.objetivo = final.objetivo ?? null;
  // Comando de abrir sem destino único: registra por quê (ambíguo ou referência ainda não resolvida).
  if (!rastreio.navegacao && final.tipo !== "navegacao" && final.objetivo?.startsWith("ABRIR:")) {
    rastreio.navegacao = { recurso: final.objetivo.split(":")[1] as RecursoObjetivo, tela: null, resultado: final.entendimento === "AMBIGUO" ? "AMBIGUO" : "SEM_DESTINO", motivo: final.entendimento ?? null };
  }
  return final;
}

/** Caminho da Foundation: a intenção resolvida define a resposta, sempre pelas mesmas funções guardadas. */
async function responderIntencao(intencao: Intencao, contexto: ContextoTela | null, e: Execucao): Promise<AIResponse> {
  const { rastreio } = e;
  if (intencao.tipo === "revisao_humana") {
    rastreio.estado = "revisao_humana";
    return naoSuportado("Esse pedido precisa de uma pessoa da equipe. Encaminhe pelo atendimento; o Kidmais não responde nem age sozinho neste caso.");
  }
  if (intencao.tipo === "nenhuma") {
    rastreio.estado = "nao_suportado";
    return naoSuportado("Ainda não sei responder isso pelo Kidmais. Veja o que consigo fazer agora:");
  }
  if (intencao.tipo === "precisa_contexto") {
    rastreio.capacidade = intencao.capacidade;
    rastreio.estado = "precisa_contexto";
    return { tipo: "precisa_contexto", mensagem: mensagemPrecisaContexto(intencao.entidade) };
  }
  if (intencao.tipo === "leitura") return responderLeitura(intencao.capacidade, intencao.parametros, intencao.origem, e);
  if (intencao.tipo === "navegacao_sem_destino") {
    // Sem destino único: diz o que foi entendido (ambíguo ou referência ainda não resolvida); nunca escolhe.
    rastreio.estado = "nao_suportado";
    return semDestino(intencao);
  }
  void contexto;
  return responderAcao(intencao.capacidade, intencao.origem, e);
}

/**
 * Portas da orquestradora: as mesmas funções guardadas da conversa. A orquestradora escolhe o caminho;
 * Policy, Tenant Context, registro fechado e Human Gate continuam aqui.
 */
function portasOrquestracao(e: Execucao, usos: ModelUsage[]): PortasOrquestracao {
  const { deps, sessao, pedido, rastreio } = e;
  let portaJev: Promise<PortaModeloClassificacao | null> | null = null;
  // Tenant comprovado uma vez por pedido, para porta de modelo e resolução de skills.
  let tenantPedido: ReturnType<typeof tenantParaModelo> | null = null;
  const tenant = () => (tenantPedido ??= tenantParaModelo(sessao, pedido, deps, rastreio));
  return {
    catalogo: catalogoDisponivel(deps.env, sessao.papel, deps.acoes),
    interpretar: (texto, contexto) => {
      const intencao = interpretarDeterministico(texto, contexto);
      if (intencao.tipo === "navegacao_sem_destino") e.navegacaoPendente = intencao;
      return intencao;
    },
    sugerirRota: (texto, contexto) => consultarAuxiliar(texto, contexto, sessao, deps),
    interpretarComModelo: (texto, contexto) => interpretarPorModelo(texto, contexto, sessao, pedido, deps, rastreio, usos),
    portaModelo() {
      const roteador = deps.roteador;
      if (!roteador || !jevModeloAtivo(deps.env) || !roteador.disponivelPara("CLASSIFICAR_INTENCAO")) return Promise.resolve(null);
      portaJev ??= tenant().then((comprovado): PortaModeloClassificacao => ({
        disponivel: () => roteador.disponivelPara("CLASSIFICAR_INTENCAO"),
        async executar(pedidoModelo) {
          const r = await roteador.executar(pedidoModelo, {
            empresaId: comprovado.empresaComprovada,
            estabelecimentoId: unidadeDe(comprovado),
            capacidade: "jev_julgar",
            correlationId: rastreio.correlationId ?? rastreio.requestId,
            hoje: hojeBrasilia(deps.agora()),
          });
          anotarUsoModelo(rastreio, r.usos);
          usos.push(...r.usos);
          return r;
        },
      }));
      return portaJev;
    },
    ler: (capacidade, parametros, origem) => responderLeitura(capacidade, parametros, origem, e),
    propor: (capacidade, _texto, origem) => responderAcao(capacidade, origem, e),
    descreverAcao: (capacidade) => deps.acoes?.descrever(capacidade) ?? null,
    usosDeModelo: () => usos,
    registrarResumo: (resumo) => anotarOrquestracao(rastreio, resumo),
    skill: (finalidade, capacidade) => skill(finalidade, capacidade),
    async complementar(resposta, opcoes) {
      const copiloto = deps.copiloto ?? null;
      if (!copiloto || resposta.tipo !== "resposta") return resposta;
      const dados = resposta.dados;
      const capacidade = "capacidade" in dados ? dados.capacidade : "atencao_hoje";
      const comprovado = await tenant();
      // Explicação por modelo: só sobre o contexto do Context Builder, montado com o tenant comprovado e com o
      // bloco marcado com a empresa em que a leitura foi FEITA. Divergência ⇒ recusa ⇒ sem explicação (fail-closed).
      let contextoModelo: ReturnType<typeof construirContextoModelo> | null = null;
      let modelo: PortaModeloClassificacao | null = null;
      if (opcoes.explicar && "fatos" in dados && deps.roteador && copilotoModeloAtivo(deps.env) && deps.roteador.disponivelPara("TEXTO_CURTO")) {
        try {
          const autorizado = construirContextoAutorizado({ sessao, tenant: comprovado, contexto: e.contexto, capacidades: catalogoDisponivel(deps.env, comprovado.papelAtual, deps.acoes).filter((c) => c.tipo === "leitura").map((c) => c.id) });
          contextoModelo = construirContextoModelo(autorizado, [{ empresaId: rastreio.empresaId ?? "", estabelecimentoId: rastreio.estabelecimentoId ?? null, capacidade: dados.capacidade, resposta: dados }], { finalidade: "EXPLICAR_DADOS" });
        } catch (erro) {
          if (!(erro instanceof ContextoRecusado)) throw erro;
          contextoModelo = null;
        }
        const roteador = deps.roteador;
        if (contextoModelo) {
          modelo = {
            disponivel: () => roteador.disponivelPara("TEXTO_CURTO"),
            async executar(pedidoModelo) {
              const r = await roteador.executar(pedidoModelo, { empresaId: comprovado.empresaComprovada, estabelecimentoId: unidadeDe(comprovado), capacidade: "copiloto_explicar", correlationId: rastreio.correlationId ?? rastreio.requestId, hoje: hojeBrasilia(deps.agora()) });
              anotarUsoModelo(rastreio, r.usos);
              usos.push(...r.usos);
              return r;
            },
          };
        }
      }
      const procedimento = await skill("PROCEDIMENTO", capacidade);
      const complemento = await copiloto.complementar({ capacidade, dados, contextoModelo, procedimento, explicar: opcoes.explicar, modelo });
      return complemento ? { ...resposta, complemento } : resposta;
    },
    agentes: deps.agentes ?? null,
    async marcadores() {
      // Só a entidade aberta na tela, lida pelo domínio no tenant comprovado (outra empresa ⇒ inexistente).
      const porta = deps.portas?.clientes ?? null;
      const id = e.contexto?.tela === "cliente" ? e.contexto.entidadeId : undefined;
      if (!porta || !id) return {};
      const cliente = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, comprovado) => {
        // Mesmo dado de `resumir_cliente`: mesma Policy V1 (manifesto, papel da membership, flag e allowlist).
        // Negada ⇒ nenhum marcador (o rascunho fica com pendências), nunca leitura por fora do registro.
        const manifesto = manifestoLeitura(ferramentas.resumir_cliente);
        const decisao = decidirPolitica({
          papel: comprovado.papelAtual, manifesto, caminho: "LEITURA", origem: "INTENCAO_DETERMINISTICA",
          grupoAtivo: grupoAtivo(deps.env, ferramentas.resumir_cliente.grupo),
          grupoAtivoNaEmpresa: grupoAtivoParaEmpresa(deps.env, ferramentas.resumir_cliente.grupo, comprovado.empresaComprovada),
        });
        return decisao === "PERMITIDO" ? porta.obter(tx, comprovado.empresaComprovada, id) : null;
      });
      if (!cliente) return {};
      const aniversariante = cliente.aniversariantes.find((a) => a.ativo)?.nome;
      return { nome_cliente: cliente.cliente.nomeCompleto, ...(aniversariante ? { nome_aniversariante: aniversariante } : {}) };
    },
    relogio: deps.relogio ?? (() => performance.now()),
  };

  async function skill(finalidade: FinalidadeSkill, capacidade: string | null) {
    const catalogo = deps.skills ?? null;
    if (!catalogo) return null;
    const comprovado = await tenant();
    // SUGGEST (rascunho, objeção, próxima ação): Policy V1 com o papel da membership e a allowlist da empresa.
    const sugestao = Object.hasOwn(SUGESTAO_POR_FINALIDADE, finalidade) ? SUGESTAO_POR_FINALIDADE[finalidade] : null;
    if (sugestao) {
      const manifesto = manifestoSugestao(sugestao);
      const grupo = manifesto && manifesto.grupoExigido !== "NENHUM" ? manifesto.grupoExigido : null;
      const decisao = decidirPolitica({
        papel: comprovado.papelAtual, manifesto, caminho: "SUGESTAO", origem: "INTENCAO_DETERMINISTICA",
        grupoAtivo: grupo !== null && grupoAtivo(deps.env, grupo),
        grupoAtivoNaEmpresa: grupo !== null && grupoAtivoParaEmpresa(deps.env, grupo, comprovado.empresaComprovada),
      });
      if (decisao !== "PERMITIDO") return null;
    }
    // Override de estabelecimento só com unidade COMPROVADA no Tenant Context (nunca a do texto ou do modelo).
    // Camadas permitidas pela Policy: plataforma sempre; empresa com AI_SKILLS_EMPRESA_ENABLED + allowlist da empresa;
    // estabelecimento só com isso E unidade comprovada. A resolução é Plataforma → Empresa → Estabelecimento.
    const unidade = unidadeDe(comprovado);
    const empresaLiberada = skillsEmpresaAtivas(deps.env) && grupoAtivoParaEmpresa(deps.env, "READ", comprovado.empresaComprovada);
    const niveis: NivelSkill[] = ["PLATAFORMA", ...(empresaLiberada ? ["EMPRESA" as const] : []), ...(empresaLiberada && unidade ? ["ESTABELECIMENTO" as const] : [])];
    const aplicada = await catalogo.resolver({ empresaId: comprovado.empresaComprovada, estabelecimentoId: unidade, finalidade, capacidade, niveis });
    if (aplicada) anotarSkill(e.rastreio, `${aplicada.id}@${aplicada.versao}#${aplicada.hash.slice(0, 8)}`);
    return aplicada;
  }
}

export async function atenderConversa(pedido: PedidoGateway, deps: DependenciasConversa): Promise<RespostaGateway> {
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const rastreio = novoRastreio("inteligencia.conversa", deps.requestId());
  try {
    if (!inteligenciaAtiva(deps.env) || !grupoAtivo(deps.env, "READ")) recursoDesativado();
    const sessao = await deps.autenticar();
    rastreio.usuarioId = sessao.usuario_id;
    // Establishment Context: unidade pedida pela tela é provada em TODA transação de tenant deste pedido.
    deps = comEstabelecimento(deps, pedido, rastreio);
    let entrada: z.infer<typeof pedidoSchema>;
    try {
      entrada = pedidoSchema.parse(await pedido.lerCorpo());
    } catch (error) {
      pedidoInvalido(error);
    }
    const contextoExtensao = (tx: ContextoExtensao["tx"], tenant: ContextoExtensao["tenant"]): ContextoExtensao => ({ tx, tenant, sessao, correlationId: rastreio.correlationId ?? rastreio.requestId });

    // Continuação de rascunho: a resposta do operador só edita o rascunho do próprio tenant e usuário.
    if (entrada.operacaoId) {
      const acoes = deps.acoes;
      if (!acoes || !grupoAtivo(deps.env, "ADMIN_ACTIONS")) recursoDesativado();
      rastreio.intencao = "UI";
      const operacaoId = entrada.operacaoId;
      const resultado = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
        rastreio.empresaId = tenant.empresaComprovada;
        exigirGrupoNaEmpresa(deps.env, "ADMIN_ACTIONS", tenant);
        return acoes.responder(operacaoId, entrada.texto, contextoExtensao(tx, tenant));
      });
      rastreio.capacidade = resultado.capacidade;
      rastreio.ferramenta = resultado.ferramenta;
      rastreio.ferramentasSolicitadas = [resultado.ferramenta];
      rastreio.humanGate = resultado.resposta.tipo === "preview" ? "PREVIEW" : "RASCUNHO";
      rastreio.estado = resultado.resposta.tipo;
      return { status: 200, corpo: { ok: true, data: finalizar(resultado.resposta, entrada.texto, rastreio) } };
    }

    const contexto = entrada.contexto ?? null;
    const execucao: Execucao = { texto: entrada.texto, sessao, pedido, deps, rastreio, contextoExtensao, contexto };

    // Orquestradora (Demerzel): decide o caminho com as mesmas portas guardadas. Qualquer erro dela cai no
    // fallback seguro abaixo — nunca no caminho sem guardas.
    const orquestrador = deps.orquestrador ?? null;
    if (orquestrador && demerzelAtivo(deps.env)) {
      const { resposta } = await orquestrador.atender({ texto: entrada.texto, contexto }, portasOrquestracao(execucao, []));
      rastreio.estado ??= resposta.tipo;
      return { status: 200, corpo: { ok: true, data: finalizar(resposta, entrada.texto, rastreio, execucao.navegacaoPendente) } };
    }

    const intencao = await resolverIntencao(entrada.texto, contexto, sessao, pedido, deps, rastreio);
    const resposta = await responderIntencao(intencao, contexto, execucao);
    return { status: 200, corpo: { ok: true, data: finalizar(resposta, entrada.texto, rastreio) } };
  } catch (error) {
    const falha = classificar(error, MENSAGEM_FALLBACK);
    rastreio.resultado = falha.resultado;
    rastreio.codigo = falha.codigo;
    rastreio.causa = falha.causa;
    rastreio.fallback = rastreio.fallback || falha.fallback;
    // Tenant Context / Policy / entidade de outra empresa: recusa fail-closed, registrada como tal.
    rastreio.entendimento = falha.status === 401 || falha.status === 403 || falha.status === 404 ? "NEGADO_POLITICA" : null;
    rastreio.objetivo ??= objetivoDaCapacidade(rastreio.capacidade) ?? (rastreio.navegacao?.recurso ? `ABRIR:${rastreio.navegacao.recurso}` : null);
    return { status: falha.status, corpo: { ok: false, erro: falha.erro, codigo: falha.codigo } };
  } finally {
    rastreio.duracaoMs = Math.max(0, Math.round(relogio() - inicio));
    try {
      deps.registrar(rastreio);
    } catch {
      // O trace nunca derruba a resposta.
    }
  }
}
