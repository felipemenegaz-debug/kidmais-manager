'use client';
import { useEffect, useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { reais, type DadosAssinatura } from './Assinatura';

/**
 * Direito de arrependimento pela mesma ferramenta (grupo C, 097). Fica disponível para a Gestão sempre que a empresa tem
 * assinatura, mesmo fora da garantia comercial e com o provedor de pagamento indisponível: registra a manifestação e
 * devolve o protocolo na hora. Sem a 097 no ambiente, indica o canal oficial (o pedido vale a partir do envio).
 */
type Manifestacao = { protocolo: string; solicitadoEm: string; situacao: 'RECEBIDO' | 'RESTITUIDO' | 'NAO_APLICAVEL'; intermediadorComunicadoEm: string | null;
    concluidoEm: string | null; valorRestituidoCentavos: number | null; emailConfirmacao: string; repetido?: boolean };
type Consulta = { instalado: boolean; canalOficial: string; manifestacoes: Manifestacao[] };
const SITUACAO: Record<Manifestacao['situacao'], string> = {
    RECEBIDO: 'Recebido: em processamento pela equipe Kidmais',
    RESTITUIDO: 'Concluído com restituição',
    NAO_APLICAVEL: 'Concluído pelo atendimento: não se aplica (resposta pelo canal oficial)',
};
const horaBr = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const novaChave = () => globalThis.crypto?.randomUUID?.() ?? '';

export function ArrependimentoLegal({ dados }: { dados: DadosAssinatura }) {
    const [consulta, setConsulta] = useState<Consulta | null>(null);
    const [aberto, setAberto] = useState(false);
    const [motivo, setMotivo] = useState('');
    const [confirmado, setConfirmado] = useState(false);
    const [senha, setSenha] = useState('');
    const [chave, setChave] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState('');
    const [registro, setRegistro] = useState<Manifestacao | null>(null);
    const ativo = Boolean(dados.gestao && dados.assinatura);

    useEffect(() => {
        if (!ativo) return;
        let vivo = true;
        adminFetch('/api/admin/assinatura/arrependimento').then(async (r) => {
            const j = await r.json().catch(() => null) as { ok?: boolean; data?: Consulta } | null;
            if (vivo && r.ok && j?.ok && j.data) setConsulta(j.data);
        }).catch(() => undefined);
        return () => { vivo = false; };
    }, [ativo, dados.agora]);

    if (!ativo || !consulta) return null;

    async function registrar() {
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi registrado.' : auth.erro); return; }
            const r = await adminFetch('/api/admin/assinatura/arrependimento', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chave, confirmar: true, motivo: motivo.trim() }) });
            const j = await r.json().catch(() => null) as { ok?: boolean; data?: Manifestacao; erro?: string } | null;
            if (!r.ok || !j?.ok || !j.data) { setErro(j?.erro ?? `Não foi possível registrar (HTTP ${r.status}). Envie o pedido para ${consulta!.canalOficial}.`); setChave(novaChave()); return; }
            setRegistro(j.data); setAberto(false); setSenha('');
            setConsulta({ ...consulta!, manifestacoes: [j.data, ...consulta!.manifestacoes.filter((m) => m.protocolo !== j.data!.protocolo)] });
        }
        finally { setOcupado(false); }
    }

    return <section className={workspace.card} aria-labelledby="t-arrependimento" data-arrependimento>
        <h2 id="t-arrependimento">Desistir da contratação (direito de arrependimento)</h2>
        {!consulta.instalado
            ? <p>Para desistir da contratação, envie o pedido para <a href={`mailto:${consulta.canalOficial}?subject=${encodeURIComponent('Arrependimento — Kidmais Manager')}`}>{consulta.canalOficial}</a>. O pedido vale a partir do envio e confirmamos o recebimento.</p>
            : <>
                <p>Registre aqui o seu pedido de arrependimento. O registro vale na hora e você recebe um protocolo, mesmo que a devolução automática não esteja disponível (por exemplo, fora da garantia de 7 dias da primeira ativação ou com o provedor de pagamento indisponível). Depois, a equipe Kidmais analisa o pedido e, quando cabível, comunica o intermediador de pagamento e restitui os valores pagos, informando o resultado pelo canal oficial. Se não conseguir acessar o sistema, use {consulta.canalOficial}.</p>
                {registro && <div role="status" data-protocolo-arrependimento={registro.protocolo} style={{ border: '1px solid currentColor', borderRadius: 12, padding: 12 }}>
                    <p style={{ marginTop: 0 }}><strong>Pedido de arrependimento registrado.</strong> Protocolo: <strong>{registro.protocolo}</strong>, em {horaBr(registro.solicitadoEm)} (horário de Brasília).</p>
                    <p style={{ marginBottom: 0 }} className={workspace.muted}>{registro.emailConfirmacao === 'ENVIADO' ? 'Enviamos a confirmação para o seu e-mail.' : 'Guarde o protocolo: a confirmação por e-mail não pôde ser enviada agora.'}</p>
                </div>}
                {!aberto ? <p><button type="button" className="danger" disabled={ocupado} onClick={() => { setAberto(true); setChave(novaChave()); setErro(''); setRegistro(null); setConfirmado(false); }}>Registrar arrependimento…</button></p>
                    : <form onSubmit={(e) => { e.preventDefault(); if (confirmado && senha) void registrar(); }} data-form-arrependimento>
                        <label>Motivo (opcional)<input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></label>
                        <label><input type="checkbox" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} /> Quero desistir da contratação do Kidmais Manager.</label>
                        <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
                        <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <button type="submit" className="danger" disabled={ocupado || !confirmado || !senha}>{ocupado ? 'Registrando…' : 'Confirmar arrependimento'}</button>
                            <button type="button" disabled={ocupado} onClick={() => { setAberto(false); setSenha(''); }}>Voltar</button>
                        </p>
                    </form>}
                {erro && <p role="alert">{erro}</p>}
                {consulta.manifestacoes.length > 0 && <ul aria-label="Pedidos de arrependimento">
                    {consulta.manifestacoes.map((m) => <li key={m.protocolo}>{m.protocolo} · {horaBr(m.solicitadoEm)} · {SITUACAO[m.situacao]}{m.valorRestituidoCentavos ? ` (${reais(m.valorRestituidoCentavos)})` : ''}</li>)}
                </ul>}
            </>}
    </section>;
}
