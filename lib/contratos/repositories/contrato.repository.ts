import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import type {
  ContratoAceiteMetodo,
  ContratoRecord,
  ContratoSnapshot,
  ContratoVersaoRecord,
  ReferenciasComerciaisContrato,
} from "./models";

function executor(custom?: DbExecutor) {
  return custom ?? db();
}

type ContratoRow = {
  id: string;
  fechamento_id: string;
  status: ContratoRecord["status"];
  versao_atual: number;
  criado_por_usuario_id: string | null;
  assinado_em: string | null;
  cancelado_em: string | null;
  criado_em: string;
  atualizado_em: string;
};

type ContratoVersaoRow = {
  id: string;
  contrato_id: string;
  numero_versao: number;
  status: ContratoVersaoRecord["status"];
  snapshot_schema_versao: number;
  snapshot: ContratoSnapshot;
  snapshot_hash: string;
  motivo_nova_versao: string | null;
  gerado_por_usuario_id: string | null;
  documento_template_versao: number | null;
  documento_pdf_hash: string | null;
  aceite_metodo: ContratoAceiteMetodo | null;
  criado_em: string;
  substituido_em: string | null;
  assinado_em: string | null;
};

type ReferenciasRow = {
  pacote_id: string;
  pacote_codigo: string;
  pacote_nome: string;
  pacote_duracao_minutos: number | null;
  tabela_preco_id: string;
  tabela_preco_codigo: string;
  tabela_preco_nome: string;
};

const contratoColumns = `
  id,
  fechamento_id,
  status,
  versao_atual,
  criado_por_usuario_id,
  assinado_em::text AS assinado_em,
  cancelado_em::text AS cancelado_em,
  criado_em::text AS criado_em,
  atualizado_em::text AS atualizado_em
`;

const versaoColumns = `
  id,
  contrato_id,
  numero_versao,
  status,
  snapshot_schema_versao,
  snapshot,
  snapshot_hash,
  motivo_nova_versao,
  gerado_por_usuario_id,
  documento_template_versao,
  documento_pdf_hash,
  aceite_metodo,
  criado_em::text AS criado_em,
  substituido_em::text AS substituido_em,
  assinado_em::text AS assinado_em
`;

function mapContrato(row: ContratoRow): ContratoRecord {
  return {
    id: row.id,
    fechamentoId: row.fechamento_id,
    status: row.status,
    versaoAtual: Number(row.versao_atual),
    criadoPorUsuarioId: row.criado_por_usuario_id,
    assinadoEm: row.assinado_em,
    canceladoEm: row.cancelado_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

function mapVersao(row: ContratoVersaoRow): ContratoVersaoRecord {
  return {
    id: row.id,
    contratoId: row.contrato_id,
    numeroVersao: Number(row.numero_versao),
    status: row.status,
    snapshotSchemaVersao: Number(row.snapshot_schema_versao),
    snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash,
    motivoNovaVersao: row.motivo_nova_versao,
    geradoPorUsuarioId: row.gerado_por_usuario_id,
    documentoTemplateVersao:
      row.documento_template_versao === null
        ? null
        : Number(row.documento_template_versao),
    documentoPdfHash: row.documento_pdf_hash,
    aceiteMetodo: row.aceite_metodo,
    criadoEm: row.criado_em,
    substituidoEm: row.substituido_em,
    assinadoEm: row.assinado_em,
  };
}

export async function buscarContratoPorId(
  contratoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<ContratoRecord | null> {
  const result = await executor(customDb).query<ContratoRow>(
    `SELECT ${contratoColumns}
       FROM contratos
      WHERE id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [contratoId],
  );
  return result.rows[0] ? mapContrato(result.rows[0]) : null;
}

export async function buscarContratoPorFechamentoId(
  fechamentoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<ContratoRecord | null> {
  const result = await executor(customDb).query<ContratoRow>(
    `SELECT ${contratoColumns}
       FROM contratos
      WHERE fechamento_id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [fechamentoId],
  );
  return result.rows[0] ? mapContrato(result.rows[0]) : null;
}

export async function criarContrato(
  input: { fechamentoId: string; criadoPorUsuarioId?: string | null },
  customDb?: DbExecutor,
): Promise<ContratoRecord> {
  const result = await executor(customDb).query<ContratoRow>(
    `INSERT INTO contratos (
       fechamento_id,
       criado_por_usuario_id
     ) VALUES ($1::uuid, $2::uuid)
     RETURNING ${contratoColumns}`,
    [input.fechamentoId, input.criadoPorUsuarioId ?? null],
  );
  return mapContrato(result.rows[0]);
}

export async function buscarVersaoPorId(
  versaoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<ContratoVersaoRecord | null> {
  const result = await executor(customDb).query<ContratoVersaoRow>(
    `SELECT ${versaoColumns}
       FROM contrato_versoes
      WHERE id = $1::uuid
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [versaoId],
  );
  return result.rows[0] ? mapVersao(result.rows[0]) : null;
}

export async function buscarVersaoCorrente(
  contratoId: string,
  customDb?: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<ContratoVersaoRecord | null> {
  const result = await executor(customDb).query<ContratoVersaoRow>(
    `SELECT ${versaoColumns}
       FROM contrato_versoes
      WHERE contrato_id = $1::uuid
        AND status IN ('ATIVA', 'ASSINADA')
        AND id = COALESCE(
          (SELECT COALESCE(versao_vigente_id,versao_em_preparacao_id) FROM contrato_fluxos WHERE contrato_id=$1::uuid),
          (SELECT v.id FROM contrato_versoes v JOIN contratos c ON c.id=v.contrato_id WHERE c.id=$1::uuid AND v.numero_versao=c.versao_atual))
      ORDER BY numero_versao DESC
      LIMIT 1
      ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [contratoId],
  );
  return result.rows[0] ? mapVersao(result.rows[0]) : null;
}

export async function criarContratoVersao(
  input: {
    contratoId: string;
    numeroVersao: number;
    snapshot: ContratoSnapshot;
    snapshotHash: string;
    motivoNovaVersao?: string | null;
    geradoPorUsuarioId?: string | null;
  },
  customDb?: DbExecutor,
): Promise<ContratoVersaoRecord> {
  const result = await executor(customDb).query<ContratoVersaoRow>(
    `INSERT INTO contrato_versoes (
       contrato_id,
       numero_versao,
       status,
       snapshot_schema_versao,
       snapshot,
       snapshot_hash,
       motivo_nova_versao,
       gerado_por_usuario_id
     ) VALUES (
       $1::uuid,
       $2,
       'ATIVA',
       $7,
       $3::jsonb,
       $4,
       $5,
       $6::uuid
     )
     RETURNING ${versaoColumns}`,
    [
      input.contratoId,
      input.numeroVersao,
      JSON.stringify(input.snapshot),
      input.snapshotHash,
      input.motivoNovaVersao ?? null,
      input.geradoPorUsuarioId ?? null,
      input.snapshot.schemaVersao,
    ],
  );
  return mapVersao(result.rows[0]);
}

export async function substituirVersaoAtiva(
  versaoId: string,
  customDb?: DbExecutor,
): Promise<void> {
  await executor(customDb).query(
    `UPDATE contrato_versoes
        SET status = 'SUBSTITUIDA',
            substituido_em = now()
      WHERE id = $1::uuid
        AND status = 'ATIVA'`,
    [versaoId],
  );
}

export async function atualizarVersaoAtualContrato(
  contratoId: string,
  numeroVersao: number,
  customDb?: DbExecutor,
): Promise<ContratoRecord> {
  const result = await executor(customDb).query<ContratoRow>(
    `UPDATE contratos
        SET versao_atual = $2
      WHERE id = $1::uuid
      RETURNING ${contratoColumns}`,
    [contratoId, numeroVersao],
  );
  return mapContrato(result.rows[0]);
}

export async function marcarVersaoContratoAssinada(
  input: {
    versaoId: string;
    documentoTemplateVersao: number;
    documentoPdfHash: string;
    aceiteMetodo: ContratoAceiteMetodo;
  },
  customDb?: DbExecutor,
): Promise<ContratoVersaoRecord | null> {
  const result = await executor(customDb).query<ContratoVersaoRow>(
    `UPDATE contrato_versoes
        SET status = 'ASSINADA',
            assinado_em = now(),
            documento_template_versao = $2,
            documento_pdf_hash = $3,
            aceite_metodo = $4
      WHERE id = $1::uuid
        AND status = 'ATIVA'
      RETURNING ${versaoColumns}`,
    [
      input.versaoId,
      input.documentoTemplateVersao,
      input.documentoPdfHash,
      input.aceiteMetodo,
    ],
  );
  return result.rows[0] ? mapVersao(result.rows[0]) : null;
}

export async function marcarContratoAssinado(
  contratoId: string,
  customDb?: DbExecutor,
): Promise<ContratoRecord | null> {
  const result = await executor(customDb).query<ContratoRow>(
    `UPDATE contratos
        SET status = 'ASSINADO',
            assinado_em = now()
      WHERE id = $1::uuid
        AND status = 'AGUARDANDO_ASSINATURA'
      RETURNING ${contratoColumns}`,
    [contratoId],
  );
  return result.rows[0] ? mapContrato(result.rows[0]) : null;
}

export async function buscarReferenciasComerciaisContrato(
  fechamentoId: string,
  customDb?: DbExecutor,
  revisaoId?: string,
): Promise<ReferenciasComerciaisContrato | null> {
  const result = await executor(customDb).query<ReferenciasRow>(
    `SELECT
       p.id AS pacote_id,
       p.codigo AS pacote_codigo,
       p.nome AS pacote_nome,
       p.duracao_minutos AS pacote_duracao_minutos,
       tp.id AS tabela_preco_id,
       tp.codigo AS tabela_preco_codigo,
       tp.nome AS tabela_preco_nome
     FROM ${revisaoId ? 'fechamento_revisoes' : 'fechamentos'} f
     JOIN pacotes p ON p.id = f.pacote_id
     JOIN tabelas_preco tp ON tp.id = f.tabela_preco_id
     WHERE f.id = $1::uuid
     LIMIT 1`,
    [revisaoId ?? fechamentoId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    pacoteId: row.pacote_id,
    pacoteCodigo: row.pacote_codigo,
    pacoteNome: row.pacote_nome,
    pacoteDuracaoMinutos:
      row.pacote_duracao_minutos === null ? null : Number(row.pacote_duracao_minutos),
    tabelaPrecoId: row.tabela_preco_id,
    tabelaPrecoCodigo: row.tabela_preco_codigo,
    tabelaPrecoNome: row.tabela_preco_nome,
  };
}
