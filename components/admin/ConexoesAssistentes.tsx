'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';

/**
 * Conexões com assistentes externos (canal MCP, docs/MCP_ASSINATURAS_V1.md). Mostra só o ESTADO PERSISTIDO das concessões
 * da própria pessoa: "autorizada" (OAuth concluído) é diferente de "consulta recebida" (ferramenta observada). Nada aqui
 * marca conectado por clique, instala plugin ou fala com o fabricante.
 */
export type Conexao = {
    id: string; clientId: string; clienteNome: string; empresaId: string; empresaNome: string; escopos: readonly string[];
    criadaEm: string; ultimoUsoEm: string | null; ultimaFerramentaEm: string | null; revogadaEm: string | null;
};
type Estado = { canal: { ativo: boolean; urlServidor: string | null }; conexoes: Conexao[] };

export const ROTULO_ESCOPO: Readonly<Record<string, string>> = {
    'agenda:read': 'Agenda do dia (horários e totais, sem nomes)',
    'financeiro:read': 'Resumo de contas a receber (totais, sem clientes)',
    'conhecimento:read': 'Documentação do KidMais',
};

const data = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');

export function situacaoConexao(c: Conexao) {
    if (c.revogadaEm) return 'Desconectada';
    if (c.ultimaFerramentaEm) return 'Autorizada · consulta recebida';
    return 'Autorizada · nenhuma consulta recebida ainda';
}

export function ListaConexoes({ estado, revogar, ocupado }: { estado: Estado; revogar: (id: string) => void; ocupado: string | null }) {
    const ativas = estado.conexoes.filter((c) => !c.revogadaEm);
    const antigas = estado.conexoes.filter((c) => c.revogadaEm);
    return <>
        <section className={workspace.card} aria-labelledby="t-conexoes" data-conexoes={ativas.length}>
            <h2 id="t-conexoes">Suas conexões</h2>
            {!estado.canal.ativo && <p data-canal="desligado">As consultas por assistentes externos estão desligadas neste ambiente. Conexões autorizadas antes continuam listadas abaixo e podem ser desconectadas.</p>}
            {ativas.length === 0 && <p className={workspace.muted}>Nenhum assistente conectado à sua conta.</p>}
            {ativas.map((c) => <article key={c.id} data-conexao={c.id} style={{ borderTop: '1px solid var(--border-navy)', padding: '16px 0' }}>
                <h3 style={{ margin: '0 0 8px' }}>{c.clienteNome} · <span data-empresa-conexao>{c.empresaNome}</span></h3>
                <p className={workspace.muted} style={{ margin: 0 }}>{situacaoConexao(c)}</p>
                <ul>{c.escopos.map((e) => <li key={e}>{ROTULO_ESCOPO[e] ?? e}</li>)}</ul>
                <p className={workspace.muted}>Autorizada em {data(c.criadaEm)} · último uso {data(c.ultimoUsoEm)}</p>
                <button type="button" className={workspace.danger} disabled={ocupado !== null} onClick={() => revogar(c.id)} data-revogar={c.id}>
                    {ocupado === c.id ? 'Desconectando…' : 'Desconectar'}
                </button>
            </article>)}
            {antigas.length > 0 && <details>
                <summary>Conexões encerradas ({antigas.length})</summary>
                <ul>{antigas.map((c) => <li key={c.id}>{c.clienteNome} · {c.empresaNome} · desconectada em {data(c.revogadaEm)}</li>)}</ul>
            </details>}
            <p className={workspace.muted}>Desconectar impede novas consultas imediatamente. O que já foi mostrado no histórico do assistente continua lá e segue as regras do fabricante.</p>
        </section>
        <section className={workspace.card} aria-labelledby="t-como">
            <h2 id="t-como">Como conectar</h2>
            {estado.canal.urlServidor
                ? <p>Endereço do servidor: <code data-url-servidor>{estado.canal.urlServidor}</code></p>
                : <p className={workspace.muted}>O endereço do servidor aparece aqui quando o recurso estiver liberado para a sua empresa.</p>}
            {/* Sem caminho de menu: os dois fabricantes mudaram os menus entre o plano e o teste real (28/10/2026). */}
            <p>Antes de conectar, confira se a empresa ativa no menu do KidMais é a que você quer conectar: a conexão vale só para ela.</p>
            <h3>ChatGPT</h3>
            <p>Disponível conforme o plano e o espaço de trabalho do ChatGPT. Nas configurações do ChatGPT, adicione um servidor MCP personalizado com o endereço acima e entre com a sua conta KidMais quando o ChatGPT pedir. Confira na ajuda do ChatGPT se o seu plano permite.</p>
            <h3>Claude</h3>
            <p>Nas configurações do Claude, adicione um conector personalizado com o endereço acima e entre com a sua conta KidMais. Planos gratuitos podem ter limite de conectores.</p>
            <h3>Gemini</h3>
            <p>A conexão de aplicativos personalizados no Gemini depende de regras do Google (país, idade, idioma e tipo de conta) que hoje não incluem o Brasil. Não use VPN nem troque o país da conta para isso.</p>
            <p className={workspace.muted}>O KidMais nunca pede a senha, o login ou a chave da sua assinatura de ChatGPT, Claude ou Gemini.</p>
        </section>
    </>;
}

export default function ConexoesAssistentes() {
    const [estado, setEstado] = useState<Estado | null>(null);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState<string | null>(null);
    // Recarregar = incrementar a versão; a leitura só grava estado depois da resposta e se a tela ainda estiver montada.
    const [versao, setVersao] = useState(0);
    useEffect(() => {
        let vivo = true;
        (async () => {
            try {
                const res = await adminFetch('/api/admin/mcp/conexoes', { cache: 'no-store' });
                const corpo = await res.json().catch(() => null) as { ok?: boolean; erro?: string; data?: Estado } | null;
                if (!vivo) return;
                if (!res.ok || !corpo?.ok || !corpo.data) { setErro(corpo?.erro ?? 'Não foi possível carregar as conexões.'); return; }
                setEstado(corpo.data);
            } catch {
                if (vivo) setErro('Falha de conexão ao carregar as conexões.');
            }
        })();
        return () => { vivo = false; };
    }, [versao]);
    const revogar = async (id: string) => {
        setOcupado(id);
        setErro('');
        try {
            const res = await adminFetch('/api/admin/mcp/conexoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concessaoId: id }) });
            const corpo = await res.json().catch(() => null) as { ok?: boolean; erro?: string } | null;
            if (!res.ok || !corpo?.ok) setErro(corpo?.erro ?? 'Não foi possível desconectar. Atualize a página e confira.');
        } catch {
            setErro('Resultado incerto: confira a lista antes de tentar de novo.');
        } finally {
            setOcupado(null);
            setVersao((v) => v + 1);
        }
    };
    return <main className={admin.page} data-conexoes-ia>
        <h1>Assistentes conectados</h1>
        <p className={workspace.muted} style={{ maxWidth: 760 }}>Converse com o ChatGPT ou o Claude da sua própria assinatura sobre a agenda, o resumo de contas a receber e a documentação do KidMais. O assistente só consulta: não envia mensagens, não altera cadastros e não vê nomes de clientes nem dados de crianças.</p>
        <p role="alert">{erro}</p>
        {estado ? <ListaConexoes estado={estado} revogar={revogar} ocupado={ocupado} /> : !erro && <p className={workspace.muted}>Carregando…</p>}
    </main>;
}
