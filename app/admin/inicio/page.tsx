'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';

type Passo = { codigo: string; titulo: string; feito: boolean | null; detalhe: string; href: string; somenteGestao: boolean };
type Dados = { passos: Passo[]; concluidos: number; total: number; gestao: boolean };

/** Início guiado da empresa (E7): o mínimo para começar a operar, com o que já foi feito marcado a partir do banco. */
export default function Inicio() {
    const [dados, setDados] = useState<Dados | null>(null);
    const [erro, setErro] = useState('');
    useEffect(() => {
        let vivo = true;
        adminFetch('/api/admin/inicio').then(async (r) => {
            const b = await r.json().catch(() => null) as { ok?: boolean; data?: Dados; erro?: string } | null;
            if (!vivo) return;
            if (r.ok && b?.ok && b.data) setDados(b.data);
            else setErro(b?.erro ?? 'Não foi possível carregar os primeiros passos.');
        }).catch(() => { if (vivo) setErro('Falha de conexão. Tente novamente.'); });
        return () => { vivo = false; };
    }, []);
    return <main className={admin.page} data-inicio>
        <h1>Primeiros passos</h1>
        {erro && <p role="alert">{erro}</p>}
        {!dados && !erro && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {dados && <>
            <p className={workspace.muted}>{dados.concluidos} de {dados.total} itens essenciais prontos. Faça na ordem que preferir; nada aqui é obrigatório para entrar no sistema.</p>
            <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12, maxWidth: 760 }} aria-label="Primeiros passos">
                {dados.passos.map((p) => <li key={p.codigo} className={workspace.card} data-passo={p.codigo} data-feito={String(p.feito)} style={{ padding: 16 }}>
                    <strong><span aria-hidden="true">{p.feito ? '✓ ' : p.feito === false ? '○ ' : '– '}</span>{p.titulo}{p.feito ? ' (pronto)' : ''}</strong>
                    <p style={{ margin: '6px 0' }}>{p.feito === null ? 'Ainda não disponível neste ambiente.' : p.detalhe}</p>
                    {p.feito !== null && (!p.somenteGestao || dados.gestao ? <Link href={p.href}>{p.feito ? 'Ver' : 'Fazer agora'}</Link> : <small className={workspace.muted}>Feito pela Gestão da empresa.</small>)}
                </li>)}
            </ol>
            <p><Link href="/admin/assinatura">Ver assinatura e teste grátis</Link></p>
        </>}
    </main>;
}
