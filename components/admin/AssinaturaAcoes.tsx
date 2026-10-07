'use client';
import { useState } from 'react';
import Link from 'next/link';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import Assinatura, { reais, type DadosAssinatura } from './Assinatura';
import { dataCurta } from './AvisoComercial';

/**
 * Ações de cobrança da tela Assinatura (E8, Asaas sandbox). Só a Gestão contrata ou cancela; a Equipe vê a situação.
 * Assinar devolve a página hospedada de pagamento do provedor. Voltar dela não libera nada: o acesso muda só quando o
 * pagamento é confirmado pelo provedor (webhook + reconsulta no servidor).
 */
type Pagamento = { urlPagamento: string | null; vencimento: string | null; ciclo: 'MENSAL' | 'ANUAL'; reaproveitada: boolean };
export const MENSAGEM_PROCESSANDO = 'Processando: o acesso é liberado quando o pagamento for confirmado.';

async function postar<T>(url: string, corpo: unknown): Promise<{ ok: true; data: T } | { ok: false; erro: string; codigo: string | null }> {
    try {
        const r = await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await r.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string; codigo?: string } | null;
        return r.ok && j?.ok ? { ok: true, data: j.data as T } : { ok: false, erro: j?.erro ?? `Não foi possível concluir (HTTP ${r.status}).`, codigo: j?.codigo ?? null };
    }
    catch {
        return { ok: false, erro: 'Falha de conexão. Confira a situação antes de repetir.', codigo: null };
    }
}

export function AcoesCobranca({ dados, recarregar }: { dados: DadosAssinatura; recarregar: () => void }) {
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState('');
    const [pagamento, setPagamento] = useState<Pagamento | null>(null);
    const [cancelando, setCancelando] = useState(false);
    const [senha, setSenha] = useState('');
    const [motivo, setMotivo] = useState('');
    const [aviso, setAviso] = useState('');
    const a = dados.assinatura;
    if (!a)
        return null;
    const precos = dados.precos;
    const cobranca = dados.cobranca;
    const ativaNoProvedor = Boolean(cobranca?.vinculada && cobranca.provedorSituacao === 'ACTIVE');
    const pagando = a.situacao === 'ATIVA' || a.situacao === 'EM_ATRASO';
    const pendenteDeConfirmacao = ativaNoProvedor && !pagando;

    async function assinar(ciclo: 'MENSAL' | 'ANUAL') {
        setOcupado(true); setErro(''); setAviso('');
        const r = await postar<Pagamento>('/api/admin/assinatura/checkout', { ciclo });
        setOcupado(false);
        if (!r.ok) { setErro(r.erro); return; }
        setPagamento(r.data);
        if (!r.data.urlPagamento)
            setAviso(a?.situacao === 'ATIVA' ? 'Sua assinatura está em dia: não há cobrança em aberto.' : 'A cobrança está sendo gerada pelo provedor. Atualize em instantes.');
    }

    async function cancelar() {
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
            const r = await postar<{ situacao: string }>('/api/admin/assinatura/cancelamento', { confirmar: true, motivo: motivo.trim() });
            if (!r.ok) { setErro(r.erro); return; }
            setCancelando(false);
            setAviso(r.data.situacao === 'CANCELADA_FIM_PERIODO' ? `Assinatura cancelada. O acesso continua até ${a?.periodoAtualFim ? dataCurta(a.periodoAtualFim) : 'o fim do período pago'}.` : 'Cancelamento registrado.');
            recarregar();
        }
        finally {
            setSenha('');
            setOcupado(false);
        }
    }

    const titulo = pagando ? 'Sua assinatura' : 'Contratar';
    return <section className={workspace.card} aria-labelledby="t-contratar" style={{ maxWidth: 720 }} data-assinatura-acoes>
        <h2 id="t-contratar">{titulo}</h2>
        {erro && <p role="alert">{erro}</p>}
        {aviso && <p role="status">{aviso}</p>}
        {!dados.gestao && <p className={workspace.muted}>Somente a Gestão desta empresa contrata ou cancela a assinatura.</p>}
        {dados.gestao && !cobranca?.disponivel && <>
            {precos && (precos.MENSAL || precos.ANUAL) && <p>{[precos.MENSAL ? `${reais(precos.MENSAL)} por mês` : null, precos.ANUAL ? `${reais(precos.ANUAL)} por ano` : null].filter(Boolean).join(' · ')}</p>}
            <p className={workspace.muted}>A contratação on-line ainda não está disponível neste ambiente. Fale com a Kidmais para assinar.</p>
        </>}
        {dados.gestao && cobranca?.disponivel && pagamento?.urlPagamento && <div data-pagamento-aberto>
            <p>{pagamento.reaproveitada ? 'Há um pagamento em aberto desta assinatura.' : 'Assinatura criada.'}{pagamento.vencimento ? ` Vencimento: ${pagamento.vencimento.split('-').reverse().join('/')}.` : ''} Pague pela página segura do provedor (Pix, boleto ou cartão).</p>
            <p style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: 0 }}>
                <a href={pagamento.urlPagamento} target="_blank" rel="noopener noreferrer">Abrir página de pagamento</a>
                <Link href="/admin/assinatura/retorno">Já paguei — acompanhar confirmação</Link>
            </p>
            <p className={workspace.muted}>{MENSAGEM_PROCESSANDO}</p>
        </div>}
        {dados.gestao && cobranca?.disponivel && !pagamento?.urlPagamento && <>
            {(a.situacao === 'EM_ATRASO' || pendenteDeConfirmacao) && a.ciclo
                ? <p><button type="button" disabled={ocupado} onClick={() => void assinar(a.ciclo as 'MENSAL' | 'ANUAL')}>{ocupado ? 'Abrindo…' : 'Continuar pagamento'}</button></p>
                : !ativaNoProvedor && <>
                    {precos && (precos.MENSAL || precos.ANUAL)
                        ? <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: 0 }}>
                            {precos.MENSAL && <button type="button" disabled={ocupado} onClick={() => void assinar('MENSAL')}>Assinar mensal — {reais(precos.MENSAL)}/mês</button>}
                            {precos.ANUAL && <button type="button" disabled={ocupado} onClick={() => void assinar('ANUAL')}>Assinar anual — {reais(precos.ANUAL)}/ano</button>}
                        </p>
                        : <p className={workspace.muted}>Os planos ainda não estão publicados neste ambiente.</p>}
                </>}
            {a.situacao === 'ATIVA' && ativaNoProvedor && <p className={workspace.muted}>Renovação automática pelo provedor. Cada cobrança chega pela página de pagamento do provedor.</p>}
        </>}
        {dados.gestao && cobranca?.disponivel && pagando && ativaNoProvedor && !cancelando && <p>
            <button type="button" className="danger" disabled={ocupado} onClick={() => { setCancelando(true); setErro(''); setAviso(''); }}>Cancelar ao fim do período…</button>
        </p>}
        {cancelando && <form onSubmit={(e) => { e.preventDefault(); if (senha) void cancelar(); }} data-cancelamento>
            <p>O acesso completo continua até {a.periodoAtualFim ? dataCurta(a.periodoAtualFim) : 'o fim do período pago'}. Depois disso a empresa fica em somente leitura. Cobranças em aberto são removidas; nada é apagado.</p>
            <label>Motivo (opcional)<input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></label>
            <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
            <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button type="submit" className="danger" disabled={ocupado || !senha}>{ocupado ? 'Cancelando…' : 'Confirmar cancelamento'}</button>
                <button type="button" disabled={ocupado} onClick={() => { setCancelando(false); setSenha(''); }}>Voltar</button>
            </p>
        </form>}
    </section>;
}

/** Tela Assinatura com as ações de cobrança (componente cliente: a página de servidor não passa funções). */
export default function AssinaturaComAcoes() {
    return <Assinatura acoes={(dados, recarregar) => <AcoesCobranca dados={dados} recarregar={recarregar} />} />;
}
