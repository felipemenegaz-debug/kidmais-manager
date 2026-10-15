import type { DbExecutor } from "../../db/contracts.ts";
import type { Regra } from "./regras.ts";

/**
 * Gatilhos e condições fixos de cada regra pré-definida. A mesma consulta serve para PLANEJAR (todos os alvos) e para
 * REVALIDAR imediatamente antes de agir (um alvo): se a condição deixou de valer (contrato fechado, cancelamento,
 * movimentação, mudança de data), a execução é suprimida.
 */
export type Alvo = {
  alvoTipo: "FECHAMENTO" | "CLIENTE"; alvoId: string; clienteId: string; clienteNome: string; fechamentoId: string | null; dataFesta: string | null;
  /** Parte da chave de idempotência que define o "ciclo" (ex.: status e dia da última movimentação). */
  ciclo: string;
};

type Linha = { alvo_id: string; cliente_id: string; cliente_nome: string; fechamento_id: string | null; data_festa: string | null; ciclo: string };

const LIMITE = 500;

function sqlProposta(filtroAlvo: boolean) {
  return `SELECT f.id::text AS alvo_id, f.cliente_id::text, c.nome_completo AS cliente_nome, f.id::text AS fechamento_id, f.data_evento::text AS data_festa,
            f.status || ':' || to_char(f.atualizado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ciclo
       FROM fechamentos f JOIN clientes c ON c.id = f.cliente_id AND c.empresa_id = f.empresa_id AND c.status = 'ATIVO'
      WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid)
        AND f.status IN ('AGUARDANDO_APROVACAO', 'APROVADO', 'AGUARDANDO_CONTRATO')
        AND f.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
        AND f.atualizado_em <= $3::timestamptz - make_interval(days => $4::int)
        AND NOT EXISTS (SELECT 1 FROM contratos ct WHERE ct.fechamento_id = f.id AND ct.status IN ('ASSINADO', 'CANCELADO'))
        ${filtroAlvo ? "AND f.id = $5::uuid" : ""}
      ORDER BY f.atualizado_em LIMIT ${LIMITE}`;
}

function sqlPosFesta(filtroAlvo: boolean) {
  return `SELECT f.id::text AS alvo_id, f.cliente_id::text, c.nome_completo AS cliente_nome, f.id::text AS fechamento_id, f.data_evento::text AS data_festa,
            f.data_evento::text AS ciclo
       FROM fechamentos f JOIN contratos ct ON ct.fechamento_id = f.id AND ct.status = 'ASSINADO'
       JOIN clientes c ON c.id = f.cliente_id AND c.empresa_id = f.empresa_id AND c.status = 'ATIVO'
      WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid) AND f.status <> 'CANCELADO'
        AND f.data_evento <= ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - $4::int
        AND f.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - $4::int - 14
        ${filtroAlvo ? "AND f.id = $5::uuid" : ""}
      ORDER BY f.data_evento LIMIT ${LIMITE}`;
}

/** Recompra: última festa assinada do cliente faz um ano em até `espera` dias (janela de 30 dias para não perder). */
function sqlRecompra(filtroAlvo: boolean) {
  return `WITH ultima AS (
         SELECT DISTINCT ON (f.cliente_id) f.cliente_id, f.id AS fechamento_id, f.data_evento
           FROM fechamentos f JOIN contratos ct ON ct.fechamento_id = f.id AND ct.status = 'ASSINADO'
          WHERE f.empresa_id = $1::uuid AND ($2::uuid IS NULL OR f.estabelecimento_id = $2::uuid) AND f.status <> 'CANCELADO'
          ORDER BY f.cliente_id, f.data_evento DESC
       )
       SELECT u.cliente_id::text AS alvo_id, u.cliente_id::text, c.nome_completo AS cliente_nome, u.fechamento_id::text, u.data_evento::text AS data_festa,
              to_char(u.data_evento, 'YYYY') AS ciclo
         FROM ultima u JOIN clientes c ON c.id = u.cliente_id AND c.empresa_id = $1::uuid AND c.status = 'ATIVO'
        WHERE (u.data_evento + 365 - $4::int) BETWEEN ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - 30 AND ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
          AND NOT EXISTS (SELECT 1 FROM fechamentos n WHERE n.cliente_id = u.cliente_id AND n.empresa_id = $1::uuid AND n.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO')
                          AND n.data_evento > ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)
          ${filtroAlvo ? "AND u.cliente_id = $5::uuid" : ""}
        ORDER BY u.data_evento LIMIT ${LIMITE}`;
}

function sqlDe(regra: Pick<Regra, "tipo">, filtroAlvo: boolean) {
  if (regra.tipo === "PROPOSTA_PARADA") return sqlProposta(filtroAlvo);
  if (regra.tipo === "POS_FESTA") return sqlPosFesta(filtroAlvo);
  if (regra.tipo === "RECOMPRA") return sqlRecompra(filtroAlvo);
  return null;
}

function mapear(regra: Pick<Regra, "tipo">, l: Linha): Alvo {
  return {
    alvoTipo: regra.tipo === "RECOMPRA" ? "CLIENTE" : "FECHAMENTO", alvoId: l.alvo_id, clienteId: l.cliente_id, clienteNome: l.cliente_nome,
    fechamentoId: l.fechamento_id, dataFesta: l.data_festa, ciclo: l.ciclo,
  };
}

export async function alvosDaRegra(tx: DbExecutor, empresaId: string, regra: Pick<Regra, "tipo" | "unidadeId" | "esperaDias">, agora: Date): Promise<Alvo[]> {
  const sql = sqlDe(regra, false);
  if (!sql) return [];
  const r = await tx.query<Linha>(sql, [empresaId, regra.unidadeId, agora.toISOString(), regra.esperaDias]);
  return r.rows.map((l) => mapear(regra, l));
}

/** Revalida um alvo: o mesmo gatilho e o mesmo ciclo da execução. */
export async function alvoContinuaElegivel(
  tx: DbExecutor, empresaId: string, regra: Pick<Regra, "tipo" | "unidadeId" | "esperaDias">, alvoId: string, ciclo: string, agora: Date,
) {
  const sql = sqlDe(regra, true);
  if (!sql) return null;
  const r = await tx.query<Linha>(sql, [empresaId, regra.unidadeId, agora.toISOString(), regra.esperaDias, alvoId]);
  const l = r.rows[0];
  return l && l.ciclo === ciclo ? mapear(regra, l) : null;
}

export function chaveExecucao(regraId: string, acao: string, alvo: Pick<Alvo, "alvoId" | "ciclo">) {
  return `${regraId}:${acao}:${alvo.alvoId}:${alvo.ciclo}`;
}

/** Ciclo gravado na chave (última parte), para revalidar o mesmo ciclo no envio. */
export function cicloDaChave(chave: string) {
  return chave.split(":").slice(3).join(":");
}
