'use client';
import { useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { chamar } from './cliente';
import { useReautenticacao } from './Reautenticacao';

type Resultado = { resultado: string; antes?: string; depois?: string; mudou?: boolean; provedorSituacao?: string };
const TEXTO: Record<string, string> = {
    SEM_ASSINATURA: 'Empresa sem cobrança: nada a sincronizar.',
    SEM_PROVEDOR: 'Empresa ainda sem assinatura no provedor.',
    RECUSADA: 'A assinatura do provedor não corresponde a esta empresa. Nada foi alterado.',
};

/** Ficha da empresa: reconsulta a assinatura no provedor (senha confirmada, auditado). */
export default function SincronizarCobranca({ empresaId }: { empresaId: string }) {
    const { executar, dialogo } = useReautenticacao();
    const [ocupado, setOcupado] = useState(false);
    const [mensagem, setMensagem] = useState('');
    return <section className={workspace.card} aria-labelledby="t-cobranca-provedor">
        <h2 id="t-cobranca-provedor">Cobrança no provedor</h2>
        <p className={workspace.muted}>Reconsulta a assinatura no provedor de pagamento e aplica a situação atual dele. Não concede acesso por conta própria.</p>
        <button type="button" disabled={ocupado} onClick={() => {
            setOcupado(true);
            setMensagem('');
            void executar(() => chamar<Resultado>(`/api/desenvolvedor/empresas/${empresaId}/cobranca`, 'POST', {}), (r) => {
                setOcupado(false);
                if (!r.ok) { setMensagem(r.erro); return; }
                const d = r.data;
                setMensagem(d.resultado === 'SINCRONIZADA'
                    ? (d.mudou ? `Situação atualizada: ${d.antes} → ${d.depois} (provedor: ${d.provedorSituacao}).` : `Sem mudança: ${d.depois} (provedor: ${d.provedorSituacao}).`)
                    : TEXTO[d.resultado] ?? d.resultado);
            });
        }}>{ocupado ? 'Sincronizando…' : 'Sincronizar com o provedor'}</button>
        {mensagem && <p role="status">{mensagem}</p>}
        {dialogo}
    </section>;
}
