/**
 * AI trace da V1: uma linha JSON por pedido, sem persistência.
 * O formato é fechado de propósito: só identificadores e metadados operacionais.
 * Nunca incluir texto do pedido, nomes, contatos, valores, mensagens de erro, tokens ou secrets.
 */
/** Classificação fechada da causa. Nunca `error.name`, mensagem, stack ou código vindo do erro. */
export type CausaRastreio =
  | "FLAG"
  | "VALIDACAO"
  | "AUTENTICACAO"
  | "POLITICA"
  | "TENANT"
  | "RECUSA_CORE"
  | "BANCO"
  | "DOMINIO"
  | "INESPERADO";

export type RastreioInteligencia = {
  evento: "inteligencia.capacidade";
  requestId: string;
  usuarioId: string | null;
  empresaId: string | null;
  capacidade: string | null;
  ferramenta: string | null;
  resultado: "sucesso" | "negado" | "invalido" | "desativado" | "fallback";
  codigo: string | null;
  estado: string | null;
  itens: number | null;
  causa: CausaRastreio | null;
  fallback: boolean;
  duracaoMs: number;
};

export function registrarRastreio(rastreio: RastreioInteligencia, saida: (linha: string) => void = console.info) {
  saida(`[Kidmais Inteligência] ${JSON.stringify(rastreio)}`);
}
