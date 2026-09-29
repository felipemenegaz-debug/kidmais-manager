import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { AIResponse, ClasseAcao, ContextoTela, GrupoFlag, ModelUsage, OrigemChamada } from "./contratos.ts";
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
}

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
  relogio(): number;
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
};

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
