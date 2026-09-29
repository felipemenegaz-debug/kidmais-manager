import type { DbExecutor } from "../db/contracts.ts";
import type { ArquivoValidado } from "./arquivo.ts";

/**
 * Persistência da Document Foundation (feature DOCUMENT; tabelas da migration 055c — NÃO aplicada).
 * Toda consulta filtra a empresa comprovada. Originais são só inseridos (o banco recusa UPDATE/DELETE)
 * e nunca têm URL pública: os bytes só saem daqui para a extração no servidor.
 */
export async function documentosDisponiveis(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.ia_documentos') IS NOT NULL AND to_regclass('public.ia_documento_originais') IS NOT NULL
        AND to_regclass('public.ia_extracoes') IS NOT NULL AND to_regclass('public.ia_evidencias') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/** Mesmo arquivo (sha256) na mesma empresa ⇒ reaproveita o documento: upload idempotente. */
export async function registrarDocumento(tx: DbExecutor, entrada: { empresaId: string; usuarioId: string; arquivo: ArquivoValidado }) {
  const existente = await tx.query<{ documento_id: string; id: string }>(
    `SELECT documento_id::text, id::text FROM ia_documento_originais WHERE empresa_id = $1::uuid AND sha256 = $2`,
    [entrada.empresaId, entrada.arquivo.sha256],
  );
  if (existente.rows[0]) return { documentoId: existente.rows[0].documento_id, originalId: existente.rows[0].id, existente: true };
  const documento = await tx.query<{ id: string }>(
    `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid) RETURNING id::text`,
    [entrada.empresaId, entrada.usuarioId],
  );
  const original = await tx.query<{ id: string }>(
    `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5, $6, $7, $8::uuid) RETURNING id::text`,
    [documento.rows[0].id, entrada.empresaId, entrada.arquivo.nomeSeguro, entrada.arquivo.contentType, entrada.arquivo.tamanhoBytes, entrada.arquivo.sha256, Buffer.from(entrada.arquivo.bytes), entrada.usuarioId],
  );
  return { documentoId: documento.rows[0].id, originalId: original.rows[0].id, existente: false };
}

export type MetodoExtracao = "TEXTO_NATIVO" | "VISAO" | "OCR" | "DETERMINISTICO";
export type StatusExtracao = "SUCESSO" | "PARCIAL" | "FALHOU";

export type RegistroExtracao = {
  empresaId: string; documentoId: string; originalId: string; metodo: MetodoExtracao;
  provedor: string | null; modelo: string | null; schemaVersao: number; status: StatusExtracao;
  /** A revisão estruturada (valor bruto, normalizado, estado e evidência de cada campo). */
  resultado: Record<string, unknown> | null; erro: string | null; correlationId: string; iniciadoEm: string; concluidoEm: string;
  evidencias: Array<{ campo: string; pagina: number | null; trecho: string; conferida: boolean }>;
};

export async function registrarExtracao(tx: DbExecutor, e: RegistroExtracao) {
  const extracao = await tx.query<{ id: string }>(
    `INSERT INTO ia_extracoes (documento_id, empresa_id, original_id, metodo, provedor, modelo, schema_versao, status, resultado, erro, correlation_id, iniciado_em, concluido_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::timestamptz, $13::timestamptz) RETURNING id::text`,
    [e.documentoId, e.empresaId, e.originalId, e.metodo, e.provedor, e.modelo, e.schemaVersao, e.status, e.resultado ? JSON.stringify(e.resultado) : null, e.erro, e.correlationId.slice(0, 100), e.iniciadoEm, e.concluidoEm],
  );
  const id = extracao.rows[0].id;
  if (e.evidencias.length) {
    await tx.query(
      `INSERT INTO ia_evidencias (extracao_id, empresa_id, campo, pagina, trecho, conferida)
       SELECT $1::uuid, $2::uuid, x.campo, x.pagina, x.trecho, x.conferida
         FROM jsonb_to_recordset($3::jsonb) AS x(campo text, pagina integer, trecho text, conferida boolean)`,
      [id, e.empresaId, JSON.stringify(e.evidencias.map((v) => ({ ...v, trecho: v.trecho.slice(0, 300) })))],
    );
  }
  await tx.query(
    `UPDATE ia_documentos SET status = $3, atualizado_em = now() WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [e.documentoId, e.empresaId, e.status === "FALHOU" ? "FALHOU" : e.status === "PARCIAL" ? "PRECISA_REVISAO" : "EXTRAIDO"],
  );
  return { extracaoId: id };
}

export type ExtracaoRegistrada = { extracaoId: string; documentoId: string; metodo: MetodoExtracao; status: StatusExtracao; resultado: Record<string, unknown> | null };

/** Última extração do documento, no tenant comprovado. Outra empresa ou inexistente: null. */
export async function ultimaExtracao(tx: DbExecutor, empresaId: string, documentoId: string): Promise<ExtracaoRegistrada | null> {
  const r = await tx.query<{ id: string; documento_id: string; metodo: MetodoExtracao; status: StatusExtracao; resultado: Record<string, unknown> | null }>(
    `SELECT id::text, documento_id::text, metodo, status, resultado FROM ia_extracoes
      WHERE documento_id = $1::uuid AND empresa_id = $2::uuid ORDER BY concluido_em DESC, id DESC LIMIT 1`,
    [documentoId, empresaId],
  );
  const l = r.rows[0];
  return l ? { extracaoId: l.id, documentoId: l.documento_id, metodo: l.metodo, status: l.status, resultado: l.resultado } : null;
}

export async function lerOriginal(tx: DbExecutor, empresaId: string, documentoId: string) {
  const r = await tx.query<{ id: string; conteudo: Buffer; content_type: string; nome_original: string; sha256: string }>(
    `SELECT id::text, conteudo, content_type, nome_original, sha256 FROM ia_documento_originais
      WHERE documento_id = $1::uuid AND empresa_id = $2::uuid ORDER BY versao DESC LIMIT 1`,
    [documentoId, empresaId],
  );
  return r.rows[0] ?? null;
}
