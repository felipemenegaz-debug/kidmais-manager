'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, formatarDocumento, formatarTelefone, rotuloAcao, type Resposta } from './cliente';
import { useReautenticacao } from './Reautenticacao';
import ComercialEmpresa, { type Comercial } from './ComercialEmpresa';
import { tomSituacao } from './Empresas';
import { rotuloResultado } from './PainelResumo';

type Cadastro = { nomeEmpresarial: string | null; documentoFiscal: string | null; responsavelNome: string | null; email: string | null; telefone: string | null; observacoes: string | null; interessadaId: string | null; implantacao: string | null; implantacaoConcluidaEm: string | null; revisao: number | null };
type Empresa = { id: string; codigo: string; nome: string; status: string; situacao: string; situacaoRotulo: string; criadoEm: string; atualizadoEm: string; implantacaoRotulo: string | null; cadastro: Cadastro | null };
type Membro = { usuarioId: string; nome: string; email: string; papel: string; nivel: string; statusVinculo: 'PENDENTE' | 'ATIVA' | 'SUSPENSA' | 'REVOGADA'; contaAtiva: boolean; membershipId: string; vinculoDesde: string; atualizadoEm: string; outrasEmpresasAtivas: number };
type Convite = { id: string; email: string; nomeSugerido: string | null; nivel: string; situacao: 'PENDENTE' | 'EXPIRADO' | 'ACEITO' | 'CANCELADO'; expiraEm: string; envios: number; ultimoEnvioEm: string | null; criadoEm: string; aceitoEm: string | null; canceladoEm: string | null };
type Atividade = { id: string; acao: string; origem: string; criado_em: string; ator: string | null; resultado: string | null };
type Pendencia = { codigo: string; titulo: string; atendida: boolean; obrigatoria: boolean; detalhe: string; acao: 'CONVITES' | 'PERFIL' | 'PLATAFORMA' | null };
type Implantacao = { itens: Pendencia[]; podeConcluir: boolean; pendentesObrigatorias: string[] };
type Ficha = { empresa: Empresa; membros: Membro[]; convites: Convite[]; atividade: Atividade[]; implantacao: Implantacao | null; envioEmail: { configurado: boolean; motivo: string | null }; comercial: Comercial };
type Envio = { enviado: boolean; destino: string; motivo?: string };

const VINCULO: Record<Membro['statusVinculo'], { rotulo: string; tom?: string }> = {
    ATIVA: { rotulo: 'Ativo', tom: 'ok' }, SUSPENSA: { rotulo: 'Desativado', tom: 'alerta' }, PENDENTE: { rotulo: 'Pendente', tom: 'info' }, REVOGADA: { rotulo: 'Removido' },
};
const CONVITE: Record<Convite['situacao'], { rotulo: string; tom?: string }> = {
    PENDENTE: { rotulo: 'Pendente', tom: 'info' }, EXPIRADO: { rotulo: 'Expirado', tom: 'alerta' }, ACEITO: { rotulo: 'Aceito', tom: 'ok' }, CANCELADO: { rotulo: 'Cancelado' },
};
const IMPLANTACAO = [
    { valor: 'AGUARDANDO_PRIMEIRO_ACESSO', rotulo: 'Aguardando primeiro acesso' }, { valor: 'EM_CONFIGURACAO', rotulo: 'Em configuração' }, { valor: 'CONCLUIDA', rotulo: 'Implantação concluída' },
];

type AcaoVinculo = { tipo: 'desativar' | 'reativar' | 'papel' | 'recuperar'; membro: Membro };

function textoEnvio(envio: Envio, o: string) {
    return envio.enviado ? `${o} enviado para ${envio.destino}.` : `${o} registrado, mas NÃO enviado: ${envio.motivo}`;
}

export default function EmpresaFicha({ id }: { id: string }) {
    const { executar, dialogo } = useReautenticacao();
    const [ficha, setFicha] = useState<Ficha | null>(null);
    const [erroCarga, setErroCarga] = useState('');
    const [aviso, setAviso] = useState<{ tipo: 'ok' | 'alerta'; texto: string } | null>(null);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [editando, setEditando] = useState(false);
    const [acao, setAcao] = useState<AcaoVinculo | null>(null);
    const [motivo, setMotivo] = useState('');
    const [situacao, setSituacao] = useState<{ motivo: string; codigo: string } | null>(null);
    const carregar = useCallback(async () => {
        const r = await chamar<Ficha>(`/api/desenvolvedor/empresas/${encodeURIComponent(id)}`);
        if (r.ok) { setFicha(r.data); setErroCarga(''); }
        else setErroCarga(r.erro);
    }, [id]);
    useEffect(() => {
        let vivo = true;
        chamar<Ficha>(`/api/desenvolvedor/empresas/${encodeURIComponent(id)}`).then((r) => {
            if (!vivo) return;
            if (r.ok) { setFicha(r.data); setErroCarga(''); }
            else setErroCarga(r.erro);
        });
        return () => { vivo = false; };
    }, [id]);
    if (!ficha)
        return <main className={admin.page}>{erroCarga ? <p role="alert">{erroCarga}</p> : <p className={workspace.muted} aria-live="polite">Carregando ficha…</p>}<Link href="/desenvolvedor/empresas">← Contratantes</Link></main>;
    const e = ficha.empresa;
    const base = `/api/desenvolvedor/empresas/${e.id}`;

    /** Executa, mostra o resultado real e recarrega a ficha. */
    function operar<T>(op: () => Promise<Resposta<T>>, sucesso: (data: T) => { tipo: 'ok' | 'alerta'; texto: string }, depois?: () => void) {
        setOcupado(true);
        setErro('');
        setAviso(null);
        void executar(op, async (r) => {
            setOcupado(false);
            if (!r.ok) { setErro(r.erro); return; }
            setAviso(sucesso(r.data));
            depois?.();
            await carregar();
        });
    }

    return <main className={admin.page}>
        <p><Link href="/desenvolvedor/empresas">← Contratantes</Link></p>
        <div className={estilos.cabecalho}>
            <div>
                <p className={estilos.sobretitulo}>Empresa administrada</p>
                <h1 className={estilos.empresaAtual}>{e.nome} <span className={estilos.selo} data-tom={tomSituacao(e.situacao)}>{e.situacaoRotulo}</span></h1>
                <p className={workspace.muted} style={{ margin: '6px 0 0' }}>Código {e.codigo} · criada em {formatarData(e.criadoEm, false)}{e.implantacaoRotulo ? ` · ${e.implantacaoRotulo}` : ''}</p>
            </div>
        </div>
        {!ficha.envioEmail.configurado && <div className={estilos.alerta} role="status"><strong>Envio de e-mail indisponível.</strong> {ficha.envioEmail.motivo}</div>}
        {aviso && <p className={aviso.tipo === 'ok' ? estilos.sucesso : estilos.alerta} role="status">{aviso.texto}</p>}
        {erro && <p role="alert">{erro}</p>}

        <section className={workspace.card} aria-labelledby="t-cadastro">
            <h2 id="t-cadastro">Cadastro administrativo</h2>
            {!e.cadastro && !editando && <p className={estilos.alerta}>Esta empresa ainda não tem cadastro administrativo (provavelmente anterior ao painel). Complete-o para acompanhar responsável e contatos.</p>}
            {editando ? <CadastroForm empresa={e} ocupado={ocupado} aoCancelar={() => setEditando(false)} aoSalvar={(corpo) => operar(
                () => chamar<{ alterados: string[] }>(base, 'PATCH', corpo),
                (d) => ({ tipo: 'ok', texto: d.alterados.length ? `Cadastro salvo (${d.alterados.length} campo(s) alterado(s)).` : 'Nada mudou.' }),
                () => setEditando(false),
            )} /> : e.cadastro && <dl className={estilos.ficha}>
                <div><dt>Nome empresarial</dt><dd>{e.cadastro.nomeEmpresarial ?? '—'}</dd></div>
                <div><dt>CPF/CNPJ</dt><dd>{formatarDocumento(e.cadastro.documentoFiscal)}</dd></div>
                <div><dt>Responsável</dt><dd>{e.cadastro.responsavelNome ?? '—'}</dd></div>
                <div><dt>E-mail</dt><dd>{e.cadastro.email ?? '—'}</dd></div>
                <div><dt>Telefone</dt><dd>{formatarTelefone(e.cadastro.telefone)}</dd></div>
                <div><dt>Origem</dt><dd>{e.cadastro.interessadaId ? <Link href={`/desenvolvedor/interessadas/${e.cadastro.interessadaId}`}>Interessada convertida</Link> : 'Cadastro direto'}</dd></div>
                <div style={{ gridColumn: '1 / -1' }}><dt>Observações administrativas</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{e.cadastro.observacoes ?? '—'}</dd></div>
            </dl>}
            {!editando && <div className={estilos.acoesLinha} style={{ marginTop: 12 }}><button type="button" onClick={() => setEditando(true)}>{e.cadastro ? 'Editar cadastro' : 'Completar cadastro'}</button></div>}
            {e.cadastro && e.status === 'ATIVA' && <>
                <h3>Implantação</h3>
                {ficha.implantacao && <ul className={estilos.lista} aria-label="Pendências de implantação">
                    {ficha.implantacao.itens.map((p) => <li key={p.codigo}>
                        <strong><span aria-hidden="true">{p.atendida ? '✓' : p.obrigatoria ? '✗' : '•'}</span> {p.titulo}{p.obrigatoria && !p.atendida ? ' (obrigatória)' : ''}</strong>
                        <span>{p.detalhe}{!p.atendida && p.acao === 'CONVITES' && <> · <a href="#t-convites">Ver convites</a></>}{!p.atendida && p.acao === 'PERFIL' && ' · Ação da Gestão da empresa, no Admin.'}{!p.atendida && p.acao === 'PLATAFORMA' && ' · Ação da plataforma, fora deste painel.'}</span>
                    </li>)}
                </ul>}
                <div className={estilos.filtros} role="group" aria-label="Etapa da implantação">
                    {IMPLANTACAO.map((i) => <button key={i.valor} type="button" aria-pressed={e.cadastro?.implantacao === i.valor}
                        disabled={ocupado || e.cadastro?.implantacao === i.valor || (i.valor === 'CONCLUIDA' && ficha.implantacao !== null && !ficha.implantacao.podeConcluir)}
                        title={i.valor === 'CONCLUIDA' && ficha.implantacao && !ficha.implantacao.podeConcluir ? 'Resolva as pendências obrigatórias antes de concluir.' : undefined}
                        onClick={() => operar(
                            () => chamar<{ implantacao: string }>(base, 'POST', { acao: 'implantacao', dados: { implantacao: i.valor, revisao: e.cadastro?.revisao } }),
                            () => ({ tipo: 'ok', texto: `Implantação: ${i.rotulo}.` }),
                        )}>{i.rotulo}</button>)}
                </div>
                {ficha.implantacao && !ficha.implantacao.podeConcluir && e.cadastro.implantacao !== 'CONCLUIDA' && <p className={workspace.muted}>“Implantação concluída” fica disponível quando as pendências obrigatórias acima forem atendidas. O servidor confere de novo ao marcar.</p>}
                {e.cadastro.implantacaoConcluidaEm && <p className={workspace.muted}>Concluída em {formatarData(e.cadastro.implantacaoConcluidaEm)}.</p>}
            </>}
        </section>

        <section className={workspace.card} aria-labelledby="t-usuarios">
            <h2 id="t-usuarios">Usuários e vínculos com {e.nome}</h2>
            <p className={workspace.muted}>Cada linha é o vínculo da pessoa com esta empresa. Desativar aqui não afeta o acesso dela a outras empresas.</p>
            {ficha.membros.length === 0 ? <div className={estilos.vazio}>Ninguém tem vínculo com esta empresa ainda. O acesso nasce quando um convite é aceito.</div> : <div className={admin.tableWrap}><table>
                <thead><tr><th>Pessoa</th><th>Papel</th><th>Vínculo</th><th>Outras empresas</th><th>Ações</th></tr></thead>
                <tbody>{ficha.membros.map((m) => <tr key={m.membershipId}>
                    <td>{m.nome}<small className={workspace.muted}>{m.email}{!m.contaAtiva ? ' · conta desativada na plataforma' : ''}</small></td>
                    <td>{m.nivel}</td>
                    <td><span className={estilos.selo} data-tom={VINCULO[m.statusVinculo].tom}>{VINCULO[m.statusVinculo].rotulo}</span><small className={workspace.muted}>desde {formatarData(m.vinculoDesde, false)}</small></td>
                    <td>{m.outrasEmpresasAtivas}</td>
                    <td><div className={estilos.acoesLinha}>
                        {m.statusVinculo === 'ATIVA' && <button type="button" disabled={ocupado} onClick={() => { setAcao({ tipo: 'papel', membro: m }); setMotivo(''); }}>{m.papel === 'REPRESENTANTE_AUTORIZADO' ? 'Tornar Equipe' : 'Tornar Gestão'}</button>}
                        {m.statusVinculo === 'ATIVA' && <button type="button" className="danger" disabled={ocupado} onClick={() => { setAcao({ tipo: 'desativar', membro: m }); setMotivo(''); }}>Desativar vínculo</button>}
                        {m.statusVinculo === 'SUSPENSA' && <button type="button" disabled={ocupado} onClick={() => { setAcao({ tipo: 'reativar', membro: m }); setMotivo(''); }}>Reativar vínculo</button>}
                        {m.statusVinculo !== 'REVOGADA' && m.contaAtiva && <button type="button" disabled={ocupado} onClick={() => { setAcao({ tipo: 'recuperar', membro: m }); setMotivo(''); }}>Recuperação de senha</button>}
                    </div></td>
                </tr>)}</tbody>
            </table></div>}
            {acao && <div className={workspace.notice} role="region" aria-label="Confirmar ação no vínculo">
                <div>
                    <h2>{acao.tipo === 'desativar' ? 'Desativar vínculo' : acao.tipo === 'reativar' ? 'Reativar vínculo' : acao.tipo === 'papel' ? 'Alterar papel' : 'Solicitar recuperação de senha'} — {acao.membro.nome}</h2>
                    <p>{acao.tipo === 'desativar' && `${acao.membro.nome} perde o acesso a ${e.nome} na hora; a assinatura de contratos pela empresa é retirada. Dados e histórico ficam preservados.${acao.membro.outrasEmpresasAtivas === 0 ? ' Como não tem outro acesso ativo, as sessões abertas serão encerradas.' : ' O acesso às outras empresas continua.'}`}
                        {acao.tipo === 'reativar' && `${acao.membro.nome} volta a acessar ${e.nome} com o papel ${acao.membro.nivel}.`}
                        {acao.tipo === 'papel' && `${acao.membro.nome} passa de ${acao.membro.nivel} para ${acao.membro.papel === 'REPRESENTANTE_AUTORIZADO' ? 'Equipe (a assinatura pela empresa é retirada)' : 'Gestão'} nesta empresa.`}
                        {acao.tipo === 'recuperar' && `Um link de uso único (30 minutos) será enviado para ${acao.membro.email}. Você não verá o link nem a senha.`}</p>
                    {(acao.tipo === 'desativar' || acao.tipo === 'reativar') && <label>Motivo *<input value={motivo} onChange={(ev) => setMotivo(ev.target.value)} maxLength={500} /></label>}
                </div>
                <div className={estilos.acoesLinha}>
                    <button type="button" disabled={ocupado || ((acao.tipo === 'desativar' || acao.tipo === 'reativar') && motivo.trim().length < 3)} onClick={() => {
                        const a = acao;
                        const url = `${base}/usuarios/${a.membro.usuarioId}`;
                        if (a.tipo === 'recuperar')
                            operar(() => chamar<Envio>(url, 'POST', { acao: 'recuperar' }), (d) => ({ tipo: d.enviado ? 'ok' : 'alerta', texto: textoEnvio(d, 'Pedido de recuperação') }), () => setAcao(null));
                        else if (a.tipo === 'papel')
                            operar(() => chamar<{ papel: string; alterado: boolean }>(url, 'POST', { acao: 'papel', dados: { nivel: a.membro.papel === 'REPRESENTANTE_AUTORIZADO' ? 'EQUIPE' : 'GESTAO' } }),
                                (d) => ({ tipo: 'ok', texto: d.alterado ? `Papel de ${a.membro.nome} alterado.` : 'O papel já era este.' }), () => setAcao(null));
                        else
                            operar(() => chamar<{ statusVinculo: string; sessoesEncerradas: number }>(url, 'POST', { acao: a.tipo, dados: { motivo: motivo.trim() } }),
                                (d) => ({ tipo: 'ok', texto: a.tipo === 'desativar' ? `Vínculo de ${a.membro.nome} desativado.${d.sessoesEncerradas ? ` ${d.sessoesEncerradas} sessão(ões) encerrada(s).` : ''}` : `Vínculo de ${a.membro.nome} reativado.` }), () => setAcao(null));
                    }}>{ocupado ? 'Processando…' : 'Confirmar'}</button>
                    <button type="button" disabled={ocupado} onClick={() => setAcao(null)}>Cancelar</button>
                </div>
            </div>}
        </section>

        <section className={workspace.card} aria-labelledby="t-convites">
            <h2 id="t-convites">Convites</h2>
            {e.status === 'ATIVA' ? <ConviteForm ocupado={ocupado} aoConvidar={(dados, limpar) => operar(
                () => chamar<{ envio: Envio }>(`${base}/convites`, 'POST', { acao: 'convidar', dados }),
                (d) => ({ tipo: d.envio.enviado ? 'ok' : 'alerta', texto: textoEnvio(d.envio, 'Convite') }), limpar,
            )} /> : <p className={workspace.muted}>Só uma empresa ativa recebe convites.</p>}
            {ficha.convites.length === 0 ? <p className={workspace.muted}>Nenhum convite registrado.</p> : <div className={admin.tableWrap}><table>
                <thead><tr><th>E-mail</th><th>Papel</th><th>Situação</th><th>Envios</th><th>Ações</th></tr></thead>
                <tbody>{ficha.convites.map((c) => <tr key={c.id}>
                    <td>{c.email}{c.nomeSugerido && <small className={workspace.muted}>{c.nomeSugerido}</small>}</td>
                    <td>{c.nivel}</td>
                    <td><span className={estilos.selo} data-tom={CONVITE[c.situacao].tom}>{CONVITE[c.situacao].rotulo}</span>
                        <small className={workspace.muted}>{c.situacao === 'ACEITO' ? `aceito ${formatarData(c.aceitoEm)}` : c.situacao === 'CANCELADO' ? `cancelado ${formatarData(c.canceladoEm)}` : `vence ${formatarData(c.expiraEm)}`}</small></td>
                    <td>{c.envios === 0 ? <span className={estilos.textoAlerta}>não enviado</span> : `${c.envios} · último ${formatarData(c.ultimoEnvioEm)}`}</td>
                    <td>{(c.situacao === 'PENDENTE' || c.situacao === 'EXPIRADO') && <div className={estilos.acoesLinha}>
                        <button type="button" disabled={ocupado || e.status !== 'ATIVA'} onClick={() => operar(() => chamar<{ envio: Envio }>(`${base}/convites`, 'POST', { acao: 'reenviar', conviteId: c.id }),
                            (d) => ({ tipo: d.envio.enviado ? 'ok' : 'alerta', texto: `${textoEnvio(d.envio, 'Convite')} O link anterior deixou de valer.` }))}>Reenviar</button>
                        <button type="button" className="danger" disabled={ocupado} onClick={() => operar(() => chamar<unknown>(`${base}/convites`, 'POST', { acao: 'cancelar', conviteId: c.id }),
                            () => ({ tipo: 'ok', texto: `Convite para ${c.email} cancelado.` }))}>Cancelar</button>
                    </div>}</td>
                </tr>)}</tbody>
            </table></div>}
        </section>

        <ComercialEmpresa empresaId={e.id} comercial={ficha.comercial} ocupado={ocupado} operar={operar} />

        {(e.status === 'ATIVA' || e.status === 'SUSPENSA') && <section className={workspace.card} aria-labelledby="t-situacao">
            <h2 id="t-situacao">{e.status === 'ATIVA' ? 'Suspender acesso da empresa' : 'Reativar acesso da empresa'}</h2>
            <p className={workspace.muted}>{e.status === 'ATIVA'
                ? 'A suspensão preserva todos os dados. Todo acesso às telas e APIs desta empresa é recusado imediatamente; quem não tiver acesso a outra empresa tem as sessões encerradas.'
                : 'A reativação devolve o acesso a quem tem vínculo ativo. Vínculos desativados continuam desativados.'}</p>
            {!situacao ? <button type="button" className={e.status === 'ATIVA' ? 'danger' : undefined} onClick={() => setSituacao({ motivo: '', codigo: '' })}>{e.status === 'ATIVA' ? 'Suspender empresa…' : 'Reativar empresa…'}</button> : <form onSubmit={(ev) => {
                ev.preventDefault();
                const acaoEmpresa = e.status === 'ATIVA' ? 'suspender' : 'reativar';
                operar(() => chamar<{ status: string; sessoesEncerradas: number; usuariosDesconectados: number }>(base, 'POST', { acao: acaoEmpresa, dados: { motivo: situacao.motivo.trim(), confirmacaoCodigo: situacao.codigo.trim() } }),
                    (d) => ({ tipo: 'ok', texto: acaoEmpresa === 'suspender' ? `Empresa suspensa. ${d.usuariosDesconectados} pessoa(s) desconectada(s), ${d.sessoesEncerradas} sessão(ões) encerrada(s).` : 'Empresa reativada.' }), () => setSituacao(null));
            }}>
                <label>Motivo *<input value={situacao.motivo} onChange={(ev) => setSituacao({ ...situacao, motivo: ev.target.value })} maxLength={500} required /></label>
                <label>Digite o código <b>{e.codigo}</b> para confirmar *<input value={situacao.codigo} onChange={(ev) => setSituacao({ ...situacao, codigo: ev.target.value })} autoComplete="off" required /></label>
                <div className={estilos.acoesLinha}>
                    <button type="submit" className={e.status === 'ATIVA' ? 'danger' : undefined} disabled={ocupado || situacao.motivo.trim().length < 3 || situacao.codigo.trim().toLowerCase() !== e.codigo}>{ocupado ? 'Processando…' : e.status === 'ATIVA' ? 'Confirmar suspensão' : 'Confirmar reativação'}</button>
                    <button type="button" onClick={() => setSituacao(null)} disabled={ocupado}>Cancelar</button>
                </div>
            </form>}
        </section>}

        <section className={workspace.card} aria-labelledby="t-atividade">
            <h2 id="t-atividade">Atividade administrativa</h2>
            <p className={workspace.muted}>Últimos registros. <Link href={`/desenvolvedor/atividade?empresaId=${e.id}`}>Ver toda a atividade desta empresa</Link>, com filtros por ação e período.</p>
            {ficha.atividade.length === 0 ? <p className={workspace.muted}>Sem registros.</p> : <div className={admin.tableWrap}><table>
                <thead><tr><th>Quando</th><th>Ação</th><th>Quem</th><th>Resultado</th></tr></thead>
                <tbody>{ficha.atividade.map((a) => <tr key={a.id}><td>{formatarData(a.criado_em)}</td><td>{rotuloAcao(a.acao)}</td><td>{a.ator ?? 'Sistema'}</td><td>{rotuloResultado(a.resultado)}</td></tr>)}</tbody>
            </table></div>}
        </section>
        {dialogo}
    </main>;
}

function CadastroForm({ empresa, ocupado, aoSalvar, aoCancelar }: { empresa: Empresa; ocupado: boolean; aoSalvar: (corpo: Record<string, unknown>) => void; aoCancelar: () => void }) {
    const c = empresa.cadastro;
    const [v, setV] = useState({ nome: empresa.nome, nomeEmpresarial: c?.nomeEmpresarial ?? '', documentoFiscal: c?.documentoFiscal ?? '', responsavelNome: c?.responsavelNome ?? '', email: c?.email ?? '', telefone: c?.telefone ?? '', observacoes: c?.observacoes ?? '' });
    const set = (k: keyof typeof v) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: ev.target.value }));
    const op = (s: string) => (s.trim() ? s.trim() : null);
    return <form onSubmit={(ev) => { ev.preventDefault(); aoSalvar({ nome: v.nome, nomeEmpresarial: op(v.nomeEmpresarial), documentoFiscal: op(v.documentoFiscal), responsavelNome: v.responsavelNome, email: v.email, telefone: op(v.telefone), observacoes: op(v.observacoes), revisao: c?.revisao ?? null }); }}>
        <div className={estilos.formGrid}>
            <label>Nome da empresa *<input value={v.nome} onChange={set('nome')} required maxLength={160} /></label>
            <label>Nome empresarial<input value={v.nomeEmpresarial} onChange={set('nomeEmpresarial')} maxLength={200} /></label>
            <label>CPF ou CNPJ<input value={v.documentoFiscal} onChange={set('documentoFiscal')} maxLength={40} /></label>
            <label>Responsável *<input value={v.responsavelNome} onChange={set('responsavelNome')} required maxLength={160} /></label>
            <label>E-mail *<input type="email" value={v.email} onChange={set('email')} required maxLength={254} /></label>
            <label>Telefone<input type="tel" value={v.telefone} onChange={set('telefone')} maxLength={40} /></label>
            <label className={estilos.inteira}>Observações administrativas<textarea rows={3} value={v.observacoes} onChange={set('observacoes')} maxLength={4000} /></label>
        </div>
        <p className={workspace.muted}>O e-mail do cadastro é só contato administrativo; não muda o login de ninguém.</p>
        <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>{ocupado ? 'Salvando…' : 'Salvar cadastro'}</button><button type="button" onClick={aoCancelar} disabled={ocupado}>Cancelar</button></div>
    </form>;
}

function ConviteForm({ ocupado, aoConvidar }: { ocupado: boolean; aoConvidar: (dados: { email: string; nome: string | null; nivel: 'GESTAO' | 'EQUIPE' }, limpar: () => void) => void }) {
    const [email, setEmail] = useState('');
    const [nome, setNome] = useState('');
    const [nivel, setNivel] = useState<'GESTAO' | 'EQUIPE'>('EQUIPE');
    return <form className={estilos.busca} onSubmit={(ev) => { ev.preventDefault(); aoConvidar({ email: email.trim(), nome: nome.trim() || null, nivel }, () => { setEmail(''); setNome(''); setNivel('EQUIPE'); }); }}>
        <label>E-mail *<input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} required maxLength={254} /></label>
        <label>Nome (opcional)<input value={nome} onChange={(ev) => setNome(ev.target.value)} maxLength={120} /></label>
        <label style={{ flex: '0 1 180px', minWidth: 160 }}>Papel<select value={nivel} onChange={(ev) => setNivel(ev.target.value as 'GESTAO' | 'EQUIPE')}><option value="EQUIPE">Equipe</option><option value="GESTAO">Gestão</option></select></label>
        <button type="submit" disabled={ocupado || !email.trim()}>Convidar</button>
    </form>;
}
