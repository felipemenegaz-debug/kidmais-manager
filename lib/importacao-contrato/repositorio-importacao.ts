import type { DbExecutor } from "../db/contracts.ts";

/**
 * Persistência do rascunho de importação (feature IMPORT; tabela `ia_importacoes`, migration 055d —
 * NÃO aplicada). Toda consulta filtra a empresa comprovada. Nunca grava dado de negócio: cliente e
 * contrato histórico só nascem pelo Import Engine, depois do clique no Human Gate.
 */
/** EM_REVISAO é o único estado aberto; IMPORTADA e DESCARTADA são terminais (a confirmação fica no Human Gate). */
export type StatusImportacao = "EM_REVISAO" | "IMPORTADA" | "DESCARTADA";

export type ImportacaoLida = {
  id: string;
  documentoId: string;
  extracaoId: string;
  status: StatusImportacao;
  versao: number;
  dados: Record<string, unknown>;
  clienteId: string | null;
  resultado: Record<string, unknown> | null;
  criadoPor: string;
};

type LinhaImportacao = { id: string; documento_id: string; extracao_id: string; status: StatusImportacao; versao: number; dados: Record<string, unknown>; cliente_id: string | null; resultado: Record<string, unknown> | null; criado_por: string };

const mapear = (l: LinhaImportacao): ImportacaoLida => ({ id: l.id, documentoId: l.documento_id, extracaoId: l.extracao_id, status: l.status, versao: Number(l.versao), dados: l.dados, clienteId: l.cliente_id, resultado: l.resultado, criadoPor: l.criado_por });
const COLUNAS = "id::text, documento_id::text, extracao_id::text, status, versao, dados, cliente_id::text, resultado, criado_por::text";

export async function importacaoDisponivel(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_importacoes') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

/** Importação ativa (aberta ou concluída) do documento; a descartada é histórico. */
const ATIVA = `SELECT ${COLUNAS} FROM ia_importacoes WHERE documento_id = $1::uuid AND empresa_id = $2::uuid AND status <> 'DESCARTADA'`;

/**
 * Uma importação ativa por documento. Abrir de novo devolve a ativa (aberta ou já importada); depois de
 * descartada, abrir cria uma nova a partir da última extração.
 */
export async function abrirImportacao(tx: DbExecutor, e: { empresaId: string; documentoId: string; extracaoId: string; usuarioId: string; dados: Record<string, unknown> }) {
  const buscar = () => tx.query<LinhaImportacao>(ATIVA, [e.documentoId, e.empresaId]);
  const existente = await buscar();
  if (existente.rows[0]) return mapear(existente.rows[0]);
  const criada = await tx.query<LinhaImportacao>(
    `INSERT INTO ia_importacoes (documento_id, empresa_id, extracao_id, status, versao, dados, criado_por)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'EM_REVISAO', 1, $4::jsonb, $5::uuid)
     ON CONFLICT (documento_id) WHERE status <> 'DESCARTADA' DO NOTHING RETURNING ${COLUNAS}`,
    [e.documentoId, e.empresaId, e.extracaoId, JSON.stringify(e.dados), e.usuarioId],
  );
  if (criada.rows[0]) return mapear(criada.rows[0]);
  // Outra aba abriu entre a leitura e o INSERT: devolve a dela.
  const concorrente = await buscar();
  if (!concorrente.rows[0]) throw new Error("IMPORTACAO_CONFLITO");
  return mapear(concorrente.rows[0]);
}

/**
 * Consulta somente leitura (A6): a importação ativa (aberta ou importada) do documento; sem ativa, a última
 * descartada. Filtra a empresa comprovada na própria consulta; outra empresa ou inexistente ⇒ null.
 */
export async function importacaoPorDocumento(tx: DbExecutor, empresaId: string, documentoId: string) {
  const r = await tx.query<LinhaImportacao>(
    `SELECT ${COLUNAS} FROM ia_importacoes WHERE documento_id = $1::uuid AND empresa_id = $2::uuid
      ORDER BY (status <> 'DESCARTADA') DESC, criado_em DESC, id DESC LIMIT 1`,
    [documentoId, empresaId],
  );
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export async function lerImportacao(tx: DbExecutor, empresaId: string, id: string, travar: boolean) {
  const r = await tx.query<LinhaImportacao>(`SELECT ${COLUNAS} FROM ia_importacoes WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? " FOR UPDATE" : ""}`, [id, empresaId]);
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

/** Compare-and-set pela versão. */
export async function atualizarImportacao(tx: DbExecutor, empresaId: string, i: ImportacaoLida, versaoEsperada: number) {
  const r = await tx.query(
    `UPDATE ia_importacoes SET status = $4, versao = $5, dados = $6::jsonb, cliente_id = $7::uuid, resultado = $8::jsonb, atualizado_em = now()
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND versao = $3 RETURNING id`,
    [i.id, empresaId, versaoEsperada, i.status, i.versao, JSON.stringify(i.dados), i.clienteId, i.resultado ? JSON.stringify(i.resultado) : null],
  );
  return r.rowCount === 1;
}
