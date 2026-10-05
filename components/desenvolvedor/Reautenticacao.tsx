'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { confirmarSenha, type Resposta } from './cliente';

/**
 * Operações de efeito exigem senha confirmada há no máximo 5 minutos (validado no servidor). Quando o servidor
 * responde REAUTENTICACAO, este hook pede a senha, confirma e repete a mesma operação uma vez.
 */
export function useReautenticacao() {
    const [pendente, setPendente] = useState<null | { repetir: () => Promise<void>; cancelar: () => void }>(null);
    const executar = useCallback(async <T,>(operacao: () => Promise<Resposta<T>>, aoConcluir: (r: Resposta<T>) => void) => {
        const r = await operacao();
        if (!r.ok && r.codigo === 'REAUTENTICACAO') {
            setPendente({ repetir: async () => aoConcluir(await operacao()), cancelar: () => aoConcluir({ ok: false, erro: 'Operação cancelada. Nada foi alterado.', codigo: 'CANCELADO', detalhes: null, status: 0 }) });
            return;
        }
        aoConcluir(r);
    }, []);
    const dialogo = <DialogoSenha aberto={Boolean(pendente)} aoCancelar={() => { pendente?.cancelar(); setPendente(null); }} aoConfirmar={async () => {
        const p = pendente;
        setPendente(null);
        await p?.repetir();
    }} />;
    return { executar, dialogo };
}

function DialogoSenha({ aberto, aoCancelar, aoConfirmar }: { aberto: boolean; aoCancelar: () => void; aoConfirmar: () => Promise<void> }) {
    const ref = useRef<HTMLDialogElement>(null);
    const [senha, setSenha] = useState('');
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    useEffect(() => {
        const d = ref.current;
        if (!d)
            return;
        if (aberto && !d.open)
            d.showModal();
        if (!aberto && d.open)
            d.close();
    }, [aberto]);
    return <dialog ref={ref} className={workspace.dialog} aria-labelledby="titulo-reautenticacao" onCancel={(e) => { e.preventDefault(); setSenha(''); setErro(''); aoCancelar(); }}>
        <form onSubmit={async (e) => {
            e.preventDefault();
            setOcupado(true);
            setErro('');
            const falha = await confirmarSenha(senha);
            setOcupado(false);
            if (falha) {
                setErro(falha);
                return;
            }
            setSenha('');
            await aoConfirmar();
        }}>
            <div className={workspace.dialogHeading}><h2 id="titulo-reautenticacao">Confirme sua senha</h2></div>
            <p className={workspace.muted}>Esta operação muda o acesso de uma empresa. Por segurança, confirme a senha da sua conta.</p>
            <label>Senha<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required autoFocus /></label>
            <p role="alert">{erro}</p>
            <div className={workspace.actions}>
                <button type="submit" disabled={ocupado || !senha}>{ocupado ? 'Confirmando…' : 'Confirmar e continuar'}</button>
                <button type="button" onClick={() => { setSenha(''); setErro(''); aoCancelar(); }}>Cancelar</button>
            </div>
        </form>
    </dialog>;
}
