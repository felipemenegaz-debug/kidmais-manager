import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapAniversariante, type AniversarianteRow } from "./mappers";
import type {
  AniversarianteRecord,
  CreateAniversarianteInput,
  UpdateAniversarianteInput,
} from "./models";
import { textoOuNull } from "./normalizers";

const columns = `
  id, cliente_id, nome, data_nascimento, tema_padrao, observacoes,
  ativo, desativado_em, criado_por_usuario_id, atualizado_por_usuario_id,
  criado_em, atualizado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function criarAniversariante(
  input: CreateAniversarianteInput,
  customDb?: DbExecutor,
): Promise<AniversarianteRecord> {
  const result = await executor(customDb).query<AniversarianteRow>(
    `INSERT INTO aniversariantes (
       cliente_id, nome, data_nascimento, tema_padrao, observacoes,
       criado_por_usuario_id, atualizado_por_usuario_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${columns}`,
    [
      input.clienteId,
      input.nome.trim(),
      input.dataNascimento ?? null,
      textoOuNull(input.temaPadrao),
      textoOuNull(input.observacoes),
      input.usuarioId ?? null,
    ],
  );
  return mapAniversariante(result.rows[0]);
}

export async function buscarAniversariantePorId(
  id: string,
  customDb?: DbExecutor,
): Promise<AniversarianteRecord | null> {
  const result = await executor(customDb).query<AniversarianteRow>(
    `SELECT ${columns} FROM aniversariantes WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapAniversariante(result.rows[0]) : null;
}

export async function listarAniversariantesDoCliente(
  clienteId: string,
  options: { incluirInativos?: boolean } = {},
  customDb?: DbExecutor,
): Promise<AniversarianteRecord[]> {
  const result = await executor(customDb).query<AniversarianteRow>(
    `SELECT ${columns}
       FROM aniversariantes
      WHERE cliente_id = $1
        AND ($2::boolean = true OR ativo = true)
      ORDER BY ativo DESC, nome ASC`,
    [clienteId, options.incluirInativos ?? false],
  );
  return result.rows.map(mapAniversariante);
}

export async function atualizarAniversariante(
  id: string,
  patch: UpdateAniversarianteInput,
  customDb?: DbExecutor,
): Promise<AniversarianteRecord | null> {
  const setters: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    setters.push(`${column} = $${values.length}`);
  };

  if (patch.nome !== undefined) set("nome", patch.nome.trim());
  if (patch.dataNascimento !== undefined) set("data_nascimento", patch.dataNascimento ?? null);
  if (patch.temaPadrao !== undefined) set("tema_padrao", textoOuNull(patch.temaPadrao));
  if (patch.observacoes !== undefined) set("observacoes", textoOuNull(patch.observacoes));
  if (setters.length === 0) return buscarAniversariantePorId(id, customDb);

  set("atualizado_por_usuario_id", patch.usuarioId ?? null);
  values.push(id);

  const result = await executor(customDb).query<AniversarianteRow>(
    `UPDATE aniversariantes
        SET ${setters.join(", ")}
      WHERE id = $${values.length}
        AND ativo = true
      RETURNING ${columns}`,
    values,
  );
  return result.rows[0] ? mapAniversariante(result.rows[0]) : null;
}

export async function desativarAniversariante(
  id: string,
  usuarioId: string | null,
  customDb?: DbExecutor,
): Promise<AniversarianteRecord | null> {
  const result = await executor(customDb).query<AniversarianteRow>(
    `UPDATE aniversariantes
        SET ativo = false,
            desativado_em = now(),
            atualizado_por_usuario_id = $2
      WHERE id = $1
        AND ativo = true
      RETURNING ${columns}`,
    [id, usuarioId],
  );
  return result.rows[0] ? mapAniversariante(result.rows[0]) : null;
}
