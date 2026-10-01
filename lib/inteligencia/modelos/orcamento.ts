import { z } from "zod";
import type { ModelUsage, MotivoRecusaOrcamento } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";

/**
 * Orçamento com teto real (H6): RESERVA → chamada → RECONCILIAÇÃO.
 *
 * AI_BUDGET_JSON = {
 *   "moeda": "USD",
 *   "porEmpresa": { "custoDiario": 2, "custoMensal": 30, "tokensDiario": 200000, "tokensMensal": 3000000 },
 *   "porCapacidade": { "extrair_documento": { "custoDiario": 1 } },
 *   "estimativa": { "overheadTokens": 512, "tokensPorMensagem": 16, "tokensPorImagem": 6000 }
 * }
 *
 * - Antes de cada chamada reserva-se o MÁXIMO estimado: mensagens + schema de saída + imagens + overhead
 *   configurável (entrada ≤ 1 token por byte UTF-8) + teto de saída. Consumo + reservas + nova ≤ limite.
 * - PERÍODO FIXO (H6): a reserva nasce com a chave do dia e do mês (America/Sao_Paulo) do momento da
 *   reserva. A reconciliação atualiza ESSA reserva e o uso herda ESSES períodos — nunca recalcula o
 *   período pelo horário em que a chamada terminou (virada de dia/mês não move consumo).
 * - Provedor sem `usage` ⇒ USO DESCONHECIDO: a reserva continua contando (nunca vira zero).
 * - Recusa comprovada antes do processamento (sem chave, 4xx) ⇒ a reserva é liberada.
 * - Moedas nunca se somam; limite de custo exige `moeda` igual à da tabela de preços.
 * - Reserva órfã (processo caiu antes de reconciliar): depois do TTL vira ORFA por rotina controlada —
 *   continua contando como consumida; nada é apagado. Uma reconciliação tardia ainda fecha a órfã.
 */
const limitesSchema = z.object({
  custoDiario: z.number().positive().optional(),
  custoMensal: z.number().positive().optional(),
  tokensDiario: z.number().int().positive().optional(),
  tokensMensal: z.number().int().positive().optional(),
}).strict();

const estimativaSchema = z.object({
  overheadTokens: z.number().int().min(0).max(100_000).optional(),
  tokensPorMensagem: z.number().int().min(0).max(10_000).optional(),
  tokensPorImagem: z.number().int().min(0).max(100_000).optional(),
}).strict();

const orcamentoSchema = z.object({
  moeda: z.string().regex(/^[A-Z]{3}$/).optional(),
  porEmpresa: limitesSchema.optional(),
  porCapacidade: z.record(z.string().regex(/^[a-z_]{1,64}$/), limitesSchema).optional(),
  estimativa: estimativaSchema.optional(),
}).strict();

export type Orcamento = z.infer<typeof orcamentoSchema>;
type Limites = z.infer<typeof limitesSchema>;

export const ESTIMATIVA_PADRAO = { overheadTokens: 512, tokensPorMensagem: 16, tokensPorImagem: 6_000 } as const;
/** Reserva ABERTA há mais que isto (bem acima do timeout máximo de modelo, 120 s) é órfã. */
export const TTL_RESERVA_MS = 15 * 60 * 1000;

/** Período contábil fixo: chave do dia ("2026-09-28") ou do mês ("2026-09") em America/Sao_Paulo. */
export type Periodos = { dia: string; mes: string };

export function periodosDe(hoje: string): Periodos {
  return { dia: hoje, mes: hoje.slice(0, 7) };
}

/** Um teto concreto, já resolvido para um período fixo. */
export type LimiteReserva = {
  escopo: "EMPRESA" | "CAPACIDADE";
  capacidade: string | null;
  periodo: { tipo: "DIA" | "MES"; chave: string };
  tokensMax: number | null;
  custoMaxMicros: number | null;
};

export type PedidoReserva = {
  id: string;
  empresaId: string;
  capacidade: string;
  correlationId: string;
  em: string;
  periodos: Periodos;
  tokens: number;
  /** Custo máximo estimado; null quando o preço não é conhecido. */
  custoMicros: number | null;
  moeda: string | null;
  limites: readonly LimiteReserva[];
};

/**
 * Por que uma reserva foi recusada — só códigos fechados, escopo e período (nunca valor de teto ou de consumo), para o
 * trace provar a causa exata sem ler configuração nem banco.
 */
export type { MotivoRecusaOrcamento };
export type RecusaReserva = { motivo: MotivoRecusaOrcamento; escopo: LimiteReserva["escopo"] | null; periodo: LimiteReserva["periodo"]["tipo"] | null };

export const recusaSemLimite = (motivo: MotivoRecusaOrcamento): RecusaReserva => ({ motivo, escopo: null, periodo: null });
export const recusaNoLimite = (motivo: MotivoRecusaOrcamento, limite: LimiteReserva): RecusaReserva => ({ motivo, escopo: limite.escopo, periodo: limite.periodo.tipo });

export type ResultadoReserva = { ok: true } | { ok: false; motivo: "ORCAMENTO" | "INDISPONIVEL"; recusa?: RecusaReserva };

export interface RegistroUso {
  /** Reserva atômica. Recusa se consumo + reservas abertas + esta reserva excederia qualquer limite. */
  reservar(pedido: PedidoReserva): Promise<ResultadoReserva>;
  /** Fecha a reserva com o uso real e grava o uso NOS PERÍODOS DA RESERVA. Tokens null ⇒ USO_DESCONHECIDO. */
  reconciliar(reservaId: string, uso: ModelUsage): Promise<void>;
  /** A chamada não chegou a consumir no provedor: a reserva deixa de contar. Grava o uso (tokens 0). */
  liberar(reservaId: string, uso: ModelUsage): Promise<void>;
  /** Uso sem orçamento configurado (nenhuma reserva). Período do dia de `uso.em`. */
  registrar(uso: ModelUsage): Promise<void>;
  /** Rotina controlada: ABERTA criada antes de `antesDe` vira ORFA (continua contando). Devolve quantas. */
  recuperarOrfas(antesDe: string, empresaId?: string): Promise<number>;
}

/** Estado do orçamento. Não existe "sem limite": sem teto aplicável, nenhuma chamada de modelo. */
export type OrcamentoConfigurado = Orcamento | "INVALIDO" | "AUSENTE";

/** Fail closed: ausente ou inválido ⇒ nenhuma chamada de modelo (causa ORCAMENTO). Sem limite nunca é padrão. */
export function orcamentoDoAmbiente(env: Ambiente): OrcamentoConfigurado {
  const bruto = env.AI_BUDGET_JSON;
  if (!bruto?.trim()) return "AUSENTE";
  try {
    const lido = orcamentoSchema.safeParse(JSON.parse(bruto));
    return lido.success ? lido.data : "INVALIDO";
  } catch {
    return "INVALIDO";
  }
}

/**
 * B1: toda reserva precisa de PELO MENOS um teto aplicável, e todo teto precisa ser utilizável (tokens ou
 * custo > 0). Lista vazia NUNCA significa "sem limite". A mesma regra vale no registro em memória e no
 * PostgreSQL (lib/ia-persistencia/uso.ts repete esta checagem: a persistência não importa código da IA).
 */
export function temTetoAplicavel(limites: readonly LimiteReserva[]) {
  return limites.length > 0 && limites.every((l) => (l.tokensMax !== null && l.tokensMax > 0) || (l.custoMaxMicros !== null && l.custoMaxMicros > 0));
}

const temLimiteDeCusto = (l?: Limites) => l?.custoDiario !== undefined || l?.custoMensal !== undefined;

function limitesDe(l: Limites | undefined, escopo: LimiteReserva["escopo"], capacidade: string | null, periodos: Periodos): LimiteReserva[] {
  if (!l) return [];
  const micros = (v?: number) => (v === undefined ? null : Math.round(v * 1_000_000));
  const lista: LimiteReserva[] = [];
  if (l.tokensDiario !== undefined || l.custoDiario !== undefined) lista.push({ escopo, capacidade, periodo: { tipo: "DIA", chave: periodos.dia }, tokensMax: l.tokensDiario ?? null, custoMaxMicros: micros(l.custoDiario) });
  if (l.tokensMensal !== undefined || l.custoMensal !== undefined) lista.push({ escopo, capacidade, periodo: { tipo: "MES", chave: periodos.mes }, tokensMax: l.tokensMensal ?? null, custoMaxMicros: micros(l.custoMensal) });
  return lista;
}

export type PlanoReserva =
  | { tipo: "RECUSAR"; motivo: MotivoRecusaOrcamento }
  | { tipo: "RESERVAR"; limites: LimiteReserva[] };

/**
 * Decide, sem I/O: recusa (orçamento ausente ou inválido, nenhum teto aplicável à empresa/capacidade atual,
 * teto de custo sem preço conhecido ou com moeda divergente) ou reserva com os tetos resolvidos no período
 * fixo. Teto de tokens não depende de preço; teto de custo exige preço e moeda iguais.
 */
export function planejarReserva(orcamento: OrcamentoConfigurado, alvo: { capacidade: string; hoje: string; moedaPreco: string | null; precoConhecido: boolean }): PlanoReserva {
  if (orcamento === "INVALIDO" || orcamento === "AUSENTE") return { tipo: "RECUSAR", motivo: orcamento };
  const daCapacidade = orcamento.porCapacidade?.[alvo.capacidade];
  if (temLimiteDeCusto(orcamento.porEmpresa) || temLimiteDeCusto(daCapacidade)) {
    if (!alvo.precoConhecido || !orcamento.moeda || orcamento.moeda !== alvo.moedaPreco) return { tipo: "RECUSAR", motivo: "SEM_PRECO" };
  }
  const periodos = periodosDe(alvo.hoje);
  const limites = [...limitesDe(orcamento.porEmpresa, "EMPRESA", null, periodos), ...limitesDe(daCapacidade, "CAPACIDADE", alvo.capacidade, periodos)];
  // `{}`, `{"porEmpresa":{}}` ou limite só de OUTRA capacidade: nenhum teto aplicável ⇒ não chama.
  if (!temTetoAplicavel(limites)) return { tipo: "RECUSAR", motivo: "SEM_TETO" };
  return { tipo: "RESERVAR", limites };
}

/**
 * Teto de entrada, conservador: 1 token por byte UTF-8 das mensagens E do schema de saída enviado,
 * mais folga por mensagem, por imagem e overhead fixo (configuráveis em `estimativa`).
 */
export function estimarTokensEntrada(
  pedido: { mensagens: ReadonlyArray<{ conteudo: string }>; imagens?: readonly unknown[]; esquema?: { schema: unknown } },
  estimativa: Orcamento["estimativa"] = {},
) {
  const e = { ...ESTIMATIVA_PADRAO, ...estimativa };
  const bytes = pedido.mensagens.reduce((t, m) => t + Buffer.byteLength(m.conteudo, "utf8"), 0);
  const schema = pedido.esquema ? Buffer.byteLength(JSON.stringify(pedido.esquema.schema), "utf8") : 0;
  return bytes + schema + pedido.mensagens.length * e.tokensPorMensagem + (pedido.imagens?.length ?? 0) * e.tokensPorImagem + e.overheadTokens;
}

/**
 * Qual teto a reserva excederia (null = cabe). Mesma regra nas implementações em memória e PostgreSQL: tokens primeiro;
 * no custo, preço desconhecido e consumo de custo desconhecido no período também recusam (fail closed).
 */
export function limiteExcedido(limite: LimiteReserva, pedido: Pick<PedidoReserva, "tokens" | "custoMicros">, atual: { tokens: number; custo: number; custoDesconhecido: boolean }): MotivoRecusaOrcamento | null {
  if (limite.tokensMax !== null && atual.tokens + pedido.tokens > limite.tokensMax) return "TETO_TOKENS";
  if (limite.custoMaxMicros === null) return null;
  if (pedido.custoMicros === null) return "SEM_PRECO";
  if (atual.custoDesconhecido) return "CUSTO_DESCONHECIDO";
  return atual.custo + pedido.custoMicros > limite.custoMaxMicros ? "TETO_CUSTO" : null;
}

// ---------------------------------------------------------------- implementação em memória (testes)

type EstadoReserva = "ABERTA" | "RECONCILIADA" | "LIBERADA" | "USO_DESCONHECIDO" | "ORFA";
type ReservaMemoria = PedidoReserva & { estado: EstadoReserva };
type UsoMemoria = ModelUsage & { periodos: Periodos };

const tokensConhecidos = (u: ModelUsage) => u.tokensEntrada !== null && u.tokensSaida !== null;
/** Estados em que a reserva ainda conta como consumo. */
export const CONTA_COMO_CONSUMO: readonly EstadoReserva[] = ["ABERTA", "USO_DESCONHECIDO", "ORFA"];

/** Dia/mês de um instante em America/Sao_Paulo (UTC-3, sem horário de verão desde 2019). */
export function periodosDoInstante(iso: string): Periodos {
  const local = new Date(Date.parse(iso) - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return periodosDe(local);
}

/**
 * Mesma semântica da implementação PostgreSQL. `reservar` confere e grava sem nenhum `await` no meio,
 * então duas reservas simultâneas nunca leem o mesmo saldo (equivalente ao advisory lock por empresa).
 */
export function criarRegistroUsoEmMemoria(): RegistroUso & { usos: UsoMemoria[]; reservas: Map<string, ReservaMemoria> } {
  const usos: UsoMemoria[] = [];
  const reservas = new Map<string, ReservaMemoria>();
  const noPeriodo = (p: Periodos, limite: LimiteReserva) => (limite.periodo.tipo === "DIA" ? p.dia : p.mes) === limite.periodo.chave;
  const consumo = (empresaId: string, limite: LimiteReserva, moeda: string | null) => {
    const doEscopo = (capacidade: string) => limite.capacidade === null || capacidade === limite.capacidade;
    const reais = usos.filter((u) => u.empresaId === empresaId && noPeriodo(u.periodos, limite) && doEscopo(u.capacidade));
    const abertas = [...reservas.values()].filter((r) => r.empresaId === empresaId && noPeriodo(r.periodos, limite) && doEscopo(r.capacidade) && CONTA_COMO_CONSUMO.includes(r.estado));
    const tokens = reais.filter(tokensConhecidos).reduce((t, u) => t + (u.tokensEntrada ?? 0) + (u.tokensSaida ?? 0), 0) + abertas.reduce((t, r) => t + r.tokens, 0);
    const custoDesconhecido = reais.some((u) => tokensConhecidos(u) && u.erro !== "HTTP_4XX" && (u.custoEstimadoMicros === null || u.moeda !== moeda))
      || abertas.some((r) => r.custoMicros === null || r.moeda !== moeda);
    const custo = reais.filter((u) => u.moeda === moeda).reduce((t, u) => t + (u.custoEstimadoMicros ?? 0), 0) + abertas.filter((r) => r.moeda === moeda).reduce((t, r) => t + (r.custoMicros ?? 0), 0);
    return { tokens, custo, custoDesconhecido };
  };
  const encerrar = (id: string, estado: EstadoReserva) => {
    const r = reservas.get(id);
    if (!r || (r.estado !== "ABERTA" && r.estado !== "ORFA")) throw new Error("RESERVA_INEXISTENTE_OU_ENCERRADA");
    if (estado === "LIBERADA" && r.estado === "ORFA") throw new Error("RESERVA_ORFA_NAO_LIBERA");
    r.estado = estado;
    return r;
  };
  return {
    usos,
    reservas,
    async reservar(pedido) {
      if (!temTetoAplicavel(pedido.limites)) return { ok: false, motivo: "ORCAMENTO", recusa: recusaSemLimite("SEM_TETO") };
      for (const limite of pedido.limites) {
        const atual = consumo(pedido.empresaId, limite, pedido.moeda);
        const motivo = limiteExcedido(limite, pedido, atual);
        if (motivo) return { ok: false, motivo: "ORCAMENTO", recusa: recusaNoLimite(motivo, limite) };
      }
      reservas.set(pedido.id, { ...pedido, estado: "ABERTA" });
      return { ok: true };
    },
    async reconciliar(id, uso) {
      const r = encerrar(id, tokensConhecidos(uso) ? "RECONCILIADA" : "USO_DESCONHECIDO");
      usos.push({ ...uso, periodos: r.periodos });
    },
    async liberar(id, uso) {
      const r = encerrar(id, "LIBERADA");
      usos.push({ ...uso, periodos: r.periodos });
    },
    async registrar(uso) { usos.push({ ...uso, periodos: periodosDoInstante(uso.em) }); },
    async recuperarOrfas(antesDe, empresaId) {
      let n = 0;
      for (const r of reservas.values()) {
        if (r.estado === "ABERTA" && Date.parse(r.em) < Date.parse(antesDe) && (!empresaId || r.empresaId === empresaId)) { r.estado = "ORFA"; n += 1; }
      }
      return n;
    },
  };
}
