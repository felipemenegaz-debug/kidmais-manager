import { z } from "zod";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { hojeBrasilia } from "../financeiro/calculos.ts";
import type { AtencaoHoje } from "./atencao-hoje.ts";
import type { AcaoObjetivo, AIResponse, ContinuacaoConsumo, ContextoTela, EntidadeRef, TipoEntidade, ModelUsage, OrigemChamada, OrigemPlano, PlanoRastreio, RecursoObjetivo, RespostaLeitura } from "./contratos.ts";
import { atualizarFoco, focoEntradaSchema, type EntidadeFoco, type FocoConversa, type FocoEntrada, type OrigemFoco } from "./foco.ts";
import { detectarReferencia, entidadesCitadas, resolverAncoraContexto, resolverReferencia, type Leitor, type Referencia, type Resolucao } from "./referencias.ts";
import { compor, faltando, fatosSolicitados, type FatoSolicitado } from "./planejador/composicao.ts";
import { FORNECEDORES, completarPlano } from "./planejador/completar.ts";
import { executarPlano, resultadoFinal, type LerPlano, type ParteResposta } from "./planejador/executor.ts";
import { planejarComModelo } from "./planejador/modelo.ts";
import { VERSAO_PLANEJADOR, validarPlano, type Plano } from "./planejador/plano.ts";
import { planejarPorRegras } from "./planejador/regras.ts";
import type { CatalogoSkills, ClassificadorAuxiliar, Complementador, ContextoExtensao, FinalidadeSkill, ModuloAcoes, NivelSkill, Orquestrador, PortaModeloClassificacao, PortaPlanejador, PortasOrquestracao, RegistroAgentes, SaidaPlanejador, SituacaoRascunho } from "./extensoes.ts";
import { construirContextoAutorizado, construirContextoModelo } from "./contexto/construtor.ts";
import { ContextoRecusado } from "./contexto/contrato.ts";
import { CAPACIDADES_OPERACIONAIS, ferramentaRegistrada, ferramentas } from "./ferramentas.ts";
import { ROTULO_PENDENTE, parametrosEscritosConsumo } from "./leituras/operacional.ts";
import { CATEGORIAS_CONSUMO, detectarConsumo, extrairParametros, respondeSemDado, type CategoriaConsumo, type ParametrosConsumo } from "./operacional/consumo.ts";
import { coordenarRascunho, type DecisaoRascunho } from "./operacional/objetivo.ts";
import { LIMITE_HISTORICO as LIMITE_HISTORICO_LUNA, VERSAO_LUNA, entenderComModelo, type Categoria, type ConsumoPendente, type Entendimento, type RascunhoParaLuna, type TrocaHistorico } from "./luna/entendimento.ts";
import { redigirComModelo } from "./luna/redacao.ts";
import type { PassoPlano } from "./planejador/plano.ts";
import { copilotoModeloAtivo, skillsEmpresaAtivas, demerzelAtivo, grupoAtivo, grupoAtivoParaEmpresa, inteligenciaAtiva, jevAtivo, jevModeloAtivo, operacionalAtivo } from "./flags.ts";
import {
  classificar, comEstabelecimento, executarLeitura, exigirGrupoNaEmpresa, pedidoInvalido, recursoDesativado, unidadeDe,
  type DependenciasGateway, type PedidoGateway, type RespostaGateway,
} from "./gateway.ts";
import { explicarResposta, mensagemIndisponivel, mensagemNavegacaoSemDestino, mensagemPrecisaContexto, objetivoDaCapacidade, objetivoDoTexto } from "./entendimento.ts";
import { criacaoAmbigua, interpretarComModelo, interpretarDeterministico, pedeAutonomia, type CapacidadeCatalogo, type Intencao } from "./intencao.ts";
import type { ResultadoRoteado, RoteadorModelos } from "./modelos/roteador.ts";
import { InteligenciaError, avaliarPolitica } from "./politica.ts";
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
  /** AI V1.1 (PR 5): foco da conversa reenviado pela UI — só DICA (tipo + id), sempre revalidada no servidor. */
  foco: focoEntradaSchema.optional(),
  /**
   * IA operacional: continuação de uma pergunta de parâmetro (ex.: "Quantos docinhos por convidado…?"). Só DICA: categoria
   * fechada e números já escritos pelo operador. Pergunta com várias categorias: TODAS as categorias da pergunta e os
   * números já escritos de cada uma seguem juntos. A festa da pergunta segue como `festaId` e é revalidada no Core a
   * cada pedido (vale mais que a tela aberta, que pode ser outra festa).
   */
  continuacao: z.object({
    tipo: z.literal("PARAMETRO_CONSUMO"),
    categoria: z.enum(CATEGORIAS_CONSUMO),
    perguntado: z.enum(["POR_CONVIDADO", "ML_POR_CONVIDADO", "EMBALAGEM"]),
    parametros: parametrosEscritosConsumo.optional(),
    categorias: z.array(z.enum(CATEGORIAS_CONSUMO)).min(2).max(CATEGORIAS_CONSUMO.length).optional(),
    informados: z.object({ DOCES: parametrosEscritosConsumo, REFRIGERANTES: parametrosEscritosConsumo }).partial().strict().optional(),
    festaId: z.string().uuid().optional(),
  }).strict()
    .refine((c) => !c.categorias || (new Set(c.categorias).size === c.categorias.length && c.categorias.includes(c.categoria)), "categorias")
    .refine((c) => !c.informados?.[c.categoria], "informados")
    .optional(),
  /**
   * Conversa adaptativa: últimas trocas mostradas na tela (pergunta do usuário + resumo da resposta). Só CONTEXTO para a
   * Luna entender elipses e correções: nunca é fonte de fatos, autorização, tenant ou conteúdo de rascunho.
   */
  historico: z.array(z.object({ pergunta: z.string().max(LIMITE_TEXTO), resposta: z.string().max(LIMITE_TEXTO) }).strict()).max(LIMITE_HISTORICO_LUNA).optional(),
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
    .filter((f) => !CAPACIDADES_OPERACIONAIS.has(f.capacidade) || operacionalAtivo(env))
    .map((f): CapacidadeCatalogo => ({ id: f.capacidade, descricao: f.descricao, tipo: "leitura", ...(f.entidade ? { entidade: f.entidade } : {}), ...((manifestoLeitura(f)?.produz.length ?? 0) ? { produz: manifestoLeitura(f)!.produz } : {}) }));
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
/** Só como passo de plano (IA operacional): exige categoria + festa vinda do Core; o classificador nunca a escolhe. */
const SO_PLANO: ReadonlySet<string> = new Set(["calcular_consumo"]);
const paraClassificador = (catalogo: CapacidadeCatalogo[]) => catalogo.filter((c) => !SO_PLANO.has(c.id));

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
  const catalogo = paraClassificador(catalogoDisponivel(deps.env, sessao.papel, deps.acoes)).map((c) => ({ id: c.id, tipo: c.tipo }));
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
  const { intencao, roteado } = await interpretarComModelo(texto, contexto, paraClassificador(catalogoDisponivel(deps.env, papelParaPolitica(sessao, tenant), deps.acoes)), deps.roteador, {
    empresaId: tenant.empresaComprovada,
    estabelecimentoId: unidadeDe(tenant),
    capacidade: "classificar_intencao",
    correlationId: rastreio.correlationId ?? rastreio.requestId,
    hoje: hojeBrasilia(deps.agora()),
  });
  anotarUsoModelo(rastreio, roteado.usos, roteado.ok ? undefined : roteado.recusa);
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
  /** Foco reenviado pela UI (dica). */
  foco: FocoEntrada | null;
  /** Referência resolvida pelo Planner/Resolver (PR 5/6), para o foco e o trace. */
  resolucao?: Resolucao;
  /** PR 6.4: resultados completos dos passos marcados `resposta`, para compor a resposta de leitura. */
  partesPlano?: ParteResposta[];
  /** IA operacional: pergunta de quantidade (categoria + parâmetros ESCRITOS neste pedido, só para este cálculo). */
  consumo?: {
    categorias: CategoriaConsumo[];
    parametros: Partial<Record<CategoriaConsumo, ParametrosConsumo>>;
    festaId?: string;
    /** Estimativa PEDIDA pelo usuário (hipótese só desta consulta), por categoria. */
    estimativa?: Partial<Record<CategoriaConsumo, { porConvidado?: number; mlPorConvidado?: number }>>;
    /** Festa que a Luna entendeu ("a próxima", "do dia 15/11"); sem ela, a do texto/continuação/tela. */
    festaRef?: { tipo: "PROXIMA" } | { tipo: "DIA"; dia: string };
  };
  /** IA operacional: a `ler` do plano em curso (contada pela orquestradora), para os complementos depois da execução. */
  lerPlano?: LerPlano;
  /** IA operacional: a orquestradora vai tentar o Planner por modelo se as regras não ancorarem o pedido. */
  planejadorModelo?: boolean;
  /** Conversa adaptativa: o que a Luna entendeu (revalidado). Presente ⇒ as regras não decidem sozinhas. */
  luna?: Entendimento;
  /** Leituras de negócio feitas neste pedido (todas as rotas), para o teto do ciclo adaptativo. */
  leiturasFeitas?: number;
};

/** Leitura pelo caminho único do gateway: registro fechado → flag → Policy → Tenant Context → serviço de domínio. */
async function responderLeitura(capacidade: string, parametros: Record<string, unknown>, origem: OrigemChamada, e: Execucao): Promise<AIResponse> {
  e.rastreio.intencao = origem;
  const ferramenta = ferramentaRegistrada(capacidade);
  if (!ferramenta) return naoSuportado("Essa análise ainda não está disponível no Kidmais.");
  // IA operacional: os parâmetros que o operador ESCREVEU entram só no cálculo (schema estrito da ferramenta valida).
  if (capacidade === "calcular_consumo" && e.consumo) {
    const categoria = parametros.categoria as CategoriaConsumo | undefined;
    const escritos = categoria ? e.consumo.parametros[categoria] : undefined;
    if (escritos) parametros = { ...parametros, ...escritos };
    const estimada = categoria ? e.consumo.estimativa?.[categoria] : undefined;
    if (estimada && Object.keys(estimada).length) parametros = { ...parametros, estimativa: estimada };
  }
  e.leiturasFeitas = (e.leiturasFeitas ?? 0) + 1;
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
async function responderAcao(capacidade: string, origem: OrigemChamada, e: Execucao, doModelo?: Readonly<Record<string, unknown>>): Promise<AIResponse> {
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
      return (await acoes.iniciar(acao.capacidade, e.texto, e.contextoExtensao(tx, tenant), doModelo)).resposta;
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

// ---------------------------------------------------------------- PR 5: referências e foco

/**
 * Leituras que uma pergunta FINANCEIRA com referência (festa/contrato) pode estreitar: as da empresa inteira e os
 * resumos padrão da tela ("quanto falta pagar?" na tela do contrato/festa pede o saldo, não o resumo).
 */
const LEITURAS_ESTREITAVEIS: ReadonlySet<string> = new Set(["analisar_recebiveis", "proxima_parcela", "atencao_hoje", "resumir_contrato", "resumir_festa", "pendencias_da_festa"]);

const ACOES_DE_MUTACAO = new Set(["CRIAR", "EDITAR", "EXCLUIR", "ENVIAR", "REGISTRAR", "CANCELAR"]);
/** IA operacional: leituras das regras que, num pedido de convidados/buffet com referência, são só a âncora. */
const ANCORAS_OPERACIONAIS: ReadonlySet<string> = new Set(["agenda_do_dia", "proximas_festas", "resumir_festa", "atencao_hoje"]);

/** Entidade resolvida ⇒ intenção pelas mesmas ferramentas guardadas (leitura do resumo ou navegação). */
function intencaoPara(entidade: EntidadeRef, texto: string, financeiro?: "SALDO" | "PARCELA"): Intencao | null {
  const acao = objetivoDoTexto(texto).acao;
  const origem: OrigemChamada = "INTENCAO_DETERMINISTICA";
  // Pergunta financeira sobre a entidade referida: a posição oficial do CONTRATO dela (PR 5.5).
  if (financeiro) return entidade.tipo === "CONTRATO" ? { tipo: "leitura", capacidade: financeiro === "SALDO" ? "saldo_contrato" : "proxima_parcela", parametros: { id: entidade.id }, origem } : null;
  if (acao && ACOES_DE_MUTACAO.has(acao)) return null; // Mutação segue o caminho atual (Human Gate/indisponível).
  if (acao === "ABRIR") {
    if (entidade.tipo === "FESTA") return { tipo: "leitura", capacidade: "abrir_festa", parametros: { id: entidade.id }, origem };
    if (entidade.tipo === "CLIENTE" || entidade.tipo === "CONTRATO") return { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: entidade.tipo === "CLIENTE" ? "cliente" : "contrato", id: entidade.id }, origem };
    return { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "catalogo" }, origem };
  }
  const resumo = { FESTA: "resumir_festa", CLIENTE: "resumir_cliente", CONTRATO: "resumir_contrato" } as const;
  const capacidade = (resumo as Partial<Record<string, string>>)[entidade.tipo];
  return capacidade ? { tipo: "leitura", capacidade, parametros: { id: entidade.id }, origem } : null;
}

const PLURAL: Readonly<Record<string, string>> = { FESTA: "festas", CLIENTE: "clientes", CONTRATO: "contratos", ITEM: "itens", CATEGORIA: "categorias" };
const NOME: Readonly<Record<string, string>> = { FESTA: "festa", CLIENTE: "cliente", CONTRATO: "contrato", ITEM: "item", CATEGORIA: "categoria" };

function respostaDaResolucao(r: Resolucao): AIResponse | null {
  const ref = r.referencia;
  if (r.resultado === "AMBIGUA") {
    const tipo = r.candidatos[0]?.tipo ?? "FESTA";
    const onde = ref.temporal ? ` para ${ref.temporal.rotulo.replace(/^(a |festa de )/, "")}` : "";
    const lista = r.candidatos.slice(0, 5).map((c, i) => `${i + 1}. ${c.rotulo}`).join("\n");
    return { ...naoSuportado(`Encontrei ${r.candidatos.length} ${PLURAL[tipo]}${onde}:\n${lista}\nQual ${tipo === "FESTA" || tipo === "CATEGORIA" ? "delas" : "deles"}?`), entendimento: "AMBIGUO" };
  }
  if (r.resultado === "NEGADA") {
    return { ...naoSuportado("Não consegui usar essa referência: ela não está disponível para você nesta empresa."), entendimento: "NEGADO_POLITICA" };
  }
  if (r.resultado === "NAO_ENCONTRADA") {
    if (ref.temporal && !r.ancora) return { ...naoSuportado(`Não encontrei ${ref.temporal.rotulo.startsWith("a ") ? ref.temporal.rotulo : `a ${ref.temporal.rotulo}`} registrada.`), entendimento: "EXECUTADO" };
    if (ref.tipo === "NOME") return { ...naoSuportado("Não encontrei cliente com esse nome nesta empresa."), entendimento: "EXECUTADO" };
    if (r.ancora && ref.alvo) return { ...naoSuportado(`Não encontrei ${NOME[ref.alvo]} vinculado a ${r.ancora.rotulo}.`), entendimento: "EXECUTADO" };
    return { ...naoSuportado(`Não sei a qual ${ref.alvo ? NOME[ref.alvo] : "registro"} você se refere. Diga qual é ou abra o registro na tela e pergunte por ali.`), entendimento: "PRECISA_DADO" };
  }
  return null;
}

/**
 * Leituras de ESTA conversa como o Planner/Resolver as veem: só `RespostaLeitura` (com entidades do Core), e a mesma
 * leitura (capacidade + parâmetros) nunca é feita duas vezes no pedido — revalidar a âncora e ler as relações dela
 * é uma leitura só.
 */
function leitorMemoizado(ler: LerPlano): { leitor: Leitor; ler: LerPlano } {
  const feitas = new Map<string, Promise<AIResponse>>();
  const lerUmaVez: LerPlano = (capacidade, parametros) => {
    const chave = `${capacidade}:${JSON.stringify(parametros)}`;
    let r = feitas.get(chave);
    if (!r) {
      r = ler(capacidade, parametros);
      feitas.set(chave, r);
    }
    return r;
  };
  const leitor: Leitor = async (capacidade, parametros) => {
    const r = await lerUmaVez(capacidade, parametros);
    if (r.tipo !== "resposta" || !("entidades" in r.dados)) throw new InteligenciaError("LEITURA_SEM_ENTIDADES", "Leitura indisponível.", 422);
    return r.dados as RespostaLeitura;
  };
  return { leitor, ler: lerUmaVez };
}

/** Capacidades que EXISTEM no Tool Registry (planos por regra): a Policy de cada passo decide, no gateway. */
function catalogoRegistro(acoes: ModuloAcoes | null): CapacidadeCatalogo[] {
  const leituras = Object.values(ferramentas).filter((f) => manifestoLeitura(f) !== null)
    .map((f): CapacidadeCatalogo => ({ id: f.capacidade, descricao: f.descricao, tipo: "leitura", ...(f.entidade ? { entidade: f.entidade } : {}), ...((manifestoLeitura(f)?.produz.length ?? 0) ? { produz: manifestoLeitura(f)!.produz } : {}) }));
  const doModulo = (acoes?.todas() ?? []).filter((a) => a.origem !== "TELA" && manifestoAcao(a) !== null)
    .map((a): CapacidadeCatalogo => ({ id: a.capacidade, descricao: a.descricao, tipo: "acao" }));
  return [...leituras, ...doModulo];
}

/**
 * Catálogo do Planner por MODELO: o mesmo do operador (registro + flags + papel + Policy), com as leituras de
 * navegação como passo final. Buscas por termo continuam só por regra (o modelo não preenche nome de cliente).
 */
function catalogoPlanejamento(env: DependenciasGateway["env"], papel: string, acoes: ModuloAcoes | null): CapacidadeCatalogo[] {
  const navegacao = Object.values(ferramentas)
    .filter((f) => CAPACIDADES_NAVEGACAO.has(f.capacidade) && manifestoLeitura(f) !== null && grupoAtivo(env, f.grupo) && avaliarPolitica({ papel }, f, "LEITURA") === "PERMITIDO")
    .map((f): CapacidadeCatalogo => ({ id: f.capacidade, descricao: f.descricao, tipo: "leitura", ...((manifestoLeitura(f)?.produz.length ?? 0) ? { produz: manifestoLeitura(f)!.produz } : {}) }));
  return [...catalogoDisponivel(env, papel, acoes), ...navegacao];
}

/** Resultado da resolução de referência (PR 5) ⇒ intenção ou resposta honesta, como antes do Planner. */
function concluirResolucao(e: Execucao, regras: Intencao, r: Resolucao): SaidaPlanejador | null {
  e.resolucao = r;
  anotarReferencia(e.rastreio, r);
  // Nada na tela nem no foco e as regras já pedem a tela ("resuma esta festa"): mantém a resposta de contexto atual.
  if (r.resultado === "NAO_ENCONTRADA" && r.origem === "FOCO" && regras.tipo === "precisa_contexto") return null;
  // Financeiro sem âncora na tela/foco: segue a leitura da empresa (regras) — nunca pergunta o que o sistema responde.
  if (r.referencia.tipo === "IMPLICITA" && r.resultado === "NAO_ENCONTRADA") {
    return r.referencia.financeiro === "PARCELA" ? { intencao: { tipo: "leitura", capacidade: "proxima_parcela", parametros: {}, origem: "INTENCAO_DETERMINISTICA" } } : null;
  }
  if (r.resultado === "RESOLVIDA" && r.entidade) {
    const intencao = intencaoPara(r.entidade, e.texto, r.referencia.financeiro);
    return intencao ? { intencao } : null;
  }
  const resposta = respostaDaResolucao(r);
  return resposta ? { resposta } : null;
}

type AncoraPlano = { entidade: EntidadeRef; origem: Resolucao["origem"]; descartados: string[] } | null;

/**
 * Executa um plano validado e o traduz de volta para a conversa: trace do plano, referência/foco (a mesma
 * `Resolucao` do PR 5) e a intenção final ou a resposta de parada (ambíguo, sem dados, negado).
 */
async function executarPlanoDaConversa(
  e: Execucao, plano: Plano, origem: OrigemPlano, motivo: PlanoRastreio["motivo"], referencia: Referencia, ancora: AncoraPlano,
  ler: LerPlano, opcoes: { anotarReferencia: boolean; usoModelo: boolean; complemento?: PlanoRastreio["complemento"] },
): Promise<SaidaPlanejador | null> {
  const relogio = e.deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const r = await executarPlano(plano, {
    ler, ancoraContexto: ancora?.entidade ?? null, catalogo: catalogoRegistro(e.deps.acoes),
    entradaDe: (capacidade) => ferramentaRegistrada(capacidade)?.entrada ?? null,
    origem: origem === "MODELO" ? "INTENCAO_MODELO" : "INTENCAO_DETERMINISTICA", relogio,
  });
  e.rastreio.plano = {
    versao: VERSAO_PLANEJADOR, origem, motivo, objetivo: plano.objetivo, quantidadePassos: plano.passos.length, passos: r.passos,
    resultadoFinal: r.estado === "FINAL" ? "NAO_EXECUTADO" : r.estado, parada: r.estado === "FINAL" ? "FIM" : r.passoId,
    motivoParada: r.estado === "FINAL" ? null : r.estado, composicao: null, complemento: opcoes.complemento ?? null,
    duracaoMs: Math.max(0, Math.round(relogio() - inicio)), usoModelo: opcoes.usoModelo,
  };
  // Referência para o foco e o trace: âncora (tela/foco ou 1º passo), alvo (entrada do passo final) e origem.
  const paradaEm = r.estado === "FINAL" ? plano.passos.at(-1)! : plano.passos.find((p) => p.id === r.passoId)!;
  const fonte = paradaEm.entradaDe?.de === "PASSO" ? plano.passos.find((p) => p.id === (paradaEm.entradaDe as { passo: string }).passo) : undefined;
  // Pela relação do Core: a entrada do passo veio de relacoes_*, ou a parada foi na própria leitura de relações.
  const viaRelacao = Boolean(fonte?.capacidade.startsWith("relacoes_")) || (r.estado === "NEGADO" && paradaEm.capacidade.startsWith("relacoes_"));
  const ancoraFinal = ancora?.entidade ?? r.entradas.get("p2") ?? null;
  const origemAncora: Resolucao["origem"] = ancora ? ancora.origem : referencia.tipo === "NOME" ? "BUSCA" : "TEMPORAL";
  const base = { referencia, ancora: ancoraFinal, descartados: ancora?.descartados ?? [], candidatos: [] as EntidadeRef[], entidade: null as EntidadeRef | null };
  if (r.estado === "FINAL") {
    e.resolucao = { ...base, resultado: "RESOLVIDA", origem: viaRelacao ? "RELACAO_CORE" : origemAncora, entidade: r.entradaFinal };
    if (opcoes.anotarReferencia) anotarReferencia(e.rastreio, e.resolucao);
    e.partesPlano = r.partes;
    return { intencao: r.intencao };
  }
  if (r.estado === "ERRO") return { resposta: naoSuportado("Não consegui concluir este pedido com segurança agora. Tente de novo com um pedido mais simples.") };
  const resultado = r.estado === "AMBIGUO" ? "AMBIGUA" : r.estado === "NEGADO" ? "NEGADA" : "NAO_ENCONTRADA";
  // Parada na âncora (1º passo ou sua saída): ainda não há âncora; depois dela, a âncora explica o que faltou.
  const naAncora = !ancora && (paradaEm.id === "p1" || fonte?.id === "p1");
  e.resolucao = { ...base, ancora: naAncora ? null : ancoraFinal, resultado, origem: viaRelacao ? "RELACAO_CORE" : origemAncora, candidatos: r.candidatos };
  if (opcoes.anotarReferencia) anotarReferencia(e.rastreio, e.resolucao);
  // PR 6.4.2: no plano do MODELO a referência é sintética — o operador não citou um registro. Sem dados no Core e sem
  // âncora para nomear, dizer que não há dado (EXECUTADO), nunca pedir que ele esclareça o que não perguntou.
  if (origem === "MODELO" && resultado === "NAO_ENCONTRADA" && !e.resolucao.ancora) {
    return { resposta: { ...naoSuportado("Não encontrei no sistema os dados pedidos para esta consulta."), entendimento: "EXECUTADO" } };
  }
  return { resposta: respostaDaResolucao(e.resolucao) ?? naoSuportado("Não consegui concluir este pedido com segurança agora.") };
}

/**
 * Planner por REGRAS (PR 6): se as regras não resolvem sozinhas (ou pediram uma leitura que a referência estreita) e
 * há referência, monta o plano — âncora, relação do Core, capacidade final — e o executa passo a passo pela `ler`
 * recebida (contada pela orquestradora; Policy + Tenant Context em cada leitura). Sem plano seguro, a resolução do
 * PR 5 responde como antes. Nunca aceita id do texto, do foco sem revalidar ou do modelo.
 */
async function planejarPedido(e: Execucao, regras: Intencao, lerPorta: LerPlano): Promise<SaidaPlanejador | null> {
  // IA operacional: pergunta de quantidade ⇒ plano fechado âncora → calcular_consumo (antes de qualquer outra regra).
  if (e.consumo) return planejarConsumo(e, lerPorta);
  e.lerPlano = lerPorta;
  // Leitura da empresa ou resumo padrão da tela pode ser estreitado ao saldo/parcela do contrato referido (só se a pergunta for financeira).
  const estreitavel = regras.tipo === "leitura" && LEITURAS_ESTREITAVEIS.has(regras.capacidade);
  // IA operacional: convidados/buffet de uma festa referida ("a festa de amanhã") — a agenda/listagem das regras vira a
  // âncora do plano, não a resposta (que não traria esses fatos).
  const operacionalPedido = operacionalAtivo(e.deps.env) && fatosSolicitados(e.texto, true).some((f) => f === "CONVIDADOS" || f === "BUFFET");
  const ancoraOperacional = operacionalPedido && regras.tipo === "leitura" && ANCORAS_OPERACIONAIS.has(regras.capacidade);
  if ((regras.tipo === "leitura" && !estreitavel && !ancoraOperacional) || regras.tipo === "acao" || regras.tipo === "revisao_humana") return null;
  const hoje = hojeBrasilia(e.deps.agora());
  const referencia = detectarReferencia(e.texto, hoje);
  if (!referencia || (estreitavel && !referencia.financeiro && !operacionalPedido)) return null;
  const { leitor, ler } = leitorMemoizado(lerPorta);
  const deps = { contexto: e.contexto, foco: e.foco, hoje, ler: leitor };

  // Âncora de tela/foco: o Reference Resolver revalida no Core ANTES de planejar (o plano recebe só o tipo).
  let ancora: AncoraPlano = null;
  if (!referencia.temporal && referencia.tipo !== "NOME") {
    const r = await resolverAncoraContexto(referencia, deps);
    if (r.resultado !== "RESOLVIDA" || !r.ancora) return concluirResolucao(e, regras, r);
    ancora = { entidade: r.ancora, origem: r.origem, descartados: r.descartados };
  }
  const porRegras = planejarPorRegras(referencia, e.texto, ancora?.entidade ?? null, operacionalAtivo(e.deps.env));
  // Sem plano seguro (ex.: relação que o Core não fornece): resolução do PR 5, com as mesmas leituras memoizadas.
  if (!porRegras) return concluirResolucao(e, regras, await resolverReferencia(referencia, deps));
  const validacao = validarPlano(porRegras.plano, catalogoRegistro(e.deps.acoes), { contexto: ancora ? [ancora.entidade.tipo] : [] });
  if (!validacao.ok) {
    e.rastreio.plano = planoRejeitado("REGRAS", porRegras.motivo, validacao.motivo);
    return null;
  }
  const comp = completar(e, validacao.plano, catalogoRegistro(e.deps.acoes), ancora ? [ancora.entidade.tipo] : []);
  return executarPlanoDaConversa(e, comp.plano, "REGRAS", porRegras.motivo, referencia, ancora, ler, { anotarReferencia: true, usoModelo: false, complemento: comp.rastro });
}

/**
 * Limites da rota operacional (valores de projeto, medidos no trace): leituras e prazo por pedido. Não substituem os
 * da orquestradora nem os da conversa: valem por cima deles. Modelo: a rota de consumo não chama modelo.
 */
export const LIMITES_OPERACIONAIS = Object.freeze({ chamadasModelo: 4, leituras: 8, prazoMs: 20_000 });

/** Leitura contada da rota operacional: passou do limite ou do prazo ⇒ parada honesta, nada é inventado. */
function lerContado(e: Execucao, ler: LerPlano): LerPlano {
  const relogio = e.deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  // Consulta no meio de um rascunho: a decisão do coordenador (NOVA_CONSULTA) continua no trace.
  e.rastreio.operacional = { rota: "CONSUMO", decisao: e.rastreio.operacional?.decisao ?? null, leituras: 0, duracaoMs: 0 };
  return async (capacidade, parametros) => {
    const op = e.rastreio.operacional!;
    if (op.leituras >= LIMITES_OPERACIONAIS.leituras || relogio() - inicio > LIMITES_OPERACIONAIS.prazoMs) {
      op.decisao = "LIMITE";
      throw new InteligenciaError("LIMITE_OPERACIONAL", "Não consegui concluir o cálculo dentro do limite desta consulta. Tente de novo com um pedido mais simples.", 503);
    }
    op.leituras += 1;
    try {
      return await ler(capacidade, parametros);
    } finally {
      op.duracaoMs = Math.max(0, Math.round(relogio() - inicio));
    }
  };
}

/**
 * Pergunta de quantidade (IA operacional): festa pela referência do texto ("a próxima festa", "sábado") ou pela tela/foco
 * revalidados no Core; o cálculo é a leitura `calcular_consumo` (convidados da versão vigente × regra da empresa ou
 * parâmetro escrito). Sem festa identificável ⇒ pergunta qual; nunca escolhe por palpite.
 */
async function planejarConsumo(e: Execucao, lerPorta: LerPlano): Promise<SaidaPlanejador | null> {
  const consumo = e.consumo!;
  const hoje = hojeBrasilia(e.deps.agora());
  const contado = lerContado(e, lerPorta);
  e.lerPlano = contado;
  const { leitor, ler } = leitorMemoizado(contado);
  // Festa entendida pela Luna ("a próxima", "do dia 15/11") vale mais que a detecção por regra no texto.
  const ref = consumo.festaRef;
  const detectada: Referencia | null = ref?.tipo === "PROXIMA" ? { tipo: "TEMPORAL", alvo: "FESTA", temporal: { seletor: "PROXIMA", rotulo: "a próxima festa" } }
    : ref?.tipo === "DIA" ? { tipo: "TEMPORAL", alvo: "FESTA", temporal: { seletor: "DIA", dia: ref.dia, rotulo: `a festa de ${ref.dia.slice(8, 10)}/${ref.dia.slice(5, 7)}` } }
      : detectarReferencia(e.texto, hoje);
  const passos: PassoPlano[] = [];
  let ancora: AncoraPlano = null;
  let referencia: Referencia;
  let fonte: NonNullable<PassoPlano["entradaDe"]>;
  if (detectada?.tipo === "TEMPORAL" && detectada.temporal && detectada.temporal.seletor !== "ULTIMO_CONTRATO") {
    const t = detectada.temporal;
    referencia = { ...detectada, alvo: "FESTA" };
    passos.push({
      id: "p1", capacidade: "proximas_festas",
      parametros: t.seletor === "DIA" && t.dia ? { ordem: "ASC", inicio: t.dia, fim: t.dia, limite: 5 } : { ordem: t.seletor === "PROXIMA" ? "ASC" : "DESC", limite: 2 },
      selecao: t.seletor === "DIA" ? "UNICA" : "PRIMEIRA",
    });
    fonte = { de: "PASSO", passo: "p1", entidade: "FESTA" };
  } else {
    referencia = { tipo: "DEITICO", alvo: "FESTA", deitico: "FESTA" };
    // Continuação: a festa da PERGUNTA (dica, revalidada no Core como o foco), não a tela aberta agora.
    const pergunta = consumo.festaId ? { contexto: null, foco: { entidades: [{ tipo: "FESTA" as const, id: consumo.festaId }], principal: 0 } } : { contexto: e.contexto, foco: e.foco };
    const r = await resolverAncoraContexto(referencia, { ...pergunta, hoje, ler: leitor });
    if (r.resultado !== "RESOLVIDA" || !r.ancora || (r.ancora.tipo !== "FESTA" && r.ancora.tipo !== "CONTRATO")) {
      e.resolucao = r;
      anotarReferencia(e.rastreio, r);
      if (r.resultado === "AMBIGUA" || r.resultado === "NEGADA") return { resposta: respostaDaResolucao(r) ?? naoSuportado("Não consegui identificar a festa com segurança.") };
      // Frase sem âncora que as regras conheçam ("pra comemoração que vem aí…"): o Planner por modelo tenta ancorar pela
      // listagem do Core; o cálculo continua sendo a mesma leitura determinística.
      // Se a Luna já entendeu que a mensagem não aponta festa, o Planner não é consultado: pergunta-se qual festa.
      if (e.planejadorModelo && e.luna?.festa !== "NENHUMA") return null;
      return { resposta: { ...naoSuportado("Para qual festa? Por exemplo: “para a próxima festa”, ou abra a festa e pergunte por lá."), entendimento: "PRECISA_DADO" } };
    }
    ancora = { entidade: r.ancora, origem: r.origem, descartados: r.descartados };
    if (r.ancora.tipo === "FESTA") fonte = { de: "CONTEXTO", entidade: "FESTA" };
    else {
      passos.push({ id: "p1", capacidade: "relacoes_contrato", entradaDe: { de: "CONTEXTO", entidade: "CONTRATO" } });
      fonte = { de: "PASSO", passo: "p1", entidade: "FESTA" };
    }
  }
  // Uma leitura de cálculo por categoria pedida (doces E refrigerantes ⇒ duas), todas da MESMA festa da cadeia; a
  // composição junta as respostas e confere a mesma âncora.
  // A tela/foco só pode alimentar o PRIMEIRO passo (validarPlano): ancorado nela, o 2º cálculo lê a festa que o 1º
  // devolveu do Core (calcular_consumo produz FESTA), sem leitura extra.
  consumo.categorias.forEach((categoria, i) => {
    const id = `p${passos.length + 1}` as PassoPlano["id"];
    passos.push({ id, capacidade: "calcular_consumo", parametros: { categoria }, entradaDe: fonte, ...(i < consumo.categorias.length - 1 ? { resposta: true } : {}) });
    if (fonte.de === "CONTEXTO") fonte = { de: "PASSO", passo: id, entidade: "FESTA" };
  });
  const catalogo = catalogoRegistro(e.deps.acoes);
  const validacao = validarPlano({ objetivo: "CONSULTAR:FESTA", recursoFinal: "FESTA", passos }, catalogo, { contexto: ancora ? [ancora.entidade.tipo] : [] });
  if (!validacao.ok) {
    e.rastreio.plano = planoRejeitado("REGRAS", "REFERENCIA", validacao.motivo);
    return { resposta: naoSuportado("Não consegui montar esse cálculo com segurança agora.") };
  }
  return executarPlanoDaConversa(e, validacao.plano, "REGRAS", "REFERENCIA", referencia, ancora, ler, { anotarReferencia: true, usoModelo: false });
}

/** Pergunta de parâmetro pendente na resposta do cálculo ⇒ continuação para a UI (dica, revalidada no próximo pedido). */
function continuacaoDa(resposta: AIResponse, e: Execucao): ContinuacaoConsumo | undefined {
  if (!e.consumo || resposta.tipo !== "resposta" || !("fatos" in resposta.dados)) return undefined;
  // O primeiro parâmetro pendente, pela evidência estruturada do cálculo ("CATEGORIA:PARAMETRO"), nunca pelo texto.
  const pendente = resposta.dados.evidencias.find((x) => x.rotulo === ROTULO_PENDENTE)?.valor.split(":");
  if (!pendente) return undefined;
  const categoria = pendente[0] as CategoriaConsumo;
  const perguntado = pendente[1] as ContinuacaoConsumo["perguntado"];
  if (!CATEGORIAS_CONSUMO.includes(categoria) || !["POR_CONVIDADO", "ML_POR_CONVIDADO", "EMBALAGEM"].includes(perguntado)) return undefined;
  const { categorias, parametros: escritos } = e.consumo;
  if (!categorias.includes(categoria)) return undefined;
  const parametros = escritos[categoria];
  const informados = Object.fromEntries(categorias.filter((c) => c !== categoria && escritos[c] && Object.keys(escritos[c]!).length).map((c) => [c, escritos[c]]));
  // A festa que o Core devolveu para TODOS os cálculos (uma só); outra situação ⇒ sem festa na dica (a próxima mensagem
  // resolve pela tela/foco, como antes).
  const festas = [...new Set((resposta.dados.entidades ?? []).filter((x) => x.tipo === "FESTA").map((x) => x.id))];
  return {
    tipo: "PARAMETRO_CONSUMO", categoria, perguntado,
    ...(parametros && Object.keys(parametros).length ? { parametros } : {}),
    ...(categorias.length > 1 ? { categorias: [...categorias] } : {}),
    ...(festas.length === 1 ? { festaId: festas[0] } : {}),
    ...(Object.keys(informados).length ? { informados } : {}),
  };
}

/**
 * Pergunta de quantidade deste pedido: continuação de uma pergunta de parâmetro (a resposta traz o número) ou pergunta
 * nova ("quantos docinhos…"). Só os números ESCRITOS entram; nada vira padrão da empresa. Na continuação, a resposta
 * vale para o parâmetro PERGUNTADO; números explícitos de outra categoria da mesma pergunta também valem ("4, e 400 ml
 * por convidado"); as demais categorias e os números já informados seguem intactos, e a festa da pergunta também.
 */
function consumoDoPedido(texto: string, continuacao: ContinuacaoConsumo | undefined): Execucao["consumo"] {
  if (continuacao) {
    const categorias = continuacao.categorias ?? [continuacao.categoria];
    const novos = new Map(categorias.map((c) => [c, c === continuacao.categoria ? extrairParametros(texto, c, continuacao.perguntado) : extrairParametros(texto, c)]));
    if ([...novos.values()].some((p) => Object.keys(p).length)) {
      const parametros: Partial<Record<CategoriaConsumo, ParametrosConsumo>> = {};
      for (const c of categorias) parametros[c] = { ...(c === continuacao.categoria ? continuacao.parametros : continuacao.informados?.[c]), ...novos.get(c) };
      return { categorias: [...categorias], parametros, ...(continuacao.festaId ? { festaId: continuacao.festaId } : {}) };
    }
    // "não sei", "não estime", "só a regra cadastrada": o mesmo cálculo, a mesma festa, sem estimar (também sem a Luna).
    if (respondeSemDado(texto) && !detectarConsumo(texto)) {
      const parametros: Partial<Record<CategoriaConsumo, ParametrosConsumo>> = {};
      for (const c of categorias) parametros[c] = { ...(c === continuacao.categoria ? continuacao.parametros : continuacao.informados?.[c]) };
      return { categorias: [...categorias], parametros, ...(continuacao.festaId ? { festaId: continuacao.festaId } : {}) };
    }
  }
  const detectado = detectarConsumo(texto);
  if (!detectado) return undefined;
  // Cada categoria lê só os SEUS números ("4 docinhos por convidado e 400 ml de refrigerante por convidado").
  return { categorias: detectado.categorias, parametros: Object.fromEntries(detectado.categorias.map((c) => [c, extrairParametros(texto, c)])) };
}

function planoRejeitado(origem: OrigemPlano, motivo: PlanoRastreio["motivo"], rejeicao: string): PlanoRastreio {
  return { versao: VERSAO_PLANEJADOR, origem, motivo, objetivo: null, quantidadePassos: 0, passos: [], resultadoFinal: "NAO_EXECUTADO", parada: `REJEITADO:${rejeicao}`, motivoParada: rejeicao, composicao: null, complemento: null, duracaoMs: 0, usoModelo: origem === "MODELO" };
}

/** Complemento determinístico (PR 6.4.3) + o que vai para o trace (só códigos). */
function completar(e: Execucao, plano: Plano, catalogo: readonly CapacidadeCatalogo[], contexto: readonly TipoEntidade[]): { plano: Plano; rastro: PlanoRastreio["complemento"] } {
  const c = completarPlano(plano, fatosSolicitados(e.texto, operacionalAtivo(e.deps.env)), catalogo, contexto);
  if (c.tipo === "COMPLETADO") return { plano: c.plano, rastro: { adicionados: c.adicionados, marcados: c.marcados, impossivel: null } };
  if (c.tipo === "IMPOSSIVEL") return { plano, rastro: { adicionados: [], marcados: [], impossivel: c.motivo } };
  return { plano, rastro: null };
}

/** Tipos de entidade que existem DE FATO neste pedido: registro aberto na tela e entidades do foco (dicas, revalidadas depois). */
function contextoDisponivel(e: Execucao): TipoEntidade[] {
  const daTela: Partial<Record<ContextoTela["tela"], TipoEntidade>> = { festa: "FESTA", cliente: "CLIENTE", contrato: "CONTRATO" };
  const tela = e.contexto?.entidadeId ? daTela[e.contexto.tela] : undefined;
  return [...new Set([...(tela ? [tela] : []), ...(e.foco?.entidades ?? []).map((x) => x.tipo)])];
}

/** Pedido que compõe recursos: 2+ entidades citadas, ou âncora temporal/nome com outro alvo. Sem rede, sem custo. */
function pedeComposicao(texto: string, hoje: string, operacional = false): boolean {
  // PR 6.4.3: 2+ fatos pedidos (ex.: situação do contrato E pagamento) também é composição, mesmo com um recurso citado.
  if (entidadesCitadas(texto).length >= 2 || fatosSolicitados(texto, operacional).length >= 2) return true;
  // IA operacional: quantidade operacional sem âncora que as regras conheçam também pede o Planner (ele ancora a festa).
  if (operacional && detectarConsumo(texto)) return true;
  const ref = detectarReferencia(texto, hoje);
  return Boolean(ref && (ref.tipo === "TEMPORAL" || ref.tipo === "NOME") && ref.alvo);
}

/** Planner por MODELO (PR 6): só monta o plano (workload PLANEJAR); a execução é a mesma, com o catálogo do operador. */
async function planejarPorModelo(e: Execucao, lerPorta: LerPlano, exigirAcaoFinal: boolean, usos: ModelUsage[]): Promise<SaidaPlanejador | null> {
  const { deps, sessao, pedido, rastreio } = e;
  const roteador = deps.roteador;
  if (!roteador?.disponivelPara("PLANEJAR")) return null;
  const tenant = await tenantParaModelo(sessao, pedido, deps, rastreio);
  const catalogo = catalogoPlanejamento(deps.env, papelParaPolitica(sessao, tenant), deps.acoes);
  const doTexto = objetivoDoTexto(e.texto);
  const saida = await planejarComModelo({
    texto: e.texto, contexto: e.contexto, objetivo: doTexto.acao && doTexto.recurso ? `${doTexto.acao}:${doTexto.recurso}` : null,
    focoTipos: [...new Set((e.foco?.entidades ?? []).map((x) => x.tipo))], contextoTipos: contextoDisponivel(e), catalogo,
    fatosPedidos: fatosSolicitados(e.texto, operacionalAtivo(deps.env)).map((fato) => ({ fato, capacidades: FORNECEDORES[fato].filter((c) => catalogo.some((x) => x.id === c)) })),
  }, roteador, { empresaId: tenant.empresaComprovada, estabelecimentoId: unidadeDe(tenant), capacidade: "planejar", correlationId: rastreio.correlationId ?? rastreio.requestId, hoje: hojeBrasilia(deps.agora()) });
  if (saida.roteado) {
    anotarUsoModelo(rastreio, saida.roteado.usos, saida.roteado.ok ? undefined : saida.roteado.recusa);
    usos.push(...saida.roteado.usos);
  }
  if (!saida.plano) {
    rastreio.plano = planoRejeitado("MODELO", "COMPOSICAO", saida.rejeicao ?? "INDISPONIVEL");
    // Cálculo de consumo sem festa e sem plano (modelo indisponível, orçamento, plano inválido): pergunta qual festa,
    // como faria sem o Planner — nunca "não sei responder".
    if (e.consumo && e.resolucao?.resultado === "NAO_ENCONTRADA") {
      return { resposta: { ...naoSuportado("Para qual festa? Por exemplo: “para a próxima festa”, ou abra a festa e pergunte por lá."), entendimento: "PRECISA_DADO" } };
    }
    return null;
  }
  const doModelo = saida.plano;
  const final = catalogo.find((c) => c.id === doModelo.passos.at(-1)!.capacidade);
  // Julgamento pede CONFIRM: só um plano que termina em proposta (Human Gate) é aceito; consulta pela metade, não.
  if (exigirAcaoFinal && final?.tipo !== "acao") {
    rastreio.plano = planoRejeitado("MODELO", "COMPOSICAO", "CONFIRM_SEM_ACAO");
    return null;
  }
  // PR 6.4.3: plano do modelo que não cobre os fatos pedidos é completado ANTES da execução (e revalidado inteiro).
  const comp = completar(e, doModelo, catalogo, contextoDisponivel(e));
  const plano = comp.plano;
  e.lerPlano = lerPorta;
  const { leitor, ler } = leitorMemoizado(lerPorta);
  const referencia: Referencia = { tipo: "IMPLICITA", alvo: plano.recursoFinal };
  let ancora: AncoraPlano = null;
  const primeira = plano.passos[0].entradaDe;
  if (primeira?.de === "CONTEXTO") {
    const tipo = primeira.entidade;
    const r = await resolverAncoraContexto({ tipo: "DEITICO", alvo: tipo, deitico: tipo }, { contexto: e.contexto, foco: e.foco, hoje: hojeBrasilia(deps.agora()), ler: leitor });
    if (r.resultado !== "RESOLVIDA" || !r.ancora) {
      e.resolucao = r;
      // Parada antes da primeira leitura do plano: o trace mostra o plano aceito e onde/por que parou (só códigos).
      const resultado = r.resultado === "AMBIGUA" ? "AMBIGUO" : r.resultado === "NEGADA" ? "NEGADO" : "SEM_DADOS";
      rastreio.plano = {
        versao: VERSAO_PLANEJADOR, origem: "MODELO", motivo: "COMPOSICAO", objetivo: plano.objetivo, quantidadePassos: plano.passos.length,
        passos: plano.passos.map((p, i) => ({ capacidade: p.capacidade, origemEntrada: p.entradaDe ? (p.entradaDe.de === "CONTEXTO" ? "CONTEXTO" : "PASSO") : "PARAMETROS", fonte: p.entradaDe ? (p.entradaDe.de === "CONTEXTO" ? "CONTEXTO" : p.entradaDe.passo) : null, resultado: i === 0 ? resultado : "NAO_EXECUTADO", duracaoMs: 0 })),
        resultadoFinal: resultado, parada: "p1", motivoParada: `CONTEXTO_${r.resultado}`, composicao: null, complemento: null, duracaoMs: 0, usoModelo: true,
      };
      return { resposta: respostaDaResolucao(r) ?? naoSuportado("Não sei a qual registro você se refere. Abra o registro na tela e pergunte por ali.") };
    }
    ancora = { entidade: r.ancora, origem: r.origem, descartados: r.descartados };
  }
  return executarPlanoDaConversa(e, plano, "MODELO", "COMPOSICAO", referencia, ancora, ler, { anotarReferencia: false, usoModelo: true, complemento: comp.rastro });
}

/** Porta do Planner para a orquestradora: planos por regra e por modelo sobre a `ler` contada que ela fornece. */
function portaPlanejador(e: Execucao, usos: ModelUsage[]): PortaPlanejador {
  return {
    planejar: ({ regras }, ler) => planejarPedido(e, regras, ler),
    pedeComposicao: (texto) => Boolean(e.deps.roteador?.disponivelPara("PLANEJAR")) && ((e.luna?.consultas.length ?? 0) >= 2 || pedeComposicao(texto, hojeBrasilia(e.deps.agora()), operacionalAtivo(e.deps.env))),
    planejarComModelo: (_entrada, ler, exigirAcaoFinal) => planejarPorModelo(e, ler, exigirAcaoFinal, usos),
    concluir: (resposta) => concluirPlano(e, resposta),
  };
}

/**
 * Complementos por fato pedido (IA operacional): a leitura que fornece o fato e a entidade-âncora de que ela precisa.
 * Só leituras do catálogo; a âncora é sempre um id DEVOLVIDO pelo Core nesta mesma execução (nunca do texto ou do modelo).
 */
const COMPLEMENTOS: Readonly<Record<FatoSolicitado, ReadonlyArray<{ capacidade: string; ancora: TipoEntidade; parametros?: Record<string, string> }>>> = {
  CLIENTE: [{ capacidade: "relacoes_festa", ancora: "FESTA" }, { capacidade: "relacoes_contrato", ancora: "CONTRATO" }],
  SITUACAO_CONTRATO: [{ capacidade: "resumir_contrato", ancora: "CONTRATO" }],
  POSICAO_FINANCEIRA: [{ capacidade: "saldo_contrato", ancora: "CONTRATO" }],
  CONVIDADOS: [{ capacidade: "contexto_operacional_festa", ancora: "FESTA" }],
  BUFFET: [{ capacidade: "contexto_operacional_festa", ancora: "FESTA" }],
  CONSUMO_DOCES: [{ capacidade: "calcular_consumo", ancora: "FESTA", parametros: { categoria: "DOCES" } }],
  CONSUMO_REFRIGERANTES: [{ capacidade: "calcular_consumo", ancora: "FESTA", parametros: { categoria: "REFRIGERANTES" } }],
};
/** Teto de leituras de complemento por pedido (abaixo do teto de leituras da rota e dos passos da orquestradora). */
export const MAX_COMPLEMENTOS = 4;

/**
 * Análise dos resultados ⇒ lacunas ⇒ complementos autorizados (IA operacional). Até 2 rodadas e MAX_COMPLEMENTOS leituras:
 * 1. lacunas = fatos pedidos que nenhuma leitura cobriu;
 * 2. âncora = entidade ÚNICA de cada tipo nos resultados (duas festas ou dois contratos ⇒ nada é escolhido);
 * 3. para cada lacuna, a leitura que a fornece com a âncora disponível; sem contrato mas com festa, a ponte é a relação
 *    do Core (relacoes_festa), e a próxima rodada usa o contrato devolvido;
 * 4. cada leitura passa pela mesma porta contada (Policy + Tenant Context no gateway); recusa, erro ou limite ⇒ para e a
 *    resposta aponta a ausência — nada é inventado.
 */
async function complementarAposExecucao(e: Execucao, partes: ParteResposta[], solicitados: readonly FatoSolicitado[], plano: PlanoRastreio): Promise<ParteResposta[]> {
  const ler = e.lerPlano;
  if (!ler) return partes;
  const autorizadas = new Set(catalogoDisponivel(e.deps.env, e.sessao.papel, e.deps.acoes).filter((c) => c.tipo === "leitura").map((c) => c.id));
  const feitas = new Set<string>();
  const rastro = { leituras: [] as string[], rodadas: 0, parada: null as string | null };
  plano.aposExecucao = rastro;
  const resultado = [...partes];
  for (let rodada = 0; rodada < 2; rodada += 1) {
    const lacunas = faltando(solicitados, resultado);
    if (!lacunas.length) break;
    const ancoras = new Map<TipoEntidade, string>();
    for (const tipo of ["FESTA", "CONTRATO", "CLIENTE"] as const) {
      const ids = [...new Set(resultado.flatMap((p) => (p.dados.entidades ?? []).filter((x) => x.tipo === tipo).map((x) => x.id)))];
      if (ids.length === 1) ancoras.set(tipo, ids[0]);
    }
    // Cálculos primeiro: um cálculo também comprova os convidados (versão vigente), evitando leitura redundante.
    const ordenadas = [...lacunas].sort((x, y) => Number(!x.startsWith("CONSUMO_")) - Number(!y.startsWith("CONSUMO_")));
    let leuNestaRodada = false;
    for (const fato of ordenadas) {
      // A lacuna pode ter sido coberta por um complemento desta mesma rodada.
      if (!faltando([fato], resultado).length) continue;
      const opcao = COMPLEMENTOS[fato].find((c) => autorizadas.has(c.capacidade) && ancoras.has(c.ancora));
      // Sem a âncora pedida, a PONTE é a relação do Core entre festa e contrato (nos dois sentidos).
      const ponte = (de: TipoEntidade, capacidade: string, para: TipoEntidade) =>
        COMPLEMENTOS[fato].some((c) => c.ancora === para) && !ancoras.has(para) && ancoras.has(de) && autorizadas.has(capacidade)
          ? { capacidade, parametros: { id: ancoras.get(de)! } as Record<string, unknown> } : null;
      const p = opcao
        ? { capacidade: opcao.capacidade, parametros: { ...(opcao.parametros ?? {}), id: ancoras.get(opcao.ancora)! } as Record<string, unknown> }
        : ponte("FESTA", "relacoes_festa", "CONTRATO") ?? ponte("CONTRATO", "relacoes_contrato", "FESTA");
      if (!p) continue;
      const chave = `${p.capacidade}:${JSON.stringify(p.parametros)}`;
      if (feitas.has(chave)) continue;
      if (!leuNestaRodada) rastro.rodadas += 1;
      leuNestaRodada = true;
      if (rastro.leituras.length >= MAX_COMPLEMENTOS) {
        rastro.parada = "LIMITE";
        return resultado;
      }
      feitas.add(chave);
      rastro.leituras.push(p.capacidade);
      let r: AIResponse;
      try {
        r = await ler(p.capacidade, p.parametros);
      } catch {
        // Policy, Tenant Context, prazo ou limite da orquestradora: para aqui, com o que foi comprovado.
        rastro.parada = "RECUSA_OU_LIMITE";
        return resultado;
      }
      if (r.tipo === "resposta" && "fatos" in r.dados) resultado.push({ passoId: `c${rastro.leituras.length}`, capacidade: p.capacidade, dados: r.dados as RespostaLeitura });
      else rastro.parada = "SEM_DADOS";
    }
    if (!leuNestaRodada) {
      rastro.parada ??= "SEM_COMPLEMENTO";
      break;
    }
  }
  return resultado;
}

/**
 * Fecha o plano: resultado do passo final (despachado pelo caminho atual) no trace e, em RESPOSTA DE LEITURA, a
 * composição determinística (PR 6.4) — leituras marcadas + final, completude dos fatos pedidos, mesma âncora e
 * limites do schema. Navegação, proposta (Human Gate), recusa e erro voltam como vieram: nada transforma uma execução
 * interrompida em sucesso. O complemento do Copiloto (calculado só sobre a leitura final) não acompanha a composta.
 */
async function concluirPlano(e: Execucao, resposta: AIResponse): Promise<AIResponse> {
  const plano = e.rastreio.plano;
  const ultimo = plano?.passos.at(-1);
  if (!plano || !ultimo || ultimo.resultado !== "NAO_EXECUTADO") return resposta;
  ultimo.resultado = resultadoFinal(resposta);
  plano.resultadoFinal = ultimo.resultado;
  if (resposta.tipo !== "resposta" || !("fatos" in resposta.dados)) return resposta;
  const solicitados = fatosSolicitados(e.texto, operacionalAtivo(e.deps.env));
  const final = resposta.dados as RespostaLeitura;
  let partes: ParteResposta[] = [...(e.partesPlano ?? []), { passoId: `p${plano.quantidadePassos}`, capacidade: final.capacidade, dados: final }];
  // IA operacional: analisa o que VOLTOU, identifica fatos pedidos ainda faltando e busca complementos autorizados, com a
  // âncora que o Core devolveu, dentro dos limites (leituras contadas pela orquestradora).
  if (operacionalAtivo(e.deps.env) && faltando(solicitados, partes).length) partes = await complementarAposExecucao(e, partes, solicitados, plano);
  if (partes.length === 1 && !faltando(solicitados, partes).length) {
    plano.composicao = { leituras: 1, solicitados, faltando: [] };
    return resposta;
  }
  const c = compor(partes, solicitados);
  if (!c.ok) {
    ultimo.resultado = "ERRO";
    plano.resultadoFinal = "ERRO";
    plano.parada = `p${plano.quantidadePassos}`;
    plano.motivoParada = c.motivo;
    plano.composicao = { leituras: partes.length, solicitados, faltando: [] };
    return naoSuportado(c.motivo === "COMPOSICAO_LIMITE"
      ? "Encontrei os dados, mas a resposta combinada passou do tamanho permitido. Peça uma coisa de cada vez."
      : "Não consegui confirmar que os dados são do mesmo registro. Peça uma coisa de cada vez.");
  }
  plano.composicao = { leituras: partes.length, solicitados, faltando: c.faltando };
  if (c.faltando.length) plano.motivoParada = "INCOMPLETO";
  return { tipo: "resposta", dados: c.dados };
}

function anotarReferencia(rastreio: RastreioInteligencia, r: Resolucao) {
  if (rastreio.referencias.length >= 5) return;
  const tipos = [...new Set([r.ancora, r.entidade, ...r.candidatos].filter((x): x is EntidadeRef => !!x).map((x) => x.tipo))].sort();
  rastreio.referencias.push({ tipo: r.referencia.tipo, alvo: r.referencia.alvo, origem: r.origem, resultado: r.resultado, tipos, candidatos: r.candidatos.length });
}

/** Novo foco: entidades desta resposta (a primeira é a principal) + âncora/alvo resolvidos + foco anterior válido. */
function focoDaResposta(resposta: AIResponse, e: Execucao | undefined): FocoConversa | undefined {
  const novas: Array<EntidadeRef & { origem?: OrigemFoco }> = [];
  if (resposta.tipo === "resposta" && "entidades" in resposta.dados) novas.push(...(resposta.dados.entidades ?? []));
  const r = e?.resolucao;
  if (r?.resultado === "RESOLVIDA") {
    if (r.entidade) novas.push({ ...r.entidade, origem: r.origem === "RELACAO_CORE" ? "RELACAO" : resposta.tipo === "navegacao" ? "NAVEGACAO" : "LEITURA" });
    if (r.ancora) novas.push(r.ancora);
  }
  const anteriores: EntidadeFoco[] = (e?.foco?.entidades ?? []).map((x) => ({ ...x, rotulo: "", origem: "LEITURA" }));
  if (!novas.length && !anteriores.length) return undefined;
  const lista = new Set(novas.filter((x) => x.tipo === novas[0]?.tipo).map((x) => x.id)).size > 1;
  return atualizarFoco(novas, anteriores, new Set(r?.descartados ?? []), !lista);
}

function finalizar(resposta: AIResponse, texto: string, rastreio: RastreioInteligencia, pendente?: Execucao["navegacaoPendente"], e?: Execucao): AIResponse {
  const foco = focoDaResposta(resposta, e);
  if (foco) resposta = { ...resposta, foco };
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
  if (intencao.tipo === "esclarecer") {
    rastreio.estado = "nao_suportado";
    return { tipo: "nao_suportado", mensagem: intencao.mensagem, sugestoes: intencao.sugestoes, entendimento: "AMBIGUO" };
  }
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
    entendido: e.luna ? { objetivo: e.luna.objetivo } : null,
    interpretar: (texto, contexto) => {
      // Quantidade operacional: nunca vira a leitura genérica das regras (ex.: "devo fazer" ⇒ atenção de hoje).
      if (e.consumo) return { tipo: "nenhuma" };
      const intencao = interpretarDeterministico(texto, contexto);
      if (intencao.tipo === "navegacao_sem_destino") e.navegacaoPendente = intencao;
      // Conversa adaptativa: a Luna já entendeu a mensagem inteira; a regra só vale se concordar com ela.
      return e.luna ? conciliarComLuna(intencao, e.luna, contexto) : intencao;
    },
    // Com a Luna, nenhum classificador extra por modelo: a escolha dela (catálogo revalidado) responde.
    sugerirRota: (texto, contexto) => (e.luna ? Promise.resolve(e.luna.consultas.length === 1 ? leituraDaLuna(e.luna.consultas[0], contexto) : null) : consultarAuxiliar(texto, contexto, sessao, deps)),
    interpretarComModelo: (texto, contexto) => (e.luna ? Promise.resolve(null) : interpretarPorModelo(texto, contexto, sessao, pedido, deps, rastreio, usos)),
    portaModelo() {
      const roteador = deps.roteador;
      // Com a Luna, o JEV julga só por regras (risco); a compreensão já foi feita.
      if (e.luna || !roteador || !jevModeloAtivo(deps.env) || !roteador.disponivelPara("CLASSIFICAR_INTENCAO")) return Promise.resolve(null);
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
          anotarUsoModelo(rastreio, r.usos, r.ok ? undefined : r.recusa);
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
              anotarUsoModelo(rastreio, r.usos, r.ok ? undefined : r.recusa);
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
    planejador: portaPlanejador(e, usos),
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

/** Pedido novo (sem rascunho, ou consulta no meio de um): orquestradora ou caminho da Foundation, como sempre. */
async function atenderNovo(e: Execucao): Promise<AIResponse> {
  const { deps, rastreio, contexto, texto } = e;
  let resposta: AIResponse;
  // Orquestradora (Demerzel): decide o caminho com as mesmas portas guardadas (inclusive o Planner, depois do JEV).
  // Qualquer erro dela cai no fallback seguro da conversa — nunca no caminho sem guardas.
  const orquestrador = deps.orquestrador ?? null;
  if (orquestrador && demerzelAtivo(deps.env)) {
    e.planejadorModelo = Boolean(deps.roteador?.disponivelPara("PLANEJAR"));
    const r = await orquestrador.atender({ texto, contexto }, portasOrquestracao(e, []));
    rastreio.estado ??= r.resposta.tipo;
    resposta = finalizar(r.resposta, texto, rastreio, e.navegacaoPendente, e);
  } else {
    // Sem orquestradora: Planner por regras (sem modelo) e, sem plano, a intenção da Foundation.
    const planejado = await planejarPedido(e, interpretarDeterministico(texto, contexto), (capacidade, parametros) => responderLeitura(capacidade, parametros, "INTENCAO_DETERMINISTICA", e));
    if (planejado && "resposta" in planejado) resposta = finalizar(planejado.resposta, texto, rastreio, undefined, e);
    else {
      const intencao = planejado?.intencao ?? await resolverIntencao(texto, contexto, e.sessao, e.pedido, deps, rastreio);
      const respondida = await responderIntencao(intencao, contexto, e);
      resposta = finalizar(planejado ? await concluirPlano(e, respondida) : respondida, texto, rastreio, undefined, e);
    }
  }
  const continuacao = continuacaoDa(resposta, e);
  return continuacao ? { ...resposta, continuacao } : resposta;
}

type ResultadoRascunho = { resposta: AIResponse; capacidade: string; ferramenta: string };

function anotarRascunho(rastreio: RastreioInteligencia, r: ResultadoRascunho) {
  rastreio.capacidade = r.capacidade;
  rastreio.ferramenta = r.ferramenta;
  rastreio.ferramentasSolicitadas = [r.ferramenta];
  rastreio.humanGate = r.resposta.tipo === "preview" || (r.resposta.tipo === "navegacao" && r.resposta.proposta) ? "PREVIEW"
    : r.resposta.tipo === "resultado_acao" ? "CANCELADO" : "RASCUNHO";
  rastreio.estado = r.resposta.tipo;
}

type Pausado = NonNullable<AIResponse["rascunhoPausado"]>;
type Coordenado = { resposta: AIResponse } | { novo: true; pausado: Pausado | null };

/**
 * IA operacional: coordenação de uma mensagem enviada com um rascunho aberto. A situação do rascunho é lida no tenant
 * comprovado (dono, empresa, estado e prazo revalidados); `null` ⇒ caminho atual (resposta ao campo / correção).
 */
async function coordenar(e: Execucao, acoes: ModuloAcoes, operacaoId: string): Promise<Coordenado | null> {
  const { deps, sessao, pedido, rastreio } = e;
  rastreio.operacional = { rota: "RASCUNHO", decisao: null, leituras: 0, duracaoMs: 0 };
  const noTenant = <T>(fn: (ctx: ContextoExtensao) => Promise<T>) => deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
    rastreio.empresaId = tenant.empresaComprovada;
    exigirGrupoNaEmpresa(deps.env, "ADMIN_ACTIONS", tenant);
    return fn(e.contextoExtensao(tx, tenant));
  });
  const situacao = await noTenant((ctx) => acoes.situacao!(operacaoId, e.texto, ctx));
  const decisao: DecisaoRascunho = coordenarRascunho(e.texto, situacao, interpretarDeterministico(e.texto, e.contexto), Boolean(e.consumo));
  rastreio.operacional.decisao = decisao.tipo;
  switch (decisao.tipo) {
    case "RESPOSTA_CAMPO":
    case "CORRECAO":
      return null;
    case "ENCERRADO":
      return { novo: true, pausado: null };
    case "NOVA_CONSULTA":
      return { novo: true, pausado: { operacaoId, titulo: situacao.titulo, pergunta: situacao.pergunta } };
    case "AMBIGUO":
      return { resposta: { ...naoSuportado(`Isso é a resposta para o rascunho “${situacao.titulo}” ou uma nova pergunta?${situacao.pergunta ? ` O rascunho pergunta: ${situacao.pergunta}` : ""}`), entendimento: "AMBIGUO" } };
    case "CANCELAR":
    case "RETOMAR": {
      const r = await noTenant((ctx) => (decisao.tipo === "CANCELAR" ? acoes.abandonar!(operacaoId, ctx) : acoes.retomar!(operacaoId, ctx)));
      anotarRascunho(rastreio, r);
      return { resposta: r.resposta };
    }
    case "MUDANCA_OBJETIVO": {
      const alvo = acoes.descrever(decisao.capacidade);
      // Novo objetivo indisponível (sem ação, DENY, flag): diz o que entendeu e preserva o rascunho atual.
      if (!alvo || alvo.classe !== "CONFIRM" || alvo.origem === "TELA" || !grupoAtivo(deps.env, alvo.grupo) || !acoes.substituir) {
        return { resposta: { ...naoSuportado(`Entendi que você quer ${decisao.capacidade === "preparar_contratacao" ? "preparar a contratação de uma festa" : "outro cadastro"}, mas isso ainda não está disponível pelo Kidmais. O rascunho “${situacao.titulo}” continua aberto.`), entendimento: "CAPACIDADE_INDISPONIVEL" } };
      }
      const r = await noTenant((ctx) => acoes.substituir!(operacaoId, decisao.capacidade, e.texto, ctx));
      anotarRascunho(rastreio, r);
      rastreio.propostaAcao = r.capacidade;
      const aviso = `Entendi: troquei o objetivo. O rascunho “${r.anterior}” foi descartado (nada foi gravado).`;
      const resposta: AIResponse = r.resposta.tipo === "rascunho" ? { ...r.resposta, pergunta: `${aviso} ${r.resposta.pergunta}` }
        : r.resposta.tipo === "nao_suportado" ? { ...r.resposta, mensagem: `${aviso} ${r.resposta.mensagem}` }
          : r.resposta.tipo === "navegacao" && r.resposta.proposta ? { ...r.resposta, proposta: { ...r.resposta.proposta, avisos: [aviso, ...r.resposta.proposta.avisos] } }
            : r.resposta;
      return { resposta };
    }
  }
}

/**
 * A consulta respondida no meio de um rascunho preserva o rascunho e o indica de forma DISCRETA (campo estruturado que a
 * UI mostra numa linha curta). A pergunta pendente não é repetida no texto da resposta.
 */
function comPausa(resposta: AIResponse, pausado: Pausado | null): AIResponse {
  return pausado ? { ...resposta, rascunhoPausado: pausado } : resposta;
}

// ---------------------------------------------------------------- conversa adaptativa (Luna + Demerzel)

/** "Não sei" a uma pergunta de parâmetro: a estimativa existe, mas só se o operador pedir (rotulada como hipótese). */
const DICA_ESTIMATIVA = "Se não souber, posso usar uma estimativa rotulada como hipótese: é só dizer “faça você a definição”.";

/**
 * Leitura escolhida pela Luna como intenção: só capacidade do catálogo (já revalidada); entidade só da TELA aberta —
 * sem ela, "precisa de contexto" (o Planner/Resolver ainda pode ancorar pelo foco). Nunca id vindo do modelo.
 */
function leituraDaLuna(capacidade: string, contexto: ContextoTela | null): Intencao | null {
  const ferramenta = ferramentaRegistrada(capacidade);
  if (!ferramenta || SO_POR_REGRA.has(capacidade) || SO_PLANO.has(capacidade)) return null;
  const origem: OrigemChamada = "INTENCAO_MODELO";
  if (ferramenta.entidade) {
    if (contexto?.tela === ferramenta.entidade && contexto.entidadeId) return { tipo: "leitura", capacidade, parametros: { id: contexto.entidadeId }, origem };
    return { tipo: "precisa_contexto", capacidade, entidade: ferramenta.entidade };
  }
  return { tipo: "leitura", capacidade, parametros: {}, origem };
}

/**
 * Regra × Luna numa CONSULTA: a regra só decide se concordar com o que a Luna entendeu da mensagem inteira. Uma ação
 * casada por palavra numa pergunta, ou uma leitura diferente da escolhida, dá lugar à escolha da Luna (ou ao Planner,
 * quando ela pediu várias consultas). Navegação e buscas com parâmetro continuam das regras (a Luna não as preenche).
 */
function conciliarComLuna(regras: Intencao, luna: Entendimento, contexto: ContextoTela | null): Intencao {
  if (luna.objetivo !== "CONSULTA") return regras;
  const escolhidas = luna.consultas;
  const daLuna = (): Intencao => (escolhidas.length === 1 ? leituraDaLuna(escolhidas[0], contexto) ?? { tipo: "nenhuma" } : { tipo: "nenhuma" });
  if (regras.tipo === "acao") return daLuna();
  // Várias consultas na mesma mensagem ("contratos pendentes E quanto recebemos"): a regra casaria só uma; vai ao Planner.
  if (regras.tipo === "leitura" && new Set(escolhidas).size >= 2 && !SO_POR_REGRA.has(regras.capacidade)) return { tipo: "nenhuma" };
  if (regras.tipo === "leitura" && escolhidas.length && !escolhidas.includes(regras.capacidade) && !SO_POR_REGRA.has(regras.capacidade)) return daLuna();
  return regras;
}

/**
 * Cálculo de consumo a partir do entendimento: categorias e números que a Luna leu da mensagem inteira, por cima da
 * continuação (revalidada) e da extração por regra (complemento). Estimativa só a PEDIDA (rotulada como hipótese).
 * Os convidados vêm sempre da festa no Core — nunca de um rascunho de contratação.
 */
function consumoDaLuna(luna: Entendimento, texto: string, continuacao: ContinuacaoConsumo | undefined): Execucao["consumo"] {
  const base = consumoDoPedido(texto, continuacao);
  const pendentes = continuacao ? (continuacao.categorias ?? [continuacao.categoria]) : [];
  const categorias = [...new Set([...pendentes, ...luna.consumo.categorias, ...(base?.categorias ?? [])])].filter((c): c is CategoriaConsumo => (CATEGORIAS_CONSUMO as readonly string[]).includes(c));
  if (!categorias.length) return undefined;
  const anteriores = (c: CategoriaConsumo): ParametrosConsumo => ({
    ...(continuacao && c === continuacao.categoria ? continuacao.parametros : continuacao?.informados?.[c]),
    ...base?.parametros[c],
  });
  const k = luna.consumo;
  const parametros: Partial<Record<CategoriaConsumo, ParametrosConsumo>> = {};
  const estimativa: NonNullable<NonNullable<Execucao["consumo"]>["estimativa"]> = {};
  for (const c of categorias) {
    const p: ParametrosConsumo = { ...anteriores(c) };
    if (c === "DOCES" && k.docesPorConvidado !== null) p.porConvidado = k.docesPorConvidado;
    if (c === "REFRIGERANTES" && k.mlPorConvidado !== null) p.mlPorConvidado = k.mlPorConvidado;
    if (c === "REFRIGERANTES" && k.embalagemMl !== null) p.embalagemMl = k.embalagemMl;
    if (k.margemPercentual !== null) p.margemPercentual = k.margemPercentual;
    parametros[c] = p;
    if (c === "DOCES" && k.estimativa.porConvidado && p.porConvidado === undefined) estimativa.DOCES = { porConvidado: k.estimativa.porConvidado };
    if (c === "REFRIGERANTES" && k.estimativa.mlPorConvidado && p.mlPorConvidado === undefined) estimativa.REFRIGERANTES = { mlPorConvidado: k.estimativa.mlPorConvidado };
  }
  const festaRef = luna.festa === "PROXIMA" ? { tipo: "PROXIMA" as const } : luna.festa === "POR_DATA" && luna.dataFesta ? { tipo: "DIA" as const, dia: luna.dataFesta } : undefined;
  // Continuação da MESMA festa (dica revalidada no Core), salvo se a mensagem apontou outra festa explicitamente.
  const festaId = !festaRef && luna.festa !== "DA_TELA" ? continuacao?.festaId : undefined;
  return { categorias, parametros, ...(festaId ? { festaId } : {}), ...(Object.keys(estimativa).length ? { estimativa } : {}), ...(festaRef ? { festaRef } : {}) };
}

/** Continuação da conversa como a Luna a vê: categorias pendentes, o que foi perguntado e os números já informados. */
function consumoPendenteParaLuna(c: ContinuacaoConsumo | undefined): ConsumoPendente | null {
  if (!c) return null;
  const numeros = (p: ParametrosConsumo | undefined) => Object.fromEntries(Object.entries(p ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>;
  const informados: ConsumoPendente["informados"] = {};
  for (const cat of c.categorias ?? [c.categoria]) {
    const n = numeros(cat === c.categoria ? c.parametros : c.informados?.[cat]);
    if (Object.keys(n).length) informados[cat as Categoria] = n;
  }
  return { categorias: (c.categorias ?? [c.categoria]) as Categoria[], perguntado: c.perguntado, informados, festaDefinida: Boolean(c.festaId) };
}

type EstadoRascunhoLuna = { operacaoId: string; situacao: SituacaoRascunho } | null;

/** Disponível só com a IA operacional, a Demerzel com o ciclo adaptativo e um provedor para o entendimento. */
function adaptativoDisponivel(deps: DependenciasConversa): boolean {
  return operacionalAtivo(deps.env) && demerzelAtivo(deps.env) && Boolean(deps.orquestrador?.atenderAdaptativo) && Boolean(deps.roteador?.disponivelPara("INTERPRETAR_CONVERSA"));
}

/** Leituras com entidade (âncora única devolvida pelo Core) que a Luna pode pedir como complemento de uma resposta. */
function complementosDe(e: Execucao, resposta: AIResponse, feitas: ReadonlySet<string>) {
  if (resposta.tipo !== "resposta" || !("entidades" in resposta.dados)) return [];
  const ancoras = new Map<string, string>();
  for (const tipo of ["festa", "cliente", "contrato"] as const) {
    const ids = [...new Set((resposta.dados.entidades ?? []).filter((x) => x.tipo === tipo.toUpperCase()).map((x) => x.id))];
    if (ids.length === 1) ancoras.set(tipo, ids[0]);
  }
  const autorizadas = catalogoDisponivel(e.deps.env, e.sessao.papel, e.deps.acoes).filter((c) => c.tipo === "leitura" && !SO_PLANO.has(c.id) && !SO_POR_REGRA.has(c.id));
  return autorizadas.flatMap((c) => {
    const f = ferramentaRegistrada(c.id);
    const id = f?.entidade ? ancoras.get(f.entidade) : undefined;
    return id && !feitas.has(`${c.id}:${id}`) && c.id !== resposta.dados.capacidade ? [{ id: c.id, descricao: c.descricao, ancora: id }] : [];
  }).slice(0, 8);
}

/**
 * Ciclo adaptativo: a Demerzel coordena; esta função fornece as portas GUARDADAS (as mesmas da conversa). Devolve null
 * quando a Luna não entendeu (indisponível, prazo, saída inválida): o caminho anterior responde, como antes.
 */
async function atenderComLuna(e: Execucao, historico: readonly TrocaHistorico[], continuacao: ContinuacaoConsumo | undefined, operacaoId: string | null): Promise<AIResponse | null> {
  const { deps, sessao, pedido, rastreio } = e;
  const relogio = deps.relogio ?? (() => performance.now());
  const inicio = relogio();
  const usos: ModelUsage[] = [];
  const acoes = deps.acoes;
  const noTenant = <T>(fn: (ctx: ContextoExtensao) => Promise<T>) => deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
    rastreio.empresaId = tenant.empresaComprovada;
    exigirGrupoNaEmpresa(deps.env, "ADMIN_ACTIONS", tenant);
    return fn(e.contextoExtensao(tx, tenant));
  });

  // Estado do SERVIDOR: o rascunho é relido no tenant comprovado (dono, empresa, estado e prazo); o cliente só aponta qual.
  let rascunho: EstadoRascunhoLuna = null;
  if (operacaoId && acoes?.situacao && grupoAtivo(deps.env, "ADMIN_ACTIONS")) {
    const situacao = await noTenant((ctx) => acoes.situacao!(operacaoId, e.texto, ctx));
    if (situacao.aberto) rascunho = { operacaoId, situacao };
  }
  const paraLuna: RascunhoParaLuna | null = rascunho ? {
    capacidade: rascunho.situacao.capacidade,
    titulo: rascunho.situacao.titulo,
    estado: rascunho.situacao.perguntado ? "COLETANDO" : "AGUARDANDO_REVISAO",
    perguntaPendente: rascunho.situacao.pergunta,
    camposPreenchidos: rascunho.situacao.preenchidos ?? {},
    pausado: false,
  } : null;

  const alvo = async (capacidade: string) => {
    const tenant = await tenantParaModelo(sessao, pedido, deps, rastreio);
    return { empresaId: tenant.empresaComprovada, estabelecimentoId: unidadeDe(tenant), capacidade, correlationId: rastreio.correlationId ?? rastreio.requestId, hoje: hojeBrasilia(deps.agora()) };
  };
  const anotar = (r: ResultadoRoteado<unknown>) => {
    anotarUsoModelo(rastreio, [...r.usos], r.ok ? undefined : r.recusa);
    usos.push(...r.usos);
  };
  const catalogo = catalogoDisponivel(deps.env, sessao.papel, acoes);
  const consultas = catalogo.filter((c) => c.tipo === "leitura" && !SO_PLANO.has(c.id) && !SO_POR_REGRA.has(c.id)).map((c) => ({ id: c.id, descricao: c.descricao }));
  const acoesCatalogo = catalogo.filter((c) => c.tipo === "acao" && c.id !== "preparar_contratacao").map((c) => ({ id: c.id, descricao: c.descricao }));

  /** Rascunho aberto e a resposta resultante (resposta ao campo, correção, troca de objetivo, cancelar, retomar). */
  const noRascunho = async (r: NonNullable<EstadoRascunhoLuna>, fn: (ctx: ContextoExtensao) => Promise<ResultadoRascunho>) => {
    const resultado = await noTenant(fn);
    anotarRascunho(rastreio, resultado);
    return resultado.resposta;
  };
  const pausa = (resposta: AIResponse) => (rascunho ? comPausa(resposta, { operacaoId: rascunho.operacaoId, titulo: rascunho.situacao.titulo, pergunta: rascunho.situacao.pergunta }) : resposta);

  /** Respostas que já passaram por atenderNovo saem finalizadas (foco, entendimento, continuação). */
  let finalizada = false;
  async function executar(ent: Entendimento): Promise<AIResponse> {
    e.luna = ent;
    rastreio.operacional = { rota: rascunho ? "RASCUNHO" : "CONSUMO", decisao: `LUNA:${ent.objetivo}`, leituras: 0, duracaoMs: 0 };
    // Resposta/correção ao rascunho com objetivo genérico (ex.: "4 horas" no rascunho de pacote): vai ao próprio rascunho,
    // que extrai e revalida o campo. Troca de objetivo, consulta, cancelar e retomar seguem os casos abaixo.
    const aoRascunho = rascunho && acoes && (ent.relacaoRascunho === "RESPONDE" || ent.relacaoRascunho === "CORRIGE") && (ent.objetivo === "ESCLARECER" || ent.objetivo === "CONVERSA" || ent.objetivo === "FORA_DO_ESCOPO");
    if (aoRascunho) {
      const doModelo = rascunho!.situacao.capacidade === "preparar_contratacao" ? ent.contratacao : undefined;
      return noRascunho(rascunho!, (ctx) => acoes!.responder(rascunho!.operacaoId, e.texto, ctx, doModelo));
    }
    // Mensagem MISTA: a Luna diz que a mensagem responde/corrige o rascunho, mas escolheu uma consulta ou um cálculo como
    // objetivo (homologação de f41018e: "o cliente é … E quantos refrigerantes…?" ⇒ RESPONDE + CALCULO_CONSUMO, e o
    // dado do cliente se perdia). Consulta paralela pura vem como CONSULTA_PARALELA/SEM_RASCUNHO, nunca RESPONDE.
    // A resposta ao rascunho vem primeiro (nada do que foi escrito se perde) e o outro pedido é anunciado como não feito.
    const mista = rascunho && acoes && (ent.relacaoRascunho === "RESPONDE" || ent.relacaoRascunho === "CORRIGE") && (ent.objetivo === "CONSULTA" || ent.objetivo === "CALCULO_CONSUMO");
    if (mista) {
      ent.outrosPedidos = Math.max(ent.outrosPedidos, 1);
      rastreio.operacional = { ...rastreio.operacional, decisao: "LUNA:MENSAGEM_MISTA" };
      const doModelo = rascunho!.situacao.capacidade === "preparar_contratacao" ? ent.contratacao : undefined;
      return noRascunho(rascunho!, (ctx) => acoes!.responder(rascunho!.operacaoId, e.texto, ctx, doModelo));
    }
    // Parâmetro de consumo pendente e mensagem sem objetivo novo ("Não estime; quero só a regra cadastrada", "não sei"):
    // é resposta à pergunta do cálculo. Refaz o MESMO cálculo (mesma festa, só o que foi escrito ou delegado), mantendo a
    // continuação — nunca "não entendi", nunca estimativa sem pedido. A resposta sem dado reconhecida por regra vale qualquer
    // que seja o rótulo da Luna (em staging ela chamou "não estime; só a regra cadastrada" de CONSULTA sem consultas).
    const semObjetivoNovo = ent.objetivo === "ESCLARECER" || ent.objetivo === "CONVERSA" || ent.objetivo === "FORA_DO_ESCOPO"
      || (respondeSemDado(e.texto) && !detectarConsumo(e.texto) && !ent.consultas.length);
    if (continuacao && !rascunho && semObjetivoNovo) {
      e.consumo = consumoDaLuna(ent, e.texto, continuacao);
      if (e.consumo) {
        finalizada = true;
        const r = await atenderNovo(e);
        const naoSabe = /\bn[aã]o sei\b/i.test(e.texto) && !Object.keys(e.consumo.estimativa ?? {}).length;
        if (naoSabe && r.tipo === "resposta" && r.continuacao && "fatos" in r.dados) {
          return { ...r, dados: { ...r.dados, resumo: `${r.dados.resumo} ${DICA_ESTIMATIVA}` } };
        }
        return r;
      }
    }
    switch (ent.objetivo) {
      case "CANCELAR_RASCUNHO":
        if (!rascunho || !acoes?.abandonar) return { ...naoSuportado("Não há rascunho aberto para cancelar."), entendimento: "EXECUTADO" };
        return noRascunho(rascunho, (ctx) => acoes.abandonar!(rascunho!.operacaoId, ctx));
      case "RETOMAR_RASCUNHO":
        if (!rascunho || !acoes?.retomar) return { ...naoSuportado("Não há rascunho aberto para retomar."), entendimento: "EXECUTADO" };
        return noRascunho(rascunho, (ctx) => acoes.retomar!(rascunho!.operacaoId, ctx));
      case "PREPARAR_CONTRATACAO":
      case "ACAO": {
        const capacidade = ent.objetivo === "PREPARAR_CONTRATACAO" ? "preparar_contratacao" : ent.acao!;
        const doModelo = capacidade === "preparar_contratacao" ? ent.contratacao : undefined;
        if (rascunho && acoes) {
          // Mesmo objetivo do rascunho ⇒ resposta/correção (nova versão; confirmações antigas deixam de valer).
          if (rascunho.situacao.capacidade === capacidade) return noRascunho(rascunho, (ctx) => acoes.responder(rascunho!.operacaoId, e.texto, ctx, doModelo));
          // Outro objetivo ⇒ troca auditável: o novo rascunho nasce e o antigo é encerrado como SUBSTITUIDO.
          const alvoAcao = acoes.descrever(capacidade);
          if (!alvoAcao || alvoAcao.classe !== "CONFIRM" || alvoAcao.origem === "TELA" || !grupoAtivo(deps.env, alvoAcao.grupo) || !acoes.substituir) {
            return pausa(await responderAcao(capacidade, "INTENCAO_MODELO", e, doModelo));
          }
          const r = await noTenant((ctx) => acoes.substituir!(rascunho!.operacaoId, capacidade, e.texto, ctx, doModelo));
          anotarRascunho(rastreio, r);
          rastreio.propostaAcao = r.capacidade;
          const aviso = `Entendi: troquei o objetivo. O rascunho “${r.anterior}” foi descartado (nada foi gravado).`;
          return r.resposta.tipo === "rascunho" ? { ...r.resposta, pergunta: `${aviso} ${r.resposta.pergunta}` }
            : r.resposta.tipo === "nao_suportado" ? { ...r.resposta, mensagem: `${aviso} ${r.resposta.mensagem}` }
              : r.resposta.tipo === "navegacao" && r.resposta.proposta ? { ...r.resposta, proposta: { ...r.resposta.proposta, avisos: [aviso, ...r.resposta.proposta.avisos] } }
                : r.resposta;
        }
        return responderAcao(capacidade, "INTENCAO_MODELO", e, doModelo);
      }
      case "CALCULO_CONSUMO": {
        e.consumo = consumoDaLuna(ent, e.texto, continuacao);
        if (!e.consumo) return pausa({ ...naoSuportado("Quer que eu calcule doces, refrigerantes ou os dois? E para qual festa?"), entendimento: "PRECISA_DADO" });
        finalizada = true;
        return pausa(await atenderNovo(e));
      }
      case "CONSULTA": {
        // A consulta segue pelas mesmas portas guardadas (regras conciliadas com a Luna, Planner, Policy por leitura).
        e.consumo = undefined;
        finalizada = true;
        // Duas ou mais consultas INDEPENDENTES (nenhuma precisa de entidade de entrada: "contratos pendentes e quanto
        // recebemos"): cada uma pela mesma porta guardada e a composição determinística junta os fatos. O Planner é para
        // cadeias (âncora → relação) e descarta listagens da resposta. Qualquer leitura que não volte ⇒ caminho anterior.
        const independentes = ent.consultas.length >= 2 && ent.consultas.every((id) => {
          const item = catalogo.find((c) => c.id === id);
          return item?.tipo === "leitura" && !item.entidade;
        });
        if (independentes) {
          const partes: ParteResposta[] = [];
          for (const [i, id] of ent.consultas.entries()) {
            const lida = await responderLeitura(id, {}, "INTENCAO_MODELO", e);
            if (lida.tipo !== "resposta" || !("fatos" in lida.dados)) break;
            partes.push({ passoId: `p${i + 1}`, capacidade: id, dados: lida.dados as RespostaLeitura });
          }
          if (partes.length === ent.consultas.length) {
            const c = compor(partes, []);
            if (c.ok) return pausa({ tipo: "resposta", dados: c.dados });
          }
        }
        return pausa(await atenderNovo(e));
      }
      case "CONVERSA":
        return pausa({ ...naoSuportado("Estou aqui. Posso consultar festas, contratos, clientes e o financeiro, calcular doces e bebidas de uma festa ou preparar a contratação de uma festa para a sua revisão."), entendimento: "EXECUTADO" });
      case "ESCLARECER":
      {
        // Criação ambígua ("crie uma do cliente…, pacote…"): o que foi entendido + as frases completas como sugestões.
        const ambigua = criacaoAmbigua(e.texto);
        return pausa({ tipo: "nao_suportado", mensagem: ent.esclarecimento ?? ambigua?.mensagem ?? "Pode me dizer um pouco mais do que você quer fazer?", sugestoes: ambigua?.sugestoes ?? [], entendimento: "AMBIGUO" });
      }
      case "FORA_DO_ESCOPO":
        return pausa({ ...naoSuportado("Ainda não sei responder isso pelo Kidmais. Veja o que consigo fazer agora:"), entendimento: "CAPACIDADE_INDISPONIVEL" });
    }
  }

  const feitas = new Set<string>();
  let baseDeterministica: AIResponse | null = null;
  const resultado = await deps.orquestrador!.atenderAdaptativo!({ texto: e.texto, contexto: e.contexto }, {
    relogio,
    usosDeModelo: () => usos,
    leiturasFeitas: () => e.leiturasFeitas ?? 0,
    async entender() {
      const r = await entenderComModelo({
        texto: e.texto, hoje: hojeBrasilia(deps.agora()), contexto: e.contexto, historico, rascunho: paraLuna,
        consumoPendente: consumoPendenteParaLuna(continuacao), consultas, acoes: acoesCatalogo,
      }, deps.roteador!, await alvo("luna_entender"));
      anotar(r.roteado);
      return r.entendimento;
    },
    executar,
    complementosPossiveis: (resposta) => complementosDe(e, resposta, feitas).map(({ id, descricao }) => ({ id, descricao })),
    async redigir(resposta, ent, possiveis) {
      if (resposta.tipo !== "resposta" || !("fatos" in resposta.dados)) return { resposta, complementos: [] };
      baseDeterministica ??= resposta;
      const r = await redigirComModelo({
        pergunta: e.texto, resposta: resposta.dados, complementos: possiveis,
        faltando: rastreio.plano?.composicao?.faltando ?? [], outrosPedidos: ent.outrosPedidos,
      }, deps.roteador!, await alvo("luna_redigir"));
      anotar(r.roteado);
      if (!r.redacao.texto) return { resposta: { ...resposta, redacao: "DETERMINISTICA" }, complementos: r.redacao.complementos };
      return { resposta: { ...resposta, dados: { ...resposta.dados, resumo: r.redacao.texto }, redacao: "MODELO" }, complementos: r.redacao.complementos };
    },
    async complementar(resposta, ids, maxLeituras) {
      // Recompõe a partir da resposta DETERMINÍSTICA (a redação anterior não entra como fato).
      const base = baseDeterministica ?? resposta;
      if (base.tipo !== "resposta" || !("fatos" in base.dados)) return resposta;
      const opcoes = complementosDe(e, base, feitas);
      const partes: ParteResposta[] = [{ passoId: "r1", capacidade: base.dados.capacidade, dados: base.dados as RespostaLeitura }];
      for (const id of ids.slice(0, Math.max(0, maxLeituras))) {
        const opcao = opcoes.find((o) => o.id === id);
        if (!opcao) continue;
        feitas.add(`${id}:${opcao.ancora}`);
        const lida = await responderLeitura(id, { id: opcao.ancora }, "INTENCAO_MODELO", e).catch(() => null);
        if (lida?.tipo === "resposta" && "fatos" in lida.dados) partes.push({ passoId: `c${partes.length}`, capacidade: id, dados: lida.dados as RespostaLeitura });
      }
      if (partes.length === 1) return base;
      const c = compor(partes, []);
      return c.ok ? { ...base, tipo: "resposta", dados: c.dados } : base;
    },
  });

  rastreio.adaptativo = {
    versao: VERSAO_LUNA,
    objetivo: resultado.entendimento?.objetivo ?? null,
    relacaoRascunho: resultado.entendimento?.relacaoRascunho ?? null,
    consultas: resultado.entendimento?.consultas ?? [],
    categorias: resultado.entendimento?.consumo.categorias ?? [],
    estimativa: Boolean(resultado.entendimento && Object.keys(resultado.entendimento.consumo.estimativa).length),
    correcao: resultado.entendimento?.correcao ?? false,
    outrosPedidos: resultado.entendimento?.outrosPedidos ?? 0,
    outrosDescartados: resultado.entendimento?.outrosDescartados ?? 0,
    chamadasModelo: usos.length,
    leituras: e.leiturasFeitas ?? 0,
    redacao: resultado.redacao,
    parada: resultado.parada,
    fallback: resultado.resposta ? null : resultado.parada,
    duracaoMs: Math.max(0, Math.round(relogio() - inicio)),
  };
  if (!resultado.resposta) {
    // Caminho anterior a seguir: o estado de execução volta ao que era antes do ciclo.
    e.luna = undefined;
    return null;
  }
  // Vários pedidos numa mensagem: um de cada vez, dito com clareza. Só a leitura REDIGIDA pela Luna já menciona os
  // demais (ela recebe outrosPedidos); leitura determinística (redação reprovada, indisponível ou limite) recebe o aviso
  // aqui — senão o pedido não feito sumiria sem explicação (homologação de ec4fac2).
  const outros = resultado.entendimento?.outrosPedidos ?? 0;
  const aviso = "Fiz um pedido por vez: comecei por este; o outro que você mencionou ainda não foi feito.";
  const r0 = resultado.resposta;
  const respostaCiclo: AIResponse = outros && r0.tipo === "rascunho" ? { ...r0, pergunta: `${aviso} ${r0.pergunta}` }
    : outros && r0.tipo === "nao_suportado" ? { ...r0, mensagem: `${r0.mensagem} ${aviso}` }
      : outros && r0.tipo === "resposta" && "fatos" in r0.dados && resultado.redacao !== "MODELO" ? { ...r0, dados: { ...r0.dados, resumo: `${r0.dados.resumo} ${aviso}` } }
        : r0;
  if (finalizada) return respostaCiclo;
  let resposta = finalizar(respostaCiclo, e.texto, rastreio, e.navegacaoPendente, e);
  const continua = continuacaoDa(resposta, e);
  if (continua) resposta = { ...resposta, continuacao: continua };
  return resposta;
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

    const operacional = operacionalAtivo(deps.env);
    const contexto = entrada.contexto ?? null;
    const execucao: Execucao = {
      texto: entrada.texto, sessao, pedido, deps, rastreio, contextoExtensao, contexto, foco: entrada.foco ?? null,
      ...(operacional ? { consumo: consumoDoPedido(entrada.texto, entrada.continuacao) } : {}),
    };

    // Conversa adaptativa: a Luna entende a mensagem inteira (com histórico, rascunho e pendências) ANTES de qualquer
    // regra; a Demerzel coordena o ciclo. Sem entendimento (modelo indisponível, prazo, saída inválida), o caminho
    // anterior responde exatamente como antes.
    if (adaptativoDisponivel(deps)) {
      if (entrada.operacaoId && (!deps.acoes || !grupoAtivo(deps.env, "ADMIN_ACTIONS"))) recursoDesativado();
      const adaptativa = await atenderComLuna(execucao, entrada.historico ?? [], entrada.continuacao, entrada.operacaoId ?? null);
      if (adaptativa) return { status: 200, corpo: { ok: true, data: adaptativa } };
    }

    // Continuação de rascunho: a resposta do operador só edita o rascunho do próprio tenant e usuário.
    if (entrada.operacaoId) {
      const acoes = deps.acoes;
      if (!acoes || !grupoAtivo(deps.env, "ADMIN_ACTIONS")) recursoDesativado();
      rastreio.intencao = "UI";
      const operacaoId = entrada.operacaoId;
      // IA operacional: o coordenador decide o que a mensagem é (resposta, correção, troca de objetivo, consulta,
      // cancelar/retomar). Sem a flag, o comportamento anterior: toda mensagem responde ao rascunho.
      const coordenado = operacional && acoes.situacao ? await coordenar(execucao, acoes, operacaoId) : null;
      if (coordenado && "novo" in coordenado) {
        const resposta = await atenderNovo(execucao);
        return { status: 200, corpo: { ok: true, data: comPausa(resposta, coordenado.pausado) } };
      }
      if (coordenado) return { status: 200, corpo: { ok: true, data: finalizar(coordenado.resposta, entrada.texto, rastreio) } };
      const resultado = await deps.withTenantTransaction(sessao, pedido.empresaSolicitada, async (tx, tenant) => {
        rastreio.empresaId = tenant.empresaComprovada;
        exigirGrupoNaEmpresa(deps.env, "ADMIN_ACTIONS", tenant);
        return acoes.responder(operacaoId, entrada.texto, contextoExtensao(tx, tenant));
      });
      anotarRascunho(rastreio, resultado);
      return { status: 200, corpo: { ok: true, data: finalizar(resultado.resposta, entrada.texto, rastreio) } };
    }

    return { status: 200, corpo: { ok: true, data: await atenderNovo(execucao) } };
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
