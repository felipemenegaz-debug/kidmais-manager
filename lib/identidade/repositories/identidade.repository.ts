import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import type {
  ConfirmarValidacaoInput,
  ConsumirProvaIdentidadeContratoInput,
  ConsumirProvaIdentidadeInput,
  CreateDesafioIdentidadeInput,
  ValidacaoIdentidadeRecord,
} from "./models";

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

type ValidacaoIdentidadeRow = {
  id: string;
  cliente_id: string;
  finalidade: ValidacaoIdentidadeRecord["finalidade"];
  canal: ValidacaoIdentidadeRecord["canal"];
  status: ValidacaoIdentidadeRecord["status"];

  codigo_hash: string | null;

  tentativas: number;
  max_tentativas: number;

  envios: number;
  max_envios: number;
  ultimo_envio_em: string | null;

  codigo_expira_em: string | null;

  confirmado_em: string | null;
  token_prova_hash: string | null;
  prova_expira_em: string | null;

  consumido_em: string | null;
  consumido_por_fechamento_id: string | null;
  consumido_por_contrato_versao_id: string | null;

  recuperacao_solicitada_em: string | null;

  criado_em: string;
  atualizado_em: string;
};

const validacaoColumns = `
  id,
  cliente_id,
  finalidade,
  canal,
  status,
  codigo_hash,
  tentativas,
  max_tentativas,
  envios,
  max_envios,
  ultimo_envio_em::text AS ultimo_envio_em,
  codigo_expira_em::text AS codigo_expira_em,
  confirmado_em::text AS confirmado_em,
  token_prova_hash,
  prova_expira_em::text AS prova_expira_em,
  consumido_em::text AS consumido_em,
  consumido_por_fechamento_id,
  consumido_por_contrato_versao_id,
  recuperacao_solicitada_em::text AS recuperacao_solicitada_em,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

function mapValidacao(
  row: ValidacaoIdentidadeRow,
): ValidacaoIdentidadeRecord {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    finalidade: row.finalidade,
    canal: row.canal,
    status: row.status,

    codigoHash: row.codigo_hash,

    tentativas: Number(row.tentativas),
    maxTentativas: Number(row.max_tentativas),

    envios: Number(row.envios),
    maxEnvios: Number(row.max_envios),
    ultimoEnvioEm: row.ultimo_envio_em,

    codigoExpiraEm: row.codigo_expira_em,

    confirmadoEm: row.confirmado_em,
    tokenProvaHash: row.token_prova_hash,
    provaExpiraEm: row.prova_expira_em,

    consumidoEm: row.consumido_em,
    consumidoPorFechamentoId: row.consumido_por_fechamento_id,
    consumidoPorContratoVersaoId: row.consumido_por_contrato_versao_id,

    recuperacaoSolicitadaEm: row.recuperacao_solicitada_em,

    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

export async function criarDesafioIdentidade(
  input: CreateDesafioIdentidadeInput,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `INSERT INTO validacoes_identidade_cliente (
       cliente_id,
       finalidade,
       canal,
       status,
       codigo_hash,
       codigo_expira_em,
       max_tentativas,
       max_envios
     ) VALUES (
       $1::uuid,
       $2,
       $3,
       'PENDENTE',
       $4,
       $5::timestamptz,
       $6,
       $7
     )
     RETURNING ${validacaoColumns}`,
    [
      input.clienteId,
      input.finalidade ?? "FECHAMENTO_PUBLICO",
      input.canal,
      input.codigoHash,
      input.codigoExpiraEm,
      input.maxTentativas ?? 5,
      input.maxEnvios ?? 3,
    ],
  );

  return mapValidacao(result.rows[0]);
}

export async function registrarEnvioOtp(
  validacaoId: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `UPDATE validacoes_identidade_cliente
        SET envios = envios + 1,
            ultimo_envio_em = now()
      WHERE id = $1::uuid
        AND status = 'PENDENTE'
        AND envios < max_envios
      RETURNING ${validacaoColumns}`,
    [validacaoId],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function buscarValidacaoPorId(
  validacaoId: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `SELECT ${validacaoColumns}
       FROM validacoes_identidade_cliente
      WHERE id = $1::uuid
      LIMIT 1`,
    [validacaoId],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

/**
 * Busca uma prova pelo hash independentemente de já ter sido consumida.
 * Uso interno para idempotência de fluxos transacionais.
 */
export async function buscarValidacaoPorTokenHash(
  tokenProvaHash: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `SELECT ${validacaoColumns}
       FROM validacoes_identidade_cliente
      WHERE token_prova_hash = $1
      LIMIT 1`,
    [tokenProvaHash],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function buscarProvaConfirmadaPorTokenHash(
  tokenProvaHash: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `SELECT ${validacaoColumns}
       FROM validacoes_identidade_cliente
      WHERE token_prova_hash = $1
        AND status = 'CONFIRMADA'
        AND confirmado_em IS NOT NULL
        AND consumido_em IS NULL
        AND prova_expira_em > now()
      LIMIT 1`,
    [tokenProvaHash],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function confirmarValidacao(
  input: ConfirmarValidacaoInput,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `UPDATE validacoes_identidade_cliente
        SET status = 'CONFIRMADA',
            codigo_hash = NULL,
            codigo_expira_em = NULL,
            confirmado_em = now(),
            token_prova_hash = $2,
            prova_expira_em = $3::timestamptz
      WHERE id = $1::uuid
        AND status = 'PENDENTE'
        AND codigo_expira_em > now()
        AND tentativas < max_tentativas
      RETURNING ${validacaoColumns}`,
    [
      input.validacaoId,
      input.tokenProvaHash,
      input.provaExpiraEm,
    ],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function registrarTentativaInvalida(
  validacaoId: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `UPDATE validacoes_identidade_cliente
        SET tentativas = tentativas + 1,
            status = CASE
              WHEN tentativas + 1 >= max_tentativas
                THEN 'BLOQUEADA'
              ELSE status
            END
      WHERE id = $1::uuid
        AND status = 'PENDENTE'
        AND tentativas < max_tentativas
      RETURNING ${validacaoColumns}`,
    [validacaoId],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

/** Mantido para o fluxo existente de Fechamento. */
export async function consumirProvaIdentidade(
  input: ConsumirProvaIdentidadeInput,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `UPDATE validacoes_identidade_cliente
        SET status = 'CONSUMIDA',
            consumido_em = now(),
            consumido_por_fechamento_id = $2::uuid
      WHERE token_prova_hash = $1
        AND finalidade = 'FECHAMENTO_PUBLICO'
        AND status = 'CONFIRMADA'
        AND consumido_em IS NULL
        AND prova_expira_em > now()
      RETURNING ${validacaoColumns}`,
    [
      input.tokenProvaHash,
      input.fechamentoId,
    ],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function consumirProvaIdentidadeParaContrato(
  input: ConsumirProvaIdentidadeContratoInput,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord | null> {
  const result = await executor(customDb).query<ValidacaoIdentidadeRow>(
    `UPDATE validacoes_identidade_cliente
        SET status = 'CONSUMIDA',
            consumido_em = now(),
            consumido_por_contrato_versao_id = $2::uuid
      WHERE token_prova_hash = $1
        AND finalidade = 'CONTRATO_ACEITE'
        AND status = 'CONFIRMADA'
        AND consumido_em IS NULL
        AND prova_expira_em > now()
      RETURNING ${validacaoColumns}`,
    [
      input.tokenProvaHash,
      input.contratoVersaoId,
    ],
  );

  return result.rows[0] ? mapValidacao(result.rows[0]) : null;
}

export async function criarRecuperacaoPendente(
  clienteId: string,
  customDb?: DbExecutor,
): Promise<ValidacaoIdentidadeRecord> {
  const exec = executor(customDb);

  const existente = await exec.query<ValidacaoIdentidadeRow>(
    `SELECT ${validacaoColumns}
       FROM validacoes_identidade_cliente
      WHERE cliente_id = $1::uuid
        AND finalidade = 'FECHAMENTO_PUBLICO'
        AND status = 'RECUPERACAO_PENDENTE'
      ORDER BY criado_em DESC
      LIMIT 1`,
    [clienteId],
  );

  if (existente.rows[0]) return mapValidacao(existente.rows[0]);

  const result = await exec.query<ValidacaoIdentidadeRow>(
    `INSERT INTO validacoes_identidade_cliente (
       cliente_id,
       finalidade,
       canal,
       status,
       recuperacao_solicitada_em
     ) VALUES (
       $1::uuid,
       'FECHAMENTO_PUBLICO',
       NULL,
       'RECUPERACAO_PENDENTE',
       now()
     )
     RETURNING ${validacaoColumns}`,
    [clienteId],
  );

  return mapValidacao(result.rows[0]);
}
