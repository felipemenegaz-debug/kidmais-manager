import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db, withTransaction } from '../db/postgres';
import type { DbExecutor } from '../db/contracts';

const MAX_BYTES = 10 * 1024 * 1024;
const tipo = 'TABELA_PACOTES_PRECOS';
export type DocumentoPublico = { id: string; nome_arquivo: string; tamanho_bytes: number; sha256: string; chave_armazenamento: string; publicado_em: string };

function diretorio() {
  return process.env.NODE_ENV === 'production'
    ? '/opt/render/project/src/data/documentos-publicos'
    : path.join(process.cwd(), 'data', 'documentos-publicos');
}
export function validarPdf(bytes: Buffer, nome: string) {
  if (!nome.toLowerCase().endsWith('.pdf') || bytes.length < 8 || bytes.length > MAX_BYTES ||
      !bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-') ||
      !bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1').includes('%%EOF'))
    throw Error('Envie um PDF válido de até 10 MB.');
}
export async function documentoVigente(tx: DbExecutor = db()) {
  return (await tx.query<DocumentoPublico>(
    'SELECT id,nome_arquivo,tamanho_bytes,sha256,chave_armazenamento,publicado_em::text FROM documentos_publicos WHERE tipo=$1 AND ativo', [tipo]
  )).rows[0] ?? null;
}
export async function publicarPdf(bytes: Buffer, nome: string) {
  validarPdf(bytes, nome);
  const chave = `${randomUUID()}.pdf`, destino = path.join(diretorio(), chave);
  await mkdir(diretorio(), { recursive: true });
  const arquivo = await open(destino, 'wx', 0o600);
  try { await arquivo.writeFile(bytes); await arquivo.sync(); }
  catch (error) { await arquivo.close(); await unlink(destino).catch(() => {}); throw error; }
  await arquivo.close();
  try {
    return await withTransaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tipo]);
      await tx.query('UPDATE documentos_publicos SET ativo=false WHERE tipo=$1 AND ativo', [tipo]);
      const result = await tx.query<DocumentoPublico>(`INSERT INTO documentos_publicos
        (tipo,nome_arquivo,mime_type,tamanho_bytes,sha256,chave_armazenamento,ativo,publicado_em)
        VALUES ($1,$2,'application/pdf',$3,$4,$5,true,clock_timestamp())
        RETURNING id,nome_arquivo,tamanho_bytes,sha256,chave_armazenamento,publicado_em::text`,
        [tipo, path.basename(nome).slice(0, 180), bytes.length, createHash('sha256').update(bytes).digest('hex'), chave]);
      return result.rows[0];
    });
  } catch (error) { await unlink(destino).catch(() => {}); throw error; }
}
export async function lerPdfVigente() {
  const documento = await documentoVigente();
  if (!documento || !/^[0-9a-f-]{36}\.pdf$/.test(documento.chave_armazenamento)) return null;
  const bytes = await readFile(path.join(diretorio(), documento.chave_armazenamento));
  if (createHash('sha256').update(bytes).digest('hex') !== documento.sha256) throw Error('Integridade do documento divergente.');
  return { documento, bytes };
}
