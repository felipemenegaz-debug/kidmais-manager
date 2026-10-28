'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import { AdminPrimaryButton } from '@/components/admin/AdminPrimaryButton';
import workspace from '@/components/admin/workspace.module.css';
import { ROTULO_ESCOPO } from '@/components/admin/ConexoesAssistentes';
import { adminFetch } from '@/lib/http/admin-fetch';

/**
 * Consentimento OAuth do canal MCP na sessão autenticada do KidMais. Mostra quem pede (aplicativo e endereço de
 * retorno), em qual empresa, quais dados sairão, o prazo e como desconectar. Permissões só entre as pedidas; a empresa
 * é a ativa da sessão, comprovada no servidor. O redirecionamento final vem do servidor (nunca montado aqui).
 */
export type PedidoTela = { clienteNome: string; clientHost: string; redirectHost: string; escopos: readonly string[]; expiraEm: string; empresaNoPiloto: boolean };
type Empresa = { id: string; nome: string };

export const DADOS_QUE_SAEM: Readonly<Record<string, string>> = {
    'agenda:read': 'horários das festas de hoje e amanhã, totais de festas e convidados e quantos contratos estão pendentes',
    'financeiro:read': 'totais de contas a receber em aberto, vencidos por faixa de atraso e a vencer',
    'conhecimento:read': 'trechos da documentação aprovada do KidMais',
};

export function FormularioConsentimento({ pedido, empresa, enviar, ocupado }: {
    pedido: PedidoTela; empresa: Empresa; ocupado: boolean;
    enviar: (decisao: 'PERMITIR' | 'NEGAR', escopos: string[]) => void;
}) {
    const [marcados, setMarcados] = useState<string[]>([...pedido.escopos]);
    return <section className={workspace.card} aria-labelledby="t-consentimento" style={{ maxWidth: 760 }} data-consentimento>
        <h2 id="t-consentimento">{pedido.clienteNome} quer acessar o KidMais</h2>
        <p>Aplicativo: <strong data-client-host>{pedido.clientHost}</strong> · retorno para <strong data-redirect-host>{pedido.redirectHost}</strong></p>
        <p>Empresa: <strong data-empresa>{empresa.nome}</strong></p>
        {/* Teste real de 28/10/2026: a sessão estava noutra empresa e a tela não deixava isso claro. */}
        <p className={workspace.muted} data-aviso-empresa>A conexão vale só para esta empresa. Para conectar outra, troque a empresa ativa no menu do KidMais e recarregue esta página.</p>
        {!pedido.empresaNoPiloto && <p role="alert" data-fora-do-piloto>Esta empresa ainda não participa do piloto de conexões com assistentes. Troque a empresa ativa no menu e recarregue esta página, ou recuse o pedido.</p>}
        <fieldset style={{ border: 0, padding: 0, margin: '16px 0' }}>
            <legend style={{ fontWeight: 800 }}>Permitir somente leitura de:</legend>
            {pedido.escopos.map((e) => <label key={e} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input type="checkbox" checked={marcados.includes(e)} data-escopo={e} style={{ flexShrink: 0, marginTop: 2 }}
                    onChange={(ev) => setMarcados((m) => ev.target.checked ? [...m, e] : m.filter((x) => x !== e))} />
                <span><strong>{ROTULO_ESCOPO[e] ?? e}</strong><br /><span className={workspace.muted}>Sai do KidMais: {DADOS_QUE_SAEM[e] ?? 'dados desta permissão'}.</span></span>
            </label>)}
        </fieldset>
        <ul className={workspace.muted}>
            <li>Nada é alterado no KidMais: sem envio de mensagens, cobranças, contratos ou cadastros.</li>
            <li>Nomes, contatos, documentos e dados de crianças não são enviados.</li>
            <li>O acesso vale enquanto você não desconectar (renovação automática por até 30 dias sem uso). Desconecte quando quiser em Assistentes conectados.</li>
            <li>O que o assistente já recebeu fica no histórico dele, conforme as regras do fabricante.</li>
        </ul>
        <div className={workspace.actions}>
            {pedido.empresaNoPiloto && <AdminPrimaryButton carregando={ocupado} disabled={marcados.length === 0} onClick={() => enviar('PERMITIR', marcados)} data-permitir>Permitir</AdminPrimaryButton>}
            <button type="button" disabled={ocupado} onClick={() => enviar('NEGAR', [])} data-negar>Não permitir</button>
        </div>
    </section>;
}

export default function ConsentimentoAssistente({ pedidoId }: { pedidoId: string }) {
    const [pedido, setPedido] = useState<PedidoTela | null>(null);
    const [empresa, setEmpresa] = useState<Empresa | null>(null);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    useEffect(() => {
        let vivo = true;
        (async () => {
            try {
                const [rp, rs] = await Promise.all([
                    adminFetch(`/api/admin/mcp/consentimento?pedido=${encodeURIComponent(pedidoId)}`, { cache: 'no-store' }),
                    fetch('/api/admin/autenticacao', { cache: 'no-store' }),
                ]);
                const cp = await rp.json().catch(() => null) as { ok?: boolean; erro?: string; data?: PedidoTela } | null;
                const cs = await rs.json().catch(() => null) as { data?: { contexto?: { empresaAtual?: Empresa | null } } } | null;
                if (!vivo) return;
                if (!rp.ok || !cp?.ok || !cp.data) { setErro(cp?.erro ?? 'Pedido de conexão inválido ou expirado.'); return; }
                const atual = cs?.data?.contexto?.empresaAtual ?? null;
                if (!atual) { setErro('Escolha a empresa no menu do KidMais e abra o link de conexão novamente.'); return; }
                setPedido(cp.data);
                setEmpresa(atual);
            } catch {
                if (vivo) setErro('Falha de conexão ao abrir o pedido.');
            }
        })();
        return () => { vivo = false; };
    }, [pedidoId]);
    const enviar = async (decisao: 'PERMITIR' | 'NEGAR', escopos: string[]) => {
        if (!empresa) return;
        setOcupado(true);
        setErro('');
        try {
            const res = await adminFetch(`/api/admin/mcp/consentimento?empresaId=${encodeURIComponent(empresa.id)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pedido: pedidoId, escopos, decisao }),
            });
            const corpo = await res.json().catch(() => null) as { ok?: boolean; erro?: string; data?: { destino?: string } } | null;
            const destino = corpo?.data?.destino;
            if (!res.ok || !corpo?.ok || !destino || !/^https:\/\//.test(destino)) { setErro(corpo?.erro ?? 'Não foi possível concluir a conexão.'); return; }
            window.location.assign(destino);
        } catch {
            setErro('Resultado incerto. Volte ao aplicativo e confira se a conexão foi criada; nada é reenviado automaticamente.');
        } finally {
            setOcupado(false);
        }
    };
    return <main className={admin.page} data-consentimento-ia>
        <h1>Conectar assistente</h1>
        <p role="alert">{erro}</p>
        {pedido && empresa && <FormularioConsentimento pedido={pedido} empresa={empresa} enviar={enviar} ocupado={ocupado} />}
        {!pedido && !erro && <p className={workspace.muted}>Carregando…</p>}
    </main>;
}
