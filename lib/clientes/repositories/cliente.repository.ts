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
  id, empresa_id, nome_completo, cpf, rg, telefone, whatsapp, email,
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
       empresa_id, nome_completo, cpf, rg, telefone, whatsapp, email,
       cep, logradouro, numero, complemento, bairro, cidade, uf, observacoes,
       criado_por_usuario_id, atualizado_por_usuario_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $16
     )
     RETURNING ${clienteColumns}`,
    [
      input.empresaId,
      input.nomeCompleto.trim(),
      normalizarCpf(input.cpf),
      textoOuNull(input.rg),
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

/**
 * Leitura por id sem escopo: só para quem já chegou ao id por uma relação comprovada
 * (fechamento.clienteId, prova de identidade, snapshot contratual). Nunca para um id recebido
 * de request administrativa — nesse caso o service confere `empresaId` do Tenant Context.
 */
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

/** Retorna o Cliente canônico quando o id informado já tiver sido mesclado. Sem escopo de tenant — ver nota de `buscarClientePorId`. */
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

/**
 * Todas as buscas de CRM e deduplicação abaixo recebem o tenant comprovado e filtram
 * `empresa_id` na própria consulta, antes de ORDER BY/LIMIT. Cliente de outra empresa ou legado
 * sem empresa nunca é candidato. Não existe variante "sem empresa" destas buscas.
 */
export async function buscarClienteCanonicoPorCpf(
  cpf: string,
  empresaId: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const normalized = normalizarCpf(cpf);
  if (!normalized) return null;

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE empresa_id = $2::uuid
        AND cpf = $1
        AND status <> 'MESCLADO'
      LIMIT 1`,
    [normalized, empresaId],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

/**
 * Busca global por CPF, só para a prova de identidade pública (lib/identidade), que ainda não
 * tem Tenant Context: enquanto o índice clientes_cpf_canonico_uk for global (até o PR-B2), o
 * CPF identifica no máximo um cliente canônico. Não usar em CRM, cadastro ou deduplicação.
 */
export async function buscarClienteCanonicoPorCpfParaIdentidade(
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
  empresaId: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord[]> {
  const normalized = normalizarTelefone(contato);
  if (!normalized) return [];

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE empresa_id = $2::uuid
        AND status <> 'MESCLADO'
        AND (telefone = $1 OR whatsapp = $1)
      ORDER BY atualizado_em DESC`,
    [normalized, empresaId],
  );
  return result.rows.map(mapCliente);
}

export async function buscarClientesPorNomeSemelhante(
  nome: string,
  empresaId: string,
  options: { limit?: number; excluirClienteId?: string; incluirInativos?: boolean } = {},
  customDb?: DbExecutor,
): Promise<Array<ClienteRecord & { similaridade: number }>> {
  const normalized = nome.trim();
  if (normalized.length < 3) return [];

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const result = await executor(customDb).query<ClienteRow & { similaridade: number }>(
    `SELECT ${clienteColumns},
            similarity(lower(nome_completo), lower($1)) AS similaridade
       FROM clientes
      WHERE empresa_id = $5::uuid
        AND status <> 'MESCLADO'
        AND ($4::boolean OR status = 'ATIVO')
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND (
          lower(nome_completo) % lower($1)
          OR lower(nome_completo) LIKE '%' || lower($1) || '%'
        )
      ORDER BY similaridade DESC, nome_completo ASC
      LIMIT $3`,
    [normalized, options.excluirClienteId ?? null, limit, options.incluirInativos ?? true, empresaId],
  );

  return result.rows.map((row) => ({
    ...mapCliente(row),
    similaridade: Number(row.similaridade),
  }));
}


export async function buscarClientesPorEmail(
  termo: string,
  empresaId: string,
  options: { limit?: number; incluirInativos?: boolean } = {},
  customDb?: DbExecutor,
): Promise<ClienteRecord[]> {
  const q = termo.trim().toLowerCase();
  if (q.length < 3) return [];

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE empresa_id = $4::uuid
        AND status <> 'MESCLADO'
        AND ($3::boolean OR status = 'ATIVO')
        AND email IS NOT NULL
        AND lower(email) LIKE '%' || $1 || '%'
      ORDER BY nome_completo ASC
      LIMIT $2`,
    [q, limit, options.incluirInativos ?? true, empresaId],
  );
  return result.rows.map(mapCliente);
}

export async function buscarClientesPorEmailExato(
  email: string,
  empresaId: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord[]> {
  const normalized = normalizarEmail(email);
  if (!normalized) return [];
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns} FROM clientes WHERE empresa_id = $2::uuid AND status <> 'MESCLADO' AND lower(email)=$1 ORDER BY nome_completo,id`,
    [normalized, empresaId],
  );
  return result.rows.map(mapCliente);
}

export async function listarClientes(
  empresaId: string,
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
      WHERE empresa_id = $1
        AND (
          $2::text = 'CANONICOS' AND status <> 'MESCLADO'
          OR $2::text <> 'CANONICOS' AND status = $2::text
        )
      ORDER BY nome_completo ASC, criado_em ASC
      LIMIT $3 OFFSET $4`,
    [empresaId, status, limit, offset],
  );
  return result.rows.map(mapCliente);
}

/**
 * Como a escrita foi autorizada. As duas formas são distintas e não se convertem:
 *  - TENANT: Tenant Context administrativo comprovado; o cliente precisa ser dessa empresa
 *    (legado sem empresa não casa).
 *  - IDENTIDADE: prova de identidade (OTP) resolvida para este cliente exato; não concede
 *    Tenant Context e só vale para o próprio clienteId comprovado.
 */
export type EscopoEscritaCliente =
  | { tipo: "TENANT"; empresaId: string }
  | { tipo: "IDENTIDADE"; clienteIdComprovado: string };

function condicaoEscopo(escopo: EscopoEscritaCliente, id: string, proximo: number) {
  if (escopo.tipo === "TENANT") {
    return { sql: `AND empresa_id = $${proximo}::uuid`, valor: escopo.empresaId as unknown };
  }
  if (escopo.clienteIdComprovado !== id) {
    throw new Error("Prova de identidade não pertence a este cliente.");
  }
  return { sql: "", valor: undefined };
}

export async function atualizarCliente(
  id: string,
  escopo: EscopoEscritaCliente,
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
  if (patch.rg !== undefined) set("rg", textoOuNull(patch.rg));
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

  if (setters.length === 0) {
    const filtro = condicaoEscopo(escopo, id, 2);
    const semAlteracao = await executor(customDb).query<ClienteRow>(
      `SELECT ${clienteColumns} FROM clientes WHERE id = $1 ${filtro.sql} LIMIT 1`,
      filtro.sql ? [id, filtro.valor] : [id],
    );
    return semAlteracao.rows[0] ? mapCliente(semAlteracao.rows[0]) : null;
  }

  set("atualizado_por_usuario_id", patch.usuarioId ?? null);
  values.push(id);
  const posicaoId = values.length;
  const filtro = condicaoEscopo(escopo, id, posicaoId + 1);
  if (filtro.sql) values.push(filtro.valor);

  const result = await executor(customDb).query<ClienteRow>(
    `UPDATE clientes
        SET ${setters.join(", ")}
      WHERE id = $${posicaoId}
        ${filtro.sql}
        AND status <> 'MESCLADO'
      RETURNING ${clienteColumns}`,
    values,
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

export async function marcarClienteInativo(
  id: string,
  empresaId: string,
  usuarioId: string | null,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const result = await executor(customDb).query<ClienteRow>(
    `UPDATE clientes
        SET status = 'INATIVO', atualizado_por_usuario_id = $3
      WHERE id = $1
        AND empresa_id = $2
        AND status = 'ATIVO'
      RETURNING ${clienteColumns}`,
    [id, empresaId, usuarioId],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}
