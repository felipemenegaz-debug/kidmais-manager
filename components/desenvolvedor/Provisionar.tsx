'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from './desenvolvedor.module.css';
import { chamar, formatarDocumento, formatarTelefone } from './cliente';
import { useReautenticacao } from './Reautenticacao';

type Campos = { nome: string; codigo: string; nomeEmpresarial: string; documentoFiscal: string; responsavelNome: string; email: string; telefone: string; observacoes: string };
type Previa = {
    dados: { nome: string; codigo: string; nomeEmpresarial: string | null; documentoFiscal: string | null; responsavelNome: string; email: string; telefone: string | null; observacoes: string | null; interessadaId: string | null };
    interessada: { id: string; nome: string; status: string } | null;
    efeitos: string[]; conflitos: string[]; podeConfirmar: boolean;
};
type Resultado = { empresaId: string; codigo: string; conviteId: string; envio: { enviado: boolean; destino: string; motivo?: string } };

/**
 * Provisionamento em dois passos: (1) prévia no servidor, sem escrita, com dados normalizados, efeitos e conflitos;
 * (2) confirmação explícita, com senha confirmada há no máximo 5 min. O resultado real (inclusive envio) é exibido.
 */
export default function Provisionar({ interessadaId }: { interessadaId: string | null }) {
    const router = useRouter();
    const { executar, dialogo } = useReautenticacao();
    const [campos, setCampos] = useState<Campos>({ nome: '', codigo: '', nomeEmpresarial: '', documentoFiscal: '', responsavelNome: '', email: '', telefone: '', observacoes: '' });
    const [carregandoInteressada, setCarregandoInteressada] = useState(Boolean(interessadaId));
    const [previa, setPrevia] = useState<Previa | null>(null);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [resultado, setResultado] = useState<Resultado | null>(null);
    useEffect(() => {
        if (!interessadaId)
            return;
        chamar<{ interessada: { nome: string; nomeEmpresarial: string | null; documentoFiscal: string | null; responsavelNome: string | null; email: string | null; telefone: string | null; observacoes: string | null } }>(`/api/desenvolvedor/interessadas/${interessadaId}`).then((r) => {
            setCarregandoInteressada(false);
            if (!r.ok) { setErro(r.erro); return; }
            const i = r.data.interessada;
            setCampos((c) => ({ ...c, nome: i.nome, nomeEmpresarial: i.nomeEmpresarial ?? '', documentoFiscal: i.documentoFiscal ?? '', responsavelNome: i.responsavelNome ?? '', email: i.email ?? '', telefone: i.telefone ?? '', observacoes: i.observacoes ?? '' }));
        });
    }, [interessadaId]);
    const corpo = (confirmar: boolean) => {
        const op = (v: string) => (v.trim() ? v.trim() : null);
        return { interessadaId, nome: campos.nome, codigo: op(campos.codigo) ?? undefined, nomeEmpresarial: op(campos.nomeEmpresarial), documentoFiscal: op(campos.documentoFiscal), responsavelNome: campos.responsavelNome, email: campos.email, telefone: op(campos.telefone), observacoes: op(campos.observacoes), confirmar: confirmar || undefined };
    };
    const set = (k: keyof Campos) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setCampos((c) => ({ ...c, [k]: e.target.value })); setPrevia(null); };
    if (resultado)
        return <main className={admin.page}>
            <h1>Contratante provisionada</h1>
            <p className={estilos.sucesso} role="status">A empresa foi criada (código <b>{resultado.codigo}</b>) e o convite do responsável foi registrado.</p>
            {resultado.envio.enviado
                ? <p className={estilos.sucesso}>Convite enviado para {resultado.envio.destino}. Ele vale por 7 dias.</p>
                : <p className={estilos.alerta} role="alert"><strong>O convite NÃO foi enviado:</strong> {resultado.envio.motivo} Use “Reenviar” na ficha da empresa quando o envio estiver disponível.</p>}
            <div className={workspace.actions}><Link className={estilos.botaoPrimario} href={`/desenvolvedor/empresas/${resultado.empresaId}`}>Abrir ficha da empresa</Link></div>
        </main>;
    return <main className={admin.page}>
        <p><Link href={interessadaId ? `/desenvolvedor/interessadas/${interessadaId}` : '/desenvolvedor/empresas'}>← Voltar</Link></p>
        <div className={estilos.cabecalho}><div><p className={estilos.sobretitulo}>Provisionamento</p><h1>Provisionar contratante</h1></div></div>
        {carregandoInteressada && <p className={workspace.muted} aria-live="polite">Carregando dados da interessada…</p>}
        {erro && <p role="alert">{erro}</p>}
        <section className={workspace.card} aria-labelledby="t-dados">
            <h2 id="t-dados">Dados da contratante e do responsável inicial</h2>
            <form onSubmit={async (e) => {
                e.preventDefault();
                setOcupado(true);
                setErro('');
                const r = await chamar<Previa>('/api/desenvolvedor/empresas', 'POST', { acao: 'previa', dados: corpo(false) });
                setOcupado(false);
                if (r.ok) setPrevia(r.data);
                else { setPrevia(null); setErro(r.erro); }
            }}>
                <div className={estilos.formGrid}>
                    <label>Nome da empresa *<input value={campos.nome} onChange={set('nome')} required maxLength={160} /></label>
                    <label>Código (opcional; gerado do nome)<input value={campos.codigo} onChange={set('codigo')} maxLength={64} pattern="[a-z][a-z0-9-]{2,63}" placeholder="ex.: buffet-alegria" /></label>
                    <label>Nome empresarial<input value={campos.nomeEmpresarial} onChange={set('nomeEmpresarial')} maxLength={200} /></label>
                    <label>CPF ou CNPJ<input value={campos.documentoFiscal} onChange={set('documentoFiscal')} maxLength={40} /></label>
                    <label>Responsável inicial *<input value={campos.responsavelNome} onChange={set('responsavelNome')} required maxLength={120} /></label>
                    <label>E-mail do responsável *<input type="email" value={campos.email} onChange={set('email')} required maxLength={254} /></label>
                    <label>Telefone<input type="tel" value={campos.telefone} onChange={set('telefone')} maxLength={40} /></label>
                    <label className={estilos.inteira}>Observações administrativas<textarea rows={3} value={campos.observacoes} onChange={set('observacoes')} maxLength={4000} /></label>
                </div>
                <div className={estilos.acoesLinha}><button type="submit" disabled={ocupado}>{ocupado && !previa ? 'Conferindo…' : 'Revisar efeitos'}</button></div>
            </form>
        </section>
        {previa && <section className={workspace.card} aria-labelledby="t-confirmar">
            <h2 id="t-confirmar">Confirme a operação</h2>
            <dl className={estilos.ficha}>
                <div><dt>Empresa</dt><dd>{previa.dados.nome}</dd></div>
                <div><dt>Código</dt><dd>{previa.dados.codigo}</dd></div>
                <div><dt>Documento</dt><dd>{formatarDocumento(previa.dados.documentoFiscal)}</dd></div>
                <div><dt>Responsável</dt><dd>{previa.dados.responsavelNome}</dd></div>
                <div><dt>E-mail</dt><dd>{previa.dados.email}</dd></div>
                <div><dt>Telefone</dt><dd>{formatarTelefone(previa.dados.telefone)}</dd></div>
            </dl>
            <h3>O que vai acontecer</h3>
            <ul className={estilos.efeitos}>{previa.efeitos.map((e) => <li key={e}>{e}</li>)}</ul>
            {previa.conflitos.length > 0 && <div role="alert"><strong>Não é possível provisionar:</strong><ul className={estilos.efeitos}>{previa.conflitos.map((c) => <li key={c}>{c}</li>)}</ul></div>}
            <div className={estilos.acoesLinha}>
                <button type="button" data-km-primario className={estilos.botaoPrimario} disabled={!previa.podeConfirmar || ocupado} onClick={() => {
                    setOcupado(true);
                    setErro('');
                    void executar(() => chamar<Resultado>('/api/desenvolvedor/empresas', 'POST', { acao: 'provisionar', dados: corpo(true) }), (r) => {
                        setOcupado(false);
                        if (r.ok) { setResultado(r.data); router.refresh(); }
                        else setErro(r.erro);
                    });
                }}>{ocupado ? 'Provisionando…' : 'Confirmar provisionamento'}</button>
                <button type="button" onClick={() => setPrevia(null)} disabled={ocupado}>Revisar dados</button>
            </div>
        </section>}
        {dialogo}
    </main>;
}
