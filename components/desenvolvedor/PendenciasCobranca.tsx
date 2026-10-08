'use client';
import { useEffect, useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { chamar } from './cliente';
import { useReautenticacao } from './Reautenticacao';

type Pendencia = {
    id: string; tipo: 'INTENCAO_CRIACAO' | 'RECONCILIACAO' | 'REMOCAO_SEM_CONFIRMACAO'; situacao: string; motivo: string | null; temAssinatura: boolean; recebidoEm: string;
    tentativas: number; liberavel: boolean; bloqueadaPor?: 'REMOCAO_SEM_CONFIRMACAO' | null;
};
export const TITULO: Record<Pendencia['tipo'], string> = {
    INTENCAO_CRIACAO: 'Criação de assinatura não confirmada',
    RECONCILIACAO: 'Reconciliação da contratação',
    REMOCAO_SEM_CONFIRMACAO: 'Exclusão no provedor sem confirmação',
};
/** Liberação bloqueada pelo marcador de exclusão: só explica; não há atalho para ignorar o marcador. */
export const AVISO_BLOQUEIO_REMOCAO = 'Liberação bloqueada: há uma exclusão de assinatura no provedor com resultado desconhecido nesta empresa. Confira no painel do Asaas; a liberação volta quando a reconciliação confirmar a exclusão.';
const CONFIRMACAO = 'CONFERI_NO_PROVEDOR_QUE_NAO_FOI_CRIADA';
const MOTIVO: Record<string, string> = {
    CRIACAO_EM_CURSO: 'criação iniciada, sem confirmação',
    CRIACAO_SEM_RESPOSTA: 'o provedor não respondeu à criação',
    CRIACAO_CONFIRMADA_SEM_VINCULO: 'assinatura confirmada, aguardando vínculo',
    COMMIT_INCERTO: 'gravação do vínculo não confirmada',
    VINCULO_DUVIDOSO: 'vínculo não pôde ser conferido',
    COMPENSACAO_FALHOU: 'remoção de duplicata falhou',
    ASSINATURAS_AMBIGUAS: 'várias assinaturas no provedor',
    REMOCAO_EM_CURSO: 'exclusão de duplicata enviada, resultado ainda não gravado',
    REMOCAO_SEM_CONFIRMACAO: 'exclusão de duplicata sem confirmação do provedor; confira no painel do Asaas (nada é excluído de novo automaticamente)',
    REVISAO_HUMANA: 'precisa de revisão',
    DUPLICATA_COM_PAGAMENTO: 'duplicata com pagamento',
    DUPLICATA_PRESERVADA: 'duplicata preservada',
};
export const textoMotivo = (m: string | null, situacao: string) => {
    if (!m) return situacao;
    const [codigo, ...resto] = m.split(': ');
    return MOTIVO[codigo] ? [MOTIVO[codigo], ...resto.map((r) => MOTIVO[r] ?? r)].join(': ') : m;
};
const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Ficha da empresa: pendências de cobrança abertas. Uma intenção de criação sem assinatura confirmada pode ser liberada
 * manualmente (senha confirmada, motivo, declaração de conferência no provedor; auditado). Nunca por prazo.
 */
export default function PendenciasCobranca({ empresaId }: { empresaId: string }) {
    const { executar, dialogo } = useReautenticacao();
    const [lista, setLista] = useState<Pendencia[] | null>(null);
    const [erro, setErro] = useState('');
    const [aberta, setAberta] = useState<string | null>(null);
    const [motivo, setMotivo] = useState('');
    const [conferi, setConferi] = useState(false);
    const [ocupado, setOcupado] = useState(false);
    const [mensagem, setMensagem] = useState('');
    const [versao, setVersao] = useState(0);
    useEffect(() => {
        let vivo = true;
        chamar<Pendencia[]>(`/api/desenvolvedor/empresas/${empresaId}/cobranca/pendencias`).then((r) => {
            if (!vivo) return;
            if (r.ok) { setLista(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [empresaId, versao]);

    return <section className={workspace.card} aria-labelledby="t-pendencias-cobranca">
        <h2 id="t-pendencias-cobranca">Pendências de cobrança</h2>
        {erro && <p role="alert">{erro}</p>}
        {lista && lista.length === 0 && <p className={workspace.muted}>Nenhuma pendência aberta.</p>}
        {lista && lista.length > 0 && <ul>
            {lista.map((p) => <li key={p.id}>
                <strong>{TITULO[p.tipo] ?? TITULO.RECONCILIACAO}</strong>
                {' '}— {textoMotivo(p.motivo, p.situacao)} · desde {quando(p.recebidoEm)}{p.tentativas ? ` · ${p.tentativas} tentativa(s)` : ''}
                {p.bloqueadaPor === 'REMOCAO_SEM_CONFIRMACAO' && <p className={workspace.muted}>{AVISO_BLOQUEIO_REMOCAO}</p>}
                {p.liberavel && aberta !== p.id && <div>
                    <button type="button" onClick={() => { setAberta(p.id); setMotivo(''); setConferi(false); setMensagem(''); }}>Liberar (não foi criada)</button>
                </div>}
                {p.liberavel && aberta === p.id && <form onSubmit={(ev) => {
                    ev.preventDefault();
                    setOcupado(true);
                    setMensagem('');
                    void executar(() => chamar<{ resultado: string }>(`/api/desenvolvedor/empresas/${empresaId}/cobranca/pendencias`, 'POST',
                        { pendenciaId: p.id, motivo, confirmacao: CONFIRMACAO }), (r) => {
                        setOcupado(false);
                        if (!r.ok) { setMensagem(r.erro); return; }
                        setAberta(null);
                        setMensagem('Intenção liberada. A empresa pode contratar de novo.');
                        setVersao((v) => v + 1);
                    });
                }}>
                    <p className={workspace.muted}>Libere só depois de conferir no painel do provedor que nenhuma assinatura foi criada para esta empresa. O sistema consulta o provedor de novo antes de liberar.</p>
                    <label>Motivo (10 a 500 caracteres)
                        <textarea value={motivo} onChange={(ev) => setMotivo(ev.target.value)} minLength={10} maxLength={500} required rows={3} />
                    </label>
                    <label><input type="checkbox" checked={conferi} onChange={(ev) => setConferi(ev.target.checked)} /> Conferi no provedor que a assinatura não foi criada</label>
                    <div>
                        <button type="submit" disabled={ocupado || !conferi || motivo.trim().length < 10}>{ocupado ? 'Liberando…' : 'Confirmar liberação'}</button>
                        <button type="button" disabled={ocupado} onClick={() => setAberta(null)}>Cancelar</button>
                    </div>
                </form>}
            </li>)}
        </ul>}
        {mensagem && <p role="status">{mensagem}</p>}
        {dialogo}
    </section>;
}
