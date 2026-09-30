import type { DbExecutor } from "../db/contracts.ts";
import type { ModelUsage } from "../inteligencia/contratos.ts";
import type { LimiteReserva, PedidoReserva, RegistroUso, ResultadoReserva } from "../inteligencia/modelos/orcamento.ts";

/**
 * Uso de modelos e reservas de orçamento em PostgreSQL (`ia_uso_modelo`, `ia_orcamento_reservas`,
 * migration 055a — NÃO aplicada).
 *
 * Conexão própria, fora da transação do pedido: chamadas de modelo nunca acontecem com transação de
 * negócio aberta. A reserva roda numa transação curta com `pg_advisory_xact_lock` por empresa: duas
 * chamadas simultâneas da mesma empresa nunca leem o mesmo saldo.
 *
 * PERÍODO FIXO: consumo é somado por `periodo_dia` / `periodo_mes`, gravados na reserva no momento em que
 * ela nasce. A reconciliação copia os períodos DA RESERVA para o uso (nunca do horário final da chamada).
 *
 * Sem as tabelas: `registrar` escreve uma linha de log (sem PII) e `reservar` responde INDISPONIVEL,
 * então um orçamento configurado bloqueia chamadas (fail closed) em vez de gastar sem medir.
 */
export type BancoUso = {
  executor(): DbExecutor;
  transacao<T>(trabalho: (tx: DbExecutor) => Promise<T>): Promise<T>;
};

/** Reservas que ainda contam como consumo. */
const CONTAM = "('ABERTA', 'USO_DESCONHECIDO', 'ORFA')";

const CONSUMO = `
  WITH ia_uso_periodo AS (
    SELECT tokens_entrada, tokens_saida, custo_estimado_micros, moeda, erro
      FROM ia_uso_modelo
     WHERE empresa_id = $1::uuid
       AND ($2::date IS NULL OR periodo_dia = $2::date) AND ($3::text IS NULL OR periodo_mes = $3)
       AND ($4::text IS NULL OR capacidade = $4)
  ), ia_reservas_periodo AS (
    SELECT tokens_reservados, custo_reservado_micros, moeda
      FROM ia_orcamento_reservas
     WHERE empresa_id = $1::uuid
       AND ($2::date IS NULL OR periodo_dia = $2::date) AND ($3::text IS NULL OR periodo_mes = $3)
       AND ($4::text IS NULL OR capacidade = $4)
       AND estado IN ${CONTAM}
  )
  SELECT (COALESCE((SELECT SUM(tokens_entrada + tokens_saida) FROM ia_uso_periodo WHERE tokens_entrada IS NOT NULL AND tokens_saida IS NOT NULL), 0)
          + COALESCE((SELECT SUM(tokens_reservados) FROM ia_reservas_periodo), 0))::text AS tokens,
         (COALESCE((SELECT SUM(custo_estimado_micros) FROM ia_uso_periodo WHERE moeda = $5), 0)
          + COALESCE((SELECT SUM(custo_reservado_micros) FROM ia_reservas_periodo WHERE moeda = $5), 0))::text AS custo,
         (EXISTS (SELECT 1 FROM ia_uso_periodo
                   WHERE tokens_entrada IS NOT NULL AND tokens_saida IS NOT NULL AND erro IS DISTINCT FROM 'HTTP_4XX'
                     AND (custo_estimado_micros IS NULL OR moeda IS DISTINCT FROM $5))
          OR EXISTS (SELECT 1 FROM ia_reservas_periodo WHERE custo_reservado_micros IS NULL OR moeda IS DISTINCT FROM $5)) AS desconhecido`;

async function excede(tx: DbExecutor, pedido: PedidoReserva, limite: LimiteReserva) {
  const dia = limite.periodo.tipo === "DIA" ? limite.periodo.chave : null;
  const mes = limite.periodo.tipo === "MES" ? limite.periodo.chave : null;
  const r = await tx.query<{ tokens: string; custo: string; desconhecido: boolean }>(CONSUMO, [pedido.empresaId, dia, mes, limite.capacidade, pedido.moeda]);
  const linha = r.rows[0];
  const tokens = Number(linha?.tokens ?? 0);
  const custo = Number(linha?.custo ?? 0);
  if (limite.tokensMax !== null && tokens + pedido.tokens > limite.tokensMax) return true;
  if (limite.custoMaxMicros !== null && (pedido.custoMicros === null || linha?.desconhecido === true || custo + pedido.custoMicros > limite.custoMaxMicros)) return true;
  return false;
}

/** Períodos do uso: os da reserva (reconciliação) ou, sem reserva, o dia de `uso.em` em São Paulo. */
const inserirUso = (tx: DbExecutor, uso: ModelUsage, reservaId: string | null, periodos: { dia: string; mes: string } | null) => tx.query(
  `INSERT INTO ia_uso_modelo (empresa_id, estabelecimento_id, correlation_id, capacidade, workload, tier, provedor, modelo,
     tokens_entrada, tokens_saida, tokens_cache, duracao_ms, custo_estimado_micros, moeda, sucesso, erro, fallback, criado_em, reserva_id,
     periodo_dia, periodo_mes)
   VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::timestamptz, $19::uuid,
     COALESCE($20::date, ($18::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date),
     COALESCE($21::text, to_char($18::timestamptz AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')))`,
  [uso.empresaId, uso.estabelecimentoId, uso.correlationId.slice(0, 100), uso.capacidade, uso.workload, uso.tier, uso.provedor, uso.modelo,
    uso.tokensEntrada, uso.tokensSaida, uso.tokensCache, uso.duracaoMs, uso.custoEstimadoMicros, uso.moeda, uso.sucesso, uso.erro, uso.fallback, uso.em, reservaId,
    periodos?.dia ?? null, periodos?.mes ?? null],
);

export function criarRegistroUsoPostgres(banco: BancoUso, log: (linha: string) => void = console.info): RegistroUso {
  let existe: { valor: boolean; em: number } | null = null;
  async function tabelasExistem(tx: DbExecutor) {
    const agora = Date.now();
    if (existe && agora - existe.em < 60_000) return existe.valor;
    const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_uso_modelo') IS NOT NULL AND to_regclass('public.ia_orcamento_reservas') IS NOT NULL AS ok`);
    existe = { valor: r.rows[0]?.ok === true, em: agora };
    return existe.valor;
  }

  /**
   * Fecha a reserva (ABERTA, ou ORFA numa reconciliação tardia) da mesma empresa e grava o uso com os
   * períodos DA RESERVA, na mesma transação. ORFA nunca é "liberada": o consumo dela fica.
   */
  const encerrar = (reservaId: string, uso: ModelUsage, estado: "RECONCILIADA" | "LIBERADA" | "USO_DESCONHECIDO") => banco.transacao(async (tx) => {
    const r = await tx.query<{ periodo_dia: string; periodo_mes: string }>(
      `UPDATE ia_orcamento_reservas SET estado = $3, encerrado_em = clock_timestamp()
        WHERE id = $1::uuid AND empresa_id = $2::uuid
          AND (estado = 'ABERTA' OR (estado = 'ORFA' AND $3 <> 'LIBERADA'))
        RETURNING periodo_dia::text AS periodo_dia, periodo_mes`,
      [reservaId, uso.empresaId, estado],
    );
    const periodos = r.rows[0];
    if (r.rowCount !== 1 || !periodos) throw new Error("RESERVA_INEXISTENTE_OU_ENCERRADA");
    await inserirUso(tx, uso, reservaId, { dia: periodos.periodo_dia, mes: periodos.periodo_mes });
  });

  return {
    async reservar(pedido): Promise<ResultadoReserva> {
      // B1: mesma regra de `temTetoAplicavel` (lib/inteligencia/modelos/orcamento.ts), repetida porque a
      // persistência importa da IA só tipos. Sem teto aplicável e utilizável: recusa, sem abrir transação.
      const tetoValido = (l: LimiteReserva) => (l.tokensMax !== null && l.tokensMax > 0) || (l.custoMaxMicros !== null && l.custoMaxMicros > 0);
      if (pedido.limites.length === 0 || !pedido.limites.every(tetoValido)) return { ok: false, motivo: "ORCAMENTO" };
      return banco.transacao(async (tx) => {
        if (!await tabelasExistem(tx)) return { ok: false, motivo: "INDISPONIVEL" };
        // Serializa as reservas da empresa: a conferência do saldo e o INSERT não se intercalam.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('kidmais-ia-orcamento'), hashtext($1::text))`, [pedido.empresaId]);
        for (const limite of pedido.limites) {
          if (await excede(tx, pedido, limite)) return { ok: false, motivo: "ORCAMENTO" };
        }
        await tx.query(
          `INSERT INTO ia_orcamento_reservas (id, empresa_id, capacidade, correlation_id, tokens_reservados, custo_reservado_micros, moeda, estado, criado_em, periodo_dia, periodo_mes)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'ABERTA', $8::timestamptz, $9::date, $10)`,
          [pedido.id, pedido.empresaId, pedido.capacidade, pedido.correlationId.slice(0, 100), pedido.tokens, pedido.custoMicros, pedido.moeda, pedido.em, pedido.periodos.dia, pedido.periodos.mes],
        );
        return { ok: true };
      });
    },
    async reconciliar(reservaId, uso) {
      await encerrar(reservaId, uso, uso.tokensEntrada !== null && uso.tokensSaida !== null ? "RECONCILIADA" : "USO_DESCONHECIDO");
    },
    async liberar(reservaId, uso) {
      await encerrar(reservaId, uso, "LIBERADA");
    },
    async registrar(uso) {
      const tx = banco.executor();
      if (!await tabelasExistem(tx)) {
        // O detalhe do erro do provedor é só do trace (H3): fora deste log também.
        log(`[Kidmais IA uso] ${JSON.stringify({ ...uso, detalheErro: undefined })}`);
        return;
      }
      await inserirUso(tx, uso, null, null);
    },
    async recuperarOrfas(antesDe, empresaId) {
      const r = await banco.executor().query(
        `UPDATE ia_orcamento_reservas SET estado = 'ORFA', encerrado_em = clock_timestamp()
          WHERE estado = 'ABERTA' AND criado_em < $1::timestamptz AND ($2::uuid IS NULL OR empresa_id = $2::uuid)`,
        [antesDe, empresaId ?? null],
      );
      return r.rowCount ?? 0;
    },
  };
}

/** Linha do uso agrupado (visão de custos). Números como string no banco ⇒ convertidos aqui; null = desconhecido. */
export type UsoAgrupado = {
  estabelecimentoId: string | null; capacidade: string; provedor: string; modelo: string; dia: string; mes: string; moeda: string | null;
  chamadas: number; tokensEntrada: number; tokensSaida: number; tokensDesconhecidos: number; custoMicros: number; custoDesconhecido: number;
};
export type ReservaAgrupada = { capacidade: string; dia: string; moeda: string | null; reservas: number; tokens: number; custoMicros: number; custoDesconhecido: number };

/**
 * Visão consolidada de custos de UMA empresa (a comprovada pelo Tenant Context, passada pela rota) num mês.
 * Somente leitura. Sem as tabelas (migration 055a não aplicada) ⇒ `disponivel: false` (nunca zero inventado).
 */
export async function lerUsoAgrupado(tx: DbExecutor, empresaId: string, mes: string): Promise<{ disponivel: boolean; usos: UsoAgrupado[]; reservas: ReservaAgrupada[] }> {
  const existe = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_uso_modelo') IS NOT NULL AND to_regclass('public.ia_orcamento_reservas') IS NOT NULL AS ok`);
  if (existe.rows[0]?.ok !== true) return { disponivel: false, usos: [], reservas: [] };
  const usos = await tx.query<Record<string, string | number | null>>(
    `SELECT estabelecimento_id::text AS estabelecimento_id, capacidade, provedor, modelo, periodo_dia::text AS dia, periodo_mes AS mes, moeda,
            COUNT(*)::int AS chamadas,
            COALESCE(SUM(tokens_entrada), 0)::text AS tokens_entrada, COALESCE(SUM(tokens_saida), 0)::text AS tokens_saida,
            (COUNT(*) FILTER (WHERE tokens_entrada IS NULL OR tokens_saida IS NULL))::int AS tokens_desconhecidos,
            COALESCE(SUM(custo_estimado_micros), 0)::text AS custo, (COUNT(*) FILTER (WHERE custo_estimado_micros IS NULL))::int AS custo_desconhecido
       FROM ia_uso_modelo
      WHERE empresa_id = $1::uuid AND periodo_mes = $2
      GROUP BY estabelecimento_id, capacidade, provedor, modelo, periodo_dia, periodo_mes, moeda
      ORDER BY periodo_dia, capacidade, modelo
      LIMIT 5000`,
    [empresaId, mes],
  );
  const reservas = await tx.query<Record<string, string | number | null>>(
    `SELECT capacidade, periodo_dia::text AS dia, moeda, COUNT(*)::int AS reservas, COALESCE(SUM(tokens_reservados), 0)::text AS tokens,
            COALESCE(SUM(custo_reservado_micros), 0)::text AS custo, (COUNT(*) FILTER (WHERE custo_reservado_micros IS NULL))::int AS custo_desconhecido
       FROM ia_orcamento_reservas
      WHERE empresa_id = $1::uuid AND periodo_mes = $2 AND estado IN ${CONTAM}
      GROUP BY capacidade, periodo_dia, moeda
      LIMIT 5000`,
    [empresaId, mes],
  );
  const n = (v: string | number | null | undefined) => Number(v ?? 0);
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? null : String(v));
  return {
    disponivel: true,
    usos: usos.rows.map((r) => ({
      estabelecimentoId: s(r.estabelecimento_id), capacidade: String(r.capacidade), provedor: String(r.provedor), modelo: String(r.modelo), dia: String(r.dia), mes: String(r.mes), moeda: s(r.moeda),
      chamadas: n(r.chamadas), tokensEntrada: n(r.tokens_entrada), tokensSaida: n(r.tokens_saida), tokensDesconhecidos: n(r.tokens_desconhecidos), custoMicros: n(r.custo), custoDesconhecido: n(r.custo_desconhecido),
    })),
    reservas: reservas.rows.map((r) => ({ capacidade: String(r.capacidade), dia: String(r.dia), moeda: s(r.moeda), reservas: n(r.reservas), tokens: n(r.tokens), custoMicros: n(r.custo), custoDesconhecido: n(r.custo_desconhecido) })),
  };
}
