'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, rotuloAcao } from './cliente';

type Resumo = {
    interessadas: Record<string, number>;
    empresas: { emImplantacao: number; ativas: number; suspensas: number; aguardandoPrimeiroAcesso: number; emConfiguracao: number; semCadastro: number };
    aguardando: { id: string; nome: string; implantacao: string; criado_em: string; convites_pendentes: number }[];
    convites: { pendentes: number; expirados: number; naoEnviados: number };
    convitesPendentes: { id: string; empresa_id: string; empresa: string; email: string; expira_em: string; expirado: boolean; envios: number }[];
    atividades: { id: string; acao: string; origem: string; criado_em: string; ator: string | null; empresa_id: string | null; empresa: string | null; resultado: string | null }[];
    envioEmail: { configurado: boolean; motivo: string | null };
    alertas: { itens: Alerta[]; total: number };
};
type Alerta = { codigo: string; severidade: 'ALTA' | 'MEDIA' | 'INFO'; empresaId: string | null; empresa: string | null; titulo: string; detalhe: string; desde: string | null; acao: { rotulo: string; href: string } | null };
const SEVERIDADE: Record<Alerta['severidade'], string> = { ALTA: 'Urgente', MEDIA: 'Atenção', INFO: 'Próximo passo' };

export default function PainelResumo() {
    const [dados, setDados] = useState<Resumo | null>(null);
    const [erro, setErro] = useState('');
    useEffect(() => {
        let vivo = true;
        chamar<Resumo>('/api/desenvolvedor/resumo').then((r) => {
            if (!vivo) return;
            if (r.ok) setDados(r.data);
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, []);
    const abertas = dados ? (dados.interessadas.NOVA ?? 0) + (dados.interessadas.EM_CONTATO ?? 0) + (dados.interessadas.PROPOSTA ?? 0) : 0;
    return <main className={admin.page}>
        <div className={estilos.cabecalho}>
            <div><p className={estilos.sobretitulo}>Painel do desenvolvedor</p><h1>Resumo da plataforma</h1></div>
            <div className={workspace.actions}>
                <Link className={estilos.botaoLink} href="/desenvolvedor/interessadas?nova=1">Nova interessada</Link>
                <Link className={estilos.botaoPrimario} href="/desenvolvedor/empresas/provisionar">Provisionar contratante</Link>
            </div>
        </div>
        {erro && <p role="alert">{erro}</p>}
        {!dados && !erro && <p className={workspace.muted} aria-live="polite">Carregando resumo…</p>}
        {dados && <>
            <section className={workspace.card} aria-labelledby="t-alertas">
                <h2 id="t-alertas">O que precisa de ação{dados.alertas.total > 0 ? ` (${dados.alertas.total})` : ''}</h2>
                {dados.alertas.itens.length === 0 ? <p className={workspace.muted}>Nenhum alerta: convites enviados, responsáveis com acesso e implantações em dia.</p> : <ul className={estilos.lista} aria-label="Alertas acionáveis">
                    {dados.alertas.itens.map((a, i) => <li key={`${a.codigo}-${a.empresaId ?? 'global'}-${i}`} data-alerta={a.codigo}>
                        <strong><span className={a.severidade === 'INFO' ? undefined : estilos.textoAlerta}>{SEVERIDADE[a.severidade]}</span> · {a.titulo}{a.empresa ? <> — {a.empresaId ? <Link href={`/desenvolvedor/empresas/${a.empresaId}`}>{a.empresa}</Link> : a.empresa}</> : null}</strong>
                        <span>{a.detalhe}{a.desde ? ` Desde ${formatarData(a.desde, false)}.` : ''}{a.acao && <> · <Link href={a.acao.href}>{a.acao.rotulo}</Link></>}</span>
                    </li>)}
                </ul>}
                {dados.alertas.total > dados.alertas.itens.length && <p className={workspace.muted}>Mostrando {dados.alertas.itens.length} de {dados.alertas.total}. Os demais aparecem na lista de contratantes.</p>}
            </section>
            <section className={estilos.metricas} aria-label="Indicadores">
                <Metrica rotulo="Interessadas em aberto" valor={abertas} href="/desenvolvedor/interessadas" detalhe={`${dados.interessadas.PROPOSTA ?? 0} com proposta`} />
                <Metrica rotulo="Em implantação" valor={dados.empresas.emImplantacao} href="/desenvolvedor/empresas?situacao=EM_IMPLANTACAO" detalhe={`${dados.empresas.aguardandoPrimeiroAcesso} aguardando primeiro acesso`} />
                <Metrica rotulo="Ativas" valor={dados.empresas.ativas} href="/desenvolvedor/empresas?situacao=ATIVA" detalhe={dados.empresas.semCadastro ? `${dados.empresas.semCadastro} sem cadastro administrativo` : 'Cadastros completos'} />
                <Metrica rotulo="Suspensas" valor={dados.empresas.suspensas} href="/desenvolvedor/empresas?situacao=SUSPENSA" detalhe="Dados preservados" alerta={dados.empresas.suspensas > 0} />
                <Metrica rotulo="Convites pendentes" valor={dados.convites.pendentes} detalhe={`${dados.convites.expirados} expirados · ${dados.convites.naoEnviados} não enviados`} alerta={dados.convites.expirados + dados.convites.naoEnviados > 0} />
            </section>
            <div className={estilos.duasColunas}>
                <section className={workspace.card} aria-labelledby="t-aguardando">
                    <h2 id="t-aguardando">Aguardando primeiro acesso ou configuração</h2>
                    {dados.aguardando.length === 0 ? <p className={workspace.muted}>Nenhuma empresa em implantação.</p> : <ul className={estilos.lista}>
                        {dados.aguardando.map((e) => <li key={e.id}><Link href={`/desenvolvedor/empresas/${e.id}`}>{e.nome}</Link>
                            <span>{e.implantacao === 'AGUARDANDO_PRIMEIRO_ACESSO' ? 'Aguardando primeiro acesso' : 'Em configuração'} · provisionada em {formatarData(e.criado_em, false)} · {e.convites_pendentes} convite(s) pendente(s)</span></li>)}
                    </ul>}
                </section>
                <section className={workspace.card} aria-labelledby="t-convites">
                    <h2 id="t-convites">Convites pendentes</h2>
                    {dados.convitesPendentes.length === 0 ? <p className={workspace.muted}>Nenhum convite pendente.</p> : <ul className={estilos.lista}>
                        {dados.convitesPendentes.map((c) => <li key={c.id}><Link href={`/desenvolvedor/empresas/${c.empresa_id}`}>{c.empresa}</Link>
                            <span>{c.email} · {c.expirado ? <b className={estilos.textoAlerta}>expirado</b> : `vence ${formatarData(c.expira_em)}`} · {c.envios === 0 ? <b className={estilos.textoAlerta}>não enviado</b> : `${c.envios} envio(s)`}</span></li>)}
                    </ul>}
                </section>
            </div>
            <section className={workspace.card} aria-labelledby="t-atividade">
                <h2 id="t-atividade">Atividades administrativas recentes</h2>
                {dados.atividades.length === 0 ? <p className={workspace.muted}>Nenhuma atividade registrada.</p> : <div className={`${admin.tableWrap} ${estilos.tabela} ${estilos.tabelaData}`}><table>
                    <thead><tr><th>Quando</th><th>Ação</th><th>Empresa</th><th>Quem</th><th>Resultado</th></tr></thead>
                    <tbody>{dados.atividades.map((a) => <tr key={a.id}>
                        <td>{formatarData(a.criado_em)}</td><td>{rotuloAcao(a.acao)}</td>
                        <td>{a.empresa_id ? <Link href={`/desenvolvedor/empresas/${a.empresa_id}`}>{a.empresa}</Link> : '—'}</td>
                        <td>{a.ator ?? 'Sistema'}</td><td>{rotuloResultado(a.resultado)}</td>
                    </tr>)}</tbody>
                </table></div>}
            </section>
        </>}
    </main>;
}

export function rotuloResultado(r: string | null) {
    return r === 'SUCESSO' ? 'Concluído' : r === 'FALHA' ? 'Falhou' : r === 'RECUSADO' ? 'Recusado' : r === 'PARCIAL' ? 'Parcial' : '—';
}

function Metrica({ rotulo, valor, detalhe, href, alerta }: { rotulo: string; valor: number; detalhe: string; href?: string; alerta?: boolean }) {
    const conteudo = <><span className={estilos.metricaRotulo}>{rotulo}</span><strong className={estilos.metricaValor}>{valor}</strong><span className={alerta ? estilos.textoAlerta : estilos.metricaDetalhe}>{detalhe}</span></>;
    return href ? <Link className={estilos.metrica} href={href}>{conteudo}</Link> : <div className={estilos.metrica}>{conteudo}</div>;
}
