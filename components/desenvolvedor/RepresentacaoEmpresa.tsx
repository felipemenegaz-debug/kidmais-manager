'use client';
import { useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, type Resposta } from './cliente';

/** Responsável, representação declarada, sócios declarados e pedidos de acesso (067/069) na ficha da empresa. */
export type Representacao = {
    instalada: boolean;
    representacoes: { id: string; pessoa: string; email: string; qualificacao: string; situacao: string; declarado_em: string; decidido_em: string | null; decidido_por: string | null; motivo_decisao: string | null }[];
    socios: { nome: string; qualificacao: string; criado_em: string }[];
    solicitacoes: { id: string; pessoa: string; email: string; situacao: string; criado_em: string; motivo_decisao: string | null }[];
};
const QUALIFICACAO: Record<string, string> = {
    SOCIO_ADMINISTRADOR: 'Sócio(a) administrador(a)', PROCURADOR: 'Procurador(a)', RESPONSAVEL_INDICADO: 'Responsável indicado(a)', SOCIO: 'Sócio(a)', ADMINISTRADOR: 'Administrador(a)',
};
const SITUACAO: Record<string, string> = { DECLARADA: 'Declarada (aguarda decisão)', APROVADA: 'Aprovada', RECUSADA: 'Recusada', REVOGADA: 'Revogada', PENDENTE: 'Pendente', ATENDIDA: 'Atendida' };
type Decisao = { alvo: 'representacao' | 'solicitacao'; id: string; decisao: string; rotulo: string };

export default function RepresentacaoEmpresa({ empresaId, dados, ocupado, operar }: {
    empresaId: string; dados: Representacao; ocupado: boolean;
    operar: (op: () => Promise<Resposta<{ situacao: string }>>, sucesso: (d: { situacao: string }) => { tipo: 'ok' | 'alerta'; texto: string }) => void;
}) {
    const [decidindo, setDecidindo] = useState<(Decisao & { motivo: string; evidencia: string }) | null>(null);
    if (!dados.instalada)
        return null;
    const iniciar = (d: Decisao) => setDecidindo({ ...d, motivo: '', evidencia: '' });
    return <section className={workspace.card} aria-labelledby="t-representacao">
        <h2 id="t-representacao">Representação e sócios</h2>
        <p className={workspace.muted}>Declarações feitas no cadastro. Dígitos de CNPJ corretos não comprovam quem representa a empresa; a decisão é da plataforma e não muda o acesso de ninguém.</p>
        {dados.representacoes.length === 0 ? <p className={workspace.muted}>Nenhuma representação declarada.</p>
            : <ul className={estilos.lista} aria-label="Representações">{dados.representacoes.map((r) => <li key={r.id}>
                <strong>{r.pessoa} · {QUALIFICACAO[r.qualificacao] ?? r.qualificacao} · {SITUACAO[r.situacao] ?? r.situacao}</strong>
                <span>{r.email} · declarada em {formatarData(r.declarado_em)}{r.decidido_em ? ` · ${r.decidido_por ?? 'Plataforma'} em ${formatarData(r.decidido_em)}: ${r.motivo_decisao ?? ''}` : ''}</span>
                <span className={estilos.acoesLinha}>
                    {r.situacao === 'DECLARADA' && <><button type="button" disabled={ocupado} onClick={() => iniciar({ alvo: 'representacao', id: r.id, decisao: 'APROVADA', rotulo: 'Aprovar representação' })}>Aprovar</button>
                        <button type="button" disabled={ocupado} onClick={() => iniciar({ alvo: 'representacao', id: r.id, decisao: 'RECUSADA', rotulo: 'Recusar representação' })}>Recusar</button></>}
                    {r.situacao === 'APROVADA' && <button type="button" disabled={ocupado} onClick={() => iniciar({ alvo: 'representacao', id: r.id, decisao: 'REVOGADA', rotulo: 'Revogar representação' })}>Revogar</button>}
                </span>
            </li>)}</ul>}
        <h3>Sócios declarados</h3>
        {dados.socios.length === 0 ? <p className={workspace.muted}>Nenhum sócio declarado.</p>
            : <ul className={estilos.lista} aria-label="Sócios declarados">{dados.socios.map((s, i) => <li key={i}><strong>{s.nome}</strong><span>{QUALIFICACAO[s.qualificacao] ?? s.qualificacao} · declarado em {formatarData(s.criado_em, false)}</span></li>)}</ul>}
        {dados.solicitacoes.length > 0 && <>
            <h3>Pedidos de acesso</h3>
            <p className={workspace.muted}>Pessoas que tentaram cadastrar este CNPJ. Para atender, envie um convite pela seção Convites e marque como atendido.</p>
            <ul className={estilos.lista} aria-label="Pedidos de acesso">{dados.solicitacoes.map((s) => <li key={s.id}>
                <strong>{s.pessoa} · {SITUACAO[s.situacao] ?? s.situacao}</strong>
                <span>{s.email} · {formatarData(s.criado_em)}{s.motivo_decisao ? ` · ${s.motivo_decisao}` : ''}</span>
                {s.situacao === 'PENDENTE' && <span className={estilos.acoesLinha}>
                    <button type="button" disabled={ocupado} onClick={() => iniciar({ alvo: 'solicitacao', id: s.id, decisao: 'ATENDIDA', rotulo: 'Marcar pedido como atendido' })}>Atendido</button>
                    <button type="button" disabled={ocupado} onClick={() => iniciar({ alvo: 'solicitacao', id: s.id, decisao: 'RECUSADA', rotulo: 'Recusar pedido' })}>Recusar</button>
                </span>}
            </li>)}</ul>
        </>}
        {decidindo && <form aria-label={decidindo.rotulo} onSubmit={(e) => {
            e.preventDefault();
            const dados = { alvo: decidindo.alvo, id: decidindo.id, decisao: decidindo.decisao, motivo: decidindo.motivo, ...(decidindo.alvo === 'representacao' && decidindo.evidencia.trim() ? { evidencia: decidindo.evidencia } : {}) };
            operar(() => chamar<{ situacao: string }>(`/api/desenvolvedor/empresas/${empresaId}`, 'POST', { acao: 'representacao', dados }), () => ({ tipo: 'ok', texto: `${decidindo.rotulo}: registrado.` }));
            setDecidindo(null);
        }}>
            <h3>{decidindo.rotulo}</h3>
            <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={decidindo.motivo} onChange={(e) => setDecidindo({ ...decidindo, motivo: e.target.value })} /></label>
            {decidindo.alvo === 'representacao' && decidindo.decisao === 'APROVADA' && <label>Evidência conferida (opcional; descreva, não anexe documentos)<textarea maxLength={1000} value={decidindo.evidencia} onChange={(e) => setDecidindo({ ...decidindo, evidencia: e.target.value })} /></label>}
            <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Confirmar</button><button type="button" onClick={() => setDecidindo(null)}>Cancelar</button></div>
        </form>}
    </section>;
}
