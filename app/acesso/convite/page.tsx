'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { postarPublico, useTokenDoFragmento } from '@/components/acesso/token';

type Consulta = { situacao: 'INVALIDO' } | { situacao: 'PENDENTE' | 'EXPIRADO' | 'ACEITO' | 'CANCELADO' | 'EMPRESA_INDISPONIVEL'; empresa: string; email: string; nivel: string; contaExistente: boolean };
const MENSAGEM: Record<string, string> = {
    INVALIDO: 'Este link de convite é inválido. Confira se abriu o link completo do e-mail.',
    EXPIRADO: 'Este convite expirou. Peça um novo convite a quem enviou.',
    ACEITO: 'Este convite já foi aceito. Entre com seu e-mail e senha.',
    CANCELADO: 'Este convite foi cancelado. Peça um novo convite a quem enviou.',
    EMPRESA_INDISPONIVEL: 'O acesso a esta empresa está indisponível no momento.',
};

export default function AceitarConvite() {
    const token = useTokenDoFragmento();
    const [consultaServidor, setConsulta] = useState<Consulta | null>(null);
    const [erro, setErro] = useState('');
    const [nome, setNome] = useState('');
    const [senha, setSenha] = useState('');
    const [confirmacao, setConfirmacao] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [aceito, setAceito] = useState<{ empresa: string; contaNova: boolean } | null>(null);
    useEffect(() => {
        if (!token) return;
        let vivo = true;
        postarPublico<Consulta>('/api/acesso/convite', { acao: 'consultar', dados: { token } }).then((r) => {
            if (!vivo) return;
            if (r.ok) setConsulta(r.data);
            else setErro(r.erro);
        });
        return () => { vivo = false; };
    }, [token]);
    const consulta: Consulta | null = token === null ? { situacao: 'INVALIDO' } : consultaServidor;
    return <main className={`${admin.page} ${admin.login}`}>
        <h1>Kidmais Manager</h1>
        <h2>Convite de acesso</h2>
        {!consulta && !erro && <p aria-live="polite">Conferindo o convite…</p>}
        {erro && !consulta && <p role="alert">{erro}</p>}
        {aceito ? <>
            <p role="status">Pronto! Seu acesso a <b>{aceito.empresa}</b> está ativo{aceito.contaNova ? ' e sua conta foi criada' : ''}.</p>
            <p><Link href="/admin/login">Entrar no Kidmais Manager</Link></p>
        </> : consulta && consulta.situacao !== 'PENDENTE' ? <>
            <p role="alert">{MENSAGEM[consulta.situacao]}</p>
            <p><Link href="/admin/login">Ir para o login</Link></p>
        </> : consulta && consulta.situacao === 'PENDENTE' && <form onSubmit={async (e) => {
            e.preventDefault();
            if (!consulta.contaExistente && senha !== confirmacao) { setErro('A senha e a confirmação não conferem.'); return; }
            setOcupado(true);
            setErro('');
            const dados = consulta.contaExistente ? { token, senha } : { token, nome: nome.trim(), senha, confirmacao };
            const r = await postarPublico<{ empresa: string; contaNova: boolean }>('/api/acesso/convite', { acao: 'aceitar', dados });
            setOcupado(false);
            if (r.ok) { setAceito(r.data); setSenha(''); setConfirmacao(''); }
            else setErro(r.erro);
        }}>
            <p>Você foi convidado para acessar <b>{consulta.empresa}</b> como <b>{consulta.nivel}</b>.</p>
            <p>E-mail do convite: <b>{consulta.email}</b></p>
            {consulta.contaExistente ? <>
                <p>Este e-mail já tem uma conta no Kidmais Manager. Confirme com a sua senha atual para aceitar.</p>
                <label>Senha atual<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required maxLength={512} /></label>
                <p><Link href="/acesso/recuperar">Esqueci minha senha</Link></p>
            </> : <>
                <label>Seu nome<input value={nome} onChange={(e) => setNome(e.target.value)} required maxLength={120} autoComplete="name" /></label>
                <label>Crie uma senha<input type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={8} maxLength={128} /></label>
                <small>Entre 8 e 128 caracteres.</small>
                <label>Confirme a senha<input type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required maxLength={128} /></label>
            </>}
            <p role="alert">{erro}</p>
            <button type="submit" disabled={ocupado || !senha || (!consulta.contaExistente && (!nome.trim() || !confirmacao))}>{ocupado ? 'Confirmando…' : 'Aceitar convite'}</button>
        </form>}
    </main>;
}
