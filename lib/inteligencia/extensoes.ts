import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { AIResponse, ClasseAcao, ComplementoCopiloto, ContextoTela, GrupoFlag, ModelUsage, OrigemChamada, RespostaLeitura } from "./contratos.ts";
import type { AtencaoHoje } from "./atencao-hoje.ts";
import type { ContextoModelo } from "./contexto/contrato.ts";
import type { CapacidadeCatalogo, Intencao } from "./intencao.ts";
import type { ResultadoRoteado } from "./modelos/roteador.ts";
import type { PedidoModelo } from "./modelos/tipos.ts";

/**
 * Pontos de extensão do CORE (contratos neutros).
 *
 * O CORE não importa nenhuma feature (ações, documentos, importação). Cada feature registra a própria
 * contribuição num `RegistroExtensoes`, a partir do seu arquivo de composição. Sem nenhuma feature
 * registrada, a IA funciona só com leituras e responde "ainda não disponível" aos pedidos de ação.
 */
export type DescricaoAcao = {
  capacidade: string;
  ferramenta: string;
  classe: Extract<ClasseAcao, "CONFIRM" | "DENY">;
  grupo: GrupoFlag;
  papeis: readonly string[];
  descricao: string;
  /** "TELA": só começa pela tela própria; a conversa nunca a abre. */
  origem: "CONVERSA" | "TELA";
  mensagemNegada?: string;
  /** DENY por indisponibilidade (não por proibição): continua DENY; só muda a explicação. */
  indisponivel?: boolean;
};

export type ContextoExtensao = {
  tx: DbExecutor;
  tenant: TenantComprovado;
  sessao: { usuario_id: string; papel: string };
  correlationId: string;
};

/** O que a conversa precisa de um módulo de ações (Human Gate). Implementado pela feature ACTIONS. */
export interface ModuloAcoes {
  descrever(capacidade: string): DescricaoAcao | null;
  todas(): readonly DescricaoAcao[];
  /** Abre um rascunho. Nunca executa mutação de negócio. */
  iniciar(capacidade: string, texto: string, ctx: ContextoExtensao): Promise<{ resposta: AIResponse; capacidade: string; ferramenta: string }>;
  /** Resposta do operador a um rascunho aberto (do mesmo tenant e usuário). */
  responder(operacaoId: string, texto: string, ctx: ContextoExtensao): Promise<{ resposta: AIResponse; capacidade: string; ferramenta: string }>;
  /** IA operacional: o que a mensagem é para o rascunho (sem alterar nada), para o coordenador da conversa decidir. */
  situacao?(operacaoId: string, texto: string, ctx: ContextoExtensao): Promise<SituacaoRascunho>;
  /** IA operacional: encerra o rascunho sem executar (cancelamento pedido em texto), registrando o motivo. */
  abandonar?(operacaoId: string, ctx: ContextoExtensao): Promise<{ resposta: AIResponse; capacidade: string; ferramenta: string }>;
  /** IA operacional: troca de objetivo — abre o novo rascunho e encerra o antigo como SUBSTITUIDO, na mesma transação. */
  substituir?(operacaoId: string, capacidade: string, texto: string, ctx: ContextoExtensao): Promise<{ resposta: AIResponse; capacidade: string; ferramenta: string; anterior: string }>;
  /** IA operacional: reapresenta o passo atual do rascunho (pergunta pendente ou revisão), sem escrita. */
  retomar?(operacaoId: string, ctx: ContextoExtensao): Promise<{ resposta: AIResponse; capacidade: string; ferramenta: string }>;
}

export type SituacaoRascunho = {
  capacidade: string;
  ferramenta: string;
  titulo: string;
  /** COLETANDO/AGUARDANDO e dentro do prazo. */
  aberto: boolean;
  /** Campo da pergunta pendente (null na prévia). */
  perguntado: string | null;
  pergunta: string | null;
  /** A mensagem traz dado para o campo perguntado (extração determinística da própria ação). */
  respondeCampo: boolean;
  /** A mensagem traz algum dado reconhecível deste rascunho (correção de outro campo). */
  trazDados: boolean;
};

/**
 * Classificador AUXILIAR (ex.: JEV). Só SUGERE uma rota depois que as regras determinísticas não
 * entenderam o pedido. Não é Model Router, não é Policy, não é Human Gate e não é autoridade de
 * tenant/RBAC: a conversa confere a sugestão contra o catálogo permitido e a política. Nunca abre ação.
 */
export type SugestaoRota =
  | { tipo: "LEITURA"; capacidade: string }
  | { tipo: "HUMANO" }
  | { tipo: "LLM" }
  | { tipo: "NENHUMA" };

export interface ClassificadorAuxiliar {
  /** Sugestão para o texto; `null` quando indisponível (a conversa segue o roteamento normal). */
  sugerirRota(texto: string, catalogo: ReadonlyArray<{ id: string; tipo: "leitura" | "acao" }>, sinal: AbortSignal): Promise<{ sugestao: SugestaoRota; motivos: readonly string[] } | null>;
}

/**
 * Porta de modelo já ligada, por quem compõe, ao tenant comprovado e ao orçamento/pricing do Model Router.
 * Quem a recebe (ex.: JEV dentro da orquestradora) nunca vê empresa nem usuário.
 */
export type PortaModeloClassificacao = {
  disponivel(): boolean;
  executar<T>(pedido: PedidoModelo<T>): Promise<ResultadoRoteado<T>>;
};

/**
 * Tudo o que uma orquestradora pode fazer, montado pela conversa (CORE) a cada pedido. Cada porta passa pelos
 * guardas da Foundation: leitura = registro fechado + Policy + Tenant Context + serviço de domínio; ação =
 * Human Gate (só rascunho; a confirmação é outro endpoint, com clique humano). Nenhuma porta aceita tenant,
 * usuário, papel, SQL ou ferramenta livre, e nenhuma executa mutação de negócio.
 */
export type PortasOrquestracao = {
  /** Capacidades que o operador pode usar agora (papel + flags). A orquestradora só escolhe entre estas. */
  catalogo: readonly CapacidadeCatalogo[];
  /** Regras determinísticas (sem rede, sem custo). */
  interpretar(texto: string, contexto: ContextoTela | null): Intencao;
  /** Classificador auxiliar legado (V0), quando instalado e ligado; null ⇒ indisponível. */
  sugerirRota(texto: string, contexto: ContextoTela | null): Promise<Intencao | null>;
  /** Classificação ECONOMY num enum fechado de capacidades; null ⇒ sem provedor/orçamento. */
  interpretarComModelo(texto: string, contexto: ContextoTela | null): Promise<Intencao | null>;
  /** Porta de modelo para o julgamento (JEV), já com tenant/orçamento; null ⇒ só regras. */
  portaModelo(): Promise<PortaModeloClassificacao | null>;
  /** Leitura pelo caminho único do gateway (registro fechado + Policy + Tenant Context). */
  ler(capacidade: string, parametros: Record<string, unknown>, origem: OrigemChamada): Promise<AIResponse>;
  /** Abre (ou recusa) rascunho sob Human Gate. Nunca executa a ação. */
  propor(capacidade: string, texto: string, origem: OrigemChamada): Promise<AIResponse>;
  descreverAcao(capacidade: string): DescricaoAcao | null;
  /** Metadados de uso de modelo acumulados neste pedido (sem texto): trace e controle de custo. */
  usosDeModelo(): readonly ModelUsage[];
  /** Resumo por passo para o trace, gravado também quando uma porta falha (ex.: Policy 403). */
  registrarResumo(resumo: ResumoOrquestracao): void;
  /**
   * Skill (playbook) aplicável à finalidade, resolvida com o tenant comprovado pela conversa
   * (Plataforma → Empresa → Estabelecimento). null ⇒ nenhuma aplicável ou catálogo não instalado.
   */
  skill(finalidade: FinalidadeSkill, capacidade: string | null): Promise<SkillAplicavel | null>;
  /**
   * Complemento do Copiloto a uma resposta READ já autorizada: próxima ação (procedimento de skill) e, se pedido,
   * explicação por modelo sobre o contexto MINIMIZADO pelo Context Builder. Nunca muda os dados da resposta;
   * sem Copiloto, falha ou recusa do contexto, devolve a resposta como veio.
   */
  complementar(resposta: AIResponse, opcoes: { explicar: boolean }): Promise<AIResponse>;
  /** Registro de agentes (feature AGENTES), quando instalado; null ⇒ só o fluxo da orquestradora. */
  agentes: RegistroAgentes | null;
  /** Planner (PR 6): planos curtos de capacidades fechadas; ausente ⇒ uma intenção por pedido, como antes. */
  planejador?: PortaPlanejador | null;
  /** Valores de marcadores de template para a entidade aberta, lidos pelo Core no tenant comprovado. */
  marcadores(): Promise<Readonly<Record<string, string>>>;
  relogio(): number;
};

/**
 * Planner + executor (PR 6). `ler` é a leitura CONTADA pela orquestradora (limites, duplicidade, prazo, trace; Policy
 * e Tenant Context no gateway). Saída: a intenção FINAL (despachada pelo caminho atual — leitura, navegação ou proposta
 * sob Human Gate) ou uma resposta honesta de parada (ambíguo, sem dados, negado). null ⇒ sem plano: segue o fluxo atual.
 */
export type SaidaPlanejador = { intencao: Intencao } | { resposta: AIResponse };
export type EntradaPlanejador = { texto: string; contexto: ContextoTela | null; regras: Intencao };
export type PortaPlanejador = {
  planejar(entrada: EntradaPlanejador, ler: (capacidade: string, parametros: Record<string, unknown>) => Promise<AIResponse>): Promise<SaidaPlanejador | null>;
  /** O pedido compõe recursos (e o modelo pode planejar)? Sem rede, sem custo. */
  pedeComposicao(texto: string): boolean;
  /** Plano pelo modelo (workload PLANEJAR); `exigirAcaoFinal` quando o julgamento pede CONFIRM. null ⇒ sem plano válido. */
  planejarComModelo(entrada: EntradaPlanejador, ler: (capacidade: string, parametros: Record<string, unknown>) => Promise<AIResponse>, exigirAcaoFinal: boolean): Promise<SaidaPlanejador | null>;
  /**
   * Fecha o plano com o resultado do despacho do passo final: trace e, em resposta de leitura, a composição
   * determinística dos fatos (PR 6.4). Devolve a resposta a entregar (a mesma, se não houver composição).
   */
  concluir(resposta: AIResponse): AIResponse;
};

export type PassoOrquestracao = { tipo: string; resultado: string; duracaoMs: number };

/** Resumo da orquestração para o trace: só códigos, contagens e duração. Nunca texto do pedido. */
export type ResumoOrquestracao = {
  versao: string;
  passos: readonly PassoOrquestracao[];
  parada: string;
  chamadasModelo: number;
  custoEstimadoMicros: number | null;
  julgamento: Readonly<Record<string, string | number>> | null;
  /** Skills aplicadas, como `id@versao#hash8` (proveniência rastreável, sem conteúdo). */
  skills: readonly string[];
};

// ---------------------------------------------------------------- skills (contratos neutros)

/** Para que uma skill serve. Nenhuma finalidade é de autorização: skill orienta forma e conteúdo, nunca poder. */
export type FinalidadeSkill = "TOM" | "ATENDIMENTO" | "SUGESTAO_TEXTO" | "PROCEDIMENTO" | "OBJECAO" | "FORMATACAO";

/**
 * Conteúdo de uma skill: orientação de forma e de atendimento. Preço, desconto, permissão, papel, acesso,
 * alteração financeira, contrato e desvio de Policy NUNCA vêm daqui (a validação da feature SKILLS recusa).
 * Templates só têm marcadores de uma lista fechada, preenchidos com dados do Core — nunca pela skill.
 */
export type ConteudoSkill = {
  tom: string | null;
  instrucoes: readonly string[];
  procedimentos: ReadonlyArray<{ titulo: string; passos: readonly string[] }>;
  objecoes: ReadonlyArray<{ objecao: string; resposta: string }>;
  templates: ReadonlyArray<{ id: string; titulo: string; texto: string; marcadores: readonly string[] }>;
  formatacao: { maxParagrafos: number | null; usarListas: boolean | null };
};

export type NivelSkill = "PLATAFORMA" | "EMPRESA" | "ESTABELECIMENTO";

/** Skill já resolvida (cadeia mesclada, validada e revisada). Só o que é seguro levar ao pedido. */
export type SkillAplicavel = {
  id: string;
  versao: string;
  /** Hash da cadeia aplicada (cada nível contribui com o próprio hash revisado). */
  hash: string;
  nivel: NivelSkill;
  cadeia: ReadonlyArray<{ nivel: NivelSkill; versao: string; hash: string }>;
  conteudo: ConteudoSkill;
  restricoes: readonly string[];
};

/** Catálogo de skills (feature SKILLS). Tenant e estabelecimento vêm SEMPRE do Tenant Context, nunca do pedido. */
export interface CatalogoSkills {
  /**
   * `niveis`: camadas que a Policy permite neste pedido (ausente ⇒ todas). Resolução determinística:
   * Plataforma (base) → Empresa (override) → Estabelecimento (override da unidade COMPROVADA).
   */
  resolver(alvo: { empresaId: string; estabelecimentoId: string | null; finalidade: FinalidadeSkill; capacidade: string | null; niveis?: readonly NivelSkill[] }): Promise<SkillAplicavel | null>;
}

export type ResultadoOrquestracao = { resposta: AIResponse; resumo: ResumoOrquestracao };

/**
 * Orquestradora (ex.: Demerzel). Decide o caminho, nunca a autoridade: não recebe banco, tenant nem sessão;
 * só as portas acima. Falha dela ⇒ fallback seguro da conversa (nunca o caminho sem guardas).
 */
export interface Orquestrador {
  atender(entrada: { texto: string; contexto: ContextoTela | null }, portas: PortasOrquestracao): Promise<ResultadoOrquestracao>;
}

/** Chave tipada de uma extensão. Cada feature cria as suas; o CORE só conhece as dele. */
export type ChaveExtensao<T> = { readonly nome: string; readonly __tipo?: T };

export function chaveExtensao<T>(nome: string): ChaveExtensao<T> {
  return Object.freeze({ nome });
}

export const CHAVE_MODULO_ACOES = chaveExtensao<ModuloAcoes>("core.modulo-acoes");
export const CHAVE_CLASSIFICADOR_AUXILIAR = chaveExtensao<ClassificadorAuxiliar>("core.classificador-auxiliar");
export const CHAVE_ORQUESTRADOR = chaveExtensao<Orquestrador>("core.orquestrador");
export const CHAVE_CATALOGO_SKILLS = chaveExtensao<CatalogoSkills>("core.catalogo-skills");
export const CHAVE_COPILOTO = chaveExtensao<Complementador>("core.copiloto");
export const CHAVE_AGENTES = chaveExtensao<RegistroAgentes>("core.agentes");

/** Contêiner de extensões por pedido. Valores podem ser preguiçosos (montados na primeira leitura). */
export class RegistroExtensoes {
  private readonly valores = new Map<string, () => unknown>();
  private readonly cache = new Map<string, unknown>();

  definir<T>(chave: ChaveExtensao<T>, fabrica: () => T) {
    if (this.valores.has(chave.nome)) throw new Error(`Extensão duplicada: ${chave.nome}`);
    this.valores.set(chave.nome, fabrica);
  }

  obter<T>(chave: ChaveExtensao<T>): T | null {
    if (this.cache.has(chave.nome)) return this.cache.get(chave.nome) as T;
    const fabrica = this.valores.get(chave.nome);
    if (!fabrica) return null;
    const valor = fabrica() as T;
    this.cache.set(chave.nome, valor);
    return valor;
  }

  /** Lista acumulável (ex.: ações de várias features). */
  lista<T>(chave: ChaveExtensao<T[]>): T[] {
    if (!this.valores.has(chave.nome)) {
      const itens: T[] = [];
      this.valores.set(chave.nome, () => itens);
      this.cache.set(chave.nome, itens);
    }
    return this.obter(chave) as T[];
  }
}

/**
 * Complementador do Copiloto (feature COPILOTO). Recebe só o que é seguro: a leitura já autorizada pelo gateway,
 * o contexto de modelo já minimizado (Context Builder), a skill de procedimento já resolvida no tenant comprovado
 * e uma porta de modelo com orçamento. Não recebe banco, tenant, sessão nem ferramenta.
 */
export interface Complementador {
  complementar(entrada: {
    capacidade: string;
    dados: RespostaLeitura | AtencaoHoje;
    contextoModelo: { contexto: ContextoModelo; json: string } | null;
    procedimento: SkillAplicavel | null;
    explicar: boolean;
    modelo: PortaModeloClassificacao | null;
  }): Promise<ComplementoCopiloto | null>;
}

/** O que um agente pode usar: só leitura, proposta sob Human Gate, skills e marcadores — tudo guardado. */
export type PortasAgente = Pick<PortasOrquestracao, "catalogo" | "ler" | "propor" | "descreverAcao" | "skill" | "marcadores">;

/**
 * Registro de agentes (feature AGENTES). Cada agente tem um plano FECHADO e uma lista própria de capacidades;
 * não escolhe ferramenta livre, não recebe banco/tenant/sessão, não executa mutação (só propõe pelo Human Gate).
 */
export interface RegistroAgentes {
  selecionar(entrada: { texto: string; contexto: ContextoTela | null; julgamento: Readonly<Record<string, string | number>>; regras: Intencao }): { id: string; motivo: string } | null;
  executar(id: string, entrada: { texto: string; contexto: ContextoTela | null; regras: Intencao; motivo: string }, portas: PortasAgente): Promise<AIResponse>;
}
