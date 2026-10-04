'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarData, formatarDocumento, formatarTelefone, rotuloAcao } from './cliente';
import InteressadaForm, { corpoInteressada } from './InteressadaForm';
import { tomStatusInteressada } from './Interessadas';

type Interessada = {
    id: string; nome: string; nomeEmpresarial: string | null; documentoFiscal: string | null; responsavelNome: string | null; email: string | null;
    telefone: string | null; status: string; statusRotulo: string; observacoes: string | null; empresaId: string | null; empresaNome: string | null;
    criadoEm: string; atualizadoEm: string; revisao: number; criadoPorNome: string | null;
};
type Historico = { acao: string; criado_em: string; ator: string | null; dados_antes: Record<string, unknown> | null; dados_depois: Record<string, unknown> | null; justificativa: string | null };
const ROTULOS: Record<string, string> = { NOVA: 'Nova', EM_CONTATO: 'Em contato', PROPOSTA: 'Proposta enviada', CONVERTIDA: 'Contratante', DESCARTADA: 'Descartada' };

export default function InteressadaDetalhe({ id }: { id: string }) {
    const params = useSearchParams();
    const [dados, setDados] = useState<{ interessada: Interessada; historico: Historico[] } | null>(null);
    const [erro, setErro] = useState('');
    const [aviso, setAviso] = useState(params.get('criada') === '1' ? 'Interessada cadastrada. Nenhuma empresa, usuário ou acesso foi criado.' : '');
    const [editando, setEditando] = useState(false);
    const [motivo, setMotivo] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const carregar = useCallback(async () => {
        const r = await chamar<{ interessada: Interessada; historico: Historico[] }>(`/api/desenvolvedor/interessadas/${encodeURIComponent(id)}`);
        if (r.ok) { setDados(r.data); setErro(''); }
        else setErro(r.erro);
    }, [id]);
    useEffect(() => {
        let vivo = true;
        chamar<{ interessada: Interessada; historico: Historico[] }>(`/api/desenvolvedor/interessadas/${encodeURIComponent(id)}`).then((r) => {
            if (!vivo) return;
            if (r.ok) { setDados(r.data); setErro(''); }
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [id]);
    if (!dados)
        return <main className={admin.page}>{erro ? <p role="alert">{erro}</p> : <p className={workspace.muted} aria-live="polite">Carregando…</p>}<Link href="/desenvolvedor/interessadas">← Voltar para interessadas</Link></main>;
    const i = dados.interessada;
    const fechada = i.status === 'CONVERTIDA';
    async function mudarStatus(status: string) {
        if (status === 'DESCARTADA' && motivo.trim().length < 3) {
            setErro('Informe o motivo do descarte (mínimo de 3 caracteres).');
            return;
        }
        setOcupado(true);
        setAviso('');
        const r = await chamar<Interessada>(`/api/desenvolvedor/interessadas/${i.id}`, 'POST', { acao: 'status', dados: { status, motivo: motivo.trim() || null, revisao: i.revisao } });
        setOcupado(false);
        if (!r.ok) { setErro(r.erro); return; }
        setErro('');
        setMotivo('');
        setAviso(`Situação alterada para "${r.data.statusRotulo}".`);
        await carregar();
    }
    return <main className={admin.page}>
        <p><Link href="/desenvolvedor/interessadas">← Interessadas</Link></p>
        <div className={estilos.cabecalho}>
            <div><p className={estilos.sobretitulo}>Interessada</p><h1 className={estilos.empresaAtual}>{i.nome} <span className={estilos.selo} data-tom={tomStatusInteressada(i.status)}>{i.statusRotulo}</span></h1></div>
            <div className={workspace.actions}>
                {fechada && i.empresaId && <Link className={estilos.botaoLink} href={`/desenvolvedor/empresas/${i.empresaId}`}>Abrir contratante: {i.empresaNome}</Link>}
                {!fechada && i.status !== 'DESCARTADA' && <Link className={estilos.botaoPrimario} href={`/desenvolvedor/empresas/provisionar?interessada=${i.id}`}>Provisionar como contratante</Link>}
                {!fechada && !editando && <button type="button" onClick={() => setEditando(true)}>Editar dados</button>}
            </div>
        </div>
        {aviso && <p className={estilos.sucesso} role="status">{aviso}</p>}
        {erro && <p role="alert">{erro}</p>}
        {editando ? <section className={workspace.card} aria-labelledby="t-editar">
            <h2 id="t-editar">Editar dados</h2>
            <InteressadaForm rotuloEnviar="Salvar alterações" aoCancelar={() => setEditando(false)} inicial={{
                nome: i.nome, nomeEmpresarial: i.nomeEmpresarial ?? '', documentoFiscal: i.documentoFiscal ?? '', responsavelNome: i.responsavelNome ?? '',
                email: i.email ?? '', telefone: i.telefone ?? '', observacoes: i.observacoes ?? '',
            }} aoEnviar={async (campos, confirmar) => {
                const r = await chamar<Interessada>(`/api/desenvolvedor/interessadas/${i.id}`, 'PATCH', { ...corpoInteressada(campos), revisao: i.revisao, confirmarSemelhantes: confirmar || undefined });
                if (!r.ok) return r;
                setEditando(false);
                setAviso('Dados salvos.');
                await carregar();
                return null;
            }} />
        </section> : <section className={workspace.card} aria-labelledby="t-dados">
            <h2 id="t-dados">Dados comerciais</h2>
            <dl className={estilos.ficha}>
                <div><dt>Nome empresarial</dt><dd>{i.nomeEmpresarial ?? '—'}</dd></div>
                <div><dt>CPF/CNPJ</dt><dd>{formatarDocumento(i.documentoFiscal)}</dd></div>
                <div><dt>Responsável</dt><dd>{i.responsavelNome ?? '—'}</dd></div>
                <div><dt>E-mail</dt><dd>{i.email ?? '—'}</dd></div>
                <div><dt>Telefone</dt><dd>{formatarTelefone(i.telefone)}</dd></div>
                <div><dt>Cadastrada</dt><dd>{formatarData(i.criadoEm)}{i.criadoPorNome ? ` por ${i.criadoPorNome}` : ''}</dd></div>
            </dl>
            <h3>Observações administrativas</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{i.observacoes ?? '—'}</p>
        </section>}
        {!fechada && <section className={workspace.card} aria-labelledby="t-situacao">
            <h2 id="t-situacao">Acompanhamento</h2>
            <p className={workspace.muted}>Mudar a situação só registra o andamento comercial. A conversão em contratante acontece pelo provisionamento.</p>
            <label>Motivo ou anotação (obrigatório para descartar)<input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} /></label>
            <div className={estilos.acoesLinha}>
                {(['NOVA', 'EM_CONTATO', 'PROPOSTA', 'DESCARTADA'] as const).filter((s) => s !== i.status).map((s) => <button key={s} type="button" disabled={ocupado} className={s === 'DESCARTADA' ? 'danger' : undefined} onClick={() => void mudarStatus(s)}>
                    {i.status === 'DESCARTADA' && s !== 'DESCARTADA' ? `Reabrir como "${ROTULOS[s]}"` : s === 'DESCARTADA' ? 'Descartar' : `Marcar "${ROTULOS[s]}"`}
                </button>)}
            </div>
        </section>}
        <section className={workspace.card} aria-labelledby="t-historico">
            <h2 id="t-historico">Histórico</h2>
            {dados.historico.length === 0 ? <p className={workspace.muted}>Sem registros.</p> : <ul className={estilos.lista}>
                {dados.historico.map((h, n) => <li key={n}><strong>{rotuloAcao(h.acao)}</strong>
                    <span>{formatarData(h.criado_em)} · {h.ator ?? 'Sistema'}{h.dados_antes?.status && h.dados_depois?.status ? ` · ${ROTULOS[String(h.dados_antes.status)] ?? h.dados_antes.status} → ${ROTULOS[String(h.dados_depois.status)] ?? h.dados_depois.status}` : ''}
                        {Array.isArray(h.dados_depois?.alterados) ? ` · campos: ${(h.dados_depois.alterados as string[]).join(', ')}` : ''}{h.justificativa ? ` · “${h.justificativa}”` : ''}</span></li>)}
            </ul>}
        </section>
    </main>;
}
