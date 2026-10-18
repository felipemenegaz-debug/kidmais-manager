'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData } from './cliente';
import { useReautenticacao } from './Reautenticacao';

type Pendente = {
    id: string; criadoEm: string; enviadoEm: string | null; recebidoEm: string | null; origem: 'CLIENTE' | 'BUFFET'; classe: string; diagnostico: string | null;
    evidencia: { diagnostico?: string; requestId?: string; etapa?: string; categorias?: string[] }; modelo: string; reservaMicrousd: string; imagemRetida: boolean;
    festaId: string; empresaId: string; empresaNome: string;
};
type Automatica = { id: string; estado: string; criadoEm: string; classe: string | null; diagnostico: string | null; empresaNome: string };
type Decisao = { id: string; resultado: string; em: string; evidencia: string; resolvedor: string | null; empresaNome: string; criadoEm: string; classe: string | null };
type Fila = { pendentes: Pendente[]; automaticas: Automatica[]; decisoes: Decisao[]; limites: string[] };
type Resultado = 'COBRANCA_CONFIRMADA' | 'SEM_COBRANCA';

export const CLASSE_FALHA: Record<string, string> = {
    RESPOSTA_PROVEDOR: 'Resposta explícita do provedor (erro HTTP)',
    DESCONHECIDA: 'Resultado desconhecido depois de um possível envio',
    ARMAZENAMENTO: 'Imagem recebida, mas o processamento ou a gravação local falhou',
    PRE_ENVIO: 'Falha antes do envio',
    DEVOLUCAO_FALHOU: 'Não enviada, mas a devolução automática não fechou (contadores divergentes). Corrija os contadores com autorização antes de registrar "sem cobrança"',
    SEM_CLASSE: 'Anterior à classificação automática (evidência só no evento)',
};
const SITUACAO_AUTOMATICA: Record<string, string> = { NAO_ENVIADA: 'Não enviada: reservas devolvidas automaticamente', CONCLUIDA: 'Concluída com a imagem recebida, sem nova chamada' };

/**
 * Painel do desenvolvedor: gerações de IA de convites sem resultado confirmado. A decisão financeira é só daqui
 * (buffet e cliente veem "Estamos verificando"); exige evidência, senha recente e fica auditada. Nada consulta o provedor.
 */
export default function GeracoesConvites() {
    const { executar, dialogo } = useReautenticacao();
    const [fila, setFila] = useState<Fila | null>(null);
    const [erro, setErro] = useState('');
    const [versao, setVersao] = useState(0);
    const [aberta, setAberta] = useState<string | null>(null);
    const [evidencia, setEvidencia] = useState('');
    const [resultado, setResultado] = useState<Resultado | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const [mensagem, setMensagem] = useState('');
    useEffect(() => {
        let vivo = true;
        chamar<Fila>('/api/desenvolvedor/convites/geracoes').then((r) => {
            if (!vivo) return;
            if (r.ok) { setFila(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [versao]);

    return <main className={admin.page}>
        <div className={estilos.cabecalho}><div><p className={estilos.sobretitulo}>Operação</p><h1>Gerações de convites</h1></div></div>
        <p className={workspace.muted}>Gerações de imagem que terminaram sem resultado confirmado. O buffet e o cliente veem apenas &ldquo;Estamos verificando sua geração&rdquo; e a festa fica protegida contra nova cobrança até a decisão. Confira o uso e os custos no painel da OpenAI (ou com o suporte, pelo identificador da geração) antes de decidir.</p>
        {erro && <p role="alert">{erro}</p>}
        {!fila && !erro && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {fila && <>
            <section className={workspace.card} aria-labelledby="t-geracoes-pendentes">
                <h2 id="t-geracoes-pendentes">Em verificação ({fila.pendentes.length})</h2>
                {fila.pendentes.length === 0 && <p className={workspace.muted}>Nenhuma geração aguardando decisão.</p>}
                {fila.pendentes.map((g) => <article key={g.id} className={workspace.card} aria-label={`Geração ${g.id}`}>
                    <p><strong>{g.empresaNome}</strong> · festa <code>{g.festaId}</code></p>
                    <p>Geração <code>{g.id}</code> · iniciada pelo {g.origem === 'CLIENTE' ? 'cliente' : 'buffet'} · {g.modelo}</p>
                    <ul>
                        <li>Classe: {CLASSE_FALHA[g.classe] ?? g.classe}</li>
                        <li>Diagnóstico: {g.diagnostico ?? g.evidencia.diagnostico ?? '—'}{g.evidencia.etapa ? ` · moderação na etapa ${g.evidencia.etapa}` : ''}{g.evidencia.categorias?.length ? ` · categorias: ${g.evidencia.categorias.join(', ')}` : ''}</li>
                        {/* Antes da 084 as etapas não eram gravadas: ausência de registro não significa "não enviada". */}
                        <li>Pedido em {formatarData(g.criadoEm)} · {g.classe === 'SEM_CLASSE' ? 'envio e recebimento não eram registrados nesta versão' : <>envio {g.enviadoEm ? formatarData(g.enviadoEm) : 'não registrado'} · imagem recebida {g.recebidoEm ? formatarData(g.recebidoEm) : 'não registrada'}</>}{g.imagemRetida ? ' (retida para conferência)' : ''}</li>
                        <li>Identificadores para o suporte: {g.classe !== 'SEM_CLASSE' && g.modelo.startsWith('gpt-image') ? <>X-Client-Request-Id <code>{g.id}</code></> : 'X-Client-Request-Id não enviado'}{g.evidencia.requestId ? <> · x-request-id <code>{g.evidencia.requestId}</code></> : null}</li>
                        <li>Reserva mantida: 1 crédito da festa e da empresa e {(Number(g.reservaMicrousd) / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' })} do orçamento diário</li>
                    </ul>
                    {aberta !== g.id && <div className={workspace.actions}>
                        {g.imagemRetida && <button type="button" disabled={ocupado} onClick={() => {
                            setOcupado(true); setMensagem('');
                            void executar(() => chamar<{ estado: string }>('/api/desenvolvedor/convites/geracoes', 'POST', { acao: 'concluir_com_imagem', geracaoId: g.id }), (r) => {
                                setOcupado(false);
                                if (!r.ok) { setMensagem(r.erro); return; }
                                setMensagem('Arte entregue com a imagem já recebida, sem nova chamada; o crédito continua consumido.');
                                setVersao((v) => v + 1);
                            });
                        }}>Concluir com a imagem recebida</button>}
                        <button type="button" onClick={() => { setAberta(g.id); setEvidencia(''); setResultado(null); setMensagem(''); }}>Registrar decisão</button>
                    </div>}
                    {aberta === g.id && <form onSubmit={(ev) => {
                        ev.preventDefault();
                        if (!resultado) return;
                        setOcupado(true);
                        setMensagem('');
                        void executar(() => chamar<{ estado: string; liberouReserva: boolean }>('/api/desenvolvedor/convites/geracoes', 'POST', { acao: 'decidir', geracaoId: g.id, resultado, evidencia }), (r) => {
                            setOcupado(false);
                            if (!r.ok) { setMensagem(r.erro); return; }
                            setAberta(null);
                            setMensagem(r.data.liberouReserva ? 'Sem cobrança registrada: as reservas originais foram devolvidas uma vez.' : 'Cobrança registrada: o crédito continua consumido.');
                            setVersao((v) => v + 1);
                        });
                    }}>
                        <fieldset>
                            <legend>Resultado da conferência</legend>
                            <label><input type="radio" name={`resultado-${g.id}`} checked={resultado === 'COBRANCA_CONFIRMADA'} onChange={() => setResultado('COBRANCA_CONFIRMADA')} /> Cobrança confirmada · manter o crédito consumido</label>
                            <label><input type="radio" name={`resultado-${g.id}`} checked={resultado === 'SEM_COBRANCA'} onChange={() => setResultado('SEM_COBRANCA')} /> Sem cobrança comprovada · devolver as reservas</label>
                        </fieldset>
                        <label>Fonte e evidência (10 a 1000 caracteres)
                            <textarea rows={3} minLength={10} maxLength={1000} required value={evidencia} onChange={(ev) => setEvidencia(ev.target.value)} placeholder="Ex.: painel de uso da OpenAI, 18/10/2026 14:00–14:05, projeto e chave da IA de convites; resposta do suporte para o X-Client-Request-Id." />
                        </label>
                        <p className={workspace.muted}>Timeout, moderation_blocked ou &ldquo;No usage data&rdquo;, sozinhos, não comprovam ausência de cobrança.</p>
                        <div className={workspace.actions}>
                            <button type="submit" disabled={ocupado || !resultado || evidencia.trim().length < 10}>{ocupado ? 'Registrando…' : 'Confirmar decisão'}</button>
                            <button type="button" disabled={ocupado} onClick={() => setAberta(null)}>Cancelar</button>
                        </div>
                    </form>}
                </article>)}
                {mensagem && <p role="status">{mensagem}</p>}
            </section>
            <section className={workspace.card} aria-labelledby="t-geracoes-automaticas">
                <h2 id="t-geracoes-automaticas">Tratadas automaticamente (30 dias)</h2>
                {fila.automaticas.length === 0 ? <p className={workspace.muted}>Nenhuma.</p> : <ul>{fila.automaticas.map((g) => <li key={g.id}>
                    {formatarData(g.criadoEm)} · {g.empresaNome} · <code>{g.id}</code> · {SITUACAO_AUTOMATICA[g.estado] ?? g.estado}{g.diagnostico ? ` (${g.diagnostico})` : ''}
                </li>)}</ul>}
            </section>
            <section className={workspace.card} aria-labelledby="t-geracoes-decisoes">
                <h2 id="t-geracoes-decisoes">Decisões anteriores</h2>
                {fila.decisoes.length === 0 ? <p className={workspace.muted}>Nenhuma decisão registrada.</p> : <ul>{fila.decisoes.map((d) => <li key={d.id}>
                    {formatarData(d.em)} · {d.empresaNome} · <code>{d.id}</code> · {d.resultado === 'COBRANCA_CONFIRMADA' ? 'cobrança confirmada; crédito mantido' : 'sem cobrança; reservas devolvidas'} · {d.resolvedor ?? 'usuário'}<br />Evidência: {d.evidencia}
                </li>)}</ul>}
            </section>
            <section className={workspace.card} aria-labelledby="t-geracoes-limites">
                <h2 id="t-geracoes-limites">Limites da recuperação automática</h2>
                <ul>{fila.limites.map((l) => <li key={l}>{l}</li>)}</ul>
                <p className={workspace.muted}>Automático só quando há prova: sem envio registrado, as reservas voltam; com a imagem recebida e guardada, a arte é concluída sem nova chamada. O resto fica nesta fila.</p>
            </section>
        </>}
        {dialogo}
    </main>;
}
