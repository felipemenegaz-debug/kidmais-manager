'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import workspace from '@/components/admin/workspace.module.css';

/**
 * Download do pacote completo e verificável (ZIP com CSVs, PDFs dos contratos, MANIFESTO.json e SHA256SUMS.txt) e dos
 * CSVs avulsos. O pacote é pedido por fetch para mostrar erro e o código de conferência (SHA-256 do MANIFESTO.json)
 * sem sair da página; os CSVs avulsos continuam como links diretos. `empresaId` só é passado para empresa suspensa
 * (a tela "Sem empresa ativa"): nas demais, a empresa é a da sessão.
 */
export default function ExportacaoDados({ empresaId, nome, csvAvulsos = true }: { empresaId?: string; nome?: string; csvAvulsos?: boolean }) {
    const [estado, setEstado] = useState<{ fase: 'parado' | 'gerando' | 'pronto' | 'erro'; texto?: string; hash?: string }>({ fase: 'parado' });
    const sufixo = empresaId ? `&empresaId=${encodeURIComponent(empresaId)}` : '';
    async function baixar() {
        if (estado.fase === 'gerando') return;
        setEstado({ fase: 'gerando' });
        try {
            const r = await adminFetch(`/api/admin/exportacao?tipo=completa${sufixo}`, { cache: 'no-store' });
            if (!r.ok) {
                const corpo = await r.json().catch(() => null) as { erro?: string } | null;
                setEstado({ fase: 'erro', texto: corpo?.erro ?? 'Não foi possível gerar o pacote. Tente novamente.' });
                return;
            }
            const blob = await r.blob();
            const nomeArquivo = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'kidmais-exportacao.zip';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = nomeArquivo;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
            setEstado({ fase: 'pronto', hash: r.headers.get('X-Kidmais-Manifesto-Sha256') ?? undefined, texto: nomeArquivo });
        } catch (e) {
            setEstado({ fase: 'erro', texto: e instanceof Error ? e.message : 'Falha de conexão. Tente novamente.' });
        }
    }
    return <div data-exportacao-dados={empresaId ?? 'sessao'}>
        <p className={workspace.muted}>
            Pacote completo{nome ? ` de ${nome}` : ''}: um arquivo ZIP com uma planilha (CSV) por tipo de registro — clientes, festas, contratos e
            seus PDFs, financeiro, agenda, pacotes, convites, marketing e atendimento — e um manifesto com a contagem e o código SHA-256 de cada arquivo
            para conferir que nada mudou. Senhas, tokens e credenciais nunca entram. Disponível em qualquer situação da assinatura.
        </p>
        <p style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', margin: 0 }}>
            <button type="button" onClick={() => void baixar()} disabled={estado.fase === 'gerando'} data-exportacao-completa>
                {estado.fase === 'gerando' ? 'Gerando o pacote…' : 'Baixar pacote completo (ZIP)'}
            </button>
            {csvAvulsos && <>
                <a href={`/api/admin/exportacao?tipo=clientes${sufixo}`} download>Clientes (CSV)</a>
                <a href={`/api/admin/exportacao?tipo=contas-receber${sufixo}`} download>Contas a receber (CSV)</a>
            </>}
        </p>
        {estado.fase === 'gerando' && <p role="status" className={workspace.muted}>Preparando os arquivos. Pode levar alguns segundos.</p>}
        {estado.fase === 'erro' && <p role="alert">{estado.texto}</p>}
        {estado.fase === 'pronto' && <p role="status" data-exportacao-pronta>
            Pacote baixado: {estado.texto}.{estado.hash && <> Código de conferência do manifesto (SHA-256): <code data-manifesto-sha256 style={{ wordBreak: 'break-all' }}>{estado.hash}</code></>}
        </p>}
    </div>;
}

/** Tela sem empresa ativa: Gestão de empresa SUSPENSA ainda leva os próprios dados (exceção mínima da exportação). */
export function ExportacaoEmpresasSuspensas() {
    const [empresas, setEmpresas] = useState<{ id: string; nome: string }[]>([]);
    useEffect(() => {
        let vivo = true;
        fetch('/api/admin/exportacao/empresas-suspensas', { cache: 'no-store' }).then((r) => r.json()).then((b: { ok?: boolean; data?: { empresas?: { id: string; nome: string }[] } }) => {
            if (vivo && b?.ok && Array.isArray(b.data?.empresas)) setEmpresas(b.data.empresas);
        }).catch(() => { /* sem lista: nada a oferecer */ });
        return () => { vivo = false; };
    }, []);
    if (empresas.length === 0) return null;
    return <section aria-labelledby="t-exportar-suspensas" data-exportacao-suspensas>
        <h2 id="t-exportar-suspensas">Exportar dados de empresa suspensa</h2>
        <p>A empresa abaixo está suspensa, mas os dados continuam dela: a Gestão pode baixar o pacote completo a qualquer momento.</p>
        {empresas.map((e) => <div key={e.id}><h3>{e.nome}</h3><ExportacaoDados empresaId={e.id} nome={e.nome} csvAvulsos={false} /></div>)}
    </section>;
}
