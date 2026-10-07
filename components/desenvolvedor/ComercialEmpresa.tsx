'use client';
import { useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, rotuloAcao, type Resposta } from './cliente';

/** Situação comercial na ficha da empresa (E5). Intervenções exigem motivo, prazo e senha (reautenticação no servidor). */
export type Comercial = {
    instalado: boolean; cobrado: boolean; situacao: string | null; nivel: string; motivo: string; ate: string | null; testeFim: string | null; periodoAtualFim: string | null;
    ciclo: string | null; testeInicio: string | null; emAtrasoDesde: string | null; versao: number | null;
    excecoes: { id: string; tipo: string; validaAte: string; motivo: string; criadoEm: string; criadoPor: string | null; revogadaEm: string | null; motivoRevogacao: string | null; vigente: boolean }[];
    eventos: { tipo: string; situacao: string; recebidoEm: string; processadoEm: string | null; tentativas: number }[];
    historico: { id: string; acao: string; criado_em: string; ator: string | null; justificativa: string | null }[];
};
const SITUACAO: Record<string, string> = { TESTE: 'Teste grátis', ATIVA: 'Assinatura ativa', EM_ATRASO: 'Pagamento pendente', CANCELADA_FIM_PERIODO: 'Cancelada no fim do período', ENCERRADA: 'Encerrada' };
const NIVEL: Record<string, string> = { COMPLETO: 'Completo', SOMENTE_LEITURA: 'Somente leitura', BLOQUEADO: 'Bloqueado' };
const EXCECAO: Record<string, string> = { EXTENSAO_TESTE: 'Extensão de teste', CORTESIA: 'Cortesia', ACESSO_TEMPORARIO: 'Acesso temporário' };
export function rotuloComercial(c: Pick<Comercial, 'instalado' | 'cobrado' | 'situacao' | 'nivel'>) {
    if (!c.instalado || !c.cobrado) return 'Sem cobrança';
    return `${SITUACAO[c.situacao ?? ''] ?? c.situacao} · ${NIVEL[c.nivel] ?? c.nivel}`;
}

type Operacao = { operacao: 'estender-teste'; dias: number; motivo: string } | { operacao: 'conceder-excecao'; tipo: 'CORTESIA' | 'ACESSO_TEMPORARIO'; dias: number; motivo: string } | { operacao: 'revogar-excecao'; excecaoId: string; motivo: string };

export default function ComercialEmpresa({ empresaId, comercial, ocupado, operar }: {
    empresaId: string; comercial: Comercial; ocupado: boolean;
    operar: (op: () => Promise<Resposta<{ operacao: string }>>, sucesso: (d: { operacao: string }) => { tipo: 'ok' | 'alerta'; texto: string }) => void;
}) {
    const [form, setForm] = useState<{ acao: 'estender-teste' | 'CORTESIA' | 'ACESSO_TEMPORARIO'; dias: string; motivo: string } | null>(null);
    const [revogar, setRevogar] = useState<{ id: string; motivo: string } | null>(null);
    const base = `/api/desenvolvedor/empresas/${empresaId}`;
    const enviar = (dados: Operacao, texto: string) => operar(() => chamar<{ operacao: string }>(base, 'POST', { acao: 'comercial', dados }), () => ({ tipo: 'ok', texto }));
    const c = comercial;
    return <section className={workspace.card} aria-labelledby="t-comercial">
        <h2 id="t-comercial">Situação comercial</h2>
        {!c.instalado ? <p className={workspace.muted}>O modelo comercial (067) não está instalado neste ambiente: a empresa opera sem cobrança.</p>
            : !c.cobrado ? <p className={workspace.muted}>Sem cobrança: empresa sem assinatura registrada (acesso completo). Só o cadastro público cria a assinatura, em teste.</p>
                : <>
                    <dl className={estilos.ficha}>
                        <div><dt>Situação</dt><dd>{rotuloComercial(c)}{c.ate ? ` até ${formatarData(c.ate, false)}` : ''}</dd></div>
                        <div><dt>Plano</dt><dd>Único{c.ciclo ? ` · ${c.ciclo === 'MENSAL' ? 'mensal' : 'anual'}` : ''}</dd></div>
                        <div><dt>Teste grátis</dt><dd>{formatarData(c.testeInicio, false)} a {formatarData(c.testeFim, false)}</dd></div>
                        {c.periodoAtualFim && <div><dt>Período pago até</dt><dd>{formatarData(c.periodoAtualFim, false)}</dd></div>}
                        {c.emAtrasoDesde && <div><dt>Pendente desde</dt><dd>{formatarData(c.emAtrasoDesde, false)}</dd></div>}
                    </dl>
                    <div className={estilos.acoesLinha} style={{ marginTop: 12 }}>
                        {c.situacao === 'TESTE' && <button type="button" disabled={ocupado} onClick={() => setForm({ acao: 'estender-teste', dias: '7', motivo: '' })}>Estender teste</button>}
                        <button type="button" disabled={ocupado} onClick={() => setForm({ acao: 'CORTESIA', dias: '30', motivo: '' })}>Conceder acesso excepcional</button>
                    </div>
                    {form && <form aria-label="Intervenção comercial" onSubmit={(e) => {
                        e.preventDefault();
                        const dias = Number(form.dias);
                        if (form.acao === 'estender-teste') enviar({ operacao: 'estender-teste', dias, motivo: form.motivo }, `Teste estendido em ${dias} dia(s).`);
                        else enviar({ operacao: 'conceder-excecao', tipo: form.acao, dias, motivo: form.motivo }, `Exceção concedida: ${EXCECAO[form.acao]} por ${dias} dia(s).`);
                        setForm(null);
                    }}>
                        {form.acao !== 'estender-teste' && <label>Tipo<select value={form.acao} onChange={(e) => setForm({ ...form, acao: e.target.value as 'CORTESIA' | 'ACESSO_TEMPORARIO' })}>
                            <option value="CORTESIA">Cortesia</option><option value="ACESSO_TEMPORARIO">Acesso temporário</option></select></label>}
                        <label>Prazo em dias<input type="number" min={1} max={form.acao === 'estender-teste' ? 60 : 365} required value={form.dias} onChange={(e) => setForm({ ...form, dias: e.target.value })} /></label>
                        <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} /></label>
                        <p className={workspace.muted}>Não concede papel, vínculo nem acesso de desenvolvedor: só muda a situação comercial desta empresa. Sua senha será pedida.</p>
                        <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Confirmar</button><button type="button" onClick={() => setForm(null)}>Cancelar</button></div>
                    </form>}
                </>}
        {c.excecoes.length > 0 && <>
            <h3>Exceções</h3>
            <ul className={estilos.lista} aria-label="Exceções comerciais">
                {c.excecoes.map((x) => <li key={x.id}>
                    <strong>{EXCECAO[x.tipo] ?? x.tipo} até {formatarData(x.validaAte, false)}{x.vigente ? '' : x.revogadaEm ? ' · revogada' : ' · vencida'}</strong>
                    <span>{x.motivo} · por {x.criadoPor ?? 'Sistema'} em {formatarData(x.criadoEm)}{x.motivoRevogacao ? ` · revogada: ${x.motivoRevogacao}` : ''}
                        {x.vigente && x.tipo !== 'EXTENSAO_TESTE' && <> · <button type="button" disabled={ocupado} onClick={() => setRevogar({ id: x.id, motivo: '' })}>Revogar</button></>}</span>
                </li>)}
            </ul>
            {revogar && <form aria-label="Revogar exceção" onSubmit={(e) => {
                e.preventDefault();
                enviar({ operacao: 'revogar-excecao', excecaoId: revogar.id, motivo: revogar.motivo }, 'Exceção revogada.');
                setRevogar(null);
            }}>
                <label>Motivo da revogação<textarea required minLength={5} maxLength={500} value={revogar.motivo} onChange={(e) => setRevogar({ ...revogar, motivo: e.target.value })} /></label>
                <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Revogar</button><button type="button" onClick={() => setRevogar(null)}>Cancelar</button></div>
            </form>}
        </>}
        {c.eventos.length > 0 && <>
            <h3>Eventos do provedor</h3>
            <ul className={estilos.lista} aria-label="Eventos de cobrança">{c.eventos.map((ev, i) => <li key={i}><strong>{ev.tipo}</strong><span>{ev.situacao} · recebido {formatarData(ev.recebidoEm)}{ev.tentativas > 0 ? ` · ${ev.tentativas} tentativa(s)` : ''}</span></li>)}</ul>
        </>}
        <h3>Histórico comercial</h3>
        {c.historico.length === 0 ? <p className={workspace.muted}>Nenhuma intervenção registrada.</p>
            : <ul className={estilos.lista} aria-label="Histórico comercial">{c.historico.map((h) => <li key={h.id}><strong>{rotuloAcao(h.acao)}</strong><span>{formatarData(h.criado_em)} · {h.ator ?? 'Sistema'}{h.justificativa ? ` · ${h.justificativa}` : ''}</span></li>)}</ul>}
    </section>;
}
