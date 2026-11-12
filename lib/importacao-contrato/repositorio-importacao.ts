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

/** 064 instalada? Lida do catálogo a cada chamada: o mesmo código roda antes e depois da migration. */
export async function reimportacaoInstalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais064_contrato_cancelado(uuid)') IS NOT NULL AS ok");
  return r.rows[0]?.ok === true;
}

/**
 * 064: importação concluída cujo contrato integrado foi CANCELADO deixa de ocupar o documento (passa a DESCARTADA)
 * para o mesmo arquivo poder ser importado de novo. Identidade e versão seguem a guarda; cliente_id e resultado ficam
 * nulos (055d) e o que havia é preservado em dados->'substituicao'. O vínculo histórico (061) e o contrato cancelado
 * não mudam. Sem a 064, sem contrato cancelado ou com versão diferente: nada muda e devolve false.
 */
export async function substituirImportacaoCancelada(tx: DbExecutor, empresaId: string, i: ImportacaoLida, usuarioId: string) {
  if (i.status !== "IMPORTADA" || !(await reimportacaoInstalada(tx))) return false;
  const r = await tx.query(
    `UPDATE ia_importacoes SET status = 'DESCARTADA', versao = $3 + 1, cliente_id = NULL, resultado = NULL, atualizado_em = now(),
            dados = dados || jsonb_build_object('substituicao', jsonb_build_object(
              'em', now(), 'por', $4::text, 'clienteId', cliente_id::text, 'resultado', resultado,
              'contratoId', (SELECT ci.contrato_id::text FROM contrato_importacoes ci WHERE ci.importacao_id = ia_importacoes.id)))
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'IMPORTADA' AND versao = $3
        AND kidmais064_contrato_cancelado(id) RETURNING id`,
    [i.id, empresaId, i.versao, usuarioId],
  );
  return r.rowCount === 1;
}

export async function lerImportacao(tx: DbExecutor, empresaId: string, id: string, travar: boolean) {
  const r = await tx.query<LinhaImportacao>(`SELECT ${COLUNAS} FROM ia_importacoes WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? " FOR UPDATE" : ""}`, [id, empresaId]);
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

/**
 * Compare-and-set pela versão. Lote L1 (plano rev. 5, R5-1): `dados.aberturas` vem SEMPRE do valor atual do banco, no
 * próprio UPDATE; o objeto novo nunca apaga nem substitui a lista (revisar, cliente, preparar, descartar, Import Engine).
 */
export async function atualizarImportacao(tx: DbExecutor, empresaId: string, i: ImportacaoLida, versaoEsperada: number) {
  const r = await tx.query(
    `UPDATE ia_importacoes SET status = $4, versao = $5, cliente_id = $7::uuid, resultado = $8::jsonb, atualizado_em = now(),
            dados = ($6::jsonb - 'aberturas') || CASE WHEN dados ? 'aberturas' THEN jsonb_build_object('aberturas', dados->'aberturas') ELSE '{}'::jsonb END
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND versao = $3 RETURNING id`,
    [i.id, empresaId, versaoEsperada, i.status, i.versao, JSON.stringify(i.dados), i.clienteId, i.resultado ? JSON.stringify(i.resultado) : null],
  );
  return r.rowCount === 1;
}

/** Teto de identidades de abertura por importação (R5-1). Atingido, identidade nova é recusada; nenhuma é esquecida. */
export const LIMITE_ABERTURAS = 200;

/**
 * Trava do documento (R5-1): `abrir` e `retomar` começam por ela e a mantêm até o commit. Filtra a empresa comprovada;
 * documento de outra empresa ou inexistente ⇒ false, sem escrita.
 */
export async function travarDocumento(tx: DbExecutor, empresaId: string, documentoId: string) {
  const r = await tx.query(`SELECT id FROM ia_documentos WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [documentoId, empresaId]);
  return r.rowCount === 1;
}

/** Importação do documento (ativa, importada ou descartada) que registrou esta abertura; a ativa primeiro. */
export async function importacaoPorAbertura(tx: DbExecutor, empresaId: string, documentoId: string, aberturaId: string) {
  const r = await tx.query<LinhaImportacao>(
    `SELECT ${COLUNAS} FROM ia_importacoes
      WHERE documento_id = $1::uuid AND empresa_id = $2::uuid AND coalesce(dados->'aberturas', '[]'::jsonb) ? $3
      ORDER BY (status <> 'DESCARTADA') DESC, criado_em DESC, id DESC LIMIT 1`,
    [documentoId, empresaId, aberturaId],
  );
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export type RegistroAbertura =
  | { tipo: "REGISTRADA"; importacao: ImportacaoLida }
  | { tipo: "JA_REGISTRADA" }
  | { tipo: "LIMITE" }
  /** Importação encerrada (IMPORTADA/DESCARTADA): a guarda da 055d não deixa mudar; nada é gravado. */
  | { tipo: "ENCERRADA" };

/**
 * Registra a identidade sobre o valor ATUAL de `dados` (jsonb_set no próprio UPDATE). A guarda da 055d exige versão
 * crescente em toda alteração, então registrar avança a versão. Repetir a mesma identidade não grava nada.
 */
export async function registrarAbertura(tx: DbExecutor, empresaId: string, importacaoId: string, aberturaId: string): Promise<RegistroAbertura> {
  const r = await tx.query<LinhaImportacao>(
    `UPDATE ia_importacoes SET versao = versao + 1, atualizado_em = now(),
            dados = jsonb_set(dados, '{aberturas}', coalesce(dados->'aberturas', '[]'::jsonb) || to_jsonb($3::text))
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'EM_REVISAO'
        AND NOT (coalesce(dados->'aberturas', '[]'::jsonb) ? $3)
        AND jsonb_array_length(coalesce(dados->'aberturas', '[]'::jsonb)) < $4
      RETURNING ${COLUNAS}`,
    [importacaoId, empresaId, aberturaId, LIMITE_ABERTURAS],
  );
  if (r.rows[0]) return { tipo: "REGISTRADA", importacao: mapear(r.rows[0]) };
  const atual = await tx.query<{ status: StatusImportacao; tem: boolean }>(
    `SELECT status, coalesce(dados->'aberturas', '[]'::jsonb) ? $3 AS tem FROM ia_importacoes WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [importacaoId, empresaId, aberturaId],
  );
  const l = atual.rows[0];
  if (!l) throw new Error("IMPORTACAO_CONFLITO");
  if (l.tem) return { tipo: "JA_REGISTRADA" };
  return l.status === "EM_REVISAO" ? { tipo: "LIMITE" } : { tipo: "ENCERRADA" };
}

/** Lista "Contratos aguardando revisão" (R1-3/R1-4): linha bruta, antes da sanitização do DTO. */
export type LinhaParaRevisao = {
  grupo: "REVISAO" | "LIDO";
  documentoId: string;
  importacaoId: string | null;
  versao: number | null;
  arquivo: string;
  enviadoEm: string;
  contratante: string | null;
  dataFesta: string | null;
};
export type CursorRevisao = { k: string; t: string; id: string };

/** Chave da data da festa: só a data normalizada (ISO) entra; ausente ou inválida ordena por último ("~" > dígitos em "C"). */
export const SEM_DATA_FESTA = "~";
const campoDaExtracao = (x: string, id: string, chave: string) =>
  `(jsonb_path_query_first(${x}, '$.secoes[*].campos[*] ? (@.id == "${id}").${chave}') #>> '{}')`;
const DATA_FESTA = `CASE WHEN ${campoDaExtracao("b.x", "evento.data", "normalizado")} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ${campoDaExtracao("b.x", "evento.data", "normalizado")} END`;

/**
 * Somente leitura. Dois grupos, ambos filtrados pela empresa comprovada em todas as tabelas:
 *  - REVISAO: importações EM_REVISAO;
 *  - LIDO: documentos cuja última extração tem dados e que não têm nenhuma importação (nem descartada).
 * Ordem estável: data da festa válida ascendente (ausente por último), envio, documento. Cursor sobre a mesma chave.
 */
export async function listarParaRevisao(tx: DbExecutor, empresaId: string, opcoes: { limite: number; cursor: CursorRevisao | null }): Promise<{ linhas: LinhaParaRevisao[]; proximo: CursorRevisao | null }> {
  const limite = Math.max(1, Math.min(50, Math.trunc(opcoes.limite)));
  const r = await tx.query<{ grupo: "REVISAO" | "LIDO"; documento_id: string; importacao_id: string | null; versao: number | null; arquivo: string; enviado_em: string; contratante: string | null; data_festa: string | null; chave: string }>(
    `WITH base AS (
        SELECT 'REVISAO'::text AS grupo, i.documento_id, i.id AS importacao_id, i.versao, i.dados->'extracao' AS x
          FROM ia_importacoes i
         WHERE i.empresa_id = $1::uuid AND i.status = 'EM_REVISAO'
        UNION ALL
        SELECT 'LIDO'::text, d.id, NULL::uuid, NULL::integer, e.resultado
          FROM ia_documentos d
          JOIN LATERAL (SELECT ex.resultado FROM ia_extracoes ex
                         WHERE ex.documento_id = d.id AND ex.empresa_id = $1::uuid
                         ORDER BY ex.concluido_em DESC, ex.id DESC LIMIT 1) e ON true
         WHERE d.empresa_id = $1::uuid AND d.tipo = 'CONTRATO_HISTORICO'
           AND NOT EXISTS (SELECT 1 FROM ia_importacoes i WHERE i.documento_id = d.id AND i.empresa_id = $1::uuid)
           AND jsonb_typeof(e.resultado->'secoes') = 'array'
           AND jsonb_path_exists(e.resultado, '$.secoes[*].campos[*].valor ? (@.type() == "string" && @ like_regex "[^[:space:]]")')
      ), linhas AS (
        SELECT b.grupo, b.documento_id, b.importacao_id, b.versao, o.nome_original AS arquivo, d.enviado_em,
               ${campoDaExtracao("b.x", "contratante.nome", "valor")} AS contratante,
               ${DATA_FESTA} AS data_festa
          FROM base b
          JOIN ia_documentos d ON d.id = b.documento_id AND d.empresa_id = $1::uuid
          JOIN LATERAL (SELECT og.nome_original FROM ia_documento_originais og
                         WHERE og.documento_id = d.id AND og.empresa_id = $1::uuid
                         ORDER BY og.versao DESC LIMIT 1) o ON true
      )
      SELECT grupo, documento_id::text, importacao_id::text, versao, arquivo,
             to_char(enviado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS enviado_em,
             contratante, data_festa, coalesce(data_festa, '${SEM_DATA_FESTA}') AS chave
        FROM linhas
       WHERE $2::text IS NULL
          OR (coalesce(data_festa, '${SEM_DATA_FESTA}') COLLATE "C", enviado_em, documento_id) > ($2::text COLLATE "C", $3::timestamptz, $4::uuid)
       ORDER BY coalesce(linhas.data_festa, '${SEM_DATA_FESTA}') COLLATE "C", linhas.enviado_em, linhas.documento_id
       LIMIT $5`,
    [empresaId, opcoes.cursor?.k ?? null, opcoes.cursor?.t ?? null, opcoes.cursor?.id ?? null, limite + 1],
  );
  const linhas = r.rows.slice(0, limite).map((l): LinhaParaRevisao => ({
    grupo: l.grupo, documentoId: l.documento_id, importacaoId: l.importacao_id, versao: l.versao == null ? null : Number(l.versao),
    arquivo: l.arquivo, enviadoEm: l.enviado_em, contratante: l.contratante, dataFesta: l.data_festa,
  }));
  const ultima = r.rows.length > limite ? r.rows[limite - 1] : null;
  return { linhas, proximo: ultima ? { k: ultima.chave, t: ultima.enviado_em, id: ultima.documento_id } : null };
}
