import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapResponsavel, type ResponsavelRow } from "./mappers";
import type {
  CreateResponsavelInput,
  ResponsavelRecord,
  UpdateResponsavelInput,
} from "./models";
import {
  normalizarCpf,
  normalizarEmail,
  normalizarTelefone,
  textoOuNull,
} from "./normalizers";

const columns = `
  id, cliente_id, nome, cpf, telefone, whatsapp, email, relacao, observacoes,
  ativo, desativado_em, criado_por_usuario_id, atualizado_por_usuario_id,
  criado_em, atualizado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function criarResponsavel(
  input: CreateResponsavelInput,
  customDb?: DbExecutor,
): Promise<ResponsavelRecord> {
  const result = await executor(customDb).query<ResponsavelRow>(
    `INSERT INTO responsaveis_adicionais (
       cliente_id, nome, cpf, telefone, whatsapp, email, relacao, observacoes,
       criado_por_usuario_id, atualizado_por_usuario_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING ${columns}`,
    [
      input.clienteId,
      input.nome.trim(),
      normalizarCpf(input.cpf),
      normalizarTelefone(input.telefone),
      normalizarTelefone(input.whatsapp),
      normalizarEmail(input.email),
      textoOuNull(input.relacao),
      textoOuNull(input.observacoes),
      input.usuarioId ?? null,
    ],
  );
  return mapResponsavel(result.rows[0]);
}

export async function buscarResponsavelPorId(
  id: string,
  customDb?: DbExecutor,
): Promise<ResponsavelRecord | null> {
  const result = await executor(customDb).query<ResponsavelRow>(
    `SELECT ${columns} FROM responsaveis_adicionais WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapResponsavel(result.rows[0]) : null;
}


export async function buscarResponsavelAtivoPorNome(
  clienteId: string,
  nome: string,
  customDb?: DbExecutor,
): Promise<ResponsavelRecord | null> {
  const normalizado = nome.trim();
  if (!normalizado) return null;

  const result = await executor(customDb).query<ResponsavelRow>(
    `SELECT ${columns}
       FROM responsaveis_adicionais
      WHERE cliente_id = $1
        AND ativo = true
        AND lower(btrim(nome)) = lower(btrim($2))
      ORDER BY criado_em ASC
      LIMIT 1`,
    [clienteId, normalizado],
  );
  return result.rows[0] ? mapResponsavel(result.rows[0]) : null;
}

export async function listarResponsaveisDoCliente(
  clienteId: string,
  options: { incluirInativos?: boolean } = {},
  customDb?: DbExecutor,
): Promise<ResponsavelRecord[]> {
  const result = await executor(customDb).query<ResponsavelRow>(
    `SELECT ${columns}
       FROM responsaveis_adicionais
      WHERE cliente_id = $1
        AND ($2::boolean = true OR ativo = true)
      ORDER BY ativo DESC, nome ASC`,
    [clienteId, options.incluirInativos ?? false],
  );
  return result.rows.map(mapResponsavel);
}

export async function atualizarResponsavel(
  id: string,
  patch: UpdateResponsavelInput,
  customDb?: DbExecutor,
): Promise<ResponsavelRecord | null> {
  const setters: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    setters.push(`${column} = $${values.length}`);
  };

  if (patch.nome !== undefined) set("nome", patch.nome.trim());
  if (patch.cpf !== undefined) set("cpf", normalizarCpf(patch.cpf));
  if (patch.telefone !== undefined) set("telefone", normalizarTelefone(patch.telefone));
  if (patch.whatsapp !== undefined) set("whatsapp", normalizarTelefone(patch.whatsapp));
  if (patch.email !== undefined) set("email", normalizarEmail(patch.email));
  if (patch.relacao !== undefined) set("relacao", textoOuNull(patch.relacao));
  if (patch.observacoes !== undefined) set("observacoes", textoOuNull(patch.observacoes));
  if (setters.length === 0) return buscarResponsavelPorId(id, customDb);

  set("atualizado_por_usuario_id", patch.usuarioId ?? null);
  values.push(id);

  const result = await executor(customDb).query<ResponsavelRow>(
    `UPDATE responsaveis_adicionais
        SET ${setters.join(", ")}
      WHERE id = $${values.length}
        AND ativo = true
      RETURNING ${columns}`,
    values,
  );
  return result.rows[0] ? mapResponsavel(result.rows[0]) : null;
}

export async function desativarResponsavel(
  id: string,
  usuarioId: string | null,
  customDb?: DbExecutor,
): Promise<ResponsavelRecord | null> {
  const result = await executor(customDb).query<ResponsavelRow>(
    `UPDATE responsaveis_adicionais
        SET ativo = false,
            desativado_em = now(),
            atualizado_por_usuario_id = $2
      WHERE id = $1
        AND ativo = true
      RETURNING ${columns}`,
    [id, usuarioId],
  );
  return result.rows[0] ? mapResponsavel(result.rows[0]) : null;
}
