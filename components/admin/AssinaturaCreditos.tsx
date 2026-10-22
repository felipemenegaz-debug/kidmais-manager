'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { reais } from './Assinatura';
import { dataCurta } from './AvisoComercial';

/**
 * Créditos de IA (095), página própria em Configurações (/admin/configuracoes/creditos): um bloco por recurso — convite e
 * WhatsApp.AI —, cada um com saldo, pacotes, pedidos, devolução e extrato próprios; sem o Wall-e liberado para a empresa,
 * o bloco do WhatsApp.AI mostra só o aviso de que ainda não está ativo (nada à venda). Saldo para toda a empresa; compra, histórico, protocolos e devolução só para a
 * Gestão. O navegador nunca define preço, quantidade, validade ou empresa: só escolhe a oferta e confirma o que viu
 * (preço e versão dos termos), e o servidor recusa se mudou. Cartão é pago na página hospedada do Asaas.
 * Créditos só aparecem depois da confirmação do pagamento pelo Asaas (o retorno da fatura não libera nada).
 */
type Recurso = 'CONVITES' | 'WALLE';
type Lote = { origem: string; quantidade: number; disponivel: number; reservado: number; consumido: number; expirado: number; cancelado: number; liberadoEm: string; venceEm: string; protocolo: string | null };
type Carteira = { recurso: Recurso; disponivel: number; reservado: number; bloqueado: number; corteEm: string | null; aviso: 'BAIXO' | 'ZERADO' | null; lotes: Lote[] };
type Oferta = { codigo: string; recurso: Recurso; nome: string; quantidadeExibida: number; precoCentavos: number; validadeDias: number };
type OpcaoDev = { tipo: 'ARREPENDIMENTO_7_DIAS' | 'SALDO_NAO_UTILIZADO'; valorCentavos: number; quantidadeCancelada: number; prazo: string; garantiaAte: string } | { indisponivel: string };
type Pedido = { protocolo: string; estado: string; recurso: Recurso; nome: string; quantidadeExibida: number; precoCentavos: number; forma: Forma; criadoEm: string;
    vencimentoPagamento: string; creditadoEm: string | null; urlPagamento: string | null; emDisputa: boolean;
    devolucao: { protocolo: string; estado: string; tipo: string; valorCentavos: number; prazo: string } | null; opcaoDevolucao: OpcaoDev | null };
type Consulta = {
    instalado: boolean; gestao: boolean; walleDisponivel: boolean; consumoConvitesAtivo?: boolean;
    convites: ({ motor: 'CREDITOS'; emVerificacao: number } & Carteira) | { motor: 'LEGADO'; legado: { limiteMensal: number; usadoNoMes: number }; emVerificacao?: number };
    walle?: Carteira | null; pedidos?: Pedido[]; extrato?: { recurso: Recurso; tipo: string; quantidade: number; protocolo: string | null; em: string; origem: string }[];
    catalogo?: { versao: string; proposta: boolean; aprovado: boolean; termos: { versao: string; texto: string; sha256: string }; ofertas: Oferta[] } | null;
    compraAberta?: boolean; motivoCompraFechada?: string | null;
};
type Forma = 'PIX' | 'CARTAO' | 'BOLETO';
type RespostaPedido = { protocolo: string; estado: string; urlPagamento: string | null; vencimentoPagamento: string; mensagem: string; repetido: boolean; precoCentavos: number; quantidadeExibida: number };

const FORMA: Record<Forma, string> = { PIX: 'Pix', CARTAO: 'Cartão (na página segura do Asaas)', BOLETO: 'Boleto' };
const ESTADO: Record<string, string> = {
    CRIACAO_EM_CURSO: 'Gerando cobrança', CRIACAO_INCERTA: 'Confirmando a cobrança com o Asaas', FALHOU_CRIACAO: 'Cobrança não criada (nada cobrado)',
    AGUARDANDO_PAGAMENTO: 'Pagamento em confirmação', VENCIDO: 'Prazo de pagamento terminou', CREDITADO: 'Créditos liberados', REVISAO: 'Em conferência pela equipe Kidmais',
    ENCERRADO: 'Encerrado sem cobrança',
};
const DEVOLUCAO: Record<string, string> = {
    AGUARDANDO_MANUAL: 'registrada: em processamento pela equipe Kidmais', EM_CURSO: 'em andamento', SOLICITADO: 'enviada ao Asaas',
    SEM_CONFIRMACAO: 'em conferência pela equipe Kidmais', RECUSADO: 'em processamento pela equipe Kidmais', CONCLUIDO: 'concluída',
};
const ORIGEM: Record<string, string> = { FRANQUIA: 'Franquia do mês', COMPRA: 'Pacote comprado', CORTESIA: 'Cortesia', LEGADO: 'Saldo do mês (modelo anterior)' };
const TIPO_EXTRATO: Record<string, string> = { CREDITO: 'Entrada', RESERVA: 'Reservado', LIBERACAO: 'Devolvido ao saldo', CONSUMO: 'Usado', BLOQUEIO: 'Bloqueado',
    DESBLOQUEIO: 'Desbloqueado', EXPIRACAO: 'Vencido', REVERSAO: 'Cancelado (devolução/estorno)' };
const UNIDADE: Record<Recurso, string> = { CONVITES: 'gerações', WALLE: 'créditos do Wall-e' };
const novaChave = () => globalThis.crypto?.randomUUID?.() ?? '';
const dataIso = (d: string) => d.split('-').reverse().join('/');

async function pedir<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; erro: string; codigo: string | null }> {
    try {
        const r = await adminFetch(url, init);
        const j = await r.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string; codigo?: string } | null;
        return r.ok && j?.ok ? { ok: true, data: j.data as T } : { ok: false, erro: j?.erro ?? `Não foi possível concluir (HTTP ${r.status}).`, codigo: j?.codigo ?? null };
    }
    catch {
        return { ok: false, erro: 'Falha de conexão. Confira o histórico antes de repetir.', codigo: null };
    }
}

function SaldoRecurso({ titulo, w, emVerificacao }: { titulo: string; w: Carteira; emVerificacao?: number }) {
    const vigentes = w.lotes.filter((l) => l.disponivel > 0);
    return <div data-saldo={w.recurso}>
        <p><strong>{titulo}:</strong> <span data-disponivel>{w.disponivel}</span> {UNIDADE[w.recurso]} disponíveis
            {w.reservado > 0 && <> · {w.reservado} reservado{w.reservado > 1 ? 's' : ''} em geração em andamento</>}</p>
        {(emVerificacao ?? 0) > 0 && <p role="status" data-em-verificacao>Há créditos reservados em uma geração em verificação. Você não precisa tentar de novo.</p>}
        {w.aviso === 'ZERADO' && <p role="status" data-aviso-saldo="ZERADO">Seus créditos acabaram. Você pode seguir sem IA (modelos, upload e download não usam créditos).</p>}
        {w.aviso === 'BAIXO' && <p role="status" data-aviso-saldo="BAIXO">Saldo baixo de créditos.</p>}
        {vigentes.length > 0 && <ul data-vencimentos>{vigentes.map((l, i) => <li key={i}>{ORIGEM[l.origem] ?? l.origem}: {l.disponivel} até {dataCurta(l.venceEm)}{l.protocolo ? ` (${l.protocolo})` : ''}</li>)}</ul>}
    </div>;
}

const TITULO: Record<Recurso, string> = { CONVITES: 'Créditos de convite', WALLE: 'Créditos do WhatsApp.AI' };
const EXPLICACAO: Record<Recurso, string> = {
    CONVITES: 'Cada geração concluída de arte ou convite completo usa 1 crédito. Uploads, modelos e downloads não gastam créditos.',
    WALLE: 'O Wall-e usa créditos conforme o tamanho de cada atendimento. Respostas da equipe não gastam créditos.',
};

export function CreditosIA({ recurso }: { recurso: Recurso }) {
    const [c, setC] = useState<Consulta | null>(null);
    const [erro, setErro] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [oferta, setOferta] = useState<Oferta | null>(null);
    const [forma, setForma] = useState<Forma>('PIX');
    const [aceite, setAceite] = useState(false);
    const [senha, setSenha] = useState('');
    const [chave, setChave] = useState('');
    const [resultado, setResultado] = useState<RespostaPedido | null>(null);
    const [devolver, setDevolver] = useState<{ pedido: string; tipo: 'ARREPENDIMENTO_7_DIAS' | 'SALDO_NAO_UTILIZADO'; valorCentavos: number } | null>(null);
    const [devolucaoFeita, setDevolucaoFeita] = useState<{ protocolo: string; valorCentavos: number; estado: string; prazo: string; tipo: string } | null>(null);
    const enviando = useRef(false);

    const [versao, setVersao] = useState(0);
    const carregar = useCallback(() => setVersao((v) => v + 1), []);
    useEffect(() => {
        let vivo = true;
        void pedir<Consulta>('/api/admin/creditos').then((r) => { if (!vivo) return; if (r.ok) setC(r.data); else setErro(r.erro); });
        return () => { vivo = false; };
    }, [versao]);
    // Pagamento pendente: atualiza a situação sozinho por alguns minutos (o crédito só vem com a confirmação do Asaas).
    useEffect(() => {
        if (!resultado || !['AGUARDANDO_PAGAMENTO', 'CRIACAO_INCERTA', 'CRIACAO_EM_CURSO'].includes(resultado.estado)) return;
        let n = 0;
        const t = setInterval(async () => {
            n += 1;
            const r = await pedir<RespostaPedido>(`/api/admin/creditos/pedido?protocolo=${encodeURIComponent(resultado.protocolo)}`);
            if (r.ok && r.data.estado !== resultado.estado) { setResultado(r.data); void carregar(); }
            if (n >= 24) clearInterval(t);
        }, 5000);
        return () => clearInterval(t);
    }, [resultado, carregar]);

    const titulo = TITULO[recurso];
    if (!c) return erro && recurso === 'CONVITES' ? <section className={workspace.card} style={{ maxWidth: 720 }} data-creditos={recurso}><h2>{titulo}</h2><p role="alert">{erro}</p></section> : null;
    // WhatsApp.AI: o bloco sempre aparece; sem o Wall-e liberado para a empresa, só o aviso (sem saldo, pacotes ou pedidos).
    // R4-P3-2: liberado e ainda sem carteira (primeira compra) = ativo com saldo zero.
    const walleInativo = recurso === 'WALLE' && !c.walleDisponivel;

    async function comprar() {
        if (!oferta || !c?.catalogo || enviando.current) return;
        enviando.current = true;
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi cobrado.' : auth.erro); return; }
            const r = await pedir<RespostaPedido>('/api/admin/creditos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oferta: oferta.codigo, forma, chave, confirmar: true, precoEsperadoCentavos: oferta.precoCentavos, termosVersao: c.catalogo.termos.versao }) });
            if (!r.ok) {
                setErro(r.erro);
                if (r.codigo === 'OFERTA_ALTERADA') { setOferta(null); void carregar(); }
                return;
            }
            setResultado(r.data); setOferta(null); setAceite(false); setChave('');
            void carregar();
        }
        finally { setSenha(''); setOcupado(false); enviando.current = false; }
    }

    async function confirmarDevolucao() {
        if (!devolver || enviando.current) return;
        enviando.current = true;
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
            const r = await pedir<{ protocolo: string; valorCentavos: number; estado: string; prazo: string; tipo: string }>('/api/admin/creditos/devolucao', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pedido: devolver.pedido, tipo: devolver.tipo, valorEsperadoCentavos: devolver.valorCentavos, chave, confirmar: true }) });
            if (!r.ok) { setErro(r.erro); if (r.codigo === 'OFERTA_ALTERADA' || r.codigo === 'CONFLITO') { setDevolver(null); void carregar(); } else setChave(novaChave()); return; }
            setDevolucaoFeita(r.data); setDevolver(null); setChave('');
            void carregar();
        }
        finally { setSenha(''); setOcupado(false); enviando.current = false; }
    }

    const conv = c.convites;
    const cat = c.catalogo && { ...c.catalogo, ofertas: c.catalogo.ofertas.filter((o) => o.recurso === recurso) };
    const pedidos = (c.pedidos ?? []).filter((p) => p.recurso === recurso);
    const extrato = (c.extrato ?? []).filter((x) => x.recurso === recurso);
    const ancora = `creditos-${recurso.toLowerCase()}`;
    return <section className={workspace.card} aria-labelledby={`t-${ancora}`} style={{ maxWidth: 720 }} id={ancora} data-creditos={recurso}>
        <h2 id={`t-${ancora}`}>{titulo}</h2>
        <p className={workspace.muted}>{EXPLICACAO[recurso]}</p>
        {erro && <p role="alert">{erro}</p>}
        {recurso === 'CONVITES' && (conv.motor === 'CREDITOS'
            ? <SaldoRecurso titulo="Convites" w={conv} emVerificacao={conv.emVerificacao} />
            : <p data-saldo-legado>Convites: franquia mensal de {conv.legado.limiteMensal} gerações ({conv.legado.usadoNoMes} usadas neste mês).
                {(conv.emVerificacao ?? 0) > 0 && ' Há uma geração em verificação.'}</p>)}
        {recurso === 'CONVITES' && c.instalado && conv.motor === 'CREDITOS' && c.consumoConvitesAtivo === false && <p role="status">A geração com créditos está em manutenção; o saldo continua guardado.</p>}
        {recurso === 'WALLE' && !walleInativo && (c.walle ? <SaldoRecurso titulo="WhatsApp.AI" w={c.walle} />
            : <p data-saldo="WALLE"><strong>WhatsApp.AI:</strong> <span data-disponivel>0</span> {UNIDADE.WALLE} disponíveis</p>)}
        {walleInativo && <p data-walle-inativo>O atendimento com IA (Wall-e) ainda não está ativo para a sua empresa. Os créditos do WhatsApp.AI ficam disponíveis quando ele for ativado.</p>}
        {!walleInativo && !c.instalado && <p className={workspace.muted} data-creditos-indisponivel>Pacotes de créditos ainda não estão disponíveis neste ambiente.</p>}
        {!walleInativo && !c.gestao && c.instalado && <p className={workspace.muted}>Somente a Gestão compra créditos e vê o histórico de pedidos.</p>}

        {resultado && <div role="status" data-pedido-resultado={resultado.estado} data-protocolo={resultado.protocolo} style={{ border: '1px solid currentColor', borderRadius: 12, padding: 12 }}>
            <p style={{ marginTop: 0 }}><strong>Pedido {resultado.protocolo}</strong>: {ESTADO[resultado.estado] ?? resultado.estado}.</p>
            <p>{resultado.mensagem}</p>
            {resultado.urlPagamento && <p><a href={resultado.urlPagamento} target="_blank" rel="noopener noreferrer" data-link-pagamento>Abrir página de pagamento do Asaas</a>
                {' '}· vencimento {dataIso(resultado.vencimentoPagamento)}</p>}
            {resultado.estado === 'AGUARDANDO_PAGAMENTO' && <p className={workspace.muted}>Pagamento em confirmação. Os créditos serão liberados após a confirmação do Asaas (boleto pode levar até 3 dias úteis).</p>}
        </div>}
        {devolucaoFeita && <div role="status" data-devolucao-resultado data-protocolo={devolucaoFeita.protocolo} style={{ border: '1px solid currentColor', borderRadius: 12, padding: 12 }}>
            <p style={{ marginTop: 0 }}><strong>Devolução registrada.</strong> Protocolo: <strong>{devolucaoFeita.protocolo}</strong>. Valor: {reais(devolucaoFeita.valorCentavos)}.</p>
            <p>{devolucaoFeita.estado === 'AGUARDANDO_MANUAL' ? `A equipe Kidmais faz a restituição até ${dataIso(devolucaoFeita.prazo)}${devolucaoFeita.tipo === 'ARREPENDIMENTO_7_DIAS' ? ', sem desconto de taxas' : ''}.`
                : devolucaoFeita.tipo === 'ARREPENDIMENTO_7_DIAS' ? 'A restituição foi enviada ao Asaas, sem desconto de taxas.' : `O processamento começa até ${dataIso(devolucaoFeita.prazo)}.`} O crédito depende do meio de pagamento. Situação: {DEVOLUCAO[devolucaoFeita.estado] ?? devolucaoFeita.estado}.</p>
        </div>}

        {!walleInativo && c.gestao && c.instalado && <>
            {cat && c.compraAberta && !oferta && <div data-catalogo>
                <h3>Comprar créditos</h3>
                {cat.proposta && <p className={workspace.muted} data-catalogo-proposta>Valores de demonstração ({cat.versao}), ainda não aprovados como oferta vigente.</p>}
                {cat.ofertas.length === 0 && <p className={workspace.muted}>Nenhum pacote disponível para esta empresa agora.</p>}
                {cat.ofertas.map((o) => <p key={o.codigo}><button type="button" disabled={ocupado} data-oferta={o.codigo} onClick={() => { setOferta(o); setChave(novaChave()); setAceite(false); setErro(''); setResultado(null); }}>
                    {o.nome} — {reais(o.precoCentavos)}</button> <span className={workspace.muted}>validade de {o.validadeDias} dias após a liberação</span></p>)}
            </div>}
            {cat && !c.compraAberta && <p className={workspace.muted} data-compra-fechada>A compra de pacotes não está aberta neste ambiente.</p>}
            {oferta && cat && <form onSubmit={(e) => { e.preventDefault(); if (senha && aceite) void comprar(); }} data-resumo-compra>
                <h3>Resumo da compra</h3>
                <p><strong>{oferta.nome}</strong>: {oferta.quantidadeExibida} {UNIDADE[oferta.recurso]} por <strong>{reais(oferta.precoCentavos)}</strong>.
                    Validade de {oferta.validadeDias} dias a partir da liberação. Compra avulsa, sem renovação automática. Os créditos são liberados só depois da confirmação do pagamento pelo Asaas.</p>
                <fieldset><legend>Forma de pagamento</legend>
                    {(['PIX', 'CARTAO', 'BOLETO'] as Forma[]).map((f) => <label key={f}><input type="radio" name="forma" value={f} checked={forma === f} onChange={() => setForma(f)} disabled={ocupado} /> {FORMA[f]}</label>)}
                </fieldset>
                <details><summary>Condições do pacote (versão {cat.termos.versao})</summary><p style={{ whiteSpace: 'pre-line' }}>{cat.termos.texto}</p></details>
                <label><input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} disabled={ocupado} data-aceite /> Li o resumo e as condições e confirmo a compra.</label>
                <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
                <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button type="submit" disabled={ocupado || !senha || !aceite} data-confirmar-compra>{ocupado ? 'Gerando cobrança…' : `Confirmar e pagar ${reais(oferta.precoCentavos)}`}</button>
                    <button type="button" disabled={ocupado} onClick={() => { setOferta(null); setSenha(''); }}>Voltar</button>
                </p>
            </form>}
            {devolver && <form onSubmit={(e) => { e.preventDefault(); if (senha) void confirmarDevolucao(); }} data-confirmar-devolucao-creditos>
                <p><strong>Devolução do pedido {devolver.pedido}: {reais(devolver.valorCentavos)}.</strong> O saldo restante desse pacote é cancelado agora; gerações já concluídas continuam com você.</p>
                <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
                <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button type="submit" className="danger" disabled={ocupado || !senha}>{ocupado ? 'Registrando…' : 'Confirmar devolução'}</button>
                    <button type="button" disabled={ocupado} onClick={() => { setDevolver(null); setSenha(''); }}>Voltar</button>
                </p>
            </form>}
            {pedidos.length > 0 && <div data-pedidos-creditos>
                <h3>Pedidos</h3>
                <ul>{pedidos.map((p) => <li key={p.protocolo} data-pedido={p.protocolo} data-estado={p.estado}>
                    <strong>{p.protocolo}</strong> — {p.nome}, {reais(p.precoCentavos)}, {FORMA[p.forma] ?? p.forma}, {dataCurta(p.criadoEm)}. {ESTADO[p.estado] ?? p.estado}.
                    {p.urlPagamento && <> <a href={p.urlPagamento} target="_blank" rel="noopener noreferrer">Pagar</a> (vence {dataIso(p.vencimentoPagamento)}).</>}
                    {p.emDisputa && <> Pagamento em contestação: o saldo restante deste pacote está bloqueado.</>}
                    {p.devolucao && <> Devolução {p.devolucao.protocolo} ({reais(p.devolucao.valorCentavos)}): {DEVOLUCAO[p.devolucao.estado] ?? p.devolucao.estado}.</>}
                    {p.opcaoDevolucao && 'tipo' in p.opcaoDevolucao && !devolver && <> <button type="button" className="danger" disabled={ocupado} data-pedir-devolucao={p.protocolo}
                        onClick={() => { const o = p.opcaoDevolucao as Extract<OpcaoDev, { tipo: string }>; setDevolver({ pedido: p.protocolo, tipo: o.tipo, valorCentavos: o.valorCentavos }); setChave(novaChave()); setErro(''); }}>
                        {(p.opcaoDevolucao as { tipo: string }).tipo === 'ARREPENDIMENTO_7_DIAS' ? `Desistir (7 dias): devolver ${reais((p.opcaoDevolucao as { valorCentavos: number }).valorCentavos)}…`
                            : `Devolver saldo não usado: ${reais((p.opcaoDevolucao as { valorCentavos: number }).valorCentavos)}…`}</button></>}
                </li>)}</ul>
            </div>}
            {extrato.length > 0 && <details data-extrato><summary>Extrato</summary><ul>{extrato.map((x, i) => <li key={i}>
                {dataCurta(x.em)} · {TIPO_EXTRATO[x.tipo] ?? x.tipo} {x.quantidade} ({ORIGEM[x.origem] ?? x.origem}){x.protocolo ? ` · ${x.protocolo}` : ''}</li>)}</ul></details>}
        </>}
    </section>;
}
