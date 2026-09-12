import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapAuditoria, type AuditoriaRow } from "./mappers";
import type { AuditoriaRecord } from "./models";

export type AppendAuditoriaInput = {
  clienteId?: string | null;
  atorTipo: AuditoriaRecord["atorTipo"];
  usuarioId?: string | null;
  acao: string;
  entidadeTipo: string;
  entidadeId: string;
  dadosAntes?: Record<string, unknown> | null;
  dadosDepois?: Record<string, unknown> | null;
  justificativa?: string | null;
  origem: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

const columns = `
  id, cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
  dados_antes, dados_depois, justificativa, origem, request_id, ip, user_agent, criado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function registrarAuditoria(
  input: AppendAuditoriaInput,
  customDb?: DbExecutor,
): Promise<AuditoriaRecord> {
  const result = await executor(customDb).query<AuditoriaRow>(
    `INSERT INTO auditoria (
       cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
       dados_antes, dados_depois, justificativa, origem, request_id, ip, user_agent
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::inet,$13
     )
     RETURNING ${columns}`,
    [
      input.clienteId ?? null,
      input.atorTipo,
      input.usuarioId ?? null,
      input.acao,
      input.entidadeTipo,
      input.entidadeId,
      input.dadosAntes == null ? null : JSON.stringify(input.dadosAntes),
      input.dadosDepois == null ? null : JSON.stringify(input.dadosDepois),
      input.justificativa ?? null,
      input.origem,
      input.requestId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  return mapAuditoria(result.rows[0]);
}

export async function listarAuditoriaCliente(
  clienteId: string,
  options: { limit?: number; offset?: number } = {},
  customDb?: DbExecutor,
): Promise<AuditoriaRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const result = await executor(customDb).query<AuditoriaRow>(
    `SELECT ${columns}
       FROM auditoria
      WHERE cliente_id = $1
      ORDER BY criado_em DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [clienteId, limit, offset],
  );
  return result.rows.map(mapAuditoria);
}
