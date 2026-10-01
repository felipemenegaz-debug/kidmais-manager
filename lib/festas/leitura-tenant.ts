import type { DbExecutor } from "../db/contracts.ts";

/**
 * Leitura somente da agenda de festas da empresa comprovada.
 *
 * Mesmo predicado de tenant do Dashboard (`painelGeral`): festa → contrato → fechamento → pacote da
 * empresa. Existe separada porque `painelGeral` também passa por `listarContasPagar`, que grava
 * categorias padrão; uma consulta da IA não pode escrever.
 * Não devolve CPF, telefone, e-mail nem endereço.
 */
export type FestaAgenda = {
  festaId: string;
  data: string;
  horaInicio: string;
  horaFim: string | null;
  cliente: string;
  pacote: string;
  convidados: number;
  contratoStatus: string;
};

/**
 * Festa com as RELAÇÕES do Core (AI V1.1, PR 4): festa → cliente (fechamento.cliente_id) e festa → contrato
 * (festas.contrato_id, com a versão vigente). Mesmo predicado de tenant da agenda.
 */
export type FestaRelacionada = FestaAgenda & {
  clienteId: string | null;
  contratoId: string;
  versaoVigente: number | null;
};

export type FiltroFestas = {
  /** ASC = próximas (a partir de `inicio`); DESC = últimas (até `fim`). */
  ordem: "ASC" | "DESC";
  inicio: string | null;
  fim: string | null;
  limite: number;
  /** Contrato cancelado não é festa "a acontecer" (padrão: fora). A agenda do dia mantém todas, como antes. */
  incluirCanceladas?: boolean;
};

const SELECAO = `SELECT festa.id::text AS id, fech.data_evento::text AS data, fech.horario_inicio::text AS hora,
            fech.horario_fim::text AS hora_fim, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            pac.nome AS pacote, fech.convidados, contrato.status AS status,
            cliente.id::text AS cliente_id, contrato.id::text AS contrato_id, ver.numero_versao
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
       LEFT JOIN contrato_versoes ver ON ver.id = fluxo.versao_vigente_id
      WHERE festa.invalidada_em IS NULL`;

type Linha = {
  id: string; data: string; hora: string; hora_fim: string | null; cliente: string; pacote: string; convidados: number; status: string;
  cliente_id: string | null; contrato_id: string; numero_versao: number | null;
};

function mapear(linha: Linha): FestaRelacionada {
  return {
    festaId: linha.id,
    data: linha.data,
    horaInicio: String(linha.hora ?? "").slice(0, 5),
    horaFim: linha.hora_fim ? String(linha.hora_fim).slice(0, 5) : null,
    cliente: linha.cliente,
    pacote: linha.pacote,
    convidados: Number(linha.convidados),
    contratoStatus: linha.status,
    clienteId: linha.cliente_id ?? null,
    contratoId: linha.contrato_id,
    versaoVigente: linha.numero_versao == null ? null : Number(linha.numero_versao),
  };
}

/** Festas da empresa comprovada, cronológicas (ASC) ou reversas (DESC), com intervalo opcional e limite. */
export async function festasDoTenant(tx: DbExecutor, empresaId: string, filtro: FiltroFestas): Promise<FestaRelacionada[]> {
  const ordem = filtro.ordem === "DESC" ? "DESC" : "ASC";
  const resultado = await tx.query<Linha>(
    `${SELECAO}
        AND ($2::date IS NULL OR fech.data_evento >= $2::date)
        AND ($3::date IS NULL OR fech.data_evento <= $3::date)
        AND ($5::boolean OR contrato.status <> 'CANCELADO')
      ORDER BY fech.data_evento ${ordem}, fech.horario_inicio ${ordem}, festa.id
      LIMIT $4`,
    [empresaId, filtro.inicio, filtro.fim, Math.max(1, Math.min(filtro.limite, 200)), filtro.incluirCanceladas === true],
  );
  return resultado.rows.map(mapear);
}

/** Uma festa da empresa comprovada, com relações. Outra empresa ou festa invalidada ⇒ null (inexistente). */
export async function festaDoTenant(tx: DbExecutor, empresaId: string, festaId: string): Promise<FestaRelacionada | null> {
  const resultado = await tx.query<Linha>(`${SELECAO}
        AND festa.id = $2::uuid
      LIMIT 1`, [empresaId, festaId]);
  const linha = resultado.rows[0];
  return linha ? mapear(linha) : null;
}

/** Agenda de um intervalo — consulta original, inalterada (inclui contratos cancelados). */
export async function agendaDoTenant(
  tx: DbExecutor,
  empresaId: string,
  inicio: string,
  fim: string,
  limite = 50,
): Promise<FestaAgenda[]> {
  const resultado = await tx.query<{
    id: string; data: string; hora: string; hora_fim: string | null; cliente: string; pacote: string; convidados: number; status: string;
  }>(
    `SELECT festa.id::text AS id, fech.data_evento::text AS data, fech.horario_inicio::text AS hora,
            fech.horario_fim::text AS hora_fim, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            pac.nome AS pacote, fech.convidados, contrato.status AS status
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento BETWEEN $2::date AND $3::date
      ORDER BY fech.data_evento, fech.horario_inicio
      LIMIT $4`,
    [empresaId, inicio, fim, Math.max(1, Math.min(limite, 200))],
  );
  return resultado.rows.map((linha) => ({
    festaId: linha.id,
    data: linha.data,
    horaInicio: String(linha.hora ?? "").slice(0, 5),
    horaFim: linha.hora_fim ? String(linha.hora_fim).slice(0, 5) : null,
    cliente: linha.cliente,
    pacote: linha.pacote,
    convidados: Number(linha.convidados),
    contratoStatus: linha.status,
  }));
}
