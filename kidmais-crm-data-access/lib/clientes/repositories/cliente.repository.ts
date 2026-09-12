import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapCliente, type ClienteRow } from "./mappers";
import type {
  ClienteRecord,
  ClienteStatus,
  CreateClienteInput,
  UpdateClienteInput,
} from "./models";
import {
  normalizarCep,
  normalizarCpf,
  normalizarEmail,
  normalizarTelefone,
  normalizarUf,
  textoOuNull,
} from "./normalizers";

const clienteColumns = `
  id, nome_completo, cpf, telefone, whatsapp, email,
  cep, logradouro, numero, complemento, bairro, cidade, uf, observacoes,
  status, cliente_principal_id, mesclado_em,
  criado_por_usuario_id, atualizado_por_usuario_id,
  criado_em, atualizado_em
`;

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function criarCliente(
  input: CreateClienteInput,
  customDb?: DbExecutor,
): Promise<ClienteRecord> {
  const result = await executor(customDb).query<ClienteRow>(
    `INSERT INTO clientes (
       nome_completo, cpf, telefone, whatsapp, email,
       cep, logradouro, numero, complemento, bairro, cidade, uf, observacoes,
       criado_por_usuario_id, atualizado_por_usuario_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $14
     )
     RETURNING ${clienteColumns}`,
    [
      input.nomeCompleto.trim(),
      normalizarCpf(input.cpf),
      normalizarTelefone(input.telefone),
      normalizarTelefone(input.whatsapp),
      normalizarEmail(input.email),
      normalizarCep(input.cep),
      textoOuNull(input.logradouro),
      textoOuNull(input.numero),
      textoOuNull(input.complemento),
      textoOuNull(input.bairro),
      textoOuNull(input.cidade),
      normalizarUf(input.uf),
      textoOuNull(input.observacoes),
      input.usuarioId ?? null,
    ],
  );

  return mapCliente(result.rows[0]);
}

export async function buscarClientePorId(
  id: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

/** Retorna o Cliente canônico quando o id informado já tiver sido mesclado. */
export async function buscarClienteCanonicoPorId(
  id: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns
      .split(",")
      .map((column) => `c.${column.trim()}`)
      .join(", ")}
       FROM clientes origem
       JOIN clientes c
         ON c.id = CASE
           WHEN origem.status = 'MESCLADO' THEN origem.cliente_principal_id
           ELSE origem.id
         END
      WHERE origem.id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

export async function buscarClienteCanonicoPorCpf(
  cpf: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const normalized = normalizarCpf(cpf);
  if (!normalized) return null;

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE cpf = $1
        AND status <> 'MESCLADO'
      LIMIT 1`,
    [normalized],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

export async function buscarClientesPorContatoExato(
  contato: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord[]> {
  const normalized = normalizarTelefone(contato);
  if (!normalized) return [];

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE status <> 'MESCLADO'
        AND (telefone = $1 OR whatsapp = $1)
      ORDER BY atualizado_em DESC`,
    [normalized],
  );
  return result.rows.map(mapCliente);
}

export async function buscarClientesPorNomeSemelhante(
  nome: string,
  options: { limit?: number; excluirClienteId?: string } = {},
  customDb?: DbExecutor,
): Promise<Array<ClienteRecord & { similaridade: number }>> {
  const normalized = nome.trim();
  if (normalized.length < 3) return [];

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const result = await executor(customDb).query<ClienteRow & { similaridade: number }>(
    `SELECT ${clienteColumns},
            similarity(lower(nome_completo), lower($1)) AS similaridade
       FROM clientes
      WHERE status <> 'MESCLADO'
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND (
          lower(nome_completo) % lower($1)
          OR lower(nome_completo) LIKE '%' || lower($1) || '%'
        )
      ORDER BY similaridade DESC, nome_completo ASC
      LIMIT $3`,
    [normalized, options.excluirClienteId ?? null, limit],
  );

  return result.rows.map((row) => ({
    ...mapCliente(row),
    similaridade: Number(row.similaridade),
  }));
}

export async function listarClientes(
  options: {
    status?: ClienteStatus | "CANONICOS";
    limit?: number;
    offset?: number;
  } = {},
  customDb?: DbExecutor,
): Promise<ClienteRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const status = options.status ?? "CANONICOS";

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE (
        $1::text = 'CANONICOS' AND status <> 'MESCLADO'
        OR $1::text <> 'CANONICOS' AND status = $1::text
      )
      ORDER BY nome_completo ASC, criado_em ASC
      LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  );
  return result.rows.map(mapCliente);
}

export async function atualizarCliente(
  id: string,
  patch: UpdateClienteInput,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const setters: string[] = [];
  const values: unknown[] = [];

  function set(column: string, value: unknown) {
    values.push(value);
    setters.push(`${column} = $${values.length}`);
  }

  if (patch.nomeCompleto !== undefined) set("nome_completo", patch.nomeCompleto.trim());
  if (patch.cpf !== undefined) set("cpf", normalizarCpf(patch.cpf));
  if (patch.telefone !== undefined) set("telefone", normalizarTelefone(patch.telefone));
  if (patch.whatsapp !== undefined) set("whatsapp", normalizarTelefone(patch.whatsapp));
  if (patch.email !== undefined) set("email", normalizarEmail(patch.email));
  if (patch.cep !== undefined) set("cep", normalizarCep(patch.cep));
  if (patch.logradouro !== undefined) set("logradouro", textoOuNull(patch.logradouro));
  if (patch.numero !== undefined) set("numero", textoOuNull(patch.numero));
  if (patch.complemento !== undefined) set("complemento", textoOuNull(patch.complemento));
  if (patch.bairro !== undefined) set("bairro", textoOuNull(patch.bairro));
  if (patch.cidade !== undefined) set("cidade", textoOuNull(patch.cidade));
  if (patch.uf !== undefined) set("uf", normalizarUf(patch.uf));
  if (patch.observacoes !== undefined) set("observacoes", textoOuNull(patch.observacoes));

  if (setters.length === 0) return buscarClientePorId(id, customDb);

  set("atualizado_por_usuario_id", patch.usuarioId ?? null);
  values.push(id);

  const result = await executor(customDb).query<ClienteRow>(
    `UPDATE clientes
        SET ${setters.join(", ")}
      WHERE id = $${values.length}
        AND status <> 'MESCLADO'
      RETURNING ${clienteColumns}`,
    values,
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

export async function marcarClienteInativo(
  id: string,
  usuarioId: string | null,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const result = await executor(customDb).query<ClienteRow>(
    `UPDATE clientes
        SET status = 'INATIVO', atualizado_por_usuario_id = $2
      WHERE id = $1
        AND status = 'ATIVO'
      RETURNING ${clienteColumns}`,
    [id, usuarioId],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}
