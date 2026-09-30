/**
 * Demerzel V1 — orquestradora do Kidmais Intelligence. NÃO é superusuária.
 *
 * Decide: que capacidade o pedido precisa, se o JEV julga (sempre, barato), se um modelo é necessário, se uma
 * leitura pode ser feita ou uma ação proposta, e quando parar. NÃO: acessa banco, altera tenant, concede
 * permissão, executa ferramenta fora do registro ou contorna Policy/Human Gate. Tudo o que ela executa passa
 * pelas portas da conversa (PortasOrquestracao), que carregam os guardas da Foundation.
 *
 * Execução determinística, com limites duros: passos, passos com modelo, propostas, custo, prazo global e
 * detecção de ação duplicada. Não existe laço de agente: o fluxo é uma sequência fixa e finita de passos.
 */
export const VERSAO_DEMERZEL = "demerzel-v1.0.0";

export type LimitesDemerzel = {
  /** Passos totais por pedido. */
  maxPassos: number;
  /** Passos que podem chamar modelo (JEV com modelo, interpretação por modelo). */
  maxPassosModelo: number;
  /** Propostas de ação (rascunho sob Human Gate) por pedido. */
  maxPropostas: number;
  /** Teto de custo estimado do pedido, em micro-unidades da moeda; null ⇒ sem teto próprio (vale o orçamento). */
  maxCustoMicros: number | null;
  /** Prazo global do pedido (ms). */
  prazoMs: number;
};

export const LIMITES_DEMERZEL_PADRAO: LimitesDemerzel = Object.freeze({
  maxPassos: 8,
  maxPassosModelo: 2,
  maxPropostas: 1,
  maxCustoMicros: null,
  prazoMs: 8_000,
});

export const TIPOS_PASSO = [
  "INTENCAO_REGRAS", "JULGAMENTO_JEV", "JULGAMENTO_JEV_MODELO", "SUGESTAO_AUXILIAR", "INTENCAO_MODELO",
  "LEITURA", "PROPOSTA_ACAO", "RECUSA", "CONTEXTO", "HUMANO", "SEM_ROTA", "SELECAO_SKILL", "COMPLEMENTO", "COMPLEMENTO_MODELO", "SELECAO_AGENTE", "MARCADORES",
] as const;
export type TipoPasso = (typeof TIPOS_PASSO)[number];

/** Passos que podem gastar modelo (contam em maxPassosModelo e no teto de custo). */
export const PASSOS_COM_MODELO: readonly TipoPasso[] = ["JULGAMENTO_JEV_MODELO", "INTENCAO_MODELO", "COMPLEMENTO_MODELO"];

export const MOTIVOS_PARADA = [
  "LEITURA", "PROPOSTA", "AGENTE", "PRECISA_CONTEXTO", "HUMANO", "NAO_SUPORTADO", "PEDIDO_MISTO",
  "RECUSA_ACAO", "RECUSA_JULGAMENTO", "RECUSA_INJECAO",
  "LIMITE_PASSOS", "LIMITE_MODELO", "LIMITE_PROPOSTAS", "LIMITE_CUSTO", "CUSTO_DESCONHECIDO", "LIMITE_PRAZO", "ACAO_DUPLICADA",
] as const;
export type MotivoParada = (typeof MOTIVOS_PARADA)[number];

/** Limite atingido: a orquestração para em falha fechada, com resposta honesta. */
export class LimiteDemerzel extends Error {
  readonly motivo: MotivoParada;
  constructor(motivo: MotivoParada) {
    super(`Demerzel: ${motivo}`);
    this.name = "LimiteDemerzel";
    this.motivo = motivo;
  }
}
