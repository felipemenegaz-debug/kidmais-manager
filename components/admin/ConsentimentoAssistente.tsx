'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import { AdminPrimaryButton } from '@/components/admin/AdminPrimaryButton';
import workspace from '@/components/admin/workspace.module.css';
import { sairDaSessao } from '@/components/admin/sair';
import { ESCOPOS_INICIAIS, ORDEM_ESCOPOS, ROTULO_ESCOPO } from '@/components/admin/conexoes-assistentes-guia';
import { adminFetch, lerCorpoOuNulo, mensagemDoEndereco } from '@/lib/http/admin-fetch';
import { fimDaTrocaEmCurso, guardarAvisoDeContexto, marcaDaSessao, sessaoObsoletaDesde } from '@/lib/http/contexto-empresa-cliente';
import { formatarDataHora } from '@/lib/integracoes/oauth/situacao-conexao';
import { loginComRetorno } from '@/lib/http/retorno-login';

/**
 * Consentimento OAuth do canal MCP na sessão autenticada do iA.Fest. Mostra quem pede (aplicativo e endereço de
 * retorno), com qual usuário e em qual empresa, quais dados sairão, o prazo e como desconectar. Permissões só entre as
 * pedidas; a empresa é a ativa da sessão, comprovada no servidor. O redirecionamento final vem do servidor (nunca montado
 * aqui). Trocar de conta ou de empresa não cria nem move autorização: o pedido segue pendente, sem dono, até alguém
 * decidir nesta tela. A concessão nasce só em concluirConsentimento, com o usuário e a empresa daquele momento. A troca de
 * empresa é a do menu da conta (AdminShell); esta tela não tem uma própria, que fica para o PR da troca de empresa.
 */
export type PedidoTela = {
    clienteNome: string; clientHost: string; redirectHost: string; escopos: readonly string[]; expiraEm: string; empresaNoPiloto: boolean;
    usuario?: { nome: string; email: string | null }; empresas?: ReadonlyArray<{ id: string; nome: string }>;
    /** Sessão que o servidor usou para montar este pedido (usuário e empresa ativa). Só para conferir a composição da tela. */
    sessao?: { usuarioId: string; empresaId: string | null };
};
const ERRO_SESSAO_NAO_CONFIRMADA = 'Não foi possível confirmar a sua sessão. Tente de novo.';
const ERRO_SESSAO_ENCERRADA = 'A sua sessão terminou. Entre de novo para responder ao pedido.';
export const ERRO_SESSOES_DIFERENTES = 'A conta ou a empresa mudou enquanto o pedido abria. Tente de novo.';
type Empresa = { id: string; nome: string };

export const DADOS_QUE_SAEM: Readonly<Record<string, string>> = {
    'agenda:read': 'horários das festas de hoje e amanhã, totais de festas e convidados e quantos contratos estão pendentes',
    'financeiro:read': 'totais de contas a receber em aberto, vencidos por faixa de atraso e a vencer',
    'conhecimento:read': 'trechos da documentação aprovada do iA.Fest',
};

/** Só a ajuda começa marcada, se foi pedida: agenda e financeiro dependem de marcação da própria pessoa. */
export function escoposIniciais(pedidos: readonly string[]) {
    return ESCOPOS_INICIAIS.filter((e) => pedidos.includes(e));
}

export function FormularioConsentimento({ pedido, empresa, enviar, ocupado, trocarConta }: {
    pedido: PedidoTela; empresa: Empresa; ocupado: boolean;
    enviar: (decisao: 'PERMITIR' | 'NEGAR', escopos: string[]) => void;
    trocarConta?: () => void;
}) {
    const [marcados, setMarcados] = useState<string[]>(escoposIniciais(pedido.escopos));
    const pedidos = ORDEM_ESCOPOS.filter((e) => pedido.escopos.includes(e));
    const variasEmpresas = (pedido.empresas ?? []).length > 1;
    return <section className={workspace.card} aria-labelledby="t-consentimento" style={{ maxWidth: 760 }} data-consentimento>
        <h2 id="t-consentimento">{pedido.clienteNome} quer consultar o iA.Fest</h2>
        <p>Aplicativo: <strong data-client-host>{pedido.clientHost}</strong> · retorno para <strong data-redirect-host>{pedido.redirectHost}</strong></p>
        {pedido.usuario && <p>Usuário do iA.Fest: <strong data-usuario>{pedido.usuario.nome}{pedido.usuario.email ? ` · ${pedido.usuario.email}` : ''}</strong></p>}
        <p>Empresa: <strong data-empresa>{empresa.nome}</strong></p>
        {/* Teste real de 28/10/2026: a sessão estava noutra empresa e a tela não deixava isso claro. */}
        <p className={workspace.muted} data-aviso-empresa>A autorização fica com este usuário e vale só para esta empresa. Ela não passa sozinha para outro usuário ou empresa.</p>
        <p className={workspace.muted} data-aviso-email>O e-mail da sua conta do assistente não precisa ser igual ao do iA.Fest. Confira apenas se este é o usuário que deve autorizar.</p>
        <div className={workspace.actions} data-trocas>
            {trocarConta && <button type="button" disabled={ocupado} onClick={trocarConta} data-trocar-conta>Entrar com outra conta</button>}
        </div>
        {variasEmpresas && <p className={workspace.muted} data-trocar-empresa>Para conectar outra empresa, troque a empresa ativa no menu da conta. A troca leva ao painel e não volta para esta página. Depois, volte ao assistente e inicie a conexão de novo. O link anterior só abre este pedido outra vez enquanto ele estiver sem resposta e dentro do prazo, até {formatarDataHora(pedido.expiraEm)}: Permitir ou Não permitir encerra o pedido.</p>}
        <p className={workspace.muted} data-prazo-pedido>Este pedido fica aberto até {formatarDataHora(pedido.expiraEm)}, enquanto não for respondido: Permitir ou Não permitir o encerra. Trocar de conta ou de empresa não o cancela, e nada é autorizado até você decidir.</p>
        {!pedido.empresaNoPiloto && <p role="alert" data-fora-do-piloto>Esta empresa ainda não participa do piloto de conexões com assistentes. Troque de empresa ou de conta, ou recuse o pedido.</p>}
        <fieldset style={{ border: 0, padding: 0, margin: '16px 0' }}>
            <legend style={{ fontWeight: 800 }}>Permitir somente leitura de:</legend>
            {pedidos.map((e) => <label key={e} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input type="checkbox" checked={marcados.includes(e)} data-escopo={e} style={{ flexShrink: 0, marginTop: 2 }}
                    onChange={(ev) => setMarcados((m) => ev.target.checked ? [...m, e] : m.filter((x) => x !== e))} />
                <span><strong>{ROTULO_ESCOPO[e] ?? e}</strong><br /><span className={workspace.muted}>Sai do iA.Fest: {DADOS_QUE_SAEM[e] ?? 'dados desta permissão'}.</span></span>
            </label>)}
        </fieldset>
        <ul className={workspace.muted}>
            <li>Nada é alterado no iA.Fest: sem envio de mensagens, cobranças, contratos ou cadastros.</li>
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

export const PRAZO_CARREGAMENTO_MS = 15_000;
export type CargaConsentimento = { ok: true; pedido: PedidoTela; empresa: Empresa } | { ok: false; erro: string; recuperavel: boolean; semEmpresa?: boolean };

/**
 * Carga do consentimento com prazo absoluto e cancelamento (revisão do Astra de 28/10/2026, P2-1: no teste real a tela
 * ficou em "Carregando…" sem se recuperar). Pedido e sessão em paralelo; o prazo cobre também a leitura dos corpos.
 * Ao vencer, as requisições são abortadas e o resultado é recuperável (a tela oferece tentar de novo). O pedido não é
 * consumido por ler, então repetir é seguro.
 */
/** Leitura da sessão conforme o contrato de GET /api/admin/autenticacao; qualquer desvio é 'invalida'. */
function sessaoLida(corpo: unknown): 'invalida' | 'encerrada' | { usuarioId: string; empresaAtual: Empresa | null } {
    if (!corpo || typeof corpo !== 'object' || (corpo as { ok?: unknown }).ok !== true) return 'invalida';
    const data = (corpo as { data?: unknown }).data;
    if (!data || typeof data !== 'object') return 'invalida';
    const { usuarioId, contexto } = data as { usuarioId?: unknown; contexto?: unknown };
    if (usuarioId === null) return 'encerrada';
    if (typeof usuarioId !== 'string' || !usuarioId) return 'invalida';
    if (!contexto || typeof contexto !== 'object') return 'invalida';
    // Só o null EXPLÍCITO é "sem empresa"; campo ausente (undefined) cai em 'invalida' logo abaixo.
    const empresa = (contexto as { empresaAtual?: unknown }).empresaAtual;
    if (empresa === null) return { usuarioId, empresaAtual: null };
    if (!empresa || typeof empresa !== 'object') return 'invalida';
    const { id, nome } = empresa as { id?: unknown; nome?: unknown };
    if (typeof id !== 'string' || !id || typeof nome !== 'string') return 'invalida';
    return { usuarioId, empresaAtual: { id, nome } };
}

/** Sessão que o GET do pedido declara ter usado; empresa nula só quando o campo existe com null. */
function sessaoDoPedido(s: unknown): { usuarioId: string; empresaId: string | null } | null {
    if (!s || typeof s !== 'object') return null;
    // Campo ausente (undefined) não é string nem null: a sessão do pedido é recusada.
    const { usuarioId, empresaId } = s as { usuarioId?: unknown; empresaId?: unknown };
    if (typeof usuarioId !== 'string' || !usuarioId) return null;
    if (empresaId !== null && (typeof empresaId !== 'string' || !empresaId)) return null;
    return { usuarioId, empresaId };
}

export async function carregarPedido(deps: {
    lerPedido: (sinal: AbortSignal) => Promise<Response>; lerSessao: (sinal: AbortSignal) => Promise<Response>; prazoMs: number; cancelamento?: AbortSignal;
}): Promise<CargaConsentimento> {
    const controle = new AbortController();
    deps.cancelamento?.addEventListener('abort', () => controle.abort());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<CargaConsentimento>((ok) => {
        timer = setTimeout(() => {
            controle.abort();
            ok({ ok: false, erro: 'O pedido demorou para carregar. Tente de novo; se continuar, volte ao assistente e conecte novamente.', recuperavel: true });
        }, deps.prazoMs);
    });
    const trabalho = (async (): Promise<CargaConsentimento> => {
        try {
            const [rp, rs] = await Promise.all([deps.lerPedido(controle.signal), deps.lerSessao(controle.signal)]);
            const cp = await lerCorpoOuNulo<{ ok?: boolean; erro?: string; data?: PedidoTela }>(rp);
            const cs = await lerCorpoOuNulo<unknown>(rs);
            if (!rp.ok || !cp?.ok || !cp.data) return { ok: false, erro: cp?.erro ?? 'Pedido de conexão inválido ou expirado.', recuperavel: rp.status >= 500 };
            // 11º parecer, P3: só depois de a sessão responder com sucesso e com usuário é que a falta de empresa significa
            // "sem empresa". 401, 5xx, corpo inválido ou sessão sem usuário são falha de sessão, nunca semEmpresa.
            // 12º parecer, P3: a estrutura é conferida em runtime; `empresaAtual: null` (sem empresa) é diferente de campo
            // ausente ou de outro tipo (resposta fora do contrato = sessão não confirmada).
            const lida = rs.ok ? sessaoLida(cs) : 'invalida';
            if (lida === 'invalida') return { ok: false, erro: ERRO_SESSAO_NAO_CONFIRMADA, recuperavel: true };
            if (lida === 'encerrada') return { ok: false, erro: ERRO_SESSAO_ENCERRADA, recuperavel: true };
            // 10º parecer, P3: usuário, empresas e piloto vêm do GET do pedido; a empresa vem da leitura da sessão. As duas
            // respostas precisam ser da MESMA sessão (mesmo usuário e mesma empresa ativa, inclusive "nenhuma").
            const s = sessaoDoPedido(cp.data.sessao);
            // 13º parecer, P3: pedido fora do contrato (sem usuário ou sem empresaId) não prova troca de conta ou de empresa:
            // é sessão não confirmada. "Mudou" fica só para duas identidades válidas que divergem.
            if (!s) return { ok: false, erro: ERRO_SESSAO_NAO_CONFIRMADA, recuperavel: true };
            const atual = lida.empresaAtual;
            if (s.usuarioId !== lida.usuarioId || s.empresaId !== (atual?.id ?? null))
                return { ok: false, erro: ERRO_SESSOES_DIFERENTES, recuperavel: true };
            if (!atual) return { ok: false, erro: 'Este usuário não tem empresa selecionada. Escolha a empresa no menu da conta e recarregue esta página, ou entre com outra conta.', recuperavel: false, semEmpresa: true };
            return { ok: true, pedido: cp.data, empresa: atual };
        } catch (e) {
            // Troca de host (F2a): o sistema mudou de endereço; tentar de novo aqui não adianta, a página precisa ser atualizada.
            const doEndereco = mensagemDoEndereco(e);
            if (doEndereco) return { ok: false, erro: doEndereco, recuperavel: false };
            // 11º parecer, P3: o adminFetch do pedido também confere a sessão; quando ela não se confirma ele lança
            // ErroContextoAdmin (reconhecido pela forma: o módulo é substituído nos testes). É falha de sessão, não de rede.
            if (e && typeof e === 'object' && 'tipo' in e && 'enviado' in e && e.tipo !== 'REDE') return { ok: false, erro: ERRO_SESSAO_NAO_CONFIRMADA, recuperavel: true };
            return { ok: false, erro: 'Falha de conexão ao abrir o pedido.', recuperavel: true };
        }
    })();
    try {
        return await Promise.race([trabalho, prazo]);
    } finally {
        clearTimeout(timer);
    }
}

export type Decisao = 'PERMITIR' | 'NEGAR';
export const AVISO_AUTORIZACAO_NA_TROCA = 'A autorização do assistente foi concluída, mas a empresa ativa começou a mudar antes do retorno ao assistente. Volte ao assistente e confira a conexão; se ela não aparecer, inicie uma conexão nova pelo assistente.';
// 17º parecer, P3-1: "Não permitir" também responde com destino de retorno (erro access_denied), mas nada foi autorizado.
export const AVISO_RECUSA_NA_TROCA = 'O pedido do assistente foi recusado e nenhuma conexão foi criada. A empresa ativa começou a mudar antes do retorno ao assistente; se quiser conectar depois, inicie uma conexão nova pelo assistente.';
export type DecisaoEnviada =
    | { tipo: 'erro'; erro: string }
    | { tipo: 'navegou' }
    /** Decisão concluída com uma troca desta página iniciada depois da confirmação: a troca decide a navegação. */
    | { tipo: 'troca'; decisao: Decisao; destino: string; fim: Promise<void> | null };

/**
 * Envia a decisão (um único POST, nunca repetido) e só volta ao assistente se nenhuma troca de empresa desta página
 * começou depois de o adminFetch confirmar a sessão (16º parecer, P2). A marca é tirada na retomada do adminFetch, sem
 * await no meio, e conferida de novo depois de ler o corpo, imediatamente antes de navegar. Com a troca no meio, o
 * resultado conhecido (autorização concluída ou pedido recusado, conforme a decisão) fica guardado e a página não
 * navega; quem navega é a troca.
 */
export async function enviarDecisao(decisao: Decisao, post: () => Promise<Response>, navegar: (destino: string) => void): Promise<DecisaoEnviada> {
    const res = await post();
    const marca = marcaDaSessao();
    const corpo = await lerCorpoOuNulo<{ ok?: boolean; erro?: string; data?: { destino?: string } }>(res);
    const destino = corpo?.data?.destino;
    if (!res.ok || !corpo?.ok || !destino || !/^https:\/\//.test(destino)) return { tipo: 'erro', erro: corpo?.erro ?? 'Não foi possível concluir a conexão.' };
    if (sessaoObsoletaDesde(marca)) {
        guardarAvisoDeContexto(decisao === 'NEGAR' ? AVISO_RECUSA_NA_TROCA : AVISO_AUTORIZACAO_NA_TROCA, 'escrita');
        return { tipo: 'troca', decisao, destino, fim: fimDaTrocaEmCurso() };
    }
    navegar(destino);
    return { tipo: 'navegou' };
}

/**
 * Decisão concluída durante uma troca: sem navegação automática; volta ao assistente só por clique, depois da troca.
 * 17º parecer: o texto segue a decisão (P3-1) e orienta o que fazer se o retorno falhar (P3-2). O código de retorno vale
 * por pouco tempo a partir da resposta, então a tela não promete que o link ainda funciona; não há reenvio nem novo prazo.
 */
export function RetornoNaTroca({ decisao, destino, liberado }: { decisao: Decisao; destino: string; liberado: boolean }) {
    const negou = decisao === 'NEGAR';
    return <div data-autorizacao-na-troca data-decisao={decisao}>
        <p>{negou
            ? 'O pedido foi recusado e nenhuma conexão foi criada. A empresa ativa começou a mudar antes do retorno ao assistente, por isso esta página não voltou sozinha.'
            : 'A autorização foi concluída. A empresa ativa começou a mudar antes do retorno ao assistente, por isso esta página não voltou sozinha.'}</p>
        {liberado
            ? <p><a href={destino} data-voltar-assistente>Voltar ao assistente</a></p>
            : <p className={workspace.muted}>Aguardando a troca de empresa terminar…</p>}
        <p className={workspace.muted} data-retorno-expirado>{negou
            ? 'Se o retorno ao assistente falhar, basta fechar esta página: nada foi conectado. Para conectar depois, inicie uma conexão nova pelo assistente.'
            : 'O retorno ao assistente vale por pouco tempo depois da sua resposta. Se ele falhar ou a conexão não aparecer no assistente, inicie uma conexão nova por lá; este pedido já foi respondido.'}</p>
    </div>;
}

export default function ConsentimentoAssistente({ pedidoId }: { pedidoId: string }) {
    const [pedido, setPedido] = useState<PedidoTela | null>(null);
    const [empresa, setEmpresa] = useState<Empresa | null>(null);
    const [erro, setErro] = useState('');
    const [recuperavel, setRecuperavel] = useState(false);
    const [tentativa, setTentativa] = useState(0);
    const [ocupado, setOcupado] = useState(false);
    const [semEmpresa, setSemEmpresa] = useState(false);
    const [retorno, setRetorno] = useState<{ decisao: Decisao; destino: string; liberado: boolean } | null>(null);
    useEffect(() => {
        let vivo = true;
        const saida = new AbortController();
        void carregarPedido({
            lerPedido: (sinal) => adminFetch(`/api/admin/mcp/consentimento?pedido=${encodeURIComponent(pedidoId)}`, { cache: 'no-store', signal: sinal }),
            lerSessao: (sinal) => fetch('/api/admin/autenticacao', { cache: 'no-store', signal: sinal }),
            prazoMs: PRAZO_CARREGAMENTO_MS,
            cancelamento: saida.signal,
        }).then((c) => {
            if (!vivo) return;
            if (c.ok) { setPedido(c.pedido); setEmpresa(c.empresa); return; }
            setErro(c.erro);
            setRecuperavel(c.recuperavel);
            setSemEmpresa(c.semEmpresa === true);
        });
        return () => { vivo = false; saida.abort(); };
    }, [pedidoId, tentativa]);
    const tentarDeNovo = () => { setErro(''); setRecuperavel(false); setTentativa((t) => t + 1); };
    // Sair pelo fluxo normal e voltar a este mesmo pedido depois do login. O pedido não é consumido por sair.
    const trocarConta = () => {
        setOcupado(true);
        const destino = loginComRetorno(window.location.pathname, window.location.search);
        void sairDaSessao({ navegar: () => window.location.assign(destino) }).finally(() => setOcupado(false));
    };
    const enviar = async (decisao: Decisao, escopos: string[]) => {
        if (!empresa) return;
        setOcupado(true);
        setErro('');
        try {
            const r = await enviarDecisao(decisao, () => adminFetch(`/api/admin/mcp/consentimento?empresaId=${encodeURIComponent(empresa.id)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pedido: pedidoId, escopos, decisao }),
            }), (destino) => window.location.assign(destino));
            if (r.tipo === 'erro') { setErro(r.erro); return; }
            if (r.tipo === 'troca') {
                setRetorno({ decisao: r.decisao, destino: r.destino, liberado: false });
                await r.fim?.catch(() => undefined);
                setRetorno({ decisao: r.decisao, destino: r.destino, liberado: true });
            }
        } catch (falha) {
            setErro(mensagemDoEndereco(falha) ?? 'Resultado incerto. Volte ao aplicativo e confira se a conexão foi criada; nada é reenviado automaticamente.');
        } finally {
            setOcupado(false);
        }
    };
    return <main className={admin.page} data-consentimento-ia>
        <h1>Conectar assistente</h1>
        <p role="alert">{erro}</p>
        {recuperavel && !pedido && <p><button type="button" onClick={tentarDeNovo} data-tentar-de-novo>Tentar de novo</button></p>}
        {semEmpresa && !pedido && <p><button type="button" disabled={ocupado} onClick={trocarConta} data-trocar-conta>Entrar com outra conta</button></p>}
        {retorno && <RetornoNaTroca decisao={retorno.decisao} destino={retorno.destino} liberado={retorno.liberado} />}
        {pedido && empresa && !retorno && <FormularioConsentimento pedido={pedido} empresa={empresa} enviar={enviar} ocupado={ocupado} trocarConta={trocarConta} />}
        {!pedido && !erro && <p className={workspace.muted}>Carregando…</p>}
    </main>;
}
