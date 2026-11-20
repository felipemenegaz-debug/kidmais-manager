import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db, withTransaction } from '../db/postgres';
import type { DbExecutor } from '../db/contracts';

const MAX_BYTES = 10 * 1024 * 1024;
const tipo = 'TABELA_PACOTES_PRECOS';
export type DocumentoPublico = { id: string; nome_arquivo: string; tamanho_bytes: number; sha256: string; chave_armazenamento: string; publicado_em: string };

/**
 * Bytes do PDF: com a 128 (documentos_publicos.conteudo), no banco; sem ela, no disco persistente, como antes.
 * Documento publicado antes da 128 continua lido do disco até a cópia (scripts/disco-para-banco-128.cjs).
 */
export function diretorioDocumentosPublicos(env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  return env.NODE_ENV === 'production'
    ? '/opt/render/project/src/data/documentos-publicos'
    : path.join(cwd, 'data', 'documentos-publicos');
}
const diretorio = () => diretorioDocumentosPublicos();
export function validarPdf(bytes: Buffer, nome: string) {
  if (!nome.toLowerCase().endsWith('.pdf') || bytes.length < 8 || bytes.length > MAX_BYTES ||
      !bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-') ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1').includes('%%EOF'))
    throw Error('Envie um PDF válido de até 10 MB.');
}
export async function conteudoNoBanco(tx: DbExecutor) {
  return (await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.documentos_publicos')
       AND attname = 'conteudo' AND NOT attisdropped) AS ok`)).rows[0]?.ok === true;
}
export async function documentoVigente(tx: DbExecutor = db()) {
  return (await tx.query<DocumentoPublico>(
    'SELECT id,nome_arquivo,tamanho_bytes,sha256,chave_armazenamento,publicado_em::text FROM documentos_publicos WHERE tipo=$1 AND ativo', [tipo]
  )).rows[0] ?? null;
}
async function registrar(tx: DbExecutor, bytes: Buffer, nome: string, chave: string, noBanco: boolean) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tipo]);
  await tx.query('UPDATE documentos_publicos SET ativo=false WHERE tipo=$1 AND ativo', [tipo]);
  const result = await tx.query<DocumentoPublico>(`INSERT INTO documentos_publicos
    (tipo,nome_arquivo,mime_type,tamanho_bytes,sha256,chave_armazenamento,ativo,publicado_em${noBanco ? ',conteudo' : ''})
    VALUES ($1,$2,'application/pdf',$3,$4,$5,true,clock_timestamp()${noBanco ? ',$6' : ''})
    RETURNING id,nome_arquivo,tamanho_bytes,sha256,chave_armazenamento,publicado_em::text`,
    [tipo, path.basename(nome).slice(0, 180), bytes.length, createHash('sha256').update(bytes).digest('hex'), chave, ...(noBanco ? [bytes] : [])]);
  return result.rows[0];
}
export async function publicarPdf(bytes: Buffer, nome: string) {
  validarPdf(bytes, nome);
  const chave = `${randomUUID()}.pdf`;
  // destino: arquivo gravado nesta publicação. registrado: a transação chegou ao fim do corpo, ou seja, o erro (se houver)
  // veio do COMMIT ou depois dele, e o banco pode ter efetivado a linha que aponta para o arquivo.
  const gravado: { destino: string | null; registrado: boolean } = { destino: null, registrado: false };
  try {
    // A trava (a mesma de registrar e de scripts/disco-para-banco-128.cjs) vem antes de decidir onde ficam os bytes: a
    // 128 não pode surgir entre a decisão e o registro, e a cópia do disco não vê um ativo trocar no meio.
    return await withTransaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tipo]);
      // 128: com a coluna, os bytes vão na mesma transação dos metadados e nada é gravado no disco.
      if (await conteudoNoBanco(tx)) return registrar(tx, bytes, nome, chave, true);
      const destino = path.join(diretorio(), chave);
      await mkdir(diretorio(), { recursive: true });
      const arquivo = await open(destino, 'wx', 0o600);
      gravado.destino = destino;
      try { await arquivo.writeFile(bytes); await arquivo.sync(); } finally { await arquivo.close(); }
      const registro = await registrar(tx, bytes, nome, chave, false);
      gravado.registrado = true;
      return registro;
    });
  } catch (error) {
    // Só apaga o arquivo quando a falha foi comprovadamente antes do COMMIT (ROLLBACK). Com o COMMIT incerto, a linha ativa
    // pode existir: o arquivo fica, e um órfão (se o COMMIT não valeu) só ocupa espaço até a limpeza pela chave.
    if (gravado.destino && !gravado.registrado) await unlink(gravado.destino).catch(() => {});
    throw error;
  }
}
export async function lerPdfVigente(tx: DbExecutor = db()) {
  const documento = await documentoVigente(tx);
  if (!documento) return null;
  let bytes: Buffer | null = null;
  if (await conteudoNoBanco(tx)) {
    const linha = (await tx.query<{ conteudo: Buffer | null }>('SELECT conteudo FROM documentos_publicos WHERE id=$1', [documento.id])).rows[0];
    bytes = linha?.conteudo ?? null;
  }
  if (!bytes) {
    if (!/^[0-9a-f-]{36}\.pdf$/.test(documento.chave_armazenamento)) return null;
    bytes = await readFile(path.join(diretorio(), documento.chave_armazenamento));
  }
  if (createHash('sha256').update(bytes).digest('hex') !== documento.sha256) throw Error('Integridade do documento divergente.');
  return { documento, bytes };
}
