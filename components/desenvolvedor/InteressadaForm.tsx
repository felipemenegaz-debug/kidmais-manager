'use client';
import { useState } from 'react';
import Link from 'next/link';
import estilos from './desenvolvedor.module.css';
import type { Falha } from './cliente';

export type CamposInteressada = {
    nome: string; nomeEmpresarial: string; documentoFiscal: string; responsavelNome: string; email: string; telefone: string; observacoes: string;
};
export const camposVazios: CamposInteressada = { nome: '', nomeEmpresarial: '', documentoFiscal: '', responsavelNome: '', email: '', telefone: '', observacoes: '' };

type Semelhante = { id: string; nome: string; status: string; motivo: string; empresaId?: string | null };
const MOTIVO: Record<string, string> = { DOCUMENTO: 'mesmo documento', EMAIL: 'mesmo e-mail', TELEFONE: 'mesmo telefone', NOME: 'mesmo nome', DOCUMENTO_CONTRATANTE: 'documento de uma contratante' };

/**
 * Formulário de interessada (cadastro e edição). A validação definitiva é do servidor; aqui só o mínimo para não
 * enviar vazio. Duplicidade bloqueante aparece como erro; semelhança (telefone/nome) pede confirmação explícita.
 */
export default function InteressadaForm({ inicial, rotuloEnviar, aoEnviar, aoCancelar }: {
    inicial: CamposInteressada;
    rotuloEnviar: string;
    aoEnviar: (campos: CamposInteressada, confirmarSemelhantes: boolean) => Promise<Falha | null>;
    aoCancelar?: () => void;
}) {
    const [campos, setCampos] = useState(inicial);
    const [falha, setFalha] = useState<Falha | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const semelhantes = (falha?.codigo === 'DUPLICIDADE' ? (falha.detalhes?.semelhantes as Semelhante[] | undefined) : undefined) ?? [];
    const podeConfirmarSemelhantes = falha?.codigo === 'DUPLICIDADE' && falha.detalhes?.bloqueante === false;
    const set = (k: keyof CamposInteressada) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setCampos((c) => ({ ...c, [k]: e.target.value }));
    async function enviar(confirmar: boolean) {
        setOcupado(true);
        setFalha(null);
        const r = await aoEnviar(campos, confirmar);
        setOcupado(false);
        setFalha(r);
    }
    return <form onSubmit={(e) => { e.preventDefault(); void enviar(false); }} noValidate>
        <div className={estilos.formGrid}>
            <label className={estilos.inteira}>Nome da empresa *<input value={campos.nome} onChange={set('nome')} required maxLength={160} autoComplete="organization" /></label>
            <label>Nome empresarial (razão social)<input value={campos.nomeEmpresarial} onChange={set('nomeEmpresarial')} maxLength={200} /></label>
            <label>CPF ou CNPJ<input value={campos.documentoFiscal} onChange={set('documentoFiscal')} maxLength={40} inputMode="text" /></label>
            <label>Responsável<input value={campos.responsavelNome} onChange={set('responsavelNome')} maxLength={160} autoComplete="name" /></label>
            <label>E-mail<input type="email" value={campos.email} onChange={set('email')} maxLength={254} autoComplete="email" /></label>
            <label>Telefone (com DDD)<input type="tel" value={campos.telefone} onChange={set('telefone')} maxLength={40} autoComplete="tel" /></label>
            <label className={estilos.inteira}>Observações administrativas<textarea rows={4} value={campos.observacoes} onChange={set('observacoes')} maxLength={4000} /></label>
        </div>
        <p className={estilos.metricaDetalhe}>* obrigatório. Informe ao menos um contato (e-mail ou telefone). Nada aqui cria empresa, usuário ou acesso.</p>
        {falha && <div role="alert">
            <p style={{ margin: 0 }}>{falha.erro}</p>
            {semelhantes.length > 0 && <ul className={estilos.efeitos}>{semelhantes.map((s) => <li key={`${s.motivo}-${s.id}`}>
                {s.motivo === 'DOCUMENTO_CONTRATANTE' ? <Link href={`/desenvolvedor/empresas/${s.empresaId ?? s.id}`}>{s.nome}</Link> : <Link href={`/desenvolvedor/interessadas/${s.id}`}>{s.nome}</Link>} — {MOTIVO[s.motivo] ?? s.motivo}
            </li>)}</ul>}
        </div>}
        <div className={estilos.acoesLinha} style={{ marginTop: 16 }}>
            <button type="submit" disabled={ocupado || campos.nome.trim().length < 2}>{ocupado ? 'Salvando…' : rotuloEnviar}</button>
            {podeConfirmarSemelhantes && <button type="button" disabled={ocupado} onClick={() => void enviar(true)}>Conferi: salvar mesmo assim</button>}
            {aoCancelar && <button type="button" onClick={aoCancelar} disabled={ocupado}>Cancelar</button>}
        </div>
    </form>;
}

export function corpoInteressada(c: CamposInteressada) {
    const opcional = (v: string) => (v.trim() ? v.trim() : null);
    return {
        nome: c.nome, nomeEmpresarial: opcional(c.nomeEmpresarial), documentoFiscal: opcional(c.documentoFiscal), responsavelNome: opcional(c.responsavelNome),
        email: opcional(c.email), telefone: opcional(c.telefone), observacoes: opcional(c.observacoes),
    };
}
