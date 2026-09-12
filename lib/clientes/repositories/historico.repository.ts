import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapHistorico, type HistoricoRow } from "./mappers";
import type { HistoricoClienteRecord } from "./models";

export type AppendHistoricoInput = {
  clienteId: string;
  clienteOrigemId?: string | null;
  tipoEvento: string;
  origem: string;
  entidadeTipo?: string | null;
  entidadeId?: string | null;
  usuarioId?: string | null;
  detalhe?: string | null;
  metadata?: Record<string, unknown>;
  critico?: boolean;
};

const columns = `
  id, cliente_id, cliente_origem_id, tipo_evento, origem,
  entidade_tipo, entidade_id, usuario_id, detalhe, metadata, critico, criado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function registrarEventoHistorico(
  input: AppendHistoricoInput,
  customDb?: DbExecutor,
): Promise<HistoricoClienteRecord> {
  const result = await executor(customDb).query<HistoricoRow>(
    `INSERT INTO eventos_historico_cliente (
       cliente_id, cliente_origem_id, tipo_evento, origem,
       entidade_tipo, entidade_id, usuario_id, detalhe, metadata, critico
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     RETURNING ${columns}`,
    [
      input.clienteId,
      input.clienteOrigemId ?? null,
      input.tipoEvento,
      input.origem,
      input.entidadeTipo ?? null,
      input.entidadeId ?? null,
      input.usuarioId ?? null,
      input.detalhe ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.critico ?? false,
    ],
  );
  return mapHistorico(result.rows[0]);
}

export async function listarHistoricoCliente(
  clienteId: string,
  options: { limit?: number; offset?: number } = {},
  customDb?: DbExecutor,
): Promise<HistoricoClienteRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const result = await executor(customDb).query<HistoricoRow>(
    `SELECT ${columns}
       FROM eventos_historico_cliente
      WHERE cliente_id = $1
      ORDER BY criado_em DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [clienteId, limit, offset],
  );
  return result.rows.map(mapHistorico);
}
