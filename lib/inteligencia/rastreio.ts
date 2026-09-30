import type { AuditTrace, ModelUsage } from "./contratos.ts";
import type { ResumoOrquestracao } from "./extensoes.ts";

/**
 * AI trace: uma linha JSON por pedido, sem persistência obrigatória.
 * O formato é fechado de propósito: só identificadores e metadados operacionais.
 * Nunca incluir texto do pedido, nomes, contatos, valores, mensagens de erro, prompts, respostas do modelo,
 * chain-of-thought, tokens de sessão, OTP ou secrets.
 *
 * AI trace ≠ auditoria de negócio: a auditoria continua nos serviços de domínio, na mesma transação da mutação.
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
  | "MODELO"
  | "HUMAN_GATE"
  | "TEMPO"
  | "SAIDA"
  | "INESPERADO";

/** `orquestracao`: resumo por passo da orquestradora (Demerzel), só códigos e contagens; null fora dela. */
export type RastreioInteligencia = AuditTrace & { causa: CausaRastreio | null; orquestracao: ResumoOrquestracao | null };

export function novoRastreio(evento: AuditTrace["evento"], requestId: string, correlationId: string | null = requestId): RastreioInteligencia {
  return {
    evento,
    requestId,
    correlationId,
    usuarioId: null,
    empresaId: null,
    capacidade: null,
    ferramenta: null,
    intencao: null,
    politica: null,
    humanGate: null,
    provedor: null,
    modelo: null,
    tokensEntrada: null,
    tokensSaida: null,
    custoEstimadoMicros: null,
    ferramentasSolicitadas: [],
    ferramentasExecutadas: [],
    resultado: "sucesso",
    codigo: null,
    estado: null,
    itens: null,
    causa: null,
    orquestracao: null,
    fallback: false,
    fallbackProvedor: false,
    chamadasModelo: 0,
    duracaoMs: 0,
  };
}

/**
 * Metadados das chamadas de modelo (nunca texto): provedor e modelo da última, tokens e custo somados,
 * troca de provedor. Uma parcela desconhecida (ou moedas diferentes no custo) deixa a soma em null,
 * nunca em zero.
 */
export function anotarUsoModelo(rastreio: RastreioInteligencia, usos: readonly ModelUsage[]) {
  const ultimo = usos.at(-1);
  if (!ultimo) return;
  const soma = (f: (u: ModelUsage) => number | null) => usos.every((u) => f(u) !== null) ? usos.reduce((t, u) => t + (f(u) as number), 0) : null;
  rastreio.provedor = ultimo.provedor;
  rastreio.modelo = ultimo.modelo;
  rastreio.tokensEntrada = soma((u) => u.tokensEntrada);
  rastreio.tokensSaida = soma((u) => u.tokensSaida);
  rastreio.custoEstimadoMicros = usos.every((u) => u.moeda === ultimo.moeda) ? soma((u) => u.custoEstimadoMicros) : null;
  rastreio.chamadasModelo += usos.length;
  rastreio.fallbackProvedor = rastreio.fallbackProvedor || usos.some((u) => u.fallback);
}

export function registrarRastreio(rastreio: RastreioInteligencia, saida: (linha: string) => void = console.info) {
  saida(`[Kidmais Inteligência] ${JSON.stringify(rastreio)}`);
}
