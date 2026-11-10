import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { PedidoTela } from './ConsentimentoAssistente';

// Renderiza o formulário real do consentimento MCP. CSS e rede são isolados; não abre banco ou navegador.
const semRede = () => { throw new Error('Rede proibida no teste do consentimento.'); };
const css = { 'workspace.module.css': {}, 'admin.module.css': {}, 'visual.module.css': {}, 'conexoes-assistentes.module.css': {}, 'http/admin-fetch': { adminFetch: semRede }, 'components/admin/sair': { sairDaSessao: semRede } };
const cache = new Map<string, Record<string, unknown>>();
const { FormularioConsentimento } = carregarModulo('components/admin/ConsentimentoAssistente.tsx', css, cache) as {
    FormularioConsentimento: ComponentType<{ pedido: PedidoTela; empresa: { id: string; nome: string }; ocupado: boolean; enviar: () => void }>;
};

function tela(empresaNoPiloto: boolean) {
    const pedido: PedidoTela = { clienteNome: 'ChatGPT', clientHost: 'chatgpt.com', redirectHost: 'chatgpt.com', escopos: ['agenda:read'], expiraEm: '2026-10-28T10:00:00Z', empresaNoPiloto };
    return renderToStaticMarkup(createElement(FormularioConsentimento, { pedido, empresa: { id: 'e1', nome: 'Buffet Sintético' }, ocupado: false, enviar: semRede })).replace(/ /g, ' ');
}

test('teste real (28/10): a tela diz que a conexão vale só para a empresa ativa e como trocar', () => {
    const html = tela(true);
    assert.match(html, /data-empresa="true">Buffet Sintético/);
    assert.match(html, /data-aviso-empresa/);
    assert.match(html, /vale só para esta empresa/);
    assert.match(html, /data-permitir/);
    assert.doesNotMatch(html, /data-fora-do-piloto/);
});

test('teste real (28/10): empresa ativa fora do piloto não mostra Permitir; avisa e deixa recusar', () => {
    const html = tela(false);
    assert.match(html, /data-fora-do-piloto/);
    assert.match(html, /ainda não participa do piloto/);
    assert.doesNotMatch(html, /data-permitir/);
    assert.match(html, /data-negar/);
});

// Revisão do Astra (28/10, P2-1): a carga tem prazo, cancela as requisições e diz se dá para tentar de novo.
const { carregarPedido } = carregarModulo('components/admin/ConsentimentoAssistente.tsx', css, cache) as {
    carregarPedido: (deps: { lerPedido: (s: AbortSignal) => Promise<Response>; lerSessao: (s: AbortSignal) => Promise<Response>; prazoMs: number; cancelamento?: AbortSignal }) =>
        Promise<{ ok: true; pedido: PedidoTela; empresa: { id: string; nome: string } } | { ok: false; erro: string; recuperavel: boolean }>;
};
const PEDIDO_OK = { clienteNome: 'Claude', clientHost: 'claude.ai', redirectHost: 'claude.ai', escopos: ['agenda:read'], expiraEm: '2026-10-28T10:00:00Z', empresaNoPiloto: true, sessao: { usuarioId: 'u1', empresaId: 'e1' } };
const sessaoOk = async () => Response.json({ ok: true, data: { usuarioId: 'u1', contexto: { empresaAtual: { id: 'e1', nome: 'Buffet Sintético' } } } });
const pendurado = (sinais: AbortSignal[]) => (s: AbortSignal) => { sinais.push(s); return new Promise<Response>(() => undefined); };

test('P2-1: pedido pendurado vence no prazo, aborta as requisições e é recuperável', async () => {
    const sinais: AbortSignal[] = [];
    const inicio = Date.now();
    const c = await carregarPedido({ lerPedido: pendurado(sinais), lerSessao: (s) => { sinais.push(s); return sessaoOk(); }, prazoMs: 60 });
    assert.ok(Date.now() - inicio < 1000);
    assert.equal(c.ok, false);
    assert.equal(c.ok === false && c.recuperavel, true);
    assert.match(c.ok === false ? c.erro : '', /demorou/);
    assert.ok(sinais.length === 2 && sinais.every((s) => s.aborted), 'as duas requisições foram abortadas');
});

test('P2-1: corpo que nunca termina também vence no prazo', async () => {
    const corpoPreso = { ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response;
    const c = await carregarPedido({ lerPedido: async () => corpoPreso, lerSessao: sessaoOk, prazoMs: 60 });
    assert.equal(c.ok === false && c.recuperavel, true);
});

test('P2-1: pedido inválido não é recuperável (mensagem do servidor); 5xx e falha de rede são', async () => {
    const invalido = await carregarPedido({ lerPedido: async () => Response.json({ ok: false, erro: 'Pedido de conexão inválido ou expirado. Volte ao aplicativo e conecte novamente.' }, { status: 404 }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.deepEqual(invalido, { ok: false, erro: 'Pedido de conexão inválido ou expirado. Volte ao aplicativo e conecte novamente.', recuperavel: false });
    const indisponivel = await carregarPedido({ lerPedido: async () => Response.json({ ok: false, erro: 'Indisponível' }, { status: 503 }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.equal(indisponivel.ok === false && indisponivel.recuperavel, true);
    const rede = await carregarPedido({ lerPedido: async () => { throw new TypeError('fetch failed'); }, lerSessao: sessaoOk, prazoMs: 1000 });
    assert.equal(rede.ok === false && rede.recuperavel, true);
});

test('P2-1: carga normal entrega pedido e empresa; sair da tela aborta', async () => {
    const ok = await carregarPedido({ lerPedido: async () => Response.json({ ok: true, data: PEDIDO_OK }), lerSessao: sessaoOk, prazoMs: 1000 });
    assert.deepEqual(ok, { ok: true, pedido: PEDIDO_OK, empresa: { id: 'e1', nome: 'Buffet Sintético' } });
    const sinais: AbortSignal[] = [];
    const saida = new AbortController();
    const carga = carregarPedido({ lerPedido: pendurado(sinais), lerSessao: pendurado(sinais), prazoMs: 200, cancelamento: saida.signal });
    saida.abort();
    assert.ok(sinais.every((s) => s.aborted), 'desmontar a tela aborta as requisições');
    await carga;
});

test('10º parecer, P3: pedido e sessão de sessões diferentes não montam a tela de decisão', async () => {
    const sessaoB = async () => Response.json({ ok: true, data: { usuarioId: 'u1', contexto: { empresaAtual: { id: 'e2', nome: 'Buffet Beta' } } } });
    const outroUsuario = async () => Response.json({ ok: true, data: { usuarioId: 'u2', contexto: { empresaAtual: { id: 'e1', nome: 'Buffet Sintético' } } } });
    const pedidoA = async () => Response.json({ ok: true, data: PEDIDO_OK });
    const semSessao = async () => Response.json({ ok: true, data: { ...PEDIDO_OK, sessao: undefined } });
    for (const [lerPedido, lerSessao] of [[pedidoA, sessaoB], [pedidoA, outroUsuario]] as const) {
        const c = await carregarPedido({ lerPedido, lerSessao, prazoMs: 1000 });
        assert.deepEqual(c, { ok: false, erro: 'A conta ou a empresa mudou enquanto o pedido abria. Tente de novo.', recuperavel: true });
    }
    // 13º parecer, P3: pedido sem a sessão não prova mudança: não montar a decisão, como sessão não confirmada.
    assert.deepEqual(await carregarPedido({ lerPedido: semSessao, lerSessao: sessaoOk, prazoMs: 1000 }), { ok: false, erro: 'Não foi possível confirmar a sua sessão. Tente de novo.', recuperavel: true });
});

test('10º parecer, P3: a rota do pedido devolve a sessão usada (usuário e empresa ativa)', () => {
    const rota = readFileSync(new URL('../../app/api/admin/mcp/consentimento/route.ts', import.meta.url), 'utf8');
    assert.ok(rota.includes('sessao: { usuarioId: sessao.usuario_id, empresaId: contexto.empresaAtual?.id ?? null }'));
});

test('11º parecer, P3: falha de sessão nunca vira "sem empresa"; empresa nula só com as duas respostas concordando', async () => {
    const pedidoA = async () => Response.json({ ok: true, data: PEDIDO_OK });
    const pedidoSemEmpresa = async () => Response.json({ ok: true, data: { ...PEDIDO_OK, sessao: { usuarioId: 'u1', empresaId: null } } });
    const sessao503 = async () => Response.json({ ok: false, erro: 'Indisponível' }, { status: 503 });
    const sessao401 = async () => Response.json({ ok: false, erro: 'Sessão expirada' }, { status: 401 });
    const corpoInvalido = async () => new Response('<html>', { status: 200 });
    const semUsuario = async () => Response.json({ ok: true, data: { usuarioId: null, contexto: { empresaAtual: null } } });
    const sessaoSemEmpresa = async () => Response.json({ ok: true, data: { usuarioId: 'u1', contexto: { empresaAtual: null } } });
    for (const lerSessao of [sessao503, sessao401, corpoInvalido])
        assert.deepEqual(await carregarPedido({ lerPedido: pedidoA, lerSessao, prazoMs: 1000 }), { ok: false, erro: 'Não foi possível confirmar a sua sessão. Tente de novo.', recuperavel: true });
    assert.deepEqual(await carregarPedido({ lerPedido: pedidoA, lerSessao: semUsuario, prazoMs: 1000 }), { ok: false, erro: 'A sua sessão terminou. Entre de novo para responder ao pedido.', recuperavel: true });
    // Pedido lido com empresa, sessão lida sem empresa (ou o contrário): sessões diferentes, não "sem empresa".
    for (const [lerPedido, lerSessao] of [[pedidoA, sessaoSemEmpresa], [pedidoSemEmpresa, sessaoOk]] as const)
        assert.deepEqual(await carregarPedido({ lerPedido, lerSessao, prazoMs: 1000 }), { ok: false, erro: 'A conta ou a empresa mudou enquanto o pedido abria. Tente de novo.', recuperavel: true });
    const legitimo = await carregarPedido({ lerPedido: pedidoSemEmpresa, lerSessao: sessaoSemEmpresa, prazoMs: 1000 });
    assert.equal(legitimo.ok === false && (legitimo as { semEmpresa?: boolean }).semEmpresa, true);
});

test('11º parecer, P3: sessão não confirmada no adminFetch do pedido também vira falha de sessão, não de rede', async () => {
    const erroDeContexto = Object.assign(new Error('Não foi possível confirmar a sessão.'), { tipo: 'SESSAO_NAO_CONFIRMADA', enviado: false });
    const c = await carregarPedido({ lerPedido: async () => { throw erroDeContexto; }, lerSessao: sessaoOk, prazoMs: 1000 });
    assert.deepEqual(c, { ok: false, erro: 'Não foi possível confirmar a sua sessão. Tente de novo.', recuperavel: true });
    const rede = await carregarPedido({ lerPedido: async () => { throw Object.assign(new Error('rede'), { tipo: 'REDE', enviado: false }); }, lerSessao: sessaoOk, prazoMs: 1000 });
    assert.equal(rede.ok === false && rede.erro, 'Falha de conexão ao abrir o pedido.');
});

test('12º parecer, P3: sessão fora do contrato (sem contexto, empresa sem id, usuário de outro tipo) é sessão não confirmada, nunca "sem empresa"', async () => {
    const pedidoSemEmpresa = async () => Response.json({ ok: true, data: { ...PEDIDO_OK, sessao: { usuarioId: 'u1', empresaId: null } } });
    const naoConfirmada = { ok: false, erro: 'Não foi possível confirmar a sua sessão. Tente de novo.', recuperavel: true };
    for (const data of [
        { usuarioId: 'u1' },
        { usuarioId: 'u1', contexto: {} },
        { usuarioId: 'u1', contexto: { empresaAtual: { nome: 'Sem id' } } },
        { usuarioId: 'u1', contexto: { empresaAtual: 'e1' } },
        { usuarioId: 42, contexto: { empresaAtual: null } },
        { usuarioId: '', contexto: { empresaAtual: null } },
    ]) assert.deepEqual(await carregarPedido({ lerPedido: pedidoSemEmpresa, lerSessao: async () => Response.json({ ok: true, data }), prazoMs: 1000 }), naoConfirmada, JSON.stringify(data));
    // 13º parecer, P3: pedido fora do contrato (sem empresaId, empresaId de outro tipo, sem usuário, sem sessão) não vira
    // "sem empresa" nem "mudou": é sessão não confirmada, com a sessão lida com ou sem empresa.
    const sessaoSemEmpresa = async () => Response.json({ ok: true, data: { usuarioId: 'u1', contexto: { empresaAtual: null } } });
    const sessaoComEmpresa = async () => Response.json({ ok: true, data: { usuarioId: 'u1', contexto: { empresaAtual: { id: 'e1', nome: 'E' } } } });
    for (const sessao of [{ usuarioId: 'u1' }, { usuarioId: 'u1', empresaId: 7 }, { usuarioId: 'u1', empresaId: '' }, { empresaId: 'e1' }, null]) {
        const pedido = async () => Response.json({ ok: true, data: { ...PEDIDO_OK, sessao } });
        for (const lerSessao of [sessaoSemEmpresa, sessaoComEmpresa])
            assert.deepEqual(await carregarPedido({ lerPedido: pedido, lerSessao, prazoMs: 1000 }), naoConfirmada, JSON.stringify(sessao));
    }
    // Controle: duas identidades válidas que divergem continuam "mudou".
    const outraEmpresa = async () => Response.json({ ok: true, data: { ...PEDIDO_OK, sessao: { usuarioId: 'u1', empresaId: 'e2' } } });
    assert.deepEqual(await carregarPedido({ lerPedido: outraEmpresa, lerSessao: sessaoComEmpresa, prazoMs: 1000 }), { ok: false, erro: 'A conta ou a empresa mudou enquanto o pedido abria. Tente de novo.', recuperavel: true });
    // Controle: os dois lados com empresaAtual/empresaId null explícitos continuam "sem empresa".
    const legitimo = await carregarPedido({ lerPedido: pedidoSemEmpresa, lerSessao: sessaoSemEmpresa, prazoMs: 1000 });
    assert.equal(legitimo.ok === false && (legitimo as { semEmpresa?: boolean }).semEmpresa, true);
});

// 16º parecer, P2-2: depois do adminFetch, o consentimento ainda lê o corpo. Uma troca desta página que começa nessa
// leitura não deixa a tela voltar ao assistente: o resultado conhecido (autorização concluída) fica guardado e a troca
// decide a navegação; nada é reenviado. adminFetch, trocarEmpresaAtiva e o contexto são os reais; só a rede é sintética.
type CtxConsent = { registrarContextoEmpresa: (s: string, e: string | null) => boolean; fimDaTrocaEmCurso: () => Promise<void> | null; lerAvisoDeContexto: () => string | null };
type ModConsent = { trocarEmpresaAtiva: (id: string) => Promise<Response>; adminFetch: (u: string, i?: RequestInit) => Promise<Response> };
type DecisaoTela = 'PERMITIR' | 'NEGAR';
type Decisao = { tipo: string; decisao?: DecisaoTela; destino?: string; fim?: Promise<void> | null };
type UiConsent = {
    enviarDecisao: (decisao: DecisaoTela, post: () => Promise<Response>, navegar: (d: string) => void) => Promise<Decisao>;
    AVISO_AUTORIZACAO_NA_TROCA: string;
    AVISO_RECUSA_NA_TROCA: string;
    RetornoNaTroca: ComponentType<{ decisao: DecisaoTela; destino: string; liberado: boolean }>;
};
const DESTINO = 'https://assistente.example/callback?code=sintetico';
// Formato do retorno de "Não permitir" no serviço (lib/integracoes/oauth/servico.ts, ramo NEGAR): erro access_denied.
const DESTINO_NEGADO = 'https://assistente.example/callback?error=access_denied&state=sintetico';
const sessaoS1Consent = () => Response.json({ ok: true, data: { usuarioId: 'u', sessaoId: 's1', csrf: 'c', contexto: { empresaAtual: { id: 'alfa' } } } });
function prepararConsentimentoReal() {
    const cacheReal = new Map<string, Record<string, unknown>>();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cacheReal) as unknown as CtxConsent;
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cacheReal) as unknown as ModConsent;
    const ui = carregarModulo('components/admin/ConsentimentoAssistente.tsx', { 'workspace.module.css': {}, 'admin.module.css': {}, 'visual.module.css': {}, 'conexoes-assistentes.module.css': {}, 'components/admin/sair': { sairDaSessao: semRede } }, cacheReal) as unknown as UiConsent;
    const janela: Array<{ destino: string; pendente: boolean }> = [];
    const avisos = new Map<string, string>();
    const registrar = (destino: string) => { janela.push({ destino, pendente: ctx.fimDaTrocaEmCurso() !== null }); };
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/mcp/consentimento', search: '', replace: registrar, assign: registrar } };
    g.sessionStorage = { getItem: (k: string) => avisos.get(k) ?? null, setItem: (k: string, v: string) => avisos.set(k, v), removeItem: (k: string) => avisos.delete(k) };
    ctx.registrarContextoEmpresa('s1', 'alfa');
    return { ctx, mod, ui, janela };
}
const postConsentimento = (mod: ModConsent) => () => mod.adminFetch('/api/admin/mcp/consentimento?empresaId=alfa', { method: 'POST', body: '{}' });

for (const [decisao, status] of [['PERMITIR', 200], ['PERMITIR', 403], ['NEGAR', 200], ['NEGAR', 403]] as const) {
    const destinoDaDecisao = decisao === 'NEGAR' ? DESTINO_NEGADO : DESTINO;
    test(`16º/17º parecer: ${decisao} com troca iniciada durante a leitura do corpo (${status === 200 ? 'aceita' : 'recusada'}): não volta ao assistente com a troca pendente; aviso da decisão guardado; um POST`, async () => {
        const { ctx, mod, ui, janela } = prepararConsentimentoReal();
        let corpoIniciado!: () => void; let soltarCorpo!: (v: unknown) => void; let trocaEnviada!: () => void; let soltarTroca!: () => void;
        const lendoCorpo = new Promise<void>((r) => { corpoIniciado = r; });
        const corpo = new Promise((r) => { soltarCorpo = r; });
        const trocaNoServidor = new Promise<void>((r) => { trocaEnviada = r; });
        const trocaRetida = new Promise<void>((r) => { soltarTroca = r; });
        let postsConsentimento = 0;
        (globalThis as unknown as { fetch: unknown }).fetch = async (u: string, i: RequestInit = {}) => {
            if (String(u) === '/api/admin/autenticacao') {
                if (i.method === 'POST') { trocaEnviada(); await trocaRetida; return Response.json(status === 200 ? { ok: true } : { ok: false, erro: 'recusada' }, { status }); }
                return sessaoS1Consent();
            }
            postsConsentimento++;
            return { ok: true, status: 200, json: () => { corpoIniciado(); return corpo; } };
        };
        const navegou: string[] = [];
        const envio = ui.enviarDecisao(decisao, postConsentimento(mod), (d) => navegou.push(d));
        await lendoCorpo;
        const troca = mod.trocarEmpresaAtiva('beta').then((r) => r.status, () => 'erro');
        await trocaNoServidor;
        soltarCorpo({ ok: true, data: { destino: destinoDaDecisao } });
        const r = await envio;
        assert.equal(r.tipo, 'troca');
        assert.equal(r.decisao, decisao);
        assert.equal(r.destino, destinoDaDecisao);
        assert.deepEqual(navegou, [], 'não voltou ao assistente com a troca pendente');
        assert.equal(janela.length, 0, 'nada navegou com a troca pendente');
        assert.ok(ctx.fimDaTrocaEmCurso() !== null && r.fim === ctx.fimDaTrocaEmCurso(), 'a tela espera a troca em curso');
        soltarTroca();
        assert.equal(await troca, status);
        await r.fim;
        assert.deepEqual(navegou, [], 'nem depois da troca: a volta ao assistente é por clique');
        assert.deepEqual(janela.filter((n) => n.pendente), []);
        assert.equal(postsConsentimento, 1, 'o POST do consentimento não é repetido');
        // 17º parecer, P3-1: "Não permitir" nunca vira "autorização concluída".
        const aviso = ctx.lerAvisoDeContexto();
        assert.equal(aviso, decisao === 'NEGAR' ? ui.AVISO_RECUSA_NA_TROCA : ui.AVISO_AUTORIZACAO_NA_TROCA);
        if (decisao === 'NEGAR') assert.doesNotMatch(aviso ?? '', /autorização do assistente foi concluída|confira a conexão/);
    });
}

test('16º parecer: sem troca, o consentimento volta ao assistente uma vez e não guarda aviso', async () => {
    const { ctx, mod, ui, janela } = prepararConsentimentoReal();
    let posts = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async (u: string) => {
        if (String(u) === '/api/admin/autenticacao') return sessaoS1Consent();
        posts++;
        return Response.json({ ok: true, data: { destino: DESTINO } });
    };
    const navegou: string[] = [];
    const r = await ui.enviarDecisao('PERMITIR', postConsentimento(mod), (d) => navegou.push(d));
    assert.equal(r.tipo, 'navegou');
    assert.deepEqual(navegou, [DESTINO]);
    assert.deepEqual(janela, []);
    assert.equal(posts, 1);
    assert.equal(ctx.lerAvisoDeContexto(), null);
});

test('16º parecer: troca já em curso ao retomar o adminFetch também segura a volta ao assistente', async () => {
    const { ctx, mod, ui } = prepararConsentimentoReal();
    (globalThis as unknown as { fetch: unknown }).fetch = async (u: string) => {
        if (String(u) === '/api/admin/autenticacao') return sessaoS1Consent();
        return Response.json({ ok: true, data: { destino: DESTINO } });
    };
    const navegou: string[] = [];
    const r = await ui.enviarDecisao('PERMITIR', async () => {
        const res = await postConsentimento(mod)();
        (ctx as unknown as { iniciarTrocaDeEmpresa: () => void }).iniciarTrocaDeEmpresa();
        return res;
    }, (d) => navegou.push(d));
    assert.equal(r.tipo, 'troca');
    assert.deepEqual(navegou, []);
    (ctx as unknown as { encerrarTrocaDeEmpresa: () => void }).encerrarTrocaDeEmpresa();
});

test('16º parecer: tela da autorização concluída na troca só oferece voltar ao assistente depois da troca', () => {
    const { ui } = prepararConsentimentoReal();
    const pendente = renderToStaticMarkup(createElement(ui.RetornoNaTroca, { decisao: 'PERMITIR', destino: DESTINO, liberado: false }));
    assert.match(pendente, /A autorização foi concluída/);
    assert.match(pendente, /Aguardando a troca de empresa terminar/);
    assert.doesNotMatch(pendente, /data-voltar-assistente/);
    const liberado = renderToStaticMarkup(createElement(ui.RetornoNaTroca, { decisao: 'PERMITIR', destino: DESTINO, liberado: true }));
    assert.match(liberado, /<a href="https:\/\/assistente\.example\/callback\?code=sintetico" data-voltar-assistente="true">Voltar ao assistente<\/a>/);
});

// 17º parecer, P3-1 e P3-2: o texto segue a decisão, e a própria tela orienta o que fazer se o retorno expirar ou falhar.
test('17º parecer: tela da troca diz "recusado" para Não permitir e orienta o retorno que falhar, sem prometer prazo', () => {
    const { ui } = prepararConsentimentoReal();
    for (const liberado of [false, true]) {
        const negou = renderToStaticMarkup(createElement(ui.RetornoNaTroca, { decisao: 'NEGAR', destino: DESTINO_NEGADO, liberado })).replace(/&quot;/g, '"');
        assert.match(negou, /O pedido foi recusado e nenhuma conexão foi criada/);
        assert.doesNotMatch(negou, /autorização foi concluída|conexão não aparecer/);
        assert.match(negou, /<p[^>]*data-retorno-expirado="true">Se o retorno ao assistente falhar, basta fechar esta página: nada foi conectado\./);
        const permitiu = renderToStaticMarkup(createElement(ui.RetornoNaTroca, { decisao: 'PERMITIR', destino: DESTINO, liberado }));
        assert.match(permitiu, /A autorização foi concluída/);
        assert.match(permitiu, /<p[^>]*data-retorno-expirado="true">O retorno ao assistente vale por pouco tempo depois da sua resposta\. Se ele falhar ou a conexão não aparecer no assistente, inicie uma conexão nova por lá; este pedido já foi respondido\.<\/p>/);
        // Sem prazo inventado na tela: nenhum número de segundos/minutos.
        assert.doesNotMatch(permitiu + negou, /\d+\s*(s|seg|segundos?|min|minutos?)\b/);
    }
});
