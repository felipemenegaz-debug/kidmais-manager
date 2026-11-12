'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData } from './cliente';
import { useReautenticacao } from './Reautenticacao';
import type { Forma } from '@/lib/creditos/dominio';

export type DevolucaoAberta = {
    protocolo: string; pedido_protocolo: string; tipo: string; origem: string; estado: string; modo: string | null; status_provedor: string | null;
    valor_centavos: number | string; forma: string | null; prazo: string | null; solicitado_em: string; empresa_nome: string;
};
type Fila = { instalado: false } | { instalado: true; devolucoes: DevolucaoAberta[] };

export const ESTADO_DEVOLUCAO: Record<string, string> = {
    AGUARDANDO_MANUAL: 'Aguardando a restituição manual no Asaas',
    EM_CURSO: 'Estorno automático em andamento',
    SOLICITADO: 'Estorno pedido ao Asaas, sem confirmação final',
    SEM_CONFIRMACAO: 'Estorno sem confirmação do Asaas',
    RECUSADO: 'Estorno recusado pelo Asaas',
};
export const TIPO_DEVOLUCAO: Record<string, string> = { ARREPENDIMENTO_7_DIAS: 'Arrependimento (7 dias)', SALDO_NAO_UTILIZADO: 'Saldo não utilizado' };
export const ORIGEM_DEVOLUCAO: Record<string, string> = { GESTAO: 'pedido pela Gestão', ATENDIMENTO: 'pedido pelo atendimento' };
/** Chaves do domínio (`Forma`, CHECK da devolução), não o billingType do Asaas. */
export const FORMA_PAGAMENTO: Record<Forma, string> = { PIX: 'Pix', BOLETO: 'Boleto', CARTAO: 'Cartão de crédito' };
const rotuloForma = (forma: string) => (FORMA_PAGAMENTO as Record<string, string>)[forma] ?? forma;

export const reais = (centavos: number | string) => (Number(centavos) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** O servidor recusa concluir durante o estorno automático (409): a tela nem oferece o botão nesse estado. */
export const podeConcluir = (d: Pick<DevolucaoAberta, 'estado'>) => d.estado !== 'EM_CURSO';

/** Mesma regra do servidor (lib/desenvolvedor/creditos.ts): referência de 3 a 200 caracteres, sem contar espaços nas pontas. */
export const referenciaValida = (r: string) => r.trim().length >= 3 && r.trim().length <= 200;

/**
 * R3 (janela sandbox de 09/11/2026): painel do desenvolvedor → Créditos de IA. Lista as devoluções de pacotes ainda
 * abertas e conclui a restituição feita à mão no painel do Asaas (boleto, flag de estorno desligada, estorno recusado ou
 * sem confirmação), com a referência do comprovante. Senha recente e auditoria (CREDITOS_DEVOLUCAO_CONCLUIDA) no servidor.
 * Nada aqui chama o Asaas: a conferência da restituição é do operador.
 */
export default function CreditosOperador() {
    const { executar, dialogo } = useReautenticacao();
    const [fila, setFila] = useState<Fila | null>(null);
    const [erro, setErro] = useState('');
    const [versao, setVersao] = useState(0);
    const [aberta, setAberta] = useState<string | null>(null);
    const [referencia, setReferencia] = useState('');
    const [conferido, setConferido] = useState(false);
    const [ocupado, setOcupado] = useState(false);
    const [mensagem, setMensagem] = useState('');
    useEffect(() => {
        let vivo = true;
        chamar<Fila>('/api/desenvolvedor/creditos').then((r) => {
            if (!vivo) return;
            if (r.ok) { setFila(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [versao]);

    return <main className={admin.page}>
        <div className={estilos.cabecalho}><div><p className={estilos.sobretitulo}>Operação</p><h1>Créditos de IA</h1></div></div>
        <p className={workspace.muted}>Devoluções de pacotes de créditos ainda abertas. O saldo restante do pacote já foi cancelado quando a devolução foi registrada; falta só confirmar que o dinheiro voltou para o buffet. Faça a restituição no painel do Asaas, confira e registre aqui a referência do comprovante.</p>
        {erro && <p role="alert">{erro}</p>}
        {!fila && !erro && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {fila && !fila.instalado && <p className={workspace.muted}>Os créditos de IA não estão instalados neste ambiente.</p>}
        {fila && fila.instalado && <section className={workspace.card} aria-labelledby="t-devolucoes-abertas">
            <h2 id="t-devolucoes-abertas">Devoluções abertas ({fila.devolucoes.length})</h2>
            {fila.devolucoes.length === 0 && <p className={workspace.muted}>Nenhuma devolução aberta.</p>}
            {fila.devolucoes.map((d) => <article key={d.protocolo} className={workspace.card} aria-label={`Devolução ${d.protocolo}`} data-devolucao={d.protocolo} data-estado={d.estado}>
                <p><strong>{d.empresa_nome}</strong> · {reais(d.valor_centavos)}{d.forma ? ` · ${rotuloForma(d.forma)}` : ''}</p>
                <ul>
                    <li>Devolução <code>{d.protocolo}</code> do pedido <code>{d.pedido_protocolo}</code></li>
                    <li>{TIPO_DEVOLUCAO[d.tipo] ?? d.tipo}, {ORIGEM_DEVOLUCAO[d.origem] ?? d.origem}, em {formatarData(d.solicitado_em)}{d.prazo ? ` · prazo ${d.prazo.split('-').reverse().join('/')}` : ''}</li>
                    <li>Situação: {ESTADO_DEVOLUCAO[d.estado] ?? d.estado}{d.modo ? ` · modo ${d.modo === 'AUTOMATICO' ? 'automático' : d.modo.toLowerCase()}` : ''}{d.status_provedor ? ` · Asaas: ${d.status_provedor}` : ''}</li>
                </ul>
                {!podeConcluir(d) && <p className={workspace.muted}>O estorno automático ainda está em andamento. Aguarde a resposta do Asaas antes de concluir à mão.</p>}
                {podeConcluir(d) && aberta !== d.protocolo && <div className={workspace.actions}>
                    <button type="button" onClick={() => { setAberta(d.protocolo); setReferencia(''); setConferido(false); setMensagem(''); }}>Concluir devolução</button>
                </div>}
                {podeConcluir(d) && aberta === d.protocolo && <form onSubmit={(ev) => {
                    ev.preventDefault();
                    if (!conferido || !referenciaValida(referencia)) return;
                    setOcupado(true);
                    setMensagem('');
                    void executar(() => chamar<{ estado: string; repetida: boolean }>('/api/desenvolvedor/creditos', 'POST', { acao: 'concluir_devolucao', protocolo: d.protocolo, referencia: referencia.trim() }), (r) => {
                        setOcupado(false);
                        if (!r.ok) { setMensagem(r.erro); return; }
                        setAberta(null);
                        setMensagem(r.data.repetida ? `A devolução ${d.protocolo} já estava concluída.` : `Devolução ${d.protocolo} concluída.`);
                        setVersao((v) => v + 1);
                    });
                }}>
                    <label>Referência da restituição (3 a 200 caracteres)
                        <input type="text" minLength={3} maxLength={200} required value={referencia} onChange={(ev) => setReferencia(ev.target.value)} placeholder="Ex.: id do estorno no Asaas ou do comprovante do Pix" />
                    </label>
                    <label><input type="checkbox" checked={conferido} onChange={(ev) => setConferido(ev.target.checked)} /> Conferi no Asaas que a restituição de {reais(d.valor_centavos)} foi feita</label>
                    <div className={workspace.actions}>
                        <button type="submit" disabled={ocupado || !conferido || !referenciaValida(referencia)}>{ocupado ? 'Concluindo…' : 'Confirmar conclusão'}</button>
                        <button type="button" disabled={ocupado} onClick={() => setAberta(null)}>Cancelar</button>
                    </div>
                </form>}
            </article>)}
            {mensagem && <p role="status">{mensagem}</p>}
        </section>}
        {dialogo}
    </main>;
}
