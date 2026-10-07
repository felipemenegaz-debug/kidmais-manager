'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';

type Socio = { nome: string; qualificacao: 'SOCIO' | 'ADMINISTRADOR' | 'SOCIO_ADMINISTRADOR' };
type Sessao = { nome: string; termos: string; privacidade: string };
const QUALIFICACAO = [
    { valor: 'SOCIO_ADMINISTRADOR', rotulo: 'Sou sócio(a) ou administrador(a) da empresa' },
    { valor: 'PROCURADOR', rotulo: 'Sou procurador(a) da empresa' },
    { valor: 'RESPONSAVEL_INDICADO', rotulo: 'Fui indicado(a) pela empresa para cuidar do sistema' },
] as const;

/**
 * Passo 3: dados da empresa (também para quem já tem conta e quer cadastrar outro CNPJ). Envio idempotente: a mesma
 * chave devolve a mesma empresa se o botão for usado duas vezes ou a conexão cair.
 */
export default function CadastroEmpresa() {
    const chave = useMemo(() => crypto.randomUUID(), []);
    const [sessao, setSessao] = useState<Sessao | null>(null);
    const csrf = useRef('');
    const [semSessao, setSemSessao] = useState(false);
    const [cnpj, setCnpj] = useState('');
    const [razaoSocial, setRazaoSocial] = useState('');
    const [nomeFantasia, setNomeFantasia] = useState('');
    const [telefone, setTelefone] = useState('');
    const [qualificacao, setQualificacao] = useState<string>('SOCIO_ADMINISTRADOR');
    const [socios, setSocios] = useState<Socio[]>([]);
    const [aceite, setAceite] = useState(false);
    const [senha, setSenha] = useState('');
    const [pedirSenha, setPedirSenha] = useState(false);
    const [erro, setErro] = useState('');
    const [aviso, setAviso] = useState('');
    const [ocupado, setOcupado] = useState(false);
    useEffect(() => {
        Promise.all([fetch('/api/admin/autenticacao', { cache: 'no-store' }).then((r) => r.json()), fetch('/api/cadastro', { cache: 'no-store' }).then((r) => r.json())]).then(([a, c]) => {
            if (!a?.ok || !a.data?.usuarioId) { setSemSessao(true); return; }
            csrf.current = a.data.csrf;
            setSessao({ nome: a.data.nome, termos: c?.data?.termos ?? '', privacidade: c?.data?.privacidade ?? '' });
        }).catch(() => setErro('Falha de conexão. Tente novamente.'));
    }, []);
    async function postar(url: string, corpo: unknown) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.current }, body: JSON.stringify(corpo), cache: 'no-store' });
        return { status: r.status, corpo: await r.json().catch(() => null) as { ok?: boolean; data?: { empresaId?: string; csrf?: string }; erro?: string; codigo?: string } | null };
    }
    async function enviar() {
        setOcupado(true);
        setErro('');
        setAviso('');
        if (pedirSenha) {
            const re = await postar('/api/admin/autenticacao', { acao: 'reautenticar', senha });
            if (re.status !== 200 || !re.corpo?.ok) { setOcupado(false); setErro(re.corpo?.erro ?? 'Senha não confirmada.'); return; }
            if (re.corpo.data?.csrf) csrf.current = re.corpo.data.csrf;
            setSenha('');
            setPedirSenha(false);
        }
        const r = await postar('/api/cadastro/empresa', {
            chave, cnpj, razaoSocial: razaoSocial.trim(), nomeFantasia: nomeFantasia.trim(), telefone: telefone.trim() || null, qualificacao,
            socios: socios.filter((s) => s.nome.trim()).map((s) => ({ ...s, nome: s.nome.trim() })),
            aceiteTermos: aceite, aceitePrivacidade: aceite, termosVersao: sessao!.termos, privacidadeVersao: sessao!.privacidade,
        });
        if (r.status === 403 && r.corpo?.codigo === 'REAUTENTICACAO') { setOcupado(false); setPedirSenha(true); setErro('Por segurança, confirme sua senha para cadastrar a empresa.'); return; }
        if (r.status === 409 && r.corpo?.codigo === 'CNPJ_EXISTENTE') { setOcupado(false); setAviso(r.corpo.erro ?? ''); return; }
        if (!r.corpo?.ok || !r.corpo.data?.empresaId) { setOcupado(false); setErro(r.corpo?.erro ?? 'Não foi possível cadastrar a empresa.'); return; }
        // A empresa nova vira a empresa ativa da sessão (mesma regra do seletor do Admin) e o início guiado abre.
        await postar('/api/admin/autenticacao', { acao: 'selecionar-empresa', empresaId: r.corpo.data.empresaId });
        window.location.replace('/admin/inicio');
    }
    if (semSessao)
        return <main className={`${admin.page} ${admin.login}`}><h1>Kidmais Manager</h1><p role="alert">Entre na sua conta para cadastrar a empresa.</p><p><Link href="/admin/login">Entrar</Link></p></main>;
    return <main className={`${admin.page} ${admin.login}`} data-cadastro-empresa>
        <h1>Kidmais Manager</h1>
        <h2>Dados da empresa</h2>
        {!sessao && !erro && <p aria-live="polite">Carregando…</p>}
        {sessao && <form onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
            <p>Olá, {sessao.nome}. Você será a pessoa responsável (Gestão) por esta empresa no sistema.</p>
            <label>CNPJ<input value={cnpj} onChange={(e) => setCnpj(e.target.value)} required maxLength={20} inputMode="text" autoComplete="off" /></label>
            <small>Conferimos os dígitos do CNPJ. Isso não comprova a existência da empresa nem quem a representa.</small>
            <label>Razão social<input value={razaoSocial} onChange={(e) => setRazaoSocial(e.target.value)} required maxLength={200} /></label>
            <label>Nome fantasia (como aparece para seus clientes)<input value={nomeFantasia} onChange={(e) => setNomeFantasia(e.target.value)} required maxLength={160} /></label>
            <label>Telefone da empresa (opcional)<input value={telefone} onChange={(e) => setTelefone(e.target.value)} maxLength={20} inputMode="tel" autoComplete="tel" /></label>
            <fieldset>
                <legend>Sua relação com a empresa</legend>
                {QUALIFICACAO.map((q) => <label key={q.valor} style={{ display: 'flex', gap: 8 }}><input type="radio" name="qualificacao" value={q.valor} checked={qualificacao === q.valor} onChange={() => setQualificacao(q.valor)} style={{ width: 'auto' }} />{q.rotulo}</label>)}
                <small>A representação fica registrada como declarada e pode ser confirmada pela Kidmais. Ela não muda o seu acesso.</small>
            </fieldset>
            <fieldset>
                <legend>Sócios (opcional)</legend>
                {socios.map((s, i) => <div key={i} style={{ display: 'grid', gap: 8 }}>
                    <label>Nome<input value={s.nome} onChange={(e) => setSocios(socios.map((x, j) => j === i ? { ...x, nome: e.target.value } : x))} maxLength={160} /></label>
                    <label>Qualificação<select value={s.qualificacao} onChange={(e) => setSocios(socios.map((x, j) => j === i ? { ...x, qualificacao: e.target.value as Socio['qualificacao'] } : x))}>
                        <option value="SOCIO_ADMINISTRADOR">Sócio(a) administrador(a)</option><option value="SOCIO">Sócio(a)</option><option value="ADMINISTRADOR">Administrador(a)</option></select></label>
                    <button type="button" onClick={() => setSocios(socios.filter((_, j) => j !== i))}>Remover</button>
                </div>)}
                {socios.length < 10 && <button type="button" onClick={() => setSocios([...socios, { nome: '', qualificacao: 'SOCIO_ADMINISTRADOR' }])}>Adicionar sócio</button>}
            </fieldset>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} required style={{ width: 'auto' }} />
                <span>Em nome da empresa, aceito os <Link href="/termos" target="_blank">termos de uso</Link> e li o <Link href="/privacidade" target="_blank">aviso de privacidade</Link>.</span></label>
            {pedirSenha && <label>Sua senha<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required maxLength={512} /></label>}
            {aviso && <p role="status" data-cnpj-existente>{aviso}</p>}
            <p role="alert">{erro}</p>
            <button type="submit" disabled={ocupado || !aceite || (pedirSenha && !senha)}>{ocupado ? 'Cadastrando…' : 'Cadastrar empresa e começar o teste'}</button>
        </form>}
    </main>;
}
