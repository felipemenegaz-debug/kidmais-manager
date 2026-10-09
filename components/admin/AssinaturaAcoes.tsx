'use client';
import { useState } from 'react';
import Link from 'next/link';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import Assinatura, { reais, type DadosAssinatura } from './Assinatura';
import { dataCurta } from './AvisoComercial';
import type { PlanoComercialId } from '@/lib/assinatura/planos-comerciais';

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
    const [cicloPlano, setCicloPlano] = useState<'MENSAL' | 'ANUAL'>('MENSAL');
    const a = dados.assinatura;
    if (!a)
        return null;
    const precos = dados.precos;
    const cobranca = dados.cobranca;
    const ativaNoProvedor = Boolean(cobranca?.vinculada && cobranca.provedorSituacao === 'ACTIVE');
    const pagando = a.situacao === 'ATIVA' || a.situacao === 'EM_ATRASO';
    const pendenteDeConfirmacao = ativaNoProvedor && !pagando;

    async function assinar(ciclo: 'MENSAL' | 'ANUAL', plano?: PlanoComercialId, valorEsperadoCentavos?: number) {
        setOcupado(true); setErro(''); setAviso('');
        const r = await postar<Pagamento>('/api/admin/assinatura/checkout', { ciclo, ...(plano ? { plano, valorEsperadoCentavos, versao: dados.ofertas?.versao } : {}) });
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
        {dados.ofertas?.planoAtual && <p>Plano contratado: {dados.ofertas.planoAtual}.</p>}
        {dados.gestao && dados.renovacao && dados.renovacao.estado !== 'CANCELADA' && <div role="status" data-aviso-renovacao>
            {dados.renovacao.estado === 'REVISAO'
                ? <p>A renovação após o Fundador precisa de revisão pelo atendimento. Confira a situação antes de pagar uma nova cobrança.</p>
                : <p>Após o Fundador, a partir de {dados.renovacao.dataRegular.split('-').reverse().join('/')}, o valor será {reais(dados.renovacao.valorRegular)}/{dados.renovacao.ciclo === 'ANUAL' ? 'ano' : 'mês'}.
                    {dados.renovacao.avisoEnviado ? ' O aviso de renovação foi enviado por e-mail à Gestão que contratou.' : ' O aviso será enviado por e-mail 30 dias antes.'}
                    {' '}Você pode cancelar antes da renovação, preservando o período já pago.</p>}
        </div>}
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
        {dados.gestao && cobranca?.disponivel && dados.ofertas?.habilitado && !pagamento?.urlPagamento && <div>
            <p>Escolha o plano para continuar após o teste. O acesso pago depende da confirmação do pagamento.</p>
            {dados.ofertas.fundador && <p>Fundador: 40% de desconto por 12 meses. Depois, renovação pelo preço normal, com aviso prévio.</p>}
            {dados.ofertas.aguardandoVaga ? <p role="status">As vagas Fundador estão em confirmação. Aguarde antes de contratar.</p> : <>
                <label>Ciclo <select value={cicloPlano} onChange={e => setCicloPlano(e.target.value as 'MENSAL' | 'ANUAL')} disabled={ocupado || Boolean(dados.ofertas.pendente)}>
                    <option value="MENSAL">Mensal</option><option value="ANUAL">Anual — pagamento único, valor de 10 mensalidades</option>
                </select></label>
                {dados.ofertas.pendente ? <p><button type="button" disabled={ocupado} onClick={() => {
                    const p = dados.ofertas!.pendente!; void assinar(p.ciclo,p.plano,p.valorCentavos);
                }}>{ocupado ? 'Abrindo…' : `Retomar ${dados.ofertas.pendente.plano} — ${reais(dados.ofertas.pendente.valorCentavos)}`}</button></p> :
                dados.ofertas.planos.map(p => <p key={p.id}><button type="button" disabled={ocupado} onClick={() => void assinar(cicloPlano,p.id,cicloPlano === 'ANUAL' ? p.anual : p.mensal)}>
                    {ocupado ? 'Abrindo…' : `Assinar ${p.nome} — ${reais(cicloPlano === 'ANUAL' ? p.anual : p.mensal)}/${cicloPlano === 'ANUAL' ? 'ano' : 'mês'}`}
                </button>{dados.ofertas?.fundador && <small style={{ display: 'block' }}>
                    Após 12 meses: {reais(cicloPlano === 'ANUAL' ? p.anualRegular : p.mensalRegular)}/{cicloPlano === 'ANUAL' ? 'ano' : 'mês'}, com aviso prévio.
                </small>}</p>)}
            </>}
        </div>}
        {dados.gestao && cobranca?.disponivel && !dados.ofertas?.habilitado && !pagamento?.urlPagamento && <>
            {(a.situacao === 'EM_ATRASO' || pendenteDeConfirmacao) && a.ciclo
                ? <p><button type="button" disabled={ocupado} onClick={() => void assinar(a.ciclo as 'MENSAL' | 'ANUAL')}>{ocupado ? 'Abrindo…' : 'Continuar pagamento'}</button></p>
                : !ativaNoProvedor && !dados.ofertas?.planoAtual && <>
                    {precos && (precos.MENSAL || precos.ANUAL)
                        ? <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: 0 }}>
                            {precos.MENSAL && <button type="button" disabled={ocupado} onClick={() => void assinar('MENSAL')}>Assinar mensal — {reais(precos.MENSAL)}/mês</button>}
                            {precos.ANUAL && <button type="button" disabled={ocupado} onClick={() => void assinar('ANUAL')}>Assinar anual — {reais(precos.ANUAL)}/ano</button>}
                        </p>
                        : <p className={workspace.muted}>Os planos ainda não estão publicados neste ambiente.</p>}
                </>}
            {a.situacao === 'ATIVA' && ativaNoProvedor && <p className={workspace.muted}>Renovação automática pelo provedor. Cada cobrança chega pela página de pagamento do provedor.</p>}
            {!ativaNoProvedor && dados.ofertas?.planoAtual && <p>A assinatura mantém seu histórico. Para recontratar ou mudar de plano, fale com o atendimento.</p>}
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
