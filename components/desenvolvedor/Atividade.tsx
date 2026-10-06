'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, rotuloAcao } from './cliente';
import { rotuloResultado } from './PainelResumo';

type Registro = {
    id: string; acao: string; origem: string; criadoEm: string; ator: string | null; empresaId: string | null; empresa: string | null;
    entidadeTipo: string; resultado: string | null; justificativa: string | null; antes: Record<string, unknown> | null; depois: Record<string, unknown> | null;
};
type Consulta = { itens: Registro[]; total: number; pagina: number; porPagina: number; acoes: string[]; empresas: Array<{ id: string; nome: string }> };

const UUID = /^[0-9a-f-]{36}$/i;
const ROTULO_STATUS: Record<string, string> = { NOVA: 'Nova', EM_CONTATO: 'Em contato', PROPOSTA: 'Proposta enviada', CONVERTIDA: 'Contratante', DESCARTADA: 'Descartada', ATIVA: 'Ativa', SUSPENSA: 'Suspensa', REVOGADA: 'Removida', DESATIVADA: 'Desativada', PROVISIONAMENTO: 'Em provisionamento' };

/** Resumo legível dos dados do registro (já sanitizados no servidor): situação antes → depois, campos alterados, e-mail, papel. */
export function detalhesDoRegistro(r: Registro) {
    const partes: string[] = [];
    const a = r.antes ?? {}, d = r.depois ?? {};
    if (typeof a.status === 'string' && typeof d.status === 'string')
        partes.push(`${ROTULO_STATUS[a.status] ?? a.status} → ${ROTULO_STATUS[d.status] ?? d.status}`);
    else if (typeof d.status === 'string')
        partes.push(ROTULO_STATUS[d.status] ?? d.status);
    if (typeof a.implantacao === 'string' || typeof d.implantacao === 'string')
        partes.push(`implantação: ${String(a.implantacao ?? '—')} → ${String(d.implantacao ?? '—')}`);
    if (Array.isArray(d.alterados) && d.alterados.length)
        partes.push(`campos: ${(d.alterados as unknown[]).map(String).join(', ')}`);
    if (typeof d.email === 'string')
        partes.push(d.email);
    if (typeof d.papel === 'string')
        partes.push(d.papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe');
    if (typeof d.motivo === 'string' && d.motivo)
        partes.push(String(d.motivo));
    if (Array.isArray(d.pendencias) && d.pendencias.length)
        partes.push(`pendências: ${(d.pendencias as unknown[]).map(String).join(', ')}`);
    if (typeof d.sessoesEncerradas === 'number' && d.sessoesEncerradas > 0)
        partes.push(`${d.sessoesEncerradas} sessão(ões) encerrada(s)`);
    if (r.justificativa)
        partes.push(`“${r.justificativa}”`);
    return partes.join(' · ');
}

export default function Atividade() {
    const params = useSearchParams();
    const empresaInicial = params.get('empresaId');
    const [empresaId, setEmpresaId] = useState(empresaInicial && UUID.test(empresaInicial) ? empresaInicial : '');
    const [acao, setAcao] = useState(params.get('acao') ?? '');
    const [de, setDe] = useState('');
    const [ate, setAte] = useState('');
    const [pagina, setPagina] = useState(1);
    const [dados, setDados] = useState<Consulta | null>(null);
    const [erro, setErro] = useState('');
    const consulta = (() => {
        const q = new URLSearchParams({ pagina: String(pagina) });
        if (empresaId) q.set('empresaId', empresaId);
        if (acao) q.set('acao', acao);
        if (de) q.set('de', de);
        if (ate) q.set('ate', ate);
        return `/api/desenvolvedor/auditoria?${q}`;
    })();
    const [carregada, setCarregada] = useState<string | null>(null);
    const carregando = carregada !== consulta;
    useEffect(() => {
        let vivo = true;
        chamar<Consulta>(consulta).then((r) => {
            if (!vivo) return;
            setCarregada(consulta);
            if (r.ok) { setDados(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [consulta]);
    const paginas = dados ? Math.max(1, Math.ceil(dados.total / dados.porPagina)) : 1;
    const empresaFiltrada = dados?.empresas.find((e) => e.id === empresaId) ?? null;
    return <main className={admin.page}>
        <div className={estilos.cabecalho}>
            <div><p className={estilos.sobretitulo}>Operação</p><h1>Atividade administrativa</h1></div>
            {empresaFiltrada && <div className={workspace.actions}><Link className={estilos.botaoLink} href={`/desenvolvedor/empresas/${empresaFiltrada.id}`}>Abrir ficha de {empresaFiltrada.nome}</Link></div>}
        </div>
        <p className={workspace.muted}>Quem fez, quando, ação, motivo e resultado das operações administrativas da plataforma. Nenhum dado de clientes, contratos, documentos ou pagamentos aparece aqui.</p>
        <form className={estilos.busca} role="search" onSubmit={(e) => { e.preventDefault(); setPagina(1); }}>
            <label>Empresa<select value={empresaId} onChange={(e) => { setEmpresaId(e.target.value); setPagina(1); }}>
                <option value="">Todas</option>
                {(dados?.empresas ?? (empresaFiltrada ? [empresaFiltrada] : [])).map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select></label>
            <label>Ação<select value={acao} onChange={(e) => { setAcao(e.target.value); setPagina(1); }}>
                <option value="">Todas</option>
                {(dados?.acoes ?? (acao ? [acao] : [])).map((a) => <option key={a} value={a}>{rotuloAcao(a)}</option>)}
            </select></label>
            <label>De<input type="date" value={de} onChange={(e) => { setDe(e.target.value); setPagina(1); }} /></label>
            <label>Até<input type="date" value={ate} onChange={(e) => { setAte(e.target.value); setPagina(1); }} /></label>
            {(empresaId || acao || de || ate) && <button type="button" onClick={() => { setEmpresaId(''); setAcao(''); setDe(''); setAte(''); setPagina(1); }}>Limpar filtros</button>}
        </form>
        {de && ate && de > ate && <p role="alert">A data inicial é posterior à final; nenhum registro é mostrado.</p>}
        {erro && <p role="alert">{erro}</p>}
        {carregando && !dados && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {dados && dados.itens.length === 0 && <div className={estilos.vazio}>Nenhum registro para estes filtros.</div>}
        {dados && dados.itens.length > 0 && <div className={admin.tableWrap} aria-busy={carregando}><table>
            <thead><tr><th>Quando</th><th>Ação</th><th>Empresa</th><th>Quem</th><th>Resultado</th><th>Detalhes</th></tr></thead>
            <tbody>{dados.itens.map((r) => <tr key={r.id}>
                <td>{formatarData(r.criadoEm)}</td>
                <td>{rotuloAcao(r.acao)}<small className={workspace.muted}>{r.origem.toLowerCase().replace(/_/g, ' ')}</small></td>
                <td>{r.empresaId ? <Link href={`/desenvolvedor/empresas/${r.empresaId}`}>{r.empresa ?? 'Empresa'}</Link> : '—'}</td>
                <td>{r.ator ?? 'Sistema'}</td>
                <td>{rotuloResultado(r.resultado)}</td>
                <td style={{ overflowWrap: 'anywhere' }}>{detalhesDoRegistro(r) || '—'}</td>
            </tr>)}</tbody>
        </table></div>}
        {dados && dados.total > dados.porPagina && <div className={estilos.paginacao}>
            <button type="button" disabled={pagina <= 1 || carregando} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
            <span>Página {pagina} de {paginas} · {dados.total} registros</span>
            <button type="button" disabled={pagina >= paginas || carregando} onClick={() => setPagina((p) => p + 1)}>Próxima</button>
        </div>}
    </main>;
}
