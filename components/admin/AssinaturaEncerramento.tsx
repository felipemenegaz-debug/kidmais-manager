'use client';
import { useEffect, useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { reais, type DadosAssinatura } from './Assinatura';
import { dataCurta } from './AvisoComercial';

/**
 * Cancelamento e devolução na tela Assinatura (L1, 21/10/2026; Decreto 7.962/2013: o arrependimento é exercido pela
 * mesma ferramenta da contratação). Só a Gestão. O histórico de protocolos carrega sozinho (sem consultar o provedor);
 * as opções e os valores são calculados pelo servidor quando a pessoa pede (a cobrança paga é lida no provedor).
 * O navegador nunca informa o valor: só confirma o que viu (`valorEsperadoCentavos`); se mudou, o servidor recusa.
 */
type Calculo = { diasCiclo: number; diasUtilizados: number; diasNaoUtilizados: number; valorCentavos: number };
type Opcao = { disponivel: true; valorCentavos: number; valorPagoCentavos: number; prazoProcessamento: string; ate: string | null; calculo: Calculo | null } | { disponivel: false; motivo: string };
type Tipo = 'CANCELAMENTO_FIM_PERIODO' | 'ARREPENDIMENTO_7_DIAS' | 'ENCERRAMENTO_ANUAL_PROPORCIONAL';
export type PedidoEncerramento = {
    protocolo: string; tipo: Tipo; solicitadoEm: string; valorDevolucaoCentavos: number | null; prazoProcessamento: string | null;
    acessoPagoEncerradoEm: string | null; cancelamentoProvedor: string; estorno: string; email: string; repetido?: boolean;
};
type Consulta = {
    instalado: boolean; estornoAutomatico: boolean; situacao: string | null; ciclo: 'MENSAL' | 'ANUAL' | null; formaPagamento: string | null;
    opcoes: { arrependimento: Opcao; anualProporcional: Opcao } | null; pedidos: PedidoEncerramento[];
};

export const TIPO: Record<Tipo, string> = {
    CANCELAMENTO_FIM_PERIODO: 'Cancelamento da renovação',
    ARREPENDIMENTO_7_DIAS: 'Arrependimento em 7 dias (devolução integral)',
    ENCERRAMENTO_ANUAL_PROPORCIONAL: 'Encerramento antecipado do anual (devolução proporcional)',
};
const ESTORNO: Record<string, string> = {
    NAO_SE_APLICA: 'Sem devolução',
    AGUARDANDO_MANUAL: 'Devolução registrada: em processamento pela equipe Kidmais',
    EM_CURSO: 'Devolução em andamento',
    SOLICITADO: 'Devolução enviada ao provedor de pagamento',
    SEM_CONFIRMACAO: 'Devolução em conferência pela equipe Kidmais',
    RECUSADO: 'Devolução em processamento pela equipe Kidmais',
    CONCLUIDO: 'Devolução concluída',
};
const INDISPONIVEL: Record<string, string> = {
    GARANTIA_ENCERRADA: 'O prazo de 7 dias da primeira ativação paga já terminou.',
    NAO_E_PRIMEIRA_ATIVACAO: 'A garantia de 7 dias vale só na primeira ativação paga da empresa.',
    SOMENTE_ANUAL: 'No plano mensal, depois dos 7 dias, o acesso continua até o fim do ciclo pago, sem devolução.',
    GARANTIA_PREVALECE: 'Enquanto vale a garantia de 7 dias, a devolução é integral (opção acima).',
    SEM_PAGAMENTO_CONFIRMADO: 'Ainda não há pagamento confirmado pelo provedor.',
    VALOR_PAGO_DESCONHECIDO: 'Não foi possível confirmar o valor pago. Fale com o atendimento.',
    PEDIDO_JA_REGISTRADO: 'Já existe um pedido de devolução para este pagamento.',
    SEM_PERIODO_PAGO_VIGENTE: 'Não há período pago vigente.',
    PERIODO_TERMINADO: 'O período pago já terminou.',
    SEM_DIAS_NAO_UTILIZADOS: 'Não há dias a devolver.',
};
const dataIso = (d: string) => d.split('-').reverse().join('/');
const novaChave = () => globalThis.crypto?.randomUUID?.() ?? '';

async function pedir<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; erro: string; codigo: string | null; detalhes: Record<string, unknown> | null }> {
    try {
        const r = await adminFetch(url, init);
        const j = await r.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string; codigo?: string; detalhes?: Record<string, unknown> } | null;
        return r.ok && j?.ok ? { ok: true, data: j.data as T } : { ok: false, erro: j?.erro ?? `Não foi possível concluir (HTTP ${r.status}).`, codigo: j?.codigo ?? null, detalhes: j?.detalhes ?? null };
    }
    catch {
        return { ok: false, erro: 'Falha de conexão. Confira a situação antes de repetir.', codigo: null, detalhes: null };
    }
}

/** Confirmação imediata com protocolo (também usada pelo cancelamento ao fim do período). */
export function ConfirmacaoProtocolo({ pedido, periodoFim }: { pedido: PedidoEncerramento; periodoFim?: string | null }) {
    return <div role="status" data-protocolo={pedido.protocolo} style={{ border: '1px solid currentColor', borderRadius: 12, padding: 12 }}>
        <p style={{ marginTop: 0 }}><strong>Pedido registrado.</strong> Protocolo: <strong>{pedido.protocolo}</strong> ({TIPO[pedido.tipo]}).</p>
        {pedido.tipo === 'CANCELAMENTO_FIM_PERIODO'
            ? <p>A assinatura não será renovada. O acesso completo continua até {periodoFim ? dataCurta(periodoFim) : 'o fim do período pago'}.</p>
            : <>
                <p>O acesso pago foi encerrado agora; a empresa fica em somente leitura por 60 dias, com exportação dos dados. Nada é apagado.</p>
                <p>Valor a devolver: <strong>{reais(pedido.valorDevolucaoCentavos ?? 0)}</strong>. {pedido.tipo === 'ARREPENDIMENTO_7_DIAS'
                    ? 'A restituição é iniciada de imediato, sem desconto de taxas.'
                    : `O processamento começa até ${pedido.prazoProcessamento ? dataIso(pedido.prazoProcessamento) : 'o 5º dia útil'}.`} O crédito depende do meio de pagamento. {ESTORNO[pedido.estorno] ?? ''}.</p>
            </>}
        <p style={{ marginBottom: 0 }} className={workspace.muted}>{pedido.email === 'ENVIADO' ? 'Enviamos a confirmação para o seu e-mail.' : 'Guarde o protocolo: a confirmação por e-mail não pôde ser enviada agora.'} Dúvidas: contato@demerzellabs.com.br.</p>
    </div>;
}

export function EncerramentoComDevolucao({ dados, recarregar }: { dados: DadosAssinatura; recarregar: () => void }) {
    const [consulta, setConsulta] = useState<Consulta | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState('');
    const [escolha, setEscolha] = useState<{ tipo: Exclude<Tipo, 'CANCELAMENTO_FIM_PERIODO'>; valorCentavos: number } | null>(null);
    const [senha, setSenha] = useState('');
    const [motivo, setMotivo] = useState('');
    const [chave, setChave] = useState('');
    const [resultado, setResultado] = useState<PedidoEncerramento | null>(null);
    const a = dados.assinatura;
    const ativo = Boolean(dados.gestao && dados.cobranca?.vinculada);

    useEffect(() => {
        if (!ativo) return;
        let vivo = true;
        void pedir<Consulta>('/api/admin/assinatura/devolucao').then((r) => { if (vivo && r.ok) setConsulta(r.data); });
        return () => { vivo = false; };
    }, [ativo, dados.agora]);

    if (!ativo || !a || !consulta?.instalado)
        return null;
    const podePedir = dados.cobranca?.disponivel && (a.situacao === 'ATIVA' || a.situacao === 'CANCELADA_FIM_PERIODO');

    async function verOpcoes() {
        setOcupado(true); setErro(''); setResultado(null);
        const r = await pedir<Consulta>('/api/admin/assinatura/devolucao?opcoes=1');
        setOcupado(false);
        if (!r.ok) { setErro(r.erro); return; }
        setConsulta(r.data);
    }

    async function confirmar() {
        if (!escolha) return;
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
            const r = await pedir<PedidoEncerramento>('/api/admin/assinatura/devolucao', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tipo: escolha.tipo, confirmar: true, chave, valorEsperadoCentavos: escolha.valorCentavos, motivo: motivo.trim() }) });
            if (!r.ok) {
                setErro(r.erro);
                // Valor mudou (virou o dia) ou opção indisponível: a pessoa revê as opções antes de confirmar de novo.
                if (r.codigo === 'OFERTA_ALTERADA' || r.codigo === 'CONFLITO') { setEscolha(null); setChave(''); void verOpcoes(); }
                else setChave(novaChave()); // nova tentativa = chave nova (a mesma chave só devolve o pedido já registrado)
                return;
            }
            setResultado(r.data); setEscolha(null); setMotivo(''); setChave('');
            recarregar();
        }
        finally {
            setSenha('');
            setOcupado(false);
        }
    }

    const opcoes = consulta.opcoes;
    const cartao = (tipo: Exclude<Tipo, 'CANCELAMENTO_FIM_PERIODO'>, o: Opcao, texto: string) => o.disponivel
        ? <div key={tipo} data-opcao={tipo} style={{ borderTop: '1px solid rgba(127,127,127,.3)', paddingTop: 8 }}>
            <p><strong>{TIPO[tipo]}</strong>: {reais(o.valorCentavos)}. {texto}</p>
            {o.calculo && <p className={workspace.muted}>Cálculo: {reais(o.valorPagoCentavos)} pagos × {o.calculo.diasNaoUtilizados} dias não utilizados ÷ {o.calculo.diasCiclo} dias do ciclo = {reais(o.valorCentavos)} ({o.calculo.diasUtilizados} dias utilizados; o dia de hoje não é cobrado).</p>}
            {o.ate && tipo === 'ARREPENDIMENTO_7_DIAS' && <p className={workspace.muted}>Disponível até {dataCurta(new Date(Date.parse(o.ate) - 1).toISOString())}.</p>}
            <button type="button" className="danger" disabled={ocupado} onClick={() => { setEscolha({ tipo, valorCentavos: o.valorCentavos }); setChave(novaChave()); setErro(''); }}>
                Encerrar e pedir {reais(o.valorCentavos)}…</button>
        </div>
        : <p key={tipo} className={workspace.muted} data-opcao-indisponivel={tipo}>{TIPO[tipo]}: {INDISPONIVEL[o.motivo] ?? 'Indisponível.'}</p>;

    return <section className={workspace.card} aria-labelledby="t-devolucao" style={{ maxWidth: 720 }} data-encerramento>
        <h2 id="t-devolucao">Cancelamento e devolução</h2>
        <p className={workspace.muted}>Você pode cancelar a renovação a qualquer momento, sem multa. Nos primeiros 7 dias da primeira ativação paga, devolvemos integralmente o valor pago, inclusive para CNPJ.
            Depois disso, no mensal o acesso continua até o fim do ciclo pago, sem devolução; no anual, você pode manter até o fim ou encerrar antes com devolução proporcional aos dias não utilizados, sobre o valor efetivamente pago (o desconto Fundador não é cobrado de volta).</p>
        {erro && <p role="alert">{erro}</p>}
        {resultado && <ConfirmacaoProtocolo pedido={resultado} />}
        {podePedir && !opcoes && !resultado && <p><button type="button" disabled={ocupado} onClick={() => void verOpcoes()}>{ocupado ? 'Calculando…' : 'Ver opções de encerramento com devolução'}</button></p>}
        {podePedir && opcoes && !escolha && !resultado && <div data-opcoes>
            {cartao('ARREPENDIMENTO_7_DIAS', opcoes.arrependimento, 'Restituição iniciada de imediato, sem desconto de taxas. O acesso pago termina agora.')}
            {cartao('ENCERRAMENTO_ANUAL_PROPORCIONAL', opcoes.anualProporcional, 'O acesso pago termina agora e o processamento começa em até 5 dias úteis.')}
            {consulta.formaPagamento === 'BOLETO' && <p className={workspace.muted}>Pagamento por boleto: a equipe pode pedir dados bancários para a devolução.</p>}
        </div>}
        {escolha && <form onSubmit={(e) => { e.preventDefault(); if (senha) void confirmar(); }} data-confirmar-devolucao>
            <p><strong>{TIPO[escolha.tipo]}: {reais(escolha.valorCentavos)}.</strong> Ao confirmar, o acesso pago termina agora e a empresa passa a somente leitura por 60 dias (consulta e exportação). Nada é apagado.
                Esta ação não pode ser desfeita pela tela; para voltar a usar, será preciso contratar de novo.</p>
            <label>Motivo (opcional)<input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></label>
            <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
            <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button type="submit" className="danger" disabled={ocupado || !senha}>{ocupado ? 'Registrando…' : 'Confirmar encerramento e devolução'}</button>
                <button type="button" disabled={ocupado} onClick={() => { setEscolha(null); setSenha(''); setChave(''); }}>Voltar</button>
            </p>
        </form>}
        {consulta.pedidos.length > 0 && <div data-pedidos>
            <h3>Pedidos registrados</h3>
            <ul>{consulta.pedidos.map((p) => <li key={p.protocolo}>
                <strong>{p.protocolo}</strong> — {TIPO[p.tipo]}, {dataCurta(p.solicitadoEm)}{p.valorDevolucaoCentavos ? `, ${reais(p.valorDevolucaoCentavos)}` : ''}. {ESTORNO[p.estorno] ?? p.estorno}.
            </li>)}</ul>
        </div>}
    </section>;
}
