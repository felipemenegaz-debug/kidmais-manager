'use client';
import { useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';

/**
 * Troca da própria senha. Política: 8 a 128 caracteres, diferente da atual. Ao concluir, todas as sessões da conta
 * são encerradas (outros dispositivos saem) e este navegador continua com uma sessão nova emitida pelo servidor.
 */
export default function PerfilSenha() {
    const [atual, setAtual] = useState('');
    const [nova, setNova] = useState('');
    const [confirmacao, setConfirmacao] = useState('');
    const [erro, setErro] = useState('');
    const [sucesso, setSucesso] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const tamanho = [...nova].length;
    const problemaLocal = nova && (tamanho < 8 || tamanho > 128) ? 'A nova senha deve ter entre 8 e 128 caracteres.'
        : confirmacao && nova !== confirmacao ? 'A confirmação não confere com a nova senha.'
            : nova && atual && nova === atual ? 'A nova senha precisa ser diferente da atual.' : '';
    return <main className={admin.page} data-profile-page>
        <h1>Meu perfil</h1>
        <section className={workspace.card} aria-labelledby="t-senha" style={{ maxWidth: 640 }}>
            <h2 id="t-senha">Trocar senha</h2>
            <p className={workspace.muted}>Ao trocar a senha, todas as suas sessões em outros dispositivos são encerradas. Você continua conectado neste navegador.</p>
            <form onSubmit={async (e) => {
                e.preventDefault();
                if (problemaLocal) { setErro(problemaLocal); return; }
                setOcupado(true);
                setErro('');
                setSucesso('');
                try {
                    const res = await adminFetch('/api/admin/perfil/senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senhaAtual: atual, novaSenha: nova, confirmacao }) });
                    const corpo = await res.json().catch(() => null) as { ok?: boolean; erro?: string; data?: { sessoesEncerradas: number } } | null;
                    if (!res.ok || !corpo?.ok) {
                        setErro(corpo?.erro ?? 'Não foi possível trocar a senha.');
                        return;
                    }
                    setAtual(''); setNova(''); setConfirmacao('');
                    const outras = Math.max(0, (corpo.data?.sessoesEncerradas ?? 1) - 1);
                    setSucesso(`Senha alterada. ${outras > 0 ? `${outras} sessão(ões) em outros dispositivos foram encerradas.` : 'Nenhuma outra sessão estava aberta.'}`);
                }
                catch {
                    setErro('Falha de conexão. Confira se a senha foi alterada tentando entrar novamente.');
                }
                finally {
                    setOcupado(false);
                }
            }}>
                <label>Senha atual<input type="password" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} required maxLength={512} /></label>
                <label>Nova senha<input type="password" autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} required maxLength={512} aria-describedby="regra-senha" /></label>
                <small id="regra-senha" className={workspace.muted}>Entre 8 e 128 caracteres. Prefira uma frase longa que você não use em outro serviço.</small>
                <label>Confirme a nova senha<input type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required maxLength={512} /></label>
                {problemaLocal && !erro && <p className={workspace.muted} aria-live="polite">{problemaLocal}</p>}
                <p role="alert">{erro}</p>
                {sucesso && <p role="status" style={{ border: '1px solid rgba(93,227,176,.3)', borderRadius: 12, padding: 16, background: 'rgba(93,227,176,.08)' }}>{sucesso}</p>}
                <button type="submit" disabled={ocupado || !atual || !nova || !confirmacao || Boolean(problemaLocal)}>{ocupado ? 'Alterando…' : 'Trocar senha'}</button>
            </form>
        </section>
    </main>;
}
