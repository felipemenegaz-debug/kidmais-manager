'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData } from './cliente';

type Item = {
    id: string; codigo: string; nome: string; situacao: string; situacaoRotulo: string; criadoEm: string; implantacaoRotulo: string | null;
    responsavelNome: string | null; email: string | null; membrosAtivos: number; convitesPendentes: number; temCadastro: boolean;
};
type Lista = { itens: Item[]; total: number; pagina: number; porPagina: number };
const FILTROS = [
    { valor: 'TODAS', rotulo: 'Todas' }, { valor: 'EM_IMPLANTACAO', rotulo: 'Em implantação' }, { valor: 'AGUARDANDO_PRIMEIRO_ACESSO', rotulo: 'Aguardando primeiro acesso' },
    { valor: 'EM_CONFIGURACAO', rotulo: 'Em configuração' }, { valor: 'ATIVA', rotulo: 'Ativas' }, { valor: 'SUSPENSA', rotulo: 'Suspensas' }, { valor: 'DESATIVADA', rotulo: 'Desativadas' },
];
export function tomSituacao(s: string) {
    return s === 'ATIVA' ? 'ok' : s === 'SUSPENSA' ? 'alerta' : s === 'EM_IMPLANTACAO' || s === 'EM_PROVISIONAMENTO' ? 'info' : undefined;
}

export default function Empresas() {
    const params = useSearchParams();
    const inicial = params.get('situacao');
    const [situacao, setSituacao] = useState(FILTROS.some((f) => f.valor === inicial) ? inicial! : 'TODAS');
    const [busca, setBusca] = useState('');
    const [buscaAplicada, setBuscaAplicada] = useState('');
    const [pagina, setPagina] = useState(1);
    const [lista, setLista] = useState<Lista | null>(null);
    const [erro, setErro] = useState('');
    const consulta = (() => { const q = new URLSearchParams({ situacao, pagina: String(pagina) }); if (buscaAplicada) q.set('busca', buscaAplicada); return `/api/desenvolvedor/empresas?${q}`; })();
    const [carregada, setCarregada] = useState<string | null>(null);
    const carregando = carregada !== consulta;
    useEffect(() => {
        let vivo = true;
        chamar<Lista>(consulta).then((r) => {
            if (!vivo) return;
            setCarregada(consulta);
            if (r.ok) { setLista(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [consulta]);
    const paginas = lista ? Math.max(1, Math.ceil(lista.total / lista.porPagina)) : 1;
    return <main className={admin.page}>
        <div className={estilos.cabecalho}>
            <div><p className={estilos.sobretitulo}>Plataforma</p><h1>Contratantes</h1></div>
            <div className={workspace.actions}><Link className={estilos.botaoPrimario} href="/desenvolvedor/empresas/provisionar">Provisionar contratante</Link></div>
        </div>
        <form className={estilos.busca} role="search" onSubmit={(e) => { e.preventDefault(); setPagina(1); setBuscaAplicada(busca.trim()); }}>
            <label>Buscar por nome, código, responsável, e-mail ou documento<input value={busca} onChange={(e) => setBusca(e.target.value)} maxLength={120} /></label>
            <button type="submit">Buscar</button>
            {buscaAplicada && <button type="button" onClick={() => { setBusca(''); setBuscaAplicada(''); setPagina(1); }}>Limpar</button>}
        </form>
        <div className={estilos.filtros} role="group" aria-label="Filtrar por situação">
            {FILTROS.map((f) => <button key={f.valor} type="button" aria-pressed={situacao === f.valor} onClick={() => { setSituacao(f.valor); setPagina(1); }}>{f.rotulo}</button>)}
        </div>
        {erro && <p role="alert">{erro}</p>}
        {carregando && !lista && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {lista && lista.itens.length === 0 && <div className={estilos.vazio}>{buscaAplicada ? 'Nenhuma empresa encontrada para esta busca.' : 'Nenhuma empresa nesta situação.'}</div>}
        {lista && lista.itens.length > 0 && <div className={admin.tableWrap} aria-busy={carregando}><table>
            <thead><tr><th>Empresa</th><th>Situação</th><th>Responsável</th><th>Acessos</th><th>Desde</th></tr></thead>
            <tbody>{lista.itens.map((e) => <tr key={e.id}>
                <td><Link href={`/desenvolvedor/empresas/${e.id}`}>{e.nome}</Link><small className={workspace.muted}>{e.codigo}{!e.temCadastro ? ' · sem cadastro administrativo' : ''}</small></td>
                <td><span className={estilos.selo} data-tom={tomSituacao(e.situacao)}>{e.situacaoRotulo}</span>{e.implantacaoRotulo && e.situacao === 'EM_IMPLANTACAO' && <small className={workspace.muted}>{e.implantacaoRotulo}</small>}</td>
                <td>{e.responsavelNome ?? '—'}{e.email && <small className={workspace.muted}>{e.email}</small>}</td>
                <td>{e.membrosAtivos} ativo(s){e.convitesPendentes > 0 && <small className={workspace.muted}>{e.convitesPendentes} convite(s) pendente(s)</small>}</td>
                <td>{formatarData(e.criadoEm, false)}</td>
            </tr>)}</tbody>
        </table></div>}
        {lista && lista.total > lista.porPagina && <div className={estilos.paginacao}>
            <button type="button" disabled={pagina <= 1 || carregando} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
            <span>Página {pagina} de {paginas} · {lista.total} registros</span>
            <button type="button" disabled={pagina >= paginas || carregando} onClick={() => setPagina((p) => p + 1)}>Próxima</button>
        </div>}
    </main>;
}
