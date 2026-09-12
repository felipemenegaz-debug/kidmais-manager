import { createHash } from 'node:crypto';
import { db } from '../../db/postgres';
import type { DbExecutor } from '../../db/contracts';
import { ContratoServiceError } from '../services/errors';
export type DocumentoPersistido = {
    id: string;
    contrato_versao_id: string;
    categoria: string;
    revisao: number;
    snapshot_hash: string;
    template_codigo: string;
    template_versao: number;
    pdf_hash: string;
    tamanho_bytes: string;
    conteudo_pdf: Buffer;
};
export async function guardarDocumento(tx: DbExecutor, input: {
    versaoId: string;
    categoria: 'CONTRATO' | 'COMPROVANTE_ASSINATURA';
    revisao: number;
    snapshotHash: string;
    templateCodigo: string;
    templateVersao?: number;
    usuarioId: string | null;
    pdf: Buffer;
}) {
    if (input.pdf.length > 10 * 1024 * 1024)
        throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES', 'Documento excede o limite de 10 MB.', 400);
    const hash = createHash('sha256').update(input.pdf).digest('hex');
    return (await tx.query<DocumentoPersistido>(`INSERT INTO contrato_documentos(contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf,gerado_por_usuario_id)
 VALUES($1,$2,$3,$4,$5,$10,$6,$7,$8,$9) RETURNING *`, [input.versaoId, input.categoria, input.revisao, input.snapshotHash, input.templateCodigo, hash, input.pdf.length, input.pdf, input.usuarioId, input.templateVersao ?? 1])).rows[0];
}
export async function lerDocumento(id: string, tx: DbExecutor = db()) {
    const d = (await tx.query<DocumentoPersistido>('SELECT * FROM contrato_documentos WHERE id=$1', [id])).rows[0];
    if (!d)
        throw new ContratoServiceError('DOCUMENTO_CONTRATO_DIVERGENTE', 'Documento não disponível nesta versão.', 404);
    if (Number(d.tamanho_bytes) !== d.conteudo_pdf.length || createHash('sha256').update(d.conteudo_pdf).digest('hex') !== d.pdf_hash)
        throw new ContratoServiceError('DOCUMENTO_CONTRATO_INTEGRIDADE_FALHOU', 'Falha de integridade documental.', 409);
    return d;
}
