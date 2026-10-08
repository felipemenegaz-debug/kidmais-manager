'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, formatarTelefone } from './cliente';
import InteressadaForm, { camposVazios, corpoInteressada } from './InteressadaForm';

type Item = { id: string; nome: string; nomeEmpresarial: string | null; responsavelNome: string | null; email: string | null; telefone: string | null; status: string; statusRotulo: string; atualizadoEm: string; empresaId: string | null };
type Lista = { itens: Item[]; total: number; pagina: number; porPagina: number; contagem: Record<string, number> };

const FILTROS = [
    { valor: 'ABERTAS', rotulo: 'Em aberto' }, { valor: 'NOVA', rotulo: 'Novas' }, { valor: 'EM_CONTATO', rotulo: 'Em contato' },
    { valor: 'PROPOSTA', rotulo: 'Proposta' }, { valor: 'CONVERTIDA', rotulo: 'Contratantes' }, { valor: 'DESCARTADA', rotulo: 'Descartadas' }, { valor: 'TODAS', rotulo: 'Todas' },
];

export function tomStatusInteressada(status: string) {
    return status === 'CONVERTIDA' ? 'ok' : status === 'DESCARTADA' ? undefined : 'info';
}

export default function Interessadas() {
    const router = useRouter();
    const params = useSearchParams();
    const [status, setStatus] = useState('ABERTAS');
    const [busca, setBusca] = useState('');
    const [buscaAplicada, setBuscaAplicada] = useState('');
    const [pagina, setPagina] = useState(1);
    const [lista, setLista] = useState<Lista | null>(null);
    const [erro, setErro] = useState('');
    const consulta = (() => { const q = new URLSearchParams({ status, pagina: String(pagina) }); if (buscaAplicada) q.set('busca', buscaAplicada); return `/api/desenvolvedor/interessadas?${q}`; })();
    const [novaAberta, setNovaAberta] = useState(params.get('nova') === '1');
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
            <div><p className={estilos.sobretitulo}>Comercial</p><h1>Interessadas</h1></div>
            <div className={workspace.actions}><button type="button" onClick={() => setNovaAberta((v) => !v)} aria-expanded={novaAberta}>{novaAberta ? 'Fechar cadastro' : 'Nova interessada'}</button></div>
        </div>
        {novaAberta && <section className={workspace.card} aria-labelledby="t-nova">
            <h2 id="t-nova">Nova interessada</h2>
            <InteressadaForm inicial={camposVazios} rotuloEnviar="Cadastrar interessada" aoCancelar={() => setNovaAberta(false)} aoEnviar={async (campos, confirmar) => {
                const r = await chamar<{ id: string }>('/api/desenvolvedor/interessadas', 'POST', { ...corpoInteressada(campos), confirmarSemelhantes: confirmar || undefined });
                if (!r.ok) return r;
                router.push(`/desenvolvedor/interessadas/${r.data.id}?criada=1`);
                return null;
            }} />
        </section>}
        <form className={estilos.busca} role="search" onSubmit={(e) => { e.preventDefault(); setPagina(1); setBuscaAplicada(busca.trim()); }}>
            <label>Buscar por nome, e-mail, documento ou telefone<input value={busca} onChange={(e) => setBusca(e.target.value)} maxLength={120} /></label>
            <button type="submit">Buscar</button>
            {buscaAplicada && <button type="button" onClick={() => { setBusca(''); setBuscaAplicada(''); setPagina(1); }}>Limpar</button>}
        </form>
        <div className={estilos.filtros} role="group" aria-label="Filtrar por situação">
            {FILTROS.map((f) => <button key={f.valor} type="button" aria-pressed={status === f.valor} onClick={() => { setStatus(f.valor); setPagina(1); }}>
                {f.rotulo}{lista && f.valor in lista.contagem ? ` (${lista.contagem[f.valor]})` : ''}
            </button>)}
        </div>
        {erro && <p role="alert">{erro}</p>}
        {carregando && !lista && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {lista && lista.itens.length === 0 && <div className={estilos.vazio}>{buscaAplicada ? 'Nenhuma interessada encontrada para esta busca.' : 'Nenhuma interessada nesta situação.'}</div>}
        {lista && lista.itens.length > 0 && <div className={`${admin.tableWrap} ${estilos.tabela}`} aria-busy={carregando}><table>
            <thead><tr><th>Empresa</th><th>Responsável</th><th>Contato</th><th>Situação</th><th>Atualizada</th></tr></thead>
            <tbody>{lista.itens.map((i) => <tr key={i.id}>
                <td><Link href={`/desenvolvedor/interessadas/${i.id}`}>{i.nome}</Link>{i.nomeEmpresarial && <small className={workspace.muted}>{i.nomeEmpresarial}</small>}</td>
                <td>{i.responsavelNome ?? '—'}</td>
                <td>{i.email ?? '—'}<br /><span className={workspace.muted}>{formatarTelefone(i.telefone)}</span></td>
                <td><span className={estilos.selo} data-tom={tomStatusInteressada(i.status)}>{i.statusRotulo}</span></td>
                <td>{formatarData(i.atualizadoEm)}</td>
            </tr>)}</tbody>
        </table></div>}
        {lista && lista.total > lista.porPagina && <div className={estilos.paginacao}>
            <button type="button" disabled={pagina <= 1 || carregando} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
            <span>Página {pagina} de {paginas} · {lista.total} registros</span>
            <button type="button" disabled={pagina >= paginas || carregando} onClick={() => setPagina((p) => p + 1)}>Próxima</button>
        </div>}
    </main>;
}
