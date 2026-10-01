import type { RastreioInteligencia } from "./rastreio.ts";

/**
 * Métricas operacionais da IA, agregadas a partir das linhas de trace (já saneadas, sem texto nem PII).
 * Função pura: serve a um painel, a um job de log ou a um teste; não grava nada.
 *
 * Custo e tokens desconhecidos NUNCA viram zero: um pedido com modelo e custo null conta em
 * `custoDesconhecido`, e a soma de custo fica null se houver qualquer parcela desconhecida.
 */
export type Metricas = {
  pedidos: number;
  porEvento: Record<string, number>;
  porResultado: Record<string, number>;
  porCausa: Record<string, number>;
  porCapacidade: Record<string, number>;
  porPolitica: Record<string, number>;
  porHumanGate: Record<string, number>;
  porClassificadorJev: Record<string, number>;
  porSkill: Record<string, number>;
  fallbacks: number;
  taxaFallback: number;
  fallbacksDeProvedor: number;
  propostasAcao: number;
  latenciaMs: { p50: number; p95: number; max: number };
  chamadasModelo: number;
  tokensEntrada: number | null;
  tokensSaida: number | null;
  custoEstimadoMicros: number | null;
  custoDesconhecido: number;
};

type Linha = Pick<RastreioInteligencia,
  | "evento" | "resultado" | "causa" | "capacidade" | "politica" | "humanGate" | "classificadorJev" | "skills" | "fallback" | "fallbackProvedor"
  | "propostaAcao" | "duracaoMs" | "chamadasModelo" | "tokensEntrada" | "tokensSaida" | "custoEstimadoMicros">;

function contar(mapa: Record<string, number>, chave: string | null) {
  const k = chave ?? "NENHUM";
  mapa[k] = (mapa[k] ?? 0) + 1;
}

function percentil(ordenados: readonly number[], p: number) {
  if (!ordenados.length) return 0;
  return ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)];
}

export function agregarMetricas(linhas: readonly Linha[]): Metricas {
  const m: Metricas = {
    pedidos: linhas.length, porEvento: {}, porResultado: {}, porCausa: {}, porCapacidade: {}, porPolitica: {}, porHumanGate: {}, porClassificadorJev: {}, porSkill: {},
    fallbacks: 0, taxaFallback: 0, fallbacksDeProvedor: 0, propostasAcao: 0, latenciaMs: { p50: 0, p95: 0, max: 0 },
    chamadasModelo: 0, tokensEntrada: 0, tokensSaida: 0, custoEstimadoMicros: 0, custoDesconhecido: 0,
  };
  const duracoes: number[] = [];
  for (const l of linhas) {
    contar(m.porEvento, l.evento);
    contar(m.porResultado, l.resultado);
    contar(m.porCausa, l.causa);
    contar(m.porCapacidade, l.capacidade);
    contar(m.porPolitica, l.politica);
    contar(m.porHumanGate, l.humanGate);
    contar(m.porClassificadorJev, l.classificadorJev);
    for (const s of l.skills) contar(m.porSkill, s);
    if (l.fallback) m.fallbacks += 1;
    if (l.fallbackProvedor) m.fallbacksDeProvedor += 1;
    if (l.propostaAcao) m.propostasAcao += 1;
    duracoes.push(Math.max(0, l.duracaoMs));
    m.chamadasModelo += l.chamadasModelo;
    if (l.chamadasModelo > 0) {
      m.tokensEntrada = m.tokensEntrada === null || l.tokensEntrada === null ? null : m.tokensEntrada + l.tokensEntrada;
      m.tokensSaida = m.tokensSaida === null || l.tokensSaida === null ? null : m.tokensSaida + l.tokensSaida;
      if (l.custoEstimadoMicros === null) {
        m.custoDesconhecido += 1;
        m.custoEstimadoMicros = null;
      } else if (m.custoEstimadoMicros !== null) {
        m.custoEstimadoMicros += l.custoEstimadoMicros;
      }
    }
  }
  duracoes.sort((a, b) => a - b);
  m.latenciaMs = { p50: percentil(duracoes, 50), p95: percentil(duracoes, 95), max: duracoes.at(-1) ?? 0 };
  m.taxaFallback = linhas.length ? Math.round((m.fallbacks / linhas.length) * 10_000) / 10_000 : 0;
  return m;
}
