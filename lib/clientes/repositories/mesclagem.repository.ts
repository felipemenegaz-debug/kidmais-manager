import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapMesclagem, type MesclagemRow } from "./mappers";
import type { MesclagemRecord } from "./models";

const columns = `
  id, cliente_principal_id, cliente_secundario_id, motivo,
  resolucao_campos, executado_por_usuario_id, criado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

/**
 * Operação de baixo nível. NÃO executa a mesclagem completa.
 * Deve ser chamada futuramente apenas dentro do serviço transacional mergeClientes().
 */
export async function registrarMesclagem(
  input: {
    clientePrincipalId: string;
    clienteSecundarioId: string;
    motivo: string;
    resolucaoCampos?: Record<string, unknown>;
    executadoPorUsuarioId: string;
  },
  customDb?: DbExecutor,
): Promise<MesclagemRecord> {
  const result = await executor(customDb).query<MesclagemRow>(
    `INSERT INTO mesclagens_clientes (
       cliente_principal_id, cliente_secundario_id, motivo,
       resolucao_campos, executado_por_usuario_id
     ) VALUES ($1,$2,$3,$4::jsonb,$5)
     RETURNING ${columns}`,
    [
      input.clientePrincipalId,
      input.clienteSecundarioId,
      input.motivo,
      JSON.stringify(input.resolucaoCampos ?? {}),
      input.executadoPorUsuarioId,
    ],
  );
  return mapMesclagem(result.rows[0]);
}

export async function buscarMesclagemPorSecundario(
  clienteSecundarioId: string,
  customDb?: DbExecutor,
): Promise<MesclagemRecord | null> {
  const result = await executor(customDb).query<MesclagemRow>(
    `SELECT ${columns}
       FROM mesclagens_clientes
      WHERE cliente_secundario_id = $1
      LIMIT 1`,
    [clienteSecundarioId],
  );
  return result.rows[0] ? mapMesclagem(result.rows[0]) : null;
}
