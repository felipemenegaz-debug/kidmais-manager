import type { DbExecutor } from "../../db/contracts.ts";
import type { Regra } from "./regras.ts";

/**
 * Gatilhos e condições fixos de cada regra pré-definida, em TRÊS modos (correção R4, 15/10/2026):
 *   PLANEJAR  — alvos elegíveis AINDA NÃO planejados: exclui, antes do limite, quem já tem execução com a MESMA chave
 *               (regra:ação:alvo:ciclo), em qualquer estado (inclusive suprimida/cancelada, que não é recriada). Ordem
 *               determinística com desempate pelo id. O limite restringe o trabalho por ciclo; o ciclo seguinte avança
 *               para os próximos — os primeiros não "seguram" a fila mesmo continuando elegíveis.
 *   REVALIDAR — um alvo já agendado, SEM a exclusão acima (a execução existe), imediatamente antes de agir: se a condição
 *               deixou de valer (contrato fechado, cancelamento, movimentação, mudança de data), a execução é suprimida.
 *   SIMULAR   — prévia da tela, com limite próprio e sem exclusão (mostra também quem já foi planejado).
 * Novo ciclo do mesmo alvo (ex.: proposta voltou a parar depois de movimentada) gera chave nova e pode ser planejado.
 */
export type Alvo = {
  alvoTipo: "FECHAMENTO" | "CLIENTE"; alvoId: string; clienteId: string; clienteNome: string; fechamentoId: string | null; dataFesta: string | null;
  /** Parte da chave de idempotência que define o "ciclo" (ex.: status e dia da última movimentação). */
  ciclo: string;
};

type Linha = { alvo_id: string; cliente_id: string; cliente_nome: string; fechamento_id: string | null; data_festa: string | null; ciclo: string };

/** Trabalho máximo de planejamento por regra e por ciclo do motor. */
export const LIMITE_PLANEJAMENTO = 500;
/** Linhas mostradas na simulação da tela. */
export const LIMITE_SIMULACAO = 50;

type Modo = { tipo: "PLANEJAR"; regraId: string; acao: string; limite: number } | { tipo: "REVALIDAR"; alvoId: string } | { tipo: "SIMULAR"; limite: number };

/**
 * Consulta-base de cada regra: colunas do alvo + `ordem` (critério principal da fila). Parâmetros fixos:
 * $1 empresa, $2 unidade (ou null), $3 instante, $4 espera em dias.
 */
function base(tipo: Regra["tipo"]): string | null {
  if (tipo === "PROPOSTA_PARADA") {
    return `SELECT f.id::text AS alvo_id, f.cliente_id::text, c.nome_completo AS cliente_nome, f.id::text AS fechamento_id, f.data_evento::text AS data_festa,
              f.status || ':' || to_char(f.atualizado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ciclo, f.atualizado_em AS ordem
         FROM fechamentos f JOIN clientes c ON c.id = f.cliente_id AND c.empresa_id = f.empresa_id AND c.status = 'ATIVO'
        WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid)
          AND f.status IN ('AGUARDANDO_APROVACAO', 'APROVADO', 'AGUARDANDO_CONTRATO')
          AND f.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
          AND f.atualizado_em <= $3::timestamptz - make_interval(days => $4::int)
          AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.fechamento_id = f.id AND ct.status IN ('ASSINADO', 'CANCELADO'))`;
  }
  if (tipo === "POS_FESTA") {
    return `SELECT f.id::text AS alvo_id, f.cliente_id::text, c.nome_completo AS cliente_nome, f.id::text AS fechamento_id, f.data_evento::text AS data_festa,
              f.data_evento::text AS ciclo, f.data_evento::timestamp AS ordem
         FROM fechamentos f JOIN contratos ct ON ct.fechamento_id = f.id AND ct.status = 'ASSINADO'
         JOIN clientes c ON c.id = f.cliente_id AND c.empresa_id = f.empresa_id AND c.status = 'ATIVO'
        WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid) AND f.status <> 'CANCELADO'
          AND f.data_evento <= ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - $4::int
          AND f.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - $4::int - 14`;
  }
  if (tipo === "RECOMPRA") {
    // Última festa assinada do cliente faz um ano em até `espera` dias (janela de 30 dias para não perder).
    return `SELECT u.cliente_id::text AS alvo_id, u.cliente_id::text, c.nome_completo AS cliente_nome, u.fechamento_id::text, u.data_evento::text AS data_festa,
              to_char(u.data_evento, 'YYYY') AS ciclo, u.data_evento::timestamp AS ordem
         FROM (SELECT DISTINCT ON (f.cliente_id) f.cliente_id, f.id AS fechamento_id, f.data_evento
                 FROM fechamentos f JOIN contratos ct ON ct.fechamento_id = f.id AND ct.status = 'ASSINADO'
                WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid) AND f.status <> 'CANCELADO'
                ORDER BY f.cliente_id, f.data_evento DESC, f.id DESC) u
         JOIN clientes c ON c.id = u.cliente_id AND c.empresa_id = $1::uuid AND c.status = 'ATIVO'
        WHERE (u.data_evento + 365 - $4::int) BETWEEN ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - 30 AND ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
          AND NOT EXISTS (SELECT 1 FROM fechamentos n WHERE n.cliente_id = u.cliente_id AND n.empresa_id = $1::uuid AND n.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO')
                          AND n.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)`;
  }
  return null;
}

/** Monta a consulta do modo. Exportada para teste de forma (o comportamento é provado nas suítes PostgreSQL). */
export function consultaDe(tipo: Regra["tipo"], modo: Modo): { sql: string; extra: unknown[] } | null {
  const b = base(tipo);
  if (!b) return null;
  if (modo.tipo === "REVALIDAR") return { sql: `SELECT * FROM (${b}) x WHERE x.alvo_id = $5::text LIMIT 1`, extra: [modo.alvoId] };
  if (modo.tipo === "SIMULAR") return { sql: `SELECT * FROM (${b}) x ORDER BY x.ordem, x.alvo_id LIMIT $5::int`, extra: [modo.limite] };
  return {
    sql: `SELECT * FROM (${b}) x
           WHERE NOT EXISTS (SELECT 1 FROM marketing_automacao_execucoes e
                              WHERE e.empresa_id = $1::uuid AND e.chave_idempotencia = $5::text || ':' || $6::text || ':' || x.alvo_id || ':' || x.ciclo)
           ORDER BY x.ordem, x.alvo_id LIMIT $7::int`,
    extra: [modo.regraId, modo.acao, modo.limite],
  };
}

function mapear(regra: Pick<Regra, "tipo">, l: Linha): Alvo {
  return {
    alvoTipo: regra.tipo === "RECOMPRA" ? "CLIENTE" : "FECHAMENTO", alvoId: l.alvo_id, clienteId: l.cliente_id, clienteNome: l.cliente_nome,
    fechamentoId: l.fechamento_id, dataFesta: l.data_festa, ciclo: l.ciclo,
  };
}

type RegraAlvos = Pick<Regra, "tipo" | "unidadeId" | "esperaDias">;

async function consultar(tx: DbExecutor, empresaId: string, regra: RegraAlvos, agora: Date, modo: Modo) {
  const q = consultaDe(regra.tipo, modo);
  if (!q) return [];
  const r = await tx.query<Linha>(q.sql, [empresaId, regra.unidadeId, agora.toISOString(), regra.esperaDias, ...q.extra]);
  return r.rows.map((l) => mapear(regra, l));
}

/** Próximo lote de alvos AINDA NÃO planejados desta regra e ação (avança a cada ciclo). */
export async function alvosParaPlanejar(tx: DbExecutor, empresaId: string, regra: RegraAlvos & Pick<Regra, "id" | "acao">, agora: Date, limite = LIMITE_PLANEJAMENTO) {
  if (!regra.id) return [];
  return consultar(tx, empresaId, regra, agora, { tipo: "PLANEJAR", regraId: regra.id, acao: regra.acao, limite });
}

/** Prévia da tela (limite próprio). */
export async function alvosParaSimular(tx: DbExecutor, empresaId: string, regra: RegraAlvos, agora: Date, limite = LIMITE_SIMULACAO) {
  return consultar(tx, empresaId, regra, agora, { tipo: "SIMULAR", limite });
}

/** Total de alvos elegíveis agora (para a tela; sem limite de lote). */
export async function totalDeAlvos(tx: DbExecutor, empresaId: string, regra: RegraAlvos, agora: Date) {
  const b = base(regra.tipo);
  if (!b) return 0;
  const r = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${b}) x`, [empresaId, regra.unidadeId, agora.toISOString(), regra.esperaDias]);
  return Number(r.rows[0]?.n ?? 0);
}

/** Revalida um alvo JÁ agendado: o mesmo gatilho e o mesmo ciclo da execução (sem excluir quem já foi planejado). */
export async function alvoContinuaElegivel(tx: DbExecutor, empresaId: string, regra: RegraAlvos, alvoId: string, ciclo: string, agora: Date) {
  const [alvo] = await consultar(tx, empresaId, regra, agora, { tipo: "REVALIDAR", alvoId });
  return alvo && alvo.ciclo === ciclo ? alvo : null;
}

export function chaveExecucao(regraId: string, acao: string, alvo: Pick<Alvo, "alvoId" | "ciclo">) {
  return `${regraId}:${acao}:${alvo.alvoId}:${alvo.ciclo}`;
}

/** Ciclo gravado na chave (última parte), para revalidar o mesmo ciclo no envio. */
export function cicloDaChave(chave: string) {
  return chave.split(":").slice(3).join(":");
}
