'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';
import { linhasComprovante, linkVersao, TITULO_DOCUMENTO } from '@/lib/assinatura/comprovante-texto';
import type { DadosAssinatura } from './Assinatura';

/**
 * Comprovante da contratação (grupo B, 096): para salvar ou imprimir. Lê a consulta da assinatura (só a Gestão recebe a
 * síntese); sem a 096 ou sem contratação, explica onde ficam as condições.
 */
export default function ComprovanteContratacao() {
    const [dados, setDados] = useState<DadosAssinatura | null>(null);
    const [erro, setErro] = useState('');
    useEffect(() => {
        let vivo = true;
        adminFetch('/api/admin/assinatura').then(async (r) => {
            const corpo = await r.json().catch(() => null) as { ok?: boolean; data?: DadosAssinatura; erro?: string } | null;
            if (!vivo) return;
            if (r.ok && corpo?.ok && corpo.data) setDados(corpo.data);
            else setErro(corpo?.erro ?? 'Não foi possível carregar o comprovante.');
        }).catch(() => { if (vivo) setErro('Falha de conexão.'); });
        return () => { vivo = false; };
    }, []);
    const c = dados?.contratacao?.comprovante ?? null;
    return <section className={workspace.card} aria-labelledby="t-comprovante" data-comprovante>
        <h1 id="t-comprovante">Comprovante da contratação</h1>
        {erro && <p role="alert">{erro}</p>}
        {!erro && !dados && <p className={workspace.muted}>Carregando…</p>}
        {dados && !dados.gestao && <p>Somente a Gestão da empresa vê o comprovante da contratação.</p>}
        {dados && dados.gestao && !c && <p>Ainda não há comprovante registrado para esta empresa. As condições da assinatura estão em <Link href="/admin/assinatura">Assinatura</Link> e nos <Link href="/termos">Termos de uso</Link>.</p>}
        {c && <>
            {linhasComprovante(c).map((l, i) => <p key={i}>{l}</p>)}
            <ul aria-label="Documentos aceitos">
                {c.documentos.map((d) => <li key={d.documento}><Link href={linkVersao(d)} target="_blank">{TITULO_DOCUMENTO[d.documento]} — versão {d.versao} (texto integral)</Link></li>)}
            </ul>
            {c.emailEnviadoEm && <p className={workspace.muted}>Uma cópia foi enviada por e-mail.</p>}
            {c.emailFalhouEm && <p className={workspace.muted}>O envio da cópia por e-mail falhou; este comprovante continua válido e disponível aqui.</p>}
            <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => window.print()}>Imprimir ou salvar em PDF</button>
                <Link href="/admin/assinatura">Voltar para Assinatura</Link>
            </p>
        </>}
    </section>;
}
