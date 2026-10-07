'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { DadosAssinatura } from './Assinatura';
import { MENSAGEM_PROCESSANDO } from './AssinaturaAcoes';
import { dataCurta } from './AvisoComercial';

const INTERVALO_MS = 5000;
const TENTATIVAS = 36; // ~3 minutos

/**
 * Retorno da página de pagamento. Só LÊ /api/admin/assinatura: voltar daqui não concede nada. O acesso muda quando o
 * provedor confirma o pagamento (webhook + reconsulta no servidor); esta tela apenas acompanha.
 */
export default function AssinaturaRetorno() {
    const [dados, setDados] = useState<DadosAssinatura | null>(null);
    const [tentativa, setTentativa] = useState(0);
    const [erro, setErro] = useState('');
    const confirmado = dados?.acesso.motivo === 'ASSINATURA_ATIVA' || dados?.acesso.motivo === 'SEM_COBRANCA';
    useEffect(() => {
        if (confirmado || tentativa >= TENTATIVAS)
            return;
        let vivo = true;
        const t = setTimeout(() => {
            adminFetch('/api/admin/assinatura').then(async (r) => {
                const corpo = await r.json().catch(() => null) as { ok?: boolean; data?: DadosAssinatura; erro?: string } | null;
                if (!vivo) return;
                if (r.ok && corpo?.ok && corpo.data) { setDados(corpo.data); setErro(''); }
                else setErro(corpo?.erro ?? 'Não foi possível consultar a assinatura.');
            }).catch(() => { if (vivo) setErro('Falha de conexão. Tentando de novo.'); })
                .finally(() => { if (vivo) setTentativa((n) => n + 1); });
        }, tentativa === 0 ? 0 : INTERVALO_MS);
        return () => { vivo = false; clearTimeout(t); };
    }, [tentativa, confirmado]);
    return <main className={admin.page} data-assinatura-retorno>
        <h1>Assinatura</h1>
        <section className={workspace.card} aria-live="polite" style={{ maxWidth: 720 }}>
            {confirmado
                ? <>
                    <h2>Pagamento confirmado</h2>
                    <p>Acesso completo liberado{dados?.assinatura?.periodoAtualFim ? ` até ${dataCurta(dados.assinatura.periodoAtualFim)}` : ''}.</p>
                </>
                : <>
                    <h2>Processando</h2>
                    <p data-processando>{MENSAGEM_PROCESSANDO}</p>
                    <p className={workspace.muted}>{tentativa >= TENTATIVAS
                        ? 'A confirmação ainda não chegou. Pix costuma ser imediato; boleto pode levar alguns dias úteis. Você pode fechar esta página: o acesso é liberado automaticamente.'
                        : 'Esta página confere a situação a cada poucos segundos.'}</p>
                </>}
            {erro && <p role="alert">{erro}</p>}
            <p><Link href="/admin/assinatura">Voltar para Assinatura</Link></p>
        </section>
    </main>;
}
