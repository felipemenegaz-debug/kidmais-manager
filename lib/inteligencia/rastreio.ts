import type { AuditTrace, ModelUsage } from "./contratos.ts";
import type { ResumoOrquestracao } from "./extensoes.ts";
import { VERSAO_POLITICA } from "./politica-v1.ts";
import { VERSAO_REGISTRO } from "./registro-ferramentas.ts";

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
    traceId: correlationId ?? requestId,
    requestId,
    correlationId,
    estabelecimentoId: null,
    skills: [],
    classificadorJev: null,
    propostaAcao: null,
    versaoRegistro: VERSAO_REGISTRO,
    versaoPolitica: VERSAO_POLITICA,
    tokensTotal: null,
    custoConhecidoMicros: 0,
    moedaCusto: null,
    chamadasCustoDesconhecido: 0,
    chamadasTokensDesconhecidos: 0,
    duracaoModeloMs: 0,
    errosModelo: [],
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
    entendimento: null,
    objetivo: null,
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
 * Metadados das chamadas de modelo (nunca texto), ACUMULADOS no pedido — cada chamada (intenção, JEV, explicação,
 * retry, fallback) SOMA, nunca substitui. Provedor e modelo são os da última chamada.
 * - Tokens: soma; qualquer chamada com tokens desconhecidos deixa o total null para sempre neste pedido.
 * - Custo: subtotal conhecido (mesma moeda) + contagem de chamadas de custo desconhecido (preço ausente, uso
 *   desconhecido ou moeda diferente). `custoEstimadoMicros` só é número quando NENHUMA chamada é desconhecida;
 *   nunca "desconhecido + conhecido = conhecido".
 */
const MAX_ERROS_MODELO = 5;

export function anotarUsoModelo(rastreio: RastreioInteligencia, usos: readonly ModelUsage[]) {
  const ultimo = usos.at(-1);
  if (!ultimo) return;
  const anteriores = rastreio.chamadasModelo;
  const somaTokens = (atual: number | null, valores: ReadonlyArray<number | null>) =>
    (anteriores > 0 && atual === null) || valores.some((v) => v === null) ? null : (atual ?? 0) + valores.reduce<number>((t, v) => t + (v as number), 0);
  rastreio.tokensEntrada = somaTokens(rastreio.tokensEntrada, usos.map((u) => u.tokensEntrada));
  rastreio.tokensSaida = somaTokens(rastreio.tokensSaida, usos.map((u) => u.tokensSaida));
  rastreio.tokensTotal = rastreio.tokensEntrada === null || rastreio.tokensSaida === null ? null : rastreio.tokensEntrada + rastreio.tokensSaida;
  rastreio.chamadasTokensDesconhecidos += usos.filter((u) => u.tokensEntrada === null || u.tokensSaida === null).length;
  for (const u of usos) {
    const moedaOk = u.moeda !== null && (rastreio.moedaCusto === null || rastreio.moedaCusto === u.moeda);
    if (u.custoEstimadoMicros === null || !moedaOk) {
      rastreio.chamadasCustoDesconhecido += 1;
      continue;
    }
    rastreio.moedaCusto = u.moeda;
    rastreio.custoConhecidoMicros += u.custoEstimadoMicros;
  }
  rastreio.custoEstimadoMicros = rastreio.chamadasCustoDesconhecido > 0 ? null : rastreio.custoConhecidoMicros;
  rastreio.duracaoModeloMs += usos.reduce((t, u) => t + Math.max(0, u.duracaoMs), 0);
  // H3: só causa classificada + detalhe já saneado pelo adaptador (nunca mensagem/corpo); teto de 5 por pedido.
  for (const u of usos) {
    if (u.erro === null || rastreio.errosModelo.length >= MAX_ERROS_MODELO) continue;
    const d = u.detalheErro ?? null;
    rastreio.errosModelo.push({ causa: u.erro, workload: u.workload, status: d?.status ?? null, tipo: d?.tipo ?? null, codigo: d?.codigo ?? null, parametro: d?.parametro ?? null });
  }
  rastreio.provedor = ultimo.provedor;
  rastreio.modelo = ultimo.modelo;
  rastreio.chamadasModelo = anteriores + usos.length;
  rastreio.fallbackProvedor = rastreio.fallbackProvedor || usos.some((u) => u.fallback);
}

export function anotarSkill(rastreio: RastreioInteligencia, proveniencia: string) {
  if (!rastreio.skills.includes(proveniencia)) rastreio.skills = [...rastreio.skills, proveniencia];
}

/** Resumo da Demerzel: passos, skills e origem do julgamento JEV (só códigos). */
export function anotarOrquestracao(rastreio: RastreioInteligencia, resumo: ResumoOrquestracao) {
  rastreio.orquestracao = resumo;
  for (const s of resumo.skills) anotarSkill(rastreio, s);
  const origem = resumo.julgamento?.origem;
  rastreio.classificadorJev = typeof origem === "string" ? origem : null;
}

// ---------------------------------------------------------------- saneamento (defesa em profundidade)

const CAMPOS = Object.keys(novoRastreio("inteligencia.capacidade", "x")) as Array<keyof RastreioInteligencia>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PII = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}|[^\s@]+@[^\s@]+\.[a-z]{2,}|\(?\d{2}\)?\s?9?\d{4}-?\d{4}|R\$|sk-[a-z0-9]{8,}|bearer\s|postgres(ql)?:\/\//i;

function saneado(valor: unknown, profundidade = 0): unknown {
  if (typeof valor === "string") return UUID.test(valor) ? valor : PII.test(valor) ? "[REDIGIDO]" : valor.slice(0, 160);
  if (typeof valor === "number" || typeof valor === "boolean" || valor === null) return valor;
  if (profundidade > 4) return null;
  if (Array.isArray(valor)) return valor.slice(0, 40).map((v) => saneado(v, profundidade + 1));
  if (typeof valor === "object") return Object.fromEntries(Object.entries(valor).slice(0, 40).map(([k, v]) => [k.slice(0, 60), saneado(v, profundidade + 1)]));
  return null;
}

/**
 * Formato FECHADO na saída: só os campos do contrato (qualquer extra é descartado), strings curtas, e qualquer
 * valor com cara de documento, e-mail, telefone, valor em reais, chave ou connection string vira [REDIGIDO].
 */
export function sanearRastreio(rastreio: RastreioInteligencia): Record<string, unknown> {
  const fonte = rastreio as unknown as Record<string, unknown>;
  return Object.fromEntries(CAMPOS.map((c) => [c, saneado(fonte[c])]));
}

export function registrarRastreio(rastreio: RastreioInteligencia, saida: (linha: string) => void = console.info) {
  saida(`[Kidmais Inteligência] ${JSON.stringify(sanearRastreio(rastreio))}`);
}
