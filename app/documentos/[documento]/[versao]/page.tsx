import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { fonteAdmin } from '@/components/admin/fonte';
import tokens from '@/components/admin/tokens.module.css';
import DocumentoLegal from '@/components/cadastro/DocumentoLegal';
import { DOCUMENTOS, type DocumentoPublicado } from '@/lib/cadastro/documentos-legais';
import { withTransaction } from '@/lib/db/postgres';
import { versaoArquivada, versaoDoCatalogo } from '@/lib/assinatura/comprovante';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Versão de documento — Kidmais Manager', robots: { index: false } };

const PARAM: Record<string, DocumentoPublicado> = { termos_uso: 'TERMOS_USO', privacidade: 'PRIVACIDADE', dpa: 'DPA' };

/**
 * Texto integral de uma versão publicada (grupo B, 096): o arquivado no banco, com a impressão digital conferida pelo
 * próprio banco, continua disponível depois de novas versões. A versão vigente ainda não arquivada é a da página atual.
 */
export default async function Page({ params }: { params: Promise<{ documento: string; versao: string }> }) {
    const { documento: d, versao } = await params;
    // Object.hasOwn: nomes herdados do protótipo (constructor, __proto__) são 404, não erro (revisão 00cecac, P3-B2).
    const documento = Object.hasOwn(PARAM, d) ? PARAM[d] : null;
    if (!documento || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$/.test(versao)) notFound();
    const arquivada = await withTransaction((tx) => versaoArquivada(tx, documento, versao)).catch(() => null) ?? versaoDoCatalogo(documento, versao);
    if (!arquivada) {
        if (DOCUMENTOS[documento].versao === versao) return <DocumentoLegal documento={DOCUMENTOS[documento]} />;
        notFound();
    }
    const [titulo, ...linhas] = arquivada.conteudo.split('\n');
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}>
        <main className={admin.page} style={{ maxWidth: 820, margin: '0 auto' }}>
            <p role="status" className={workspace.muted}>Texto integral da versão {versao}, impressão digital {arquivada.hash}. A versão vigente está em <Link href={DOCUMENTOS[documento].rota}>{DOCUMENTOS[documento].rota}</Link>.</p>
            <h1>{titulo}</h1>
            <section className={workspace.card}>{linhas.map((l, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{l}</p>)}</section>
        </main>
    </div>;
}
