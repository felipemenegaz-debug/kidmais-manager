import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapDuplicidade, type DuplicidadeRow } from "./mappers";
import type { DuplicidadeRecord, DuplicidadeStatus } from "./models";

const columns = `
  id, cliente_a_id, cliente_b_id, motivos, status, observacoes, criado_em,
  analisado_por_usuario_id, analisado_em, mesclagem_id
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

function ordenarPar(clienteUmId: string, clienteDoisId: string) {
  if (clienteUmId === clienteDoisId) {
    throw new Error("Uma possível duplicidade exige dois Clientes diferentes.");
  }
  return clienteUmId < clienteDoisId
    ? [clienteUmId, clienteDoisId] as const
    : [clienteDoisId, clienteUmId] as const;
}

export async function registrarPossivelDuplicidade(
  input: {
    clienteUmId: string;
    clienteDoisId: string;
    motivos: string[];
    observacoes?: string | null;
  },
  customDb?: DbExecutor,
): Promise<DuplicidadeRecord> {
  const [clienteAId, clienteBId] = ordenarPar(input.clienteUmId, input.clienteDoisId);
  const motivos = [...new Set(input.motivos.map((item) => item.trim()).filter(Boolean))];
  if (motivos.length === 0) throw new Error("Informe ao menos um motivo de duplicidade.");

  const result = await executor(customDb).query<DuplicidadeRow>(
    `INSERT INTO possiveis_duplicidades_cliente (
       cliente_a_id, cliente_b_id, motivos, observacoes
     ) VALUES ($1,$2,$3::text[],$4)
     ON CONFLICT (cliente_a_id, cliente_b_id)
     DO UPDATE SET
       motivos = ARRAY(
         SELECT DISTINCT motivo
           FROM unnest(possiveis_duplicidades_cliente.motivos || EXCLUDED.motivos) AS motivo
       ),
       observacoes = COALESCE(EXCLUDED.observacoes, possiveis_duplicidades_cliente.observacoes)
     RETURNING ${columns}`,
    [clienteAId, clienteBId, motivos, input.observacoes ?? null],
  );
  return mapDuplicidade(result.rows[0]);
}

export async function listarDuplicidades(
  options: { status?: DuplicidadeStatus; limit?: number; offset?: number } = {},
  customDb?: DbExecutor,
): Promise<DuplicidadeRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const result = await executor(customDb).query<DuplicidadeRow>(
    `SELECT ${columns}
       FROM possiveis_duplicidades_cliente
      WHERE ($1::text IS NULL OR status = $1::text)
      ORDER BY criado_em DESC
      LIMIT $2 OFFSET $3`,
    [options.status ?? null, limit, offset],
  );
  return result.rows.map(mapDuplicidade);
}

export async function buscarDuplicidadePorId(
  id: string,
  customDb?: DbExecutor,
): Promise<DuplicidadeRecord | null> {
  const result = await executor(customDb).query<DuplicidadeRow>(
    `SELECT ${columns}
       FROM possiveis_duplicidades_cliente
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapDuplicidade(result.rows[0]) : null;
}
