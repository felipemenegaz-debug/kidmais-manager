import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import type {
  ComprovantePagamentoRecord,
  EstornoRecord,
  PagamentoRecord,
  PagamentoStatus,
  ParcelaMovimentoResumo,
  ParcelaPagamentoRecord,
  ParcelaPagamentoStatus,
  PlanoPagamentoRecord,
  RecebimentoAlocacaoRecord,
  RecebimentoRecord,
  RecebimentoStatus,
  ReservaPagamentoStatus,
} from "./models";

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

type PagamentoRow = {
  id: string;
  contrato_versao_id: string;
  valor_total_contratado: string | number;
  moeda: "BRL";
  status: PagamentoRecord["status"];
  reserva_status: PagamentoRecord["reservaStatus"];
  reserva_confirmada_em: string | null;
  reserva_conflito_em: string | null;
  quitado_em: string | null;
  cancelado_em: string | null;
  criado_por_usuario_id: string | null;
  criado_em: string;
  atualizado_em: string;
};

type PlanoRow = {
  id: string;
  pagamento_id: string;
  numero_versao: number;
  status: PlanoPagamentoRecord["status"];
  meio_pagamento: PlanoPagamentoRecord["meioPagamento"];
  modalidade: PlanoPagamentoRecord["modalidade"];
  quantidade_parcelas: number;
  provedor_preferido: string | null;
  observacoes: string | null;
  motivo_substituicao: string | null;
  criado_por_usuario_id: string | null;
  criado_em: string;
  substituido_em: string | null;
  cancelado_em: string | null;
};

type ParcelaRow = {
  id: string;
  plano_id: string;
  numero: number;
  valor_previsto: string | number;
  vencimento: string;
  confirma_reserva: boolean;
  status: ParcelaPagamentoRecord["status"];
  criado_em: string;
  atualizado_em: string;
};

type RecebimentoRow = {
  id: string;
  pagamento_id: string;
  status: RecebimentoRecord["status"];
  meio_pagamento: RecebimentoRecord["meioPagamento"];
  valor_bruto: string | number;
  recebido_em: string;
  confirmado_em: string | null;
  cancelado_em: string | null;
  provedor_codigo: string | null;
  referencia_externa: string | null;
  chave_idempotencia: string | null;
  metadata_provedor: Record<string, unknown>;
  registrado_por_usuario_id: string | null;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
};

type AlocacaoRow = {
  id: string;
  recebimento_id: string;
  parcela_id: string;
  valor_alocado: string | number;
  criado_em: string;
};

type EstornoRow = {
  id: string;
  recebimento_id: string;
  parcela_id: string;
  valor: string | number;
  status: EstornoRecord["status"];
  motivo: string | null;
  solicitado_em: string;
  confirmado_em: string | null;
  cancelado_em: string | null;
  provedor_codigo: string | null;
  referencia_externa: string | null;
  chave_idempotencia: string | null;
  metadata_provedor: Record<string, unknown>;
  registrado_por_usuario_id: string | null;
  criado_em: string;
  atualizado_em: string;
};

type ComprovanteRow = {
  id: string;
  recebimento_id: string;
  nome_arquivo: string;
  mime_type: string;
  tamanho_bytes: string | number;
  sha256: string;
  localizador_arquivo: string;
  registrado_por_usuario_id: string | null;
  criado_em: string;
};

const pagamentoColumns = `
  id,
  contrato_versao_id,
  valor_total_contratado,
  moeda,
  status,
  reserva_status,
  reserva_confirmada_em::text AS reserva_confirmada_em,
  reserva_conflito_em::text AS reserva_conflito_em,
  quitado_em::text AS quitado_em,
  cancelado_em::text AS cancelado_em,
  criado_por_usuario_id,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;


const pagamentoColumnsAliased = `
  p.id,
  p.contrato_versao_id,
  p.valor_total_contratado,
  p.moeda,
  p.status,
  p.reserva_status,
  p.reserva_confirmada_em::text AS reserva_confirmada_em,
  p.reserva_conflito_em::text AS reserva_conflito_em,
  p.quitado_em::text AS quitado_em,
  p.cancelado_em::text AS cancelado_em,
  p.criado_por_usuario_id,
  p.criado_em::text AS criado_em,
  p.atualizado_em::text AS atualizado_em
`;

const planoColumns = `
  id,
  pagamento_id,
  numero_versao,
  status,
  meio_pagamento,
  modalidade,
  quantidade_parcelas,
  provedor_preferido,
  observacoes,
  motivo_substituicao,
  criado_por_usuario_id,
  criado_em::text AS criado_em,
  substituido_em::text AS substituido_em,
  cancelado_em::text AS cancelado_em
`;

const parcelaColumns = `
  id,
  plano_id,
  numero,
  valor_previsto,
  vencimento::text AS vencimento,
  confirma_reserva,
  status,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

const recebimentoColumns = `
  id,
  pagamento_id,
  status,
  meio_pagamento,
  valor_bruto,
  recebido_em::text AS recebido_em,
  confirmado_em::text AS confirmado_em,
  cancelado_em::text AS cancelado_em,
  provedor_codigo,
  referencia_externa,
  chave_idempotencia,
  metadata_provedor,
  registrado_por_usuario_id,
  observacoes,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

const alocacaoColumns = `
  id,
  recebimento_id,
  parcela_id,
  valor_alocado,
  criado_em::text AS criado_em
`;

const estornoColumns = `
  id,
  recebimento_id,
  parcela_id,
  valor,
  status,
  motivo,
  solicitado_em::text AS solicitado_em,
  confirmado_em::text AS confirmado_em,
  cancelado_em::text AS cancelado_em,
  provedor_codigo,
  referencia_externa,
  chave_idempotencia,
  metadata_provedor,
  registrado_por_usuario_id,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

function mapPagamento(row: PagamentoRow): PagamentoRecord {
  return {
    id: row.id,
    contratoVersaoId: row.contrato_versao_id,
    valorTotalContratado: Number(row.valor_total_contratado),
    moeda: row.moeda,
    status: row.status,
    reservaStatus: row.reserva_status,
    reservaConfirmadaEm: row.reserva_confirmada_em,
    reservaConflitoEm: row.reserva_conflito_em,
    quitadoEm: row.quitado_em,
    canceladoEm: row.cancelado_em,
    criadoPorUsuarioId: row.criado_por_usuario_id,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapPlano(row: PlanoRow): PlanoPagamentoRecord {
  return {
    id: row.id,
    pagamentoId: row.pagamento_id,
    numeroVersao: Number(row.numero_versao),
    status: row.status,
    meioPagamento: row.meio_pagamento,
    modalidade: row.modalidade,
    quantidadeParcelas: Number(row.quantidade_parcelas),
    provedorPreferido: row.provedor_preferido,
    observacoes: row.observacoes,
    motivoSubstituicao: row.motivo_substituicao,
    criadoPorUsuarioId: row.criado_por_usuario_id,
    criadoEm: row.criado_em,
    substituidoEm: row.substituido_em,
    canceladoEm: row.cancelado_em,
  };
}

function mapParcela(row: ParcelaRow): ParcelaPagamentoRecord {
  return {
    id: row.id,
    planoId: row.plano_id,
    numero: Number(row.numero),
    valorPrevisto: Number(row.valor_previsto),
    vencimento: row.vencimento,
    confirmaReserva: row.confirma_reserva,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapRecebimento(row: RecebimentoRow): RecebimentoRecord {
  return {
    id: row.id,
    pagamentoId: row.pagamento_id,
    status: row.status,
    meioPagamento: row.meio_pagamento,
    valorBruto: Number(row.valor_bruto),
    recebidoEm: row.recebido_em,
    confirmadoEm: row.confirmado_em,
    canceladoEm: row.cancelado_em,
    provedorCodigo: row.provedor_codigo,
    referenciaExterna: row.referencia_externa,
    chaveIdempotencia: row.chave_idempotencia,
    metadataProvedor: row.metadata_provedor ?? {},
    registradoPorUsuarioId: row.registrado_por_usuario_id,
    observacoes: row.observacoes,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapAlocacao(row: AlocacaoRow): RecebimentoAlocacaoRecord {
  return {
    id: row.id,
    recebimentoId: row.recebimento_id,
    parcelaId: row.parcela_id,
    valorAlocado: Number(row.valor_alocado),
    criadoEm: row.criado_em,
  };
}

function mapEstorno(row: EstornoRow): EstornoRecord {
  return {
    id: row.id,
    recebimentoId: row.recebimento_id,
    parcelaId: row.parcela_id,
    valor: Number(row.valor),
    status: row.status,
    motivo: row.motivo,
    solicitadoEm: row.solicitado_em,
    confirmadoEm: row.confirmado_em,
    canceladoEm: row.cancelado_em,
    provedorCodigo: row.provedor_codigo,
    referenciaExterna: row.referencia_externa,
    chaveIdempotencia: row.chave_idempotencia,
    metadataProvedor: row.metadata_provedor ?? {},
    registradoPorUsuarioId: row.registrado_por_usuario_id,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

export async function criarPagamento(input: {
  contratoVersaoId: string;
  valorTotalContratado: number;
  criadoPorUsuarioId?: string | null;
}, customDb?: DbExecutor) {
  const result = await executor(customDb).query<PagamentoRow>(
    `INSERT INTO pagamentos (
       contrato_versao_id, valor_total_contratado, criado_por_usuario_id
     ) VALUES ($1::uuid, $2, $3::uuid)
     RETURNING ${pagamentoColumns}`,
    [input.contratoVersaoId, input.valorTotalContratado, input.criadoPorUsuarioId ?? null],
  );
  return mapPagamento(result.rows[0]);
}

export async function buscarPagamentoPorId(
  pagamentoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<PagamentoRecord | null> {
  const result = await executor(customDb).query<PagamentoRow>(
    `SELECT ${pagamentoColumns}
       FROM pagamentos
      WHERE id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [pagamentoId],
  );
  return result.rows[0] ? mapPagamento(result.rows[0]) : null;
}

export async function buscarPagamentoPorContratoVersaoId(
  contratoVersaoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<PagamentoRecord | null> {
  const result = await executor(customDb).query<PagamentoRow>(
    `SELECT ${pagamentoColumns}
       FROM pagamentos
      WHERE contrato_versao_id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [contratoVersaoId],
  );
  return result.rows[0] ? mapPagamento(result.rows[0]) : null;
}

export async function buscarPagamentoPorFechamentoId(
  fechamentoId: string,
  customDb?: DbExecutor,
): Promise<PagamentoRecord | null> {
  const result = await executor(customDb).query<PagamentoRow>(
    `SELECT ${pagamentoColumnsAliased}
       FROM pagamentos p
       JOIN contrato_versoes cv ON cv.id = p.contrato_versao_id
       JOIN contratos c ON c.id = cv.contrato_id
      WHERE c.fechamento_id = $1::uuid
      ORDER BY p.criado_em DESC
      LIMIT 1`,
    [fechamentoId],
  );
  return result.rows[0] ? mapPagamento(result.rows[0]) : null;
}

export async function atualizarStatusPagamento(
  pagamentoId: string,
  status: PagamentoStatus,
  customDb?: DbExecutor,
): Promise<PagamentoRecord> {
  const result = await executor(customDb).query<PagamentoRow>(
    `UPDATE pagamentos
        SET status = $2::varchar(30),
            quitado_em = CASE
              WHEN $2::varchar(30) = 'QUITADO' AND quitado_em IS NULL THEN now()
              ELSE quitado_em
            END
      WHERE id = $1::uuid
      RETURNING ${pagamentoColumns}`,
    [pagamentoId, status],
  );
  return mapPagamento(result.rows[0]);
}

export async function marcarReservaPagamento(
  pagamentoId: string,
  status: Exclude<ReservaPagamentoStatus, "PENDENTE">,
  customDb?: DbExecutor,
): Promise<PagamentoRecord> {
  const result = await executor(customDb).query<PagamentoRow>(
    `UPDATE pagamentos
        SET reserva_status = $2::varchar(20),
            reserva_confirmada_em = CASE WHEN $2::varchar(20) = 'CONFIRMADA' THEN COALESCE(reserva_confirmada_em, now()) ELSE reserva_confirmada_em END,
            reserva_conflito_em = CASE WHEN $2::varchar(20) = 'CONFLITO' THEN COALESCE(reserva_conflito_em, now()) ELSE reserva_conflito_em END
      WHERE id = $1::uuid
        AND reserva_status = 'PENDENTE'
      RETURNING ${pagamentoColumns}`,
    [pagamentoId, status],
  );
  return result.rows[0] ? mapPagamento(result.rows[0]) : (await buscarPagamentoPorId(pagamentoId, customDb))!;
}

export async function criarPlanoPagamento(input: {
  pagamentoId: string;
  numeroVersao: number;
  meioPagamento: PlanoPagamentoRecord["meioPagamento"];
  modalidade: PlanoPagamentoRecord["modalidade"];
  quantidadeParcelas: number;
  provedorPreferido?: string | null;
  observacoes?: string | null;
  criadoPorUsuarioId?: string | null;
}, customDb?: DbExecutor): Promise<PlanoPagamentoRecord> {
  const result = await executor(customDb).query<PlanoRow>(
    `INSERT INTO pagamento_planos (
       pagamento_id, numero_versao, meio_pagamento, modalidade,
       quantidade_parcelas, provedor_preferido, observacoes, criado_por_usuario_id
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid)
     RETURNING ${planoColumns}`,
    [
      input.pagamentoId,
      input.numeroVersao,
      input.meioPagamento,
      input.modalidade,
      input.quantidadeParcelas,
      input.provedorPreferido ?? null,
      input.observacoes ?? null,
      input.criadoPorUsuarioId ?? null,
    ],
  );
  return mapPlano(result.rows[0]);
}

export async function buscarPlanoAtivo(
  pagamentoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<PlanoPagamentoRecord | null> {
  const result = await executor(customDb).query<PlanoRow>(
    `SELECT ${planoColumns}
       FROM pagamento_planos
      WHERE pagamento_id = $1::uuid
        AND status = 'ATIVO'
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [pagamentoId],
  );
  return result.rows[0] ? mapPlano(result.rows[0]) : null;
}

export async function substituirPlanoAtivo(
  planoId: string,
  motivo: string,
  customDb?: DbExecutor,
): Promise<PlanoPagamentoRecord> {
  const result = await executor(customDb).query<PlanoRow>(
    `UPDATE pagamento_planos
        SET status = 'SUBSTITUIDO',
            substituido_em = now(),
            motivo_substituicao = $2
      WHERE id = $1::uuid
        AND status = 'ATIVO'
      RETURNING ${planoColumns}`,
    [planoId, motivo],
  );
  return mapPlano(result.rows[0]);
}

export async function criarParcelaPagamento(input: {
  planoId: string;
  numero: number;
  valorPrevisto: number;
  vencimento: string;
  confirmaReserva: boolean;
}, customDb?: DbExecutor): Promise<ParcelaPagamentoRecord> {
  const result = await executor(customDb).query<ParcelaRow>(
    `INSERT INTO pagamento_parcelas (
       plano_id, numero, valor_previsto, vencimento, confirma_reserva
     ) VALUES ($1::uuid,$2,$3,$4::date,$5)
     RETURNING ${parcelaColumns}`,
    [input.planoId, input.numero, input.valorPrevisto, input.vencimento, input.confirmaReserva],
  );
  return mapParcela(result.rows[0]);
}

export async function listarParcelasPlano(planoId: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<ParcelaRow>(
    `SELECT ${parcelaColumns}
       FROM pagamento_parcelas
      WHERE plano_id = $1::uuid
      ORDER BY numero ASC`,
    [planoId],
  );
  return result.rows.map(mapParcela);
}

export async function buscarParcelaPorId(
  parcelaId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<ParcelaPagamentoRecord | null> {
  const result = await executor(customDb).query<ParcelaRow>(
    `SELECT ${parcelaColumns}
       FROM pagamento_parcelas
      WHERE id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [parcelaId],
  );
  return result.rows[0] ? mapParcela(result.rows[0]) : null;
}

export async function atualizarStatusParcela(
  parcelaId: string,
  status: ParcelaPagamentoStatus,
  customDb?: DbExecutor,
) {
  const result = await executor(customDb).query<ParcelaRow>(
    `UPDATE pagamento_parcelas
        SET status = $2::varchar(30)
      WHERE id = $1::uuid
        AND status <> 'CANCELADA'
      RETURNING ${parcelaColumns}`,
    [parcelaId, status],
  );
  return result.rows[0] ? mapParcela(result.rows[0]) : null;
}

export async function cancelarParcelasPendentesDoPlano(planoId: string, customDb?: DbExecutor) {
  await executor(customDb).query(
    `UPDATE pagamento_parcelas
        SET status = 'CANCELADA'
      WHERE plano_id = $1::uuid
        AND status IN ('PENDENTE', 'PARCIALMENTE_PAGA', 'ESTORNADA')`,
    [planoId],
  );
}

export async function criarRecebimento(input: {
  pagamentoId: string;
  meioPagamento: RecebimentoRecord["meioPagamento"];
  valorBruto: number;
  recebidoEm?: string | null;
  provedorCodigo?: string | null;
  referenciaExterna?: string | null;
  chaveIdempotencia?: string | null;
  metadataProvedor?: Record<string, unknown>;
  registradoPorUsuarioId?: string | null;
  observacoes?: string | null;
}, customDb?: DbExecutor) {
  const result = await executor(customDb).query<RecebimentoRow>(
    `INSERT INTO pagamento_recebimentos (
       pagamento_id, meio_pagamento, valor_bruto, recebido_em,
       provedor_codigo, referencia_externa, chave_idempotencia, metadata_provedor,
       registrado_por_usuario_id, observacoes
     ) VALUES (
       $1::uuid,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8::jsonb,$9::uuid,$10
     )
     RETURNING ${recebimentoColumns}`,
    [
      input.pagamentoId,
      input.meioPagamento,
      input.valorBruto,
      input.recebidoEm ?? null,
      input.provedorCodigo ?? null,
      input.referenciaExterna ?? null,
      input.chaveIdempotencia ?? null,
      JSON.stringify(input.metadataProvedor ?? {}),
      input.registradoPorUsuarioId ?? null,
      input.observacoes ?? null,
    ],
  );
  return mapRecebimento(result.rows[0]);
}

export async function buscarRecebimentoPorId(
  recebimentoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<RecebimentoRecord | null> {
  const result = await executor(customDb).query<RecebimentoRow>(
    `SELECT ${recebimentoColumns}
       FROM pagamento_recebimentos
      WHERE id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [recebimentoId],
  );
  return result.rows[0] ? mapRecebimento(result.rows[0]) : null;
}

export async function buscarRecebimentoPorIdempotencia(
  chave: string,
  customDb?: DbExecutor,
): Promise<RecebimentoRecord | null> {
  const result = await executor(customDb).query<RecebimentoRow>(
    `SELECT ${recebimentoColumns}
       FROM pagamento_recebimentos
      WHERE chave_idempotencia = $1
      LIMIT 1`,
    [chave],
  );
  return result.rows[0] ? mapRecebimento(result.rows[0]) : null;
}

export async function marcarRecebimentoStatus(
  recebimentoId: string,
  status: RecebimentoStatus,
  customDb?: DbExecutor,
) {
  const result = await executor(customDb).query<RecebimentoRow>(
    `UPDATE pagamento_recebimentos
        SET status = $2::varchar(20),
            confirmado_em = CASE WHEN $2::varchar(20) = 'CONFIRMADO' THEN COALESCE(confirmado_em, now()) ELSE confirmado_em END,
            cancelado_em = CASE WHEN $2::varchar(20) = 'CANCELADO' THEN COALESCE(cancelado_em, now()) ELSE cancelado_em END
      WHERE id = $1::uuid
      RETURNING ${recebimentoColumns}`,
    [recebimentoId, status],
  );
  return mapRecebimento(result.rows[0]);
}

export async function criarRecebimentoAlocacao(input: {
  recebimentoId: string;
  parcelaId: string;
  valorAlocado: number;
}, customDb?: DbExecutor) {
  const result = await executor(customDb).query<AlocacaoRow>(
    `INSERT INTO pagamento_recebimento_alocacoes (
       recebimento_id, parcela_id, valor_alocado
     ) VALUES ($1::uuid,$2::uuid,$3)
     RETURNING ${alocacaoColumns}`,
    [input.recebimentoId, input.parcelaId, input.valorAlocado],
  );
  return mapAlocacao(result.rows[0]);
}

export async function listarAlocacoesRecebimento(recebimentoId: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<AlocacaoRow>(
    `SELECT ${alocacaoColumns}
       FROM pagamento_recebimento_alocacoes
      WHERE recebimento_id = $1::uuid
      ORDER BY criado_em ASC, id ASC`,
    [recebimentoId],
  );
  return result.rows.map(mapAlocacao);
}

export async function resumoMovimentosParcelas(planoId: string, customDb?: DbExecutor): Promise<ParcelaMovimentoResumo[]> {
  const result = await executor(customDb).query<{
    parcela_id: string;
    valor_previsto: string | number;
    recebido_confirmado: string | number;
    estornado_confirmado: string | number;
  }>(
    `SELECT
       pp.id AS parcela_id,
       pp.valor_previsto,
       COALESCE((
         SELECT SUM(pra.valor_alocado)
           FROM pagamento_recebimento_alocacoes pra
           JOIN pagamento_recebimentos pr ON pr.id = pra.recebimento_id
          WHERE pra.parcela_id = pp.id
            AND pr.status = 'CONFIRMADO'
       ), 0) AS recebido_confirmado,
       COALESCE((
         SELECT SUM(pe.valor)
           FROM pagamento_estornos pe
          WHERE pe.parcela_id = pp.id
            AND pe.status = 'CONFIRMADO'
       ), 0) AS estornado_confirmado
     FROM pagamento_parcelas pp
     WHERE pp.plano_id = $1::uuid
     ORDER BY pp.numero ASC`,
    [planoId],
  );
  return result.rows.map((row) => ({
    parcelaId: row.parcela_id,
    valorPrevisto: Number(row.valor_previsto),
    recebidoConfirmado: Number(row.recebido_confirmado),
    estornadoConfirmado: Number(row.estornado_confirmado),
  }));
}

export async function resumoMovimentosPagamento(pagamentoId: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<{
    recebido_confirmado: string | number;
    estornado_confirmado: string | number;
  }>(
    `SELECT
       COALESCE((
         SELECT SUM(valor_bruto)
           FROM pagamento_recebimentos
          WHERE pagamento_id = $1::uuid
            AND status = 'CONFIRMADO'
       ), 0) AS recebido_confirmado,
       COALESCE((
         SELECT SUM(pe.valor)
           FROM pagamento_estornos pe
           JOIN pagamento_recebimentos pr ON pr.id = pe.recebimento_id
          WHERE pr.pagamento_id = $1::uuid
            AND pe.status = 'CONFIRMADO'
       ), 0) AS estornado_confirmado`,
    [pagamentoId],
  );
  return {
    recebidoConfirmado: Number(result.rows[0]?.recebido_confirmado ?? 0),
    estornadoConfirmado: Number(result.rows[0]?.estornado_confirmado ?? 0),
  };
}

export async function criarEstorno(input: {
  recebimentoId: string;
  parcelaId: string;
  valor: number;
  motivo?: string | null;
  provedorCodigo?: string | null;
  referenciaExterna?: string | null;
  chaveIdempotencia?: string | null;
  metadataProvedor?: Record<string, unknown>;
  registradoPorUsuarioId?: string | null;
}, customDb?: DbExecutor) {
  const result = await executor(customDb).query<EstornoRow>(
    `INSERT INTO pagamento_estornos (
       recebimento_id, parcela_id, valor, motivo, provedor_codigo,
       referencia_externa, chave_idempotencia, metadata_provedor,
       registrado_por_usuario_id
     ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid)
     RETURNING ${estornoColumns}`,
    [
      input.recebimentoId,
      input.parcelaId,
      input.valor,
      input.motivo ?? null,
      input.provedorCodigo ?? null,
      input.referenciaExterna ?? null,
      input.chaveIdempotencia ?? null,
      JSON.stringify(input.metadataProvedor ?? {}),
      input.registradoPorUsuarioId ?? null,
    ],
  );
  return mapEstorno(result.rows[0]);
}

export async function buscarEstornoPorIdempotencia(chave: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<EstornoRow>(
    `SELECT ${estornoColumns}
       FROM pagamento_estornos
      WHERE chave_idempotencia = $1
      LIMIT 1`,
    [chave],
  );
  return result.rows[0] ? mapEstorno(result.rows[0]) : null;
}

export async function marcarEstornoConfirmado(estornoId: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<EstornoRow>(
    `UPDATE pagamento_estornos
        SET status = 'CONFIRMADO', confirmado_em = COALESCE(confirmado_em, now())
      WHERE id = $1::uuid
        AND status = 'SOLICITADO'
      RETURNING ${estornoColumns}`,
    [estornoId],
  );
  return result.rows[0] ? mapEstorno(result.rows[0]) : null;
}

export async function valorAlocadoConfirmadoRecebimentoParcela(
  recebimentoId: string,
  parcelaId: string,
  customDb?: DbExecutor,
) {
  const result = await executor(customDb).query<{ valor: string | number }>(
    `SELECT COALESCE(SUM(pra.valor_alocado), 0) AS valor
       FROM pagamento_recebimento_alocacoes pra
       JOIN pagamento_recebimentos pr ON pr.id = pra.recebimento_id
      WHERE pra.recebimento_id = $1::uuid
        AND pra.parcela_id = $2::uuid
        AND pr.status = 'CONFIRMADO'`,
    [recebimentoId, parcelaId],
  );
  return Number(result.rows[0]?.valor ?? 0);
}

export async function valorEstornadoConfirmadoRecebimentoParcela(
  recebimentoId: string,
  parcelaId: string,
  customDb?: DbExecutor,
) {
  const result = await executor(customDb).query<{ valor: string | number }>(
    `SELECT COALESCE(SUM(valor), 0) AS valor
       FROM pagamento_estornos
      WHERE recebimento_id = $1::uuid
        AND parcela_id = $2::uuid
        AND status = 'CONFIRMADO'`,
    [recebimentoId, parcelaId],
  );
  return Number(result.rows[0]?.valor ?? 0);
}

export async function existeRecebimentoPagamento(pagamentoId: string, customDb?: DbExecutor) {
  const result = await executor(customDb).query<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pagamento_recebimentos
        WHERE pagamento_id = $1::uuid
     ) AS existe`,
    [pagamentoId],
  );
  return result.rows[0]?.existe === true;
}

export async function buscarRecebimentoPorReferencia(provedor: string, referencia: string, tx: DbExecutor) {
  const result = await tx.query<RecebimentoRow>(`SELECT ${recebimentoColumns} FROM pagamento_recebimentos
    WHERE provedor_codigo=$1 AND referencia_externa=$2`, [provedor, referencia]);
  return result.rows[0] ? mapRecebimento(result.rows[0]) : null;
}

export async function buscarEstornoPorReferencia(provedor: string, referencia: string, tx: DbExecutor) {
  const result = await tx.query<EstornoRow>(`SELECT ${estornoColumns} FROM pagamento_estornos
    WHERE provedor_codigo=$1 AND referencia_externa=$2`, [provedor, referencia]);
  return result.rows[0] ? mapEstorno(result.rows[0]) : null;
}

export async function valorEstornosComprometidos(recebimentoId: string, parcelaId: string, excluirId: string | null, tx: DbExecutor) {
  const result = await tx.query<{ valor: string }>(`SELECT COALESCE(SUM(valor),0) AS valor FROM pagamento_estornos
    WHERE recebimento_id=$1::uuid AND parcela_id=$2::uuid AND status IN ('SOLICITADO','CONFIRMADO')
    AND ($3::uuid IS NULL OR id<>$3::uuid)`, [recebimentoId, parcelaId, excluirId]);
  return Number(result.rows[0].valor);
}

export async function buscarComprovantePorHash(recebimentoId: string, sha256: string, tx: DbExecutor) {
  const result = await tx.query<ComprovanteRow>(`SELECT *, criado_em::text AS criado_em FROM pagamento_comprovantes
    WHERE recebimento_id=$1::uuid AND sha256=$2`, [recebimentoId, sha256]);
  return result.rows[0] ? mapComprovante(result.rows[0]) : null;
}

export async function criarComprovantePagamento(input: {
  recebimentoId: string;
  nomeArquivo: string;
  mimeType: string;
  tamanhoBytes: number;
  sha256: string;
  localizadorArquivo: string;
  registradoPorUsuarioId?: string | null;
}, customDb?: DbExecutor): Promise<ComprovantePagamentoRecord> {
  const result = await executor(customDb).query<ComprovanteRow>(
    `INSERT INTO pagamento_comprovantes (
       recebimento_id, nome_arquivo, mime_type, tamanho_bytes,
       sha256, localizador_arquivo, registrado_por_usuario_id
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid)
     RETURNING id, recebimento_id, nome_arquivo, mime_type, tamanho_bytes,
               sha256, localizador_arquivo, registrado_por_usuario_id,
               criado_em::text AS criado_em`,
    [
      input.recebimentoId,
      input.nomeArquivo,
      input.mimeType,
      input.tamanhoBytes,
      input.sha256,
      input.localizadorArquivo,
      input.registradoPorUsuarioId ?? null,
    ],
  );
  return mapComprovante(result.rows[0]);
}

function mapComprovante(row: ComprovanteRow): ComprovantePagamentoRecord {
  return {
    id: row.id,
    recebimentoId: row.recebimento_id,
    nomeArquivo: row.nome_arquivo,
    mimeType: row.mime_type,
    tamanhoBytes: Number(row.tamanho_bytes),
    sha256: row.sha256,
    localizadorArquivo: row.localizador_arquivo,
    registradoPorUsuarioId: row.registrado_por_usuario_id,
    criadoEm: row.criado_em,
  };
}
