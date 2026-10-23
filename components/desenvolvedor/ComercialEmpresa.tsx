'use client';
import { useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, rotuloAcao, textoResultadoArrependimento, type Resposta } from './cliente';

/** Situação comercial na ficha da empresa (E5). Intervenções exigem motivo, prazo e senha (reautenticação no servidor). */
export type Comercial = {
    instalado: boolean; cobrado: boolean; situacao: string | null; nivel: string; motivo: string; ate: string | null; testeFim: string | null; periodoAtualFim: string | null;
    ciclo: string | null; testeInicio: string | null; emAtrasoDesde: string | null; versao: number | null;
    excecoes: { id: string; tipo: string; validaAte: string; motivo: string; criadoEm: string; criadoPor: string | null; revogadaEm: string | null; motivoRevogacao: string | null; vigente: boolean }[];
    eventos: { tipo: string; situacao: string; recebidoEm: string; processadoEm: string | null; tentativas: number }[];
    historico: { id: string; acao: string; criado_em: string; ator: string | null; justificativa: string | null }[];
    continuidades?: { id: string; tipo: TipoContinuidade; situacao: string; documentoAnterior: string | null; documentoNovo: string | null; nomeNovo: string; instrumento: string;
        dataEfetiva: string; registradaEm: string; registradaPor: string | null; provedorConferidoEm: string | null; provedorNota: string | null }[];
    arrependimentos?: Arrependimento[];
};
type TipoContinuidade = 'RETIFICACAO' | 'MESMA_TITULARIDADE' | 'CESSAO';
type Arrependimento = { protocolo: string; canal: string; solicitadoEm: string; situacao: 'RECEBIDO' | 'RESTITUIDO' | 'NAO_APLICAVEL'; dentroDe7Dias: boolean | null;
    provedorDisponivel: boolean; intermediadorComunicadoEm: string | null; concluidoEm: string | null; valorRestituidoCentavos: number | null; emailConclusao?: string | null };
const CONTINUIDADE: Record<TipoContinuidade, string> = { RETIFICACAO: 'Retificação (mesmo tipo de documento)', MESMA_TITULARIDADE: 'CPF → CNPJ da mesma titularidade (empresário individual/MEI)', CESSAO: 'CPF → CNPJ de sociedade (cessão de posição contratual)' };
type FormContinuidade = { tipo: TipoContinuidade; documentoNovo: string; nomeNovo: string; instrumento: string; evidencias: string; dataEfetiva: string; motivo: string };
const SITUACAO: Record<string, string> = { TESTE: 'Teste grátis', ATIVA: 'Assinatura ativa', EM_ATRASO: 'Pagamento pendente', CANCELADA_FIM_PERIODO: 'Cancelada no fim do período', ENCERRADA: 'Encerrada' };
const NIVEL: Record<string, string> = { COMPLETO: 'Completo', SOMENTE_LEITURA: 'Somente leitura', BLOQUEADO: 'Bloqueado' };
const EXCECAO: Record<string, string> = { EXTENSAO_TESTE: 'Extensão de teste', CORTESIA: 'Cortesia', ACESSO_TEMPORARIO: 'Acesso temporário' };
export function rotuloComercial(c: Pick<Comercial, 'instalado' | 'cobrado' | 'situacao' | 'nivel'>) {
    if (!c.instalado || !c.cobrado) return 'Sem cobrança';
    return `${SITUACAO[c.situacao ?? ''] ?? c.situacao} · ${NIVEL[c.nivel] ?? c.nivel}`;
}

type Operacao = { operacao: 'iniciar-teste'; dias: number; motivo: string } | { operacao: 'estender-teste'; dias: number; motivo: string } | { operacao: 'conceder-excecao'; tipo: 'CORTESIA' | 'ACESSO_TEMPORARIO'; dias: number; motivo: string } | { operacao: 'revogar-excecao'; excecaoId: string; motivo: string }
    | ({ operacao: 'registrar-continuidade' } & FormContinuidade) | { operacao: 'concluir-continuidade'; continuidadeId: string; motivo: string }
    | { operacao: 'recuperar-vinculo'; assinaturaId: string; motivo: string }
    | { operacao: 'arrependimento-registrar'; chave: string; emailSolicitante: string; recebidoEm: string; referencia: string; motivo: string }
    | { operacao: 'arrependimento-comunicar'; protocolo: string; referencia: string; motivo: string }
    | { operacao: 'arrependimento-concluir'; protocolo: string; situacao: 'RESTITUIDO' | 'NAO_APLICAVEL'; referencia: string; valorCentavos: number | null; cobrancaIds: string[] | null; assinaturaId: string | null; motivo: string };

export default function ComercialEmpresa({ empresaId, comercial, ocupado, operar }: {
    empresaId: string; comercial: Comercial; ocupado: boolean;
    operar: (op: () => Promise<Resposta<{ operacao: string }>>, sucesso: (d: { operacao: string }) => { tipo: 'ok' | 'alerta'; texto: string }) => void;
}) {
    const [form, setForm] = useState<{ acao: 'estender-teste' | 'CORTESIA' | 'ACESSO_TEMPORARIO'; dias: string; motivo: string } | null>(null);
    const [inicio, setInicio] = useState<{ dias: string; motivo: string } | null>(null);
    const [revogar, setRevogar] = useState<{ id: string; motivo: string } | null>(null);
    const [continuidade, setContinuidade] = useState<FormContinuidade | null>(null);
    const [concluir, setConcluir] = useState<{ id: string; motivo: string } | null>(null);
    const [recuperar, setRecuperar] = useState<{ assinaturaId: string; motivo: string } | null>(null);
    const [registro, setRegistro] = useState<{ chave: string; emailSolicitante: string; recebidoEm: string; referencia: string; motivo: string } | null>(null);
    const [arrep, setArrep] = useState<{ protocolo: string; acao: 'comunicar' | 'RESTITUIDO' | 'NAO_APLICAVEL'; referencia: string; valor: string; cobranca: string; assinatura: string; motivo: string } | null>(null);
    const pendente = comercial.continuidades?.find((x) => x.situacao === 'PENDENTE_PROVEDOR');
    const base = `/api/desenvolvedor/empresas/${empresaId}`;
    const enviar = (dados: Operacao, texto: string | ((d: { operacao: string }) => { tipo: 'ok' | 'alerta'; texto: string })) =>
        operar(() => chamar<{ operacao: string }>(base, 'POST', { acao: 'comercial', dados }), (d) => (typeof texto === 'string' ? { tipo: 'ok', texto } : texto(d)));
    const c = comercial;
    return <section className={workspace.card} aria-labelledby="t-comercial">
        <h2 id="t-comercial">Situação comercial</h2>
        {!c.instalado ? <p className={workspace.muted}>O modelo comercial (067) não está instalado neste ambiente: a empresa opera sem cobrança.</p>
            : !c.cobrado ? <>
                <p className={workspace.muted}>Sem cobrança: empresa sem assinatura registrada (acesso completo, sem prazo). Sem assinatura a empresa não vê planos nem a condição Fundador.</p>
                <div className={estilos.acoesLinha}><button type="button" disabled={ocupado} onClick={() => setInicio({ dias: '15', motivo: '' })}>Iniciar teste grátis…</button></div>
                {inicio && <form aria-label="Iniciar teste grátis" onSubmit={(e) => {
                    e.preventDefault();
                    const dias = Number(inicio.dias);
                    enviar({ operacao: 'iniciar-teste', dias, motivo: inicio.motivo }, `Teste grátis iniciado por ${dias} dia(s).`);
                    setInicio(null);
                }}>
                    <label>Duração do teste em dias (1 a 90)<input type="number" min={1} max={90} required value={inicio.dias} onChange={(e) => setInicio({ ...inicio, dias: e.target.value })} /></label>
                    <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={inicio.motivo} onChange={(e) => setInicio({ ...inicio, motivo: e.target.value })} /></label>
                    <p className={workspace.muted}>Cria a assinatura em teste com o CPF ou CNPJ do cadastro (CPF só quando a contratação por CPF estiver ligada) e não tem volta: acesso completo até o fim do teste, depois somente leitura até a contratação. Com a venda ligada, a Gestão escolhe o plano pela tela (Fundador se houver vaga). Sua senha será pedida.</p>
                    <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Confirmar</button><button type="button" onClick={() => setInicio(null)}>Cancelar</button></div>
                </form>}
            </>
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
                        {!pendente && <button type="button" disabled={ocupado} onClick={() => setContinuidade({ tipo: 'MESMA_TITULARIDADE', documentoNovo: '', nomeNovo: '', instrumento: '', evidencias: '', dataEfetiva: '', motivo: '' })}>Continuidade de documento…</button>}
                    </div>
                    {continuidade && <form aria-label="Continuidade de documento" onSubmit={(e) => {
                        e.preventDefault();
                        enviar({ operacao: 'registrar-continuidade', ...continuidade }, 'Continuidade de documento registrada.');
                        setContinuidade(null);
                    }}>
                        <label>Tipo<select value={continuidade.tipo} onChange={(e) => setContinuidade({ ...continuidade, tipo: e.target.value as TipoContinuidade })}>
                            {(Object.keys(CONTINUIDADE) as TipoContinuidade[]).map((t) => <option key={t} value={t}>{CONTINUIDADE[t]}</option>)}</select></label>
                        <label>CPF ou CNPJ novo<input required maxLength={40} value={continuidade.documentoNovo} onChange={(e) => setContinuidade({ ...continuidade, documentoNovo: e.target.value })} /></label>
                        <label>Nome civil (CPF) ou razão social (CNPJ)<input required minLength={2} maxLength={200} value={continuidade.nomeNovo} onChange={(e) => setContinuidade({ ...continuidade, nomeNovo: e.target.value })} /></label>
                        <label>Instrumento assinado (identificação e versão)<input required minLength={5} maxLength={300} value={continuidade.instrumento} onChange={(e) => setContinuidade({ ...continuidade, instrumento: e.target.value })} /></label>
                        <label>Evidências do vínculo conferidas<textarea required minLength={5} maxLength={1000} value={continuidade.evidencias} onChange={(e) => setContinuidade({ ...continuidade, evidencias: e.target.value })} /></label>
                        <label>Data efetiva (hoje ou anterior)<input type="date" required max={new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })} value={continuidade.dataEfetiva} onChange={(e) => setContinuidade({ ...continuidade, dataEfetiva: e.target.value })} /></label>
                        <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={continuidade.motivo} onChange={(e) => setContinuidade({ ...continuidade, motivo: e.target.value })} /></label>
                        <p className={workspace.muted}>Preserva o preço contratado, o benefício Fundador e suas datas originais, sem novo teste nem novo período. A troca vale a partir do registro (aplicação imediata): registre na data efetiva do instrumento, nunca antes. O documento novo passa a valer na ficha, no checkout e no Perfil; os registros anteriores não são reescritos. A contratação fica bloqueada até você registrar a conferência do provedor (cliente atualizado ou ausência de cliente conferida por referência). Recusa se houver contratação em andamento. Sua senha será pedida.</p>
                        <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Registrar</button><button type="button" onClick={() => setContinuidade(null)}>Cancelar</button></div>
                    </form>}
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
        {(c.continuidades?.length ?? 0) > 0 && <>
            <h3>Continuidade de documento</h3>
            <ul className={estilos.lista} aria-label="Continuidades de documento">
                {c.continuidades!.map((x) => <li key={x.id}>
                    <strong>{CONTINUIDADE[x.tipo] ?? x.tipo}: {x.documentoAnterior} → {x.documentoNovo}{x.situacao === 'PENDENTE_PROVEDOR' ? ' · aguardando conferência do provedor' : ' · concluída'}</strong>
                    <span>{x.nomeNovo} · {x.instrumento} · efetiva em {x.dataEfetiva.split('-').reverse().join('/')} · por {x.registradaPor ?? 'Sistema'} em {formatarData(x.registradaEm)}{x.provedorNota ? ` · provedor: ${x.provedorNota}` : ''}
                        {x.situacao === 'PENDENTE_PROVEDOR' && <> · <button type="button" disabled={ocupado} onClick={() => setConcluir({ id: x.id, motivo: '' })}>Registrar conferência do provedor</button></>}</span>
                </li>)}
            </ul>
            {!pendente && <div className={estilos.acoesLinha}><button type="button" disabled={ocupado} onClick={() => setRecuperar({ assinaturaId: '', motivo: '' })}>Recuperar vínculo da assinatura…</button></div>}
            {recuperar && <form aria-label="Recuperar vínculo" onSubmit={(e) => {
                e.preventDefault();
                enviar({ operacao: 'recuperar-vinculo', assinaturaId: recuperar.assinaturaId.trim(), motivo: recuperar.motivo }, 'Vínculo recuperado; o pagamento segue a sincronização.');
                setRecuperar(null);
            }}>
                <label>Id da assinatura no provedor (conferida)<input required minLength={3} maxLength={100} value={recuperar.assinaturaId} onChange={(e) => setRecuperar({ ...recuperar, assinaturaId: e.target.value })} /></label>
                <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={recuperar.motivo} onChange={(e) => setRecuperar({ ...recuperar, motivo: e.target.value })} /></label>
                <p className={workspace.muted}>Para assinatura criada no provedor sem vínculo aqui, depois da continuidade concluída. O sistema confere que ela é a única ativa da empresa e que o cliente dela tem o CPF/CNPJ vigente; não cria nem exclui nada no provedor. O pagamento segue a regra normal: feito no prazo da oferta confirma a condição; tardio vai para análise, sem cobrança complementar. Sua senha será pedida.</p>
                <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Recuperar</button><button type="button" onClick={() => setRecuperar(null)}>Cancelar</button></div>
            </form>}
            {concluir && <form aria-label="Conferência do provedor" onSubmit={(e) => {
                e.preventDefault();
                enviar({ operacao: 'concluir-continuidade', continuidadeId: concluir.id, motivo: concluir.motivo }, 'Continuidade concluída.');
                setConcluir(null);
            }}>
                <label>O que foi conferido no provedor (fica no registro)<textarea required minLength={5} maxLength={500} value={concluir.motivo} onChange={(e) => setConcluir({ ...concluir, motivo: e.target.value })} /></label>
                <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Concluir</button><button type="button" onClick={() => setConcluir(null)}>Cancelar</button></div>
            </form>}
        </>}
        {c.arrependimentos !== undefined && <>
            <h3>Arrependimento (direito legal)</h3>
            {!registro ? <p><button type="button" disabled={ocupado} onClick={() => setRegistro({ chave: globalThis.crypto?.randomUUID?.() ?? '', emailSolicitante: '', recebidoEm: '', referencia: '', motivo: '' })}>Registrar pedido recebido pelo canal oficial…</button></p>
                : <form aria-label="Registro de arrependimento recebido pelo canal oficial" onSubmit={(e) => {
                    e.preventDefault();
                    // O campo é a hora de Brasília (UTC−3, sem horário de verão desde 2019).
                    enviar({ operacao: 'arrependimento-registrar', chave: registro.chave, emailSolicitante: registro.emailSolicitante, recebidoEm: `${registro.recebidoEm}:00-03:00`,
                        referencia: registro.referencia, motivo: registro.motivo }, textoResultadoArrependimento);
                    setRegistro(null);
                }}>
                    <label>E-mail de quem enviou o pedido (Gestão ativa desta empresa)<input type="email" required maxLength={320} value={registro.emailSolicitante} onChange={(e) => setRegistro({ ...registro, emailSolicitante: e.target.value })} /></label>
                    <label>Recebido em (horário de Brasília)<input type="datetime-local" required value={registro.recebidoEm} onChange={(e) => setRegistro({ ...registro, recebidoEm: e.target.value })} /></label>
                    <label>Mensagem recebida (assunto, data e hora, trecho)<input required minLength={5} maxLength={400} value={registro.referencia} onChange={(e) => setRegistro({ ...registro, referencia: e.target.value })} /></label>
                    <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={registro.motivo} onChange={(e) => setRegistro({ ...registro, motivo: e.target.value })} /></label>
                    <p className={workspace.muted}>O pedido vale da data do recebimento. Remetente que não é da Gestão ativa desta empresa é recusado: confirme a identidade pelo canal oficial antes. Sua senha será pedida.</p>
                    <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Registrar pedido</button><button type="button" onClick={() => setRegistro(null)}>Cancelar</button></div>
                </form>}
            {(c.arrependimentos?.length ?? 0) > 0 && <ul className={estilos.lista} aria-label="Manifestações de arrependimento">
                {c.arrependimentos!.map((x) => <li key={x.protocolo}>
                    <strong>{x.protocolo}: {x.situacao === 'RECEBIDO' ? 'aguardando o atendimento (prazo imediato)' : x.situacao === 'RESTITUIDO' ? 'restituído' : 'não se aplica'}</strong>
                    <span>{formatarData(x.solicitadoEm)} · {x.dentroDe7Dias === null ? 'sem contratação confirmada' : x.dentroDe7Dias ? 'dentro de 7 dias da contratação' : 'mais de 7 dias da contratação'} (informativo) · provedor {x.provedorDisponivel ? 'configurado' : 'indisponível'}
                        {x.intermediadorComunicadoEm ? ` · intermediador comunicado em ${formatarData(x.intermediadorComunicadoEm)}` : ''}
                        {x.situacao !== 'RECEBIDO' ? ` · e-mail do resultado ao contratante: ${x.emailConclusao === 'ENVIADO' ? 'enviado' : x.emailConclusao === 'FALHOU' ? 'falhou (responder pelo canal oficial)' : x.emailConclusao === 'SEM_DESTINATARIO' ? 'sem destinatário (responder pelo canal oficial)' : 'não registrado'}` : ''}
                        {x.situacao === 'RECEBIDO' && !x.intermediadorComunicadoEm && <> · <button type="button" disabled={ocupado} onClick={() => setArrep({ protocolo: x.protocolo, acao: 'comunicar', referencia: '', valor: '', cobranca: '', assinatura: '', motivo: '' })}>Registrar comunicação ao intermediador</button></>}
                        {x.situacao === 'RECEBIDO' && x.intermediadorComunicadoEm && <> · <button type="button" disabled={ocupado} onClick={() => setArrep({ protocolo: x.protocolo, acao: 'RESTITUIDO', referencia: '', valor: '', cobranca: '', assinatura: '', motivo: '' })}>Concluir com restituição</button></>}
                        {x.situacao === 'RECEBIDO' && <> · <button type="button" disabled={ocupado} onClick={() => setArrep({ protocolo: x.protocolo, acao: 'NAO_APLICAVEL', referencia: '', valor: '', cobranca: '', assinatura: '', motivo: '' })}>Não se aplica…</button></>}</span>
                </li>)}
            </ul>}
            {arrep && <form aria-label="Acompanhamento do arrependimento" onSubmit={(e) => {
                e.preventDefault();
                if (arrep.acao === 'comunicar') enviar({ operacao: 'arrependimento-comunicar', protocolo: arrep.protocolo, referencia: arrep.referencia, motivo: arrep.motivo }, 'Comunicação registrada.');
                else enviar({ operacao: 'arrependimento-concluir', protocolo: arrep.protocolo, situacao: arrep.acao, referencia: arrep.referencia,
                    valorCentavos: arrep.acao === 'RESTITUIDO' ? Math.round(Number(arrep.valor.replace(',', '.')) * 100) : null,
                    cobrancaIds: arrep.acao === 'RESTITUIDO' ? arrep.cobranca.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean) : null,
                    assinaturaId: arrep.acao === 'RESTITUIDO' && arrep.assinatura.trim() ? arrep.assinatura.trim() : null, motivo: arrep.motivo }, textoResultadoArrependimento);
                setArrep(null);
            }}>
                <label>{arrep.acao === 'comunicar' ? 'Referência da comunicação ao intermediador (ex.: estorno solicitado no painel do Asaas, data)' : arrep.acao === 'RESTITUIDO' ? 'Referência da restituição (comprovante/estorno)' : 'Justificativa (enviada ao contratante por e-mail na conclusão)'}
                    <input required minLength={arrep.acao === 'comunicar' ? 3 : 5} maxLength={arrep.acao === 'comunicar' ? 300 : 500} value={arrep.referencia} onChange={(e) => setArrep({ ...arrep, referencia: e.target.value })} /></label>
                {arrep.acao === 'RESTITUIDO' && <label>Valor restituído (R$)<input required inputMode="decimal" value={arrep.valor} onChange={(e) => setArrep({ ...arrep, valor: e.target.value })} /></label>}
                {arrep.acao === 'RESTITUIDO' && <label>Cobranças restituídas no Asaas (pay_…, separadas por vírgula; todas as pagas que foram devolvidas, inclusive antecipadas)<input required value={arrep.cobranca} onChange={(e) => setArrep({ ...arrep, cobranca: e.target.value })} /></label>}
                {arrep.acao === 'RESTITUIDO' && <label>Assinatura restituída no Asaas (sub_…; obrigatória se o pedido foi registrado sem vínculo: a atual ou uma anterior, conferida contra os registros da empresa ou a referência no Asaas)<input pattern="[A-Za-z0-9_-]{1,100}" value={arrep.assinatura} onChange={(e) => setArrep({ ...arrep, assinatura: e.target.value })} /></label>}
                <label>Motivo (fica na auditoria)<textarea required minLength={5} maxLength={500} value={arrep.motivo} onChange={(e) => setArrep({ ...arrep, motivo: e.target.value })} /></label>
                {arrep.acao === 'RESTITUIDO' && <p className={workspace.muted}>Concluir com restituição encerra o período pago (somente leitura por 60 dias, com exportação) se a empresa ainda estiver na assinatura do registro, e as cobranças dessa assinatura até hoje deixam de reabrir o acesso. Sua senha será pedida.</p>}
                <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>Registrar</button><button type="button" onClick={() => setArrep(null)}>Cancelar</button></div>
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
