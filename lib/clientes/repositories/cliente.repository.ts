import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import { mapCliente, type ClienteRow } from "./mappers";
import type {
  ClienteRecord,
  ClienteStatus,
  CreateClienteInput,
  UpdateClienteInput,
} from "./models";
import { normalizarCnpj } from "../../cadastro/cnpj.ts";
import {
  normalizarCep,
  normalizarCpf,
  normalizarEmail,
  normalizarTelefone,
  normalizarUf,
  textoOuNull,
} from "./normalizers";

/**
 * Colunas do cliente, com e sem a 112 numa consulta só (R2-3): as colunas de PJ são lidas pela linha inteira em JSON
 * (`to_jsonb(<alias>) ->> 'cnpj'`), que devolve NULL quando a coluna não existe. Assim nenhuma leitura depende de
 * detecção nem de cache: antes da 112, depois dela e depois de um rollback a mesma consulta vale; o mapper assume PF.
 * Escritas de PJ, ao contrário, exigem `migration112Aplicada` na própria transação.
 */
export function colunasCliente(alias = "clientes") {
  const a = alias;
  const json = (coluna: string) => `to_jsonb(${a}) ->> '${coluna}' AS ${coluna}`;
  return `
  ${a}.id, ${a}.empresa_id, ${a}.nome_completo, ${a}.cpf, ${a}.rg, ${a}.telefone, ${a}.whatsapp, ${a}.email,
  ${a}.cep, ${a}.logradouro, ${a}.numero, ${a}.complemento, ${a}.bairro, ${a}.cidade, ${a}.uf, ${a}.observacoes,
  ${a}.status, ${a}.cliente_principal_id, ${a}.mesclado_em,
  ${a}.criado_por_usuario_id, ${a}.atualizado_por_usuario_id,
  ${a}.criado_em, ${a}.atualizado_em,
  ${["tipo_pessoa", "cnpj", "razao_social", "nome_fantasia", "representante_nome", "representante_cpf"].map(json).join(", ")}
`;
}
const clienteColumns = colunasCliente();

/** A 112 (cliente PJ) está aplicada? Conferido na transação de quem grava, sem cache (vale também depois de um rollback). */
export async function migration112Aplicada(customDb?: DbExecutor) {
  const r = await executor(customDb).query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'tipo_pessoa' AND NOT attisdropped) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

const CAMPOS_PJ = ["cnpj", "nomeFantasia", "representanteNome", "representanteCpf"] as const;
/** Algum dado próprio de PJ na entrada? (PF nunca grava esses campos: CHECK da 112 e regra do serviço.) */
export function entradaTemDadoPj(input: Partial<CreateClienteInput>) {
  return input.tipoPessoa === "PJ" || CAMPOS_PJ.some((k) => typeof input[k] === "string" && input[k]!.trim() !== "");
}

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

export async function criarCliente(
  input: CreateClienteInput,
  customDb?: DbExecutor,
): Promise<ClienteRecord> {
  if (input.tipoPessoa === "PJ") return criarClientePj(input, customDb);
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

/** PJ: só com a 112 (o serviço já recusou antes, com PJ_INDISPONIVEL; aqui é a defesa em profundidade). */
async function criarClientePj(input: CreateClienteInput, customDb?: DbExecutor): Promise<ClienteRecord> {
  if (!(await migration112Aplicada(customDb))) throw new Error("112 ausente: cliente PJ indisponível.");
  const razao = input.nomeCompleto.trim();
  const result = await executor(customDb).query<ClienteRow>(
    `INSERT INTO clientes (
       empresa_id, nome_completo, tipo_pessoa, cpf, cnpj, razao_social, nome_fantasia, representante_nome, representante_cpf,
       rg, telefone, whatsapp, email, cep, logradouro, numero, complemento, bairro, cidade, uf, observacoes,
       criado_por_usuario_id, atualizado_por_usuario_id
     ) VALUES (
       $1, $2, 'PJ', NULL, $3, $2, $4, $5, $6,
       NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $18
     )
     RETURNING ${clienteColumns}`,
    [
      input.empresaId,
      razao,
      normalizarCnpj(input.cnpj) || null,
      textoOuNull(input.nomeFantasia),
      textoOuNull(input.representanteNome),
      normalizarCpf(input.representanteCpf),
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
    `SELECT ${colunasCliente("c")}
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
 * Escopo da identidade pública: a empresa do endereço (resolvida no servidor, nunca do corpo do pedido).
 * `incluirLegadoSemEmpresa` só no endereço atual da instalação: clientes anteriores à 054 (sem empresa)
 * nasceram nela. Endereço de outra empresa nunca enxerga legado nem cliente de terceiros.
 */
export type EscopoIdentidade =
  | { empresaId: string; incluirLegadoSemEmpresa: boolean }
  /** Aceite de contrato: só o cliente canônico do próprio contrato. */
  | { clienteId: string };

/**
 * Busca por CNPJ só para a prova de identidade pública (Entrega B, R2-1), no mesmo escopo da busca por CPF. Exige a
 * 112 (quem chama confere antes, na mesma transação). Só PJ: o CNPJ é a chave dela; o CPF do representante nunca entra.
 */
export async function buscarClienteCanonicoPorCnpjParaIdentidade(
  cnpj: string,
  escopo: EscopoIdentidade,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const normalized = normalizarCnpj(cnpj);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(normalized)) return null;
  if (escopo && "clienteId" in escopo) {
    if (!escopo.clienteId) return null;
    const porCliente = await executor(customDb).query<ClienteRow>(
      `SELECT ${clienteColumns} FROM clientes WHERE cnpj = $1 AND tipo_pessoa = 'PJ' AND status <> 'MESCLADO' AND id = $2::uuid LIMIT 1`,
      [normalized, escopo.clienteId],
    );
    return porCliente.rows[0] ? mapCliente(porCliente.rows[0]) : null;
  }
  if (!escopo?.empresaId) return null;
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE cnpj = $1
        AND tipo_pessoa = 'PJ'
        AND status <> 'MESCLADO'
        AND (empresa_id = $2::uuid OR ($3::boolean AND empresa_id IS NULL))
      ORDER BY (empresa_id IS NULL), id
      LIMIT 1`,
    [normalized, escopo.empresaId, escopo.incluirLegadoSemEmpresa === true],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

/**
 * Busca por CPF só para a prova de identidade pública (lib/identidade), dentro da empresa do endereço.
 * Antes e depois da 076 (CPF único por empresa) o resultado é no máximo um cliente da empresa; cadastro da
 * própria empresa tem prioridade sobre legado. Não usar em CRM, cadastro ou deduplicação.
 */
export async function buscarClienteCanonicoPorCpfParaIdentidade(
  cpf: string,
  escopo: EscopoIdentidade,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const normalized = normalizarCpf(cpf);
  if (!normalized) return null;
  if (escopo && "clienteId" in escopo) {
    if (!escopo.clienteId) return null;
    const porCliente = await executor(customDb).query<ClienteRow>(
      `SELECT ${clienteColumns} FROM clientes WHERE cpf = $1 AND status <> 'MESCLADO' AND id = $2::uuid LIMIT 1`,
      [normalized, escopo.clienteId],
    );
    return porCliente.rows[0] ? mapCliente(porCliente.rows[0]) : null;
  }
  if (!escopo?.empresaId) return null;

  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns}
       FROM clientes
      WHERE cpf = $1
        AND status <> 'MESCLADO'
        AND (empresa_id = $2::uuid OR ($3::boolean AND empresa_id IS NULL))
      ORDER BY (empresa_id IS NULL), id
      LIMIT 1`,
    [normalized, escopo.empresaId, escopo.incluirLegadoSemEmpresa === true],
  );
  return result.rows[0] ? mapCliente(result.rows[0]) : null;
}

/**
 * Só existência, para o fechamento público por endereço de empresa decidir se grava o CPF: true apenas enquanto
 * o índice global da 002 existir (antes da 076) E o CPF estiver em cadastro de OUTRA empresa ou legado.
 * Depois da 076 é sempre false (o CPF de outra empresa não conflita). Nunca sai na resposta pública.
 */
export async function cpfBloqueadoPorOutraEmpresa(cpf: string, empresaId: string, customDb?: DbExecutor): Promise<boolean> {
  const normalized = normalizarCpf(cpf);
  if (!normalized) return false;
  const result = await executor(customDb).query<{ bloqueado: boolean }>(
    `SELECT to_regclass('public.clientes_cpf_canonico_uk') IS NOT NULL
        AND EXISTS(SELECT 1 FROM clientes WHERE cpf = $1 AND status <> 'MESCLADO' AND empresa_id IS DISTINCT FROM $2::uuid) AS bloqueado`,
    [normalized, empresaId],
  );
  return result.rows[0]?.bloqueado === true;
}

/** Nomes do índice de CPF canônico: global (002, até a 076) e por empresa (076). */
export const INDICES_CPF_CANONICO = ["clientes_cpf_canonico_uk", "clientes_cpf_empresa_canonico_uk"] as const;
/** 112: CNPJ único por empresa fora de MESCLADO. */
export const INDICE_CNPJ_CANONICO = "clientes_cnpj_empresa_canonico_uk";

/** Duplicidade de PJ (R2-5): o CNPJ na empresa do tenant. Sem a 112 não há PJ: null sem consultar a coluna. */
export async function buscarClienteCanonicoPorCnpj(
  cnpj: string,
  empresaId: string,
  customDb?: DbExecutor,
): Promise<ClienteRecord | null> {
  const normalized = normalizarCnpj(cnpj);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(normalized)) return null;
  if (!(await migration112Aplicada(customDb))) return null;
  const result = await executor(customDb).query<ClienteRow>(
    `SELECT ${clienteColumns} FROM clientes WHERE empresa_id = $2::uuid AND cnpj = $1 AND status <> 'MESCLADO' LIMIT 1`,
    [normalized, empresaId],
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
          OR lower(coalesce(to_jsonb(clientes) ->> 'nome_fantasia', '')) LIKE '%' || lower($1) || '%'
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
  // Escopo recusado antes de qualquer consulta (inclusive a do catálogo da 112).
  condicaoEscopo(escopo, id, 0);
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

  // 112: campos de PJ só com a migration na própria transação. Troca de tipo para PF limpa os cinco campos na mesma
  // gravação (R21-3); a razão social acompanha sempre o nome_completo da PJ (CHECK clientes_112_pj_identidade).
  const tocaPj = patch.tipoPessoa !== undefined || CAMPOS_PJ.some((k) => patch[k] !== undefined);
  if (tocaPj || patch.nomeCompleto !== undefined) {
    const com112 = await migration112Aplicada(customDb);
    if (tocaPj && !com112) throw new Error("112 ausente: cliente PJ indisponível.");
    if (com112) {
      if (patch.tipoPessoa !== undefined) set("tipo_pessoa", patch.tipoPessoa);
      if (patch.tipoPessoa === "PF") {
        for (const coluna of ["cnpj", "nome_fantasia", "representante_nome", "representante_cpf"]) set(coluna, null);
      } else {
        if (patch.cnpj !== undefined) set("cnpj", normalizarCnpj(patch.cnpj) || null);
        if (patch.nomeFantasia !== undefined) set("nome_fantasia", textoOuNull(patch.nomeFantasia));
        if (patch.representanteNome !== undefined) set("representante_nome", textoOuNull(patch.representanteNome));
        if (patch.representanteCpf !== undefined) set("representante_cpf", normalizarCpf(patch.representanteCpf));
      }
      const tipoNovo = patch.tipoPessoa !== undefined ? `'${patch.tipoPessoa === "PJ" ? "PJ" : "PF"}'` : "tipo_pessoa";
      const nomeNovo = patch.nomeCompleto !== undefined ? `$${values.length + 1}` : "nome_completo";
      if (patch.nomeCompleto !== undefined) values.push(patch.nomeCompleto.trim());
      setters.push(`razao_social = CASE WHEN ${tipoNovo} = 'PJ' THEN ${nomeNovo} ELSE NULL END`);
    }
  }

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
