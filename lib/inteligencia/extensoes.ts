import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { AIResponse, ClasseAcao, GrupoFlag } from "./contratos.ts";

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

/** Chave tipada de uma extensão. Cada feature cria as suas; o CORE só conhece as dele. */
export type ChaveExtensao<T> = { readonly nome: string; readonly __tipo?: T };

export function chaveExtensao<T>(nome: string): ChaveExtensao<T> {
  return Object.freeze({ nome });
}

export const CHAVE_MODULO_ACOES = chaveExtensao<ModuloAcoes>("core.modulo-acoes");
export const CHAVE_CLASSIFICADOR_AUXILIAR = chaveExtensao<ClassificadorAuxiliar>("core.classificador-auxiliar");

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
