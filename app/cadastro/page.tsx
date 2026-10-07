'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import { postarPublico } from '@/components/acesso/token';
import { dias } from '@/lib/assinatura/texto';

type Situacao = { ativo: boolean; testeDias: number | null; termos: string; privacidade: string };

/** Passo 1 do cadastro: a pessoa responsável. A conta só nasce quando o e-mail é confirmado. */
export default function Cadastro() {
    const [situacao, setSituacao] = useState<Situacao | null>(null);
    const [erroCarga, setErroCarga] = useState('');
    const [nome, setNome] = useState('');
    const [email, setEmail] = useState('');
    const [senha, setSenha] = useState('');
    const [confirmacao, setConfirmacao] = useState('');
    const [termos, setTermos] = useState(false);
    const [privacidade, setPrivacidade] = useState(false);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [enviado, setEnviado] = useState('');
    useEffect(() => {
        fetch('/api/cadastro', { cache: 'no-store' }).then((r) => r.json()).then((b) => b?.ok ? setSituacao(b.data) : setErroCarga('Não foi possível carregar o cadastro.'))
            .catch(() => setErroCarga('Falha de conexão. Tente novamente.'));
    }, []);
    return <main className={`${admin.page} ${admin.login}`} data-cadastro-pessoa>
        <h1>Kidmais Manager</h1>
        <h2>Criar conta da empresa</h2>
        {erroCarga && <p role="alert">{erroCarga}</p>}
        {!situacao && !erroCarga && <p aria-live="polite">Carregando…</p>}
        {situacao && !situacao.ativo && <>
            <p role="status">O cadastro de novas empresas ainda não está aberto. Fale com a Kidmais para começar.</p>
            <p><Link href="/planos">Conheça os planos</Link> · <Link href="/admin/login">Já tenho conta</Link></p>
        </>}
        {situacao?.ativo && (enviado ? <>
            <p role="status">{enviado}</p>
            <p>Abra o link do e-mail neste aparelho para continuar com os dados da empresa.</p>
        </> : <form onSubmit={async (e) => {
            e.preventDefault();
            if (senha !== confirmacao) { setErro('A senha e a confirmação não conferem.'); return; }
            setOcupado(true);
            setErro('');
            const r = await postarPublico<{ mensagem: string }>('/api/cadastro', {
                nome: nome.trim(), email: email.trim(), senha, confirmacao, aceiteTermos: termos, aceitePrivacidade: privacidade, termosVersao: situacao.termos, privacidadeVersao: situacao.privacidade,
            });
            setOcupado(false);
            if (r.ok) { setEnviado(r.data.mensagem); setSenha(''); setConfirmacao(''); }
            else setErro(r.erro);
        }}>
            <p>{situacao.testeDias ? `Teste grátis de ${dias(situacao.testeDias)}, sem cartão e sem cobrança automática.` : 'Teste grátis sem cartão e sem cobrança automática.'} Primeiro seus dados; depois de confirmar o e-mail, os dados da empresa.</p>
            <label>Seu nome<input value={nome} onChange={(e) => setNome(e.target.value)} required maxLength={120} autoComplete="name" /></label>
            <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" /></label>
            <label>Crie uma senha<input type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={8} maxLength={128} /></label>
            <small>Entre 8 e 128 caracteres.</small>
            <label>Confirme a senha<input type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required maxLength={128} /></label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={termos} onChange={(e) => setTermos(e.target.checked)} required style={{ width: 'auto' }} />
                <span>Li e aceito os <Link href="/termos" target="_blank">termos de uso</Link> (versão {situacao.termos}).</span></label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={privacidade} onChange={(e) => setPrivacidade(e.target.checked)} required style={{ width: 'auto' }} />
                <span>Li o <Link href="/privacidade" target="_blank">aviso de privacidade</Link> (versão {situacao.privacidade}).</span></label>
            <p role="alert">{erro}</p>
            <button type="submit" disabled={ocupado || !termos || !privacidade}>{ocupado ? 'Enviando…' : 'Continuar'}</button>
            <p><Link href="/admin/login">Já tenho conta</Link></p>
        </form>)}
    </main>;
}
