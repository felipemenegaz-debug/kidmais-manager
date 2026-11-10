import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach } from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { AVISO_ABRIR_CONFIRMACAO, AVISO_ABRIR_LINK, AVISO_ENDERECO_MUDOU, varianteDaRota } from '../../components/enderecos/variante-aviso.ts';

type Consulta = Record<string, unknown> | 'rede' | 'http500' | 'html' | 'pendurada';
const consulta = (modoEfetivo: string, painelNesteHost: boolean | null, toleranciaAtiva = true) => ({ modoEfetivo, painelNesteHost, toleranciaAtiva });
const MINUTO = 60 * 1000;

const agoraReal = Date.now;
const g = globalThis as unknown as Record<string, unknown>;
let agora = 1_000_000;
beforeEach(() => { agora = 1_000_000; Date.now = () => agora; });
afterEach(() => { Date.now = agoraReal; });

type Cli = {
    decidirFalhaSessao: (e: { tipo: '403' | 'falha'; telaCarregada: boolean; aindaValida: () => boolean }) => Promise<string>;
    conferirLeituraDaSessao: (l: { resposta: Response } | { erro: unknown }, c: { telaCarregada: () => boolean; aindaValida: () => boolean; vivo: () => boolean }) => Promise<unknown>;
    classificarLeituraSessao: (s: number, c: unknown) => string;
    sessaoValida: () => void; enderecoFinal: () => boolean; estadoAviso: () => string;
    assinarAviso: (a: () => void) => () => void; iniciarAcompanhamento: () => () => void;
};

function ambiente(roteiro: Consulta[]) {
    const pedidos: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const ouvintes = new Set<() => void>();
    g.window = { addEventListener: (_: string, f: () => void) => ouvintes.add(f), removeEventListener: (_: string, f: () => void) => ouvintes.delete(f) };
    g.fetch = async (url: string, init: RequestInit) => {
        pedidos.push({ url, init });
        const passo = roteiro[Math.min(i, roteiro.length - 1)];
        i += 1;
        if (passo === 'rede') throw new TypeError('fetch failed');
        if (passo === 'http500') return new Response('{}', { status: 500 });
        if (passo === 'html') return new Response('<html>', { status: 200 });
        if (passo === 'pendurada') return new Promise((_, rejeitar) => { init.signal!.addEventListener('abort', () => rejeitar(new Error('abortada'))); });
        return new Response(JSON.stringify(passo));
    };
    const cli = carregarModulo('lib/enderecos/cliente.ts', {}, new Map()) as unknown as Cli;
    const falha = (tipo: '403' | 'falha' = 'falha', aindaValida = () => true) => cli.decidirFalhaSessao({ tipo, telaCarregada: true, aindaValida });
    /** Consulta periódica (monta o acompanhamento e espera a resposta). */
    const periodica = async () => { const parar = cli.iniciarAcompanhamento(); await new Promise((r) => setImmediate(r)); parar(); };
    return { cli, pedidos, falha, periodica, ouvintes };
}

const passar = (ms: number) => { agora += ms; };

test('falha sem aba armada: como hoje, sem consulta (qualquer modo)', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    assert.equal(await a.falha(), 'COMO_HOJE');
    assert.equal(a.pedidos.length, 0);
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
});

test('sem tela carregada: como hoje, mesmo armada ou com 403', async () => {
    const a = ambiente([consulta('ATIVA', true)]);
    await a.periodica();
    const pedidos = a.pedidos.length;
    assert.equal(await a.cli.decidirFalhaSessao({ tipo: '403', telaCarregada: false, aindaValida: () => true }), 'COMO_HOJE');
    assert.equal(a.pedidos.length, pedidos);
});

test('403 sem aba armada: painel falso e modo em uso = endereço mudou, mesmo com tolerância falsa', async () => {
    for (const modo of ['PREPARACAO', 'ATIVA', 'REVERSAO', 'CONFIGURACAO_INVALIDA']) {
        const a = ambiente([consulta(modo, false, false)]);
        assert.equal(await a.falha('403'), 'ENDERECO_MUDOU', modo);
        assert.equal(a.cli.enderecoFinal(), true);
        assert.equal(a.cli.estadoAviso(), 'ENDERECO_MUDOU');
    }
});

test('403 sem aba armada: qualquer outro resultado mantém a recusa original', async () => {
    for (const passo of [consulta('ATIVA', true), consulta('PREPARACAO', true), consulta('DESLIGADO', false), consulta('DESLIGADO', null), consulta('ATIVA', null), 'rede', 'http500', 'html'] as Consulta[]) {
        const a = ambiente([passo]);
        assert.equal(await a.falha('403'), 'COMO_HOJE', JSON.stringify(passo));
        assert.equal(a.pedidos.length, 1);
        assert.equal(a.cli.enderecoFinal(), false);
        assert.equal(a.cli.estadoAviso(), 'NENHUM');
    }
});

test('aba armada: painel falso = final; painel verdadeiro em consulta nova = como hoje', async () => {
    const mudou = ambiente([consulta('PREPARACAO', true), consulta('CONFIGURACAO_INVALIDA', false)]);
    await mudou.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await mudou.falha(), 'ENDERECO_MUDOU');
    assert.equal(mudou.cli.enderecoFinal(), true);
    const sessao = ambiente([consulta('ATIVA', true), consulta('ATIVA', true)]);
    await sessao.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await sessao.falha('403'), 'COMO_HOJE');
    assert.equal(sessao.cli.enderecoFinal(), false);
});
function INTERVALO_FORCADO() { return 30 * 1000 + 1; }

test('aba armada: indisponível, tempo, corpo inválido ou painel nulo = inconclusivo; nunca equivale a falso', async () => {
    for (const passo of ['rede', 'http500', 'html', consulta('ATIVA', null), { modoEfetivo: 'ATIVA' }, { modoEfetivo: 'XPTO', painelNesteHost: false, toleranciaAtiva: true }] as Consulta[]) {
        const a = ambiente([consulta('PREPARACAO', true), passo]);
        await a.periodica();
        passar(INTERVALO_FORCADO());
        assert.equal(await a.falha(), 'INCONCLUSIVO', JSON.stringify(passo));
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
        assert.equal(a.cli.enderecoFinal(), false);
    }
});

test('consulta conclusiva com tolerância falsa, DESLIGADO desarma: como hoje e a próxima falha nem consulta', async () => {
    for (const passo of [consulta('ATIVA', null, false), consulta('DESLIGADO', null), consulta('DESLIGADO', false), consulta('CONFIGURACAO_INVALIDA', null, false)]) {
        const a = ambiente([consulta('PREPARACAO', true), passo]);
        await a.periodica();
        passar(INTERVALO_FORCADO());
        assert.equal(await a.falha(), 'COMO_HOJE', JSON.stringify(passo));
        const pedidos = a.pedidos.length;
        passar(INTERVALO_FORCADO());
        assert.equal(await a.falha(), 'COMO_HOJE');
        assert.equal(a.pedidos.length, pedidos);
    }
});

test('armar: PREPARACAO, ATIVA e REVERSAO com tolerância; CONFIGURACAO_INVALIDA não arma, mas mantém', async () => {
    for (const modo of ['PREPARACAO', 'ATIVA', 'REVERSAO']) {
        const a = ambiente([consulta(modo, true), 'rede']);
        await a.periodica();
        passar(INTERVALO_FORCADO());
        assert.equal(await a.falha(), 'INCONCLUSIVO', modo);
    }
    const nao = ambiente([consulta('CONFIGURACAO_INVALIDA', true), 'rede']);
    await nao.periodica();
    assert.equal(await nao.falha(), 'COMO_HOJE');
    const ja = ambiente([consulta('ATIVA', true), consulta('CONFIGURACAO_INVALIDA', null), 'rede']);
    await ja.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await ja.falha(), 'INCONCLUSIVO');
    passar(INTERVALO_FORCADO());
    assert.equal(await ja.falha(), 'INCONCLUSIVO');
});

test('sem tolerância, nem PREPARACAO arma: falha genérica segue como hoje', async () => {
    const a = ambiente([consulta('ATIVA', true, false)]);
    await a.periodica();
    assert.equal(await a.falha(), 'COMO_HOJE');
    assert.equal(a.pedidos.length, 1);
});

test('prazo: começa na primeira falha, não reinicia, só leitura válida zera; esgotado = como hoje sem consulta', async () => {
    const a = ambiente([consulta('ATIVA', true), 'rede']);
    await a.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await a.falha(), 'INCONCLUSIVO');
    passar(10 * MINUTO);
    assert.equal(await a.falha(), 'INCONCLUSIVO');
    passar(10 * MINUTO - 1);
    assert.equal(await a.falha(), 'INCONCLUSIVO');
    passar(1);
    const pedidos = a.pedidos.length;
    assert.equal(await a.falha(), 'COMO_HOJE');
    assert.equal(a.pedidos.length, pedidos);
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
    a.cli.sessaoValida();
    assert.equal(await a.falha(), 'INCONCLUSIVO', 'leitura válida zerou o prazo');
    a.cli.sessaoValida();
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
});

test('limites: uma por vez e intervalo de 30 s; resultado anterior à falha não autoriza descarte', async () => {
    const a = ambiente([consulta('ATIVA', true), consulta('ATIVA', true)]);
    await a.periodica();
    assert.equal(a.pedidos.length, 1);
    passar(1000);
    assert.equal(await a.falha(), 'INCONCLUSIVO', 'verdadeiro de antes da falha não leva a "como hoje"');
    assert.equal(a.pedidos.length, 1, 'reaproveita dentro do intervalo');
    passar(29 * 1000);
    assert.equal(await a.falha(), 'COMO_HOJE', 'consulta nova, iniciada depois da falha');
    assert.equal(a.pedidos.length, 2);
    const b = ambiente([consulta('ATIVA', true), 'rede']);
    await b.periodica();
    passar(INTERVALO_FORCADO());
    const juntas = await Promise.all([b.falha(), b.falha(), b.falha()]);
    assert.deepEqual(juntas, ['INCONCLUSIVO', 'INCONCLUSIVO', 'INCONCLUSIVO']);
    assert.equal(b.pedidos.length, 2);
});

test('consulta em andamento vale mais que o resultado anterior do intervalo', async () => {
    const a = ambiente([consulta('PREPARACAO', true), consulta('ATIVA', false)]);
    await a.periodica();
    passar(5 * MINUTO);
    const fetchOriginal = g.fetch as (u: string, i: RequestInit) => Promise<Response>;
    let soltar = () => {};
    g.fetch = (u: string, i: RequestInit) => fetchOriginal(u, i).then((r) => new Promise((ok) => { soltar = () => ok(r); }));
    const parar = a.cli.iniciarAcompanhamento(); // inicia a consulta periódica, que fica pendente
    parar();
    const pendente = ambienteEspera();
    await pendente;
    const decisao = a.falha();
    await pendente;
    soltar();
    assert.equal(await decisao, 'ENDERECO_MUDOU');
    assert.equal(a.pedidos.length, 2);
});
const ambienteEspera = () => new Promise((r) => setImmediate(r));

test('revalidação depois da espera: geração, sessão ou saída mudaram, o resultado é ignorado', async () => {
    const a = ambiente([consulta('ATIVA', true), consulta('ATIVA', false)]);
    await a.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await a.falha('falha', () => false), 'COMO_HOJE');
    const b = ambiente([consulta('ATIVA', true), 'rede']);
    await b.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await b.falha('falha', () => false), 'COMO_HOJE');
    assert.equal(b.cli.estadoAviso(), 'NENHUM');
});

test('tempo limite: 5 s aborta a consulta e dá inconclusivo', async (t) => {
    const a = ambiente([consulta('ATIVA', true), 'pendurada']);
    await a.periodica();
    passar(INTERVALO_FORCADO());
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const decisao = a.falha();
    await Promise.resolve();
    t.mock.timers.tick(5000);
    assert.equal(await decisao, 'INCONCLUSIVO');
});

test('consulta: relativa, sem cookie, sem referrer e sem cache', async () => {
    const a = ambiente([consulta('ATIVA', true)]);
    await a.periodica();
    assert.equal(a.pedidos[0].url, '/api/endereco-atual');
    const { credentials, referrerPolicy, cache, method, headers, body } = a.pedidos[0].init;
    assert.deepEqual({ credentials, referrerPolicy, cache, method, headers, body }, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', method: undefined, headers: undefined, body: undefined });
});

test('aviso de rotina em ATIVA e REVERSAO com o painel em outro host; a consulta periódica nunca avisa em PREPARACAO', async () => {
    for (const [passo, esperado] of [
        [consulta('ATIVA', false, false), 'ENDERECO_MUDOU'], [consulta('REVERSAO', false), 'ENDERECO_MUDOU'], [consulta('PREPARACAO', false), 'NENHUM'],
        [consulta('ATIVA', true), 'NENHUM'], [consulta('DESLIGADO', false), 'NENHUM'], [consulta('CONFIGURACAO_INVALIDA', false), 'NENHUM'], ['rede', 'NENHUM'],
    ] as Array<[Consulta, string]>) {
        const a = ambiente([passo]);
        let avisos = 0;
        a.cli.assinarAviso(() => { avisos += 1; });
        await a.periodica();
        assert.equal(a.cli.estadoAviso(), esperado, JSON.stringify(passo));
        assert.equal(avisos, esperado === 'NENHUM' ? 0 : 1);
    }
});

test('estado final: não volta atrás e segue valendo para as próximas decisões, sem consulta', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    await a.periodica();
    assert.equal(a.pedidos.length, 1);
    passar(30 * MINUTO);
    assert.equal(await a.falha(), 'ENDERECO_MUDOU');
    assert.equal(await a.falha('403'), 'ENDERECO_MUDOU');
    a.cli.sessaoValida();
    assert.equal(a.cli.estadoAviso(), 'ENDERECO_MUDOU');
    assert.equal(a.pedidos.length, 1);
});

test('acompanhamento: um temporizador só, foco e intervalo compartilham o limite de 5 min', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const a = ambiente([consulta('DESLIGADO', null)]);
    const parar1 = a.cli.iniciarAcompanhamento();
    const parar2 = a.cli.iniciarAcompanhamento();
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 1);
    assert.equal(a.ouvintes.size, 1);
    const foco = [...a.ouvintes][0];
    foco();
    passar(4 * MINUTO);
    foco();
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 1, 'foco dentro dos 5 min não consulta');
    passar(MINUTO);
    foco();
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 2);
    passar(5 * MINUTO);
    t.mock.timers.tick(5 * MINUTO);
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 3);
    parar1();
    assert.equal(a.ouvintes.size, 1, 'ainda há quem acompanhe');
    parar2();
    assert.equal(a.ouvintes.size, 0);
    passar(5 * MINUTO);
    t.mock.timers.tick(5 * MINUTO);
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 3, 'parado');
});

test('acompanhamento para ao chegar ao estado final', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let limpezas = 0;
    const limpar = globalThis.clearInterval;
    t.mock.method(globalThis, 'clearInterval', (id: Parameters<typeof clearInterval>[0]) => { limpezas += 1; limpar(id); });
    const a = ambiente([consulta('ATIVA', false)]);
    const parar = a.cli.iniciarAcompanhamento();
    await new Promise((r) => setImmediate(r));
    assert.equal(limpezas, 1, 'temporizador parado sem esperar a tela sair');
    passar(5 * MINUTO);
    t.mock.timers.tick(5 * MINUTO);
    [...a.ouvintes][0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(a.pedidos.length, 1);
    parar();
});

test('classificação preserva o status: 401 e 200 válido sem usuário são fim real; corpo inválido é falha', () => {
    const { classificarLeituraSessao: c } = ambiente(['rede']).cli;
    assert.equal(c(200, { ok: true, data: { usuarioId: 'u' } }), 'VALIDA');
    assert.equal(c(200, { ok: true, data: { usuarioId: null } }), 'ENCERRADA');
    assert.equal(c(401, null), 'ENCERRADA');
    assert.equal(c(401, { ok: false }), 'ENCERRADA');
    assert.equal(c(403, { ok: false }), 'RECUSA_403');
    for (const corpo of [undefined, null, 'x', {}, { ok: true }, { ok: false }, { ok: true, data: 1 }, { ok: false, data: { usuarioId: 'u' } }]) assert.equal(c(200, corpo), 'FALHA', JSON.stringify(corpo));
    for (const status of [500, 502, 404, 301]) assert.equal(c(status, { ok: true, data: { usuarioId: 'u' } }), 'FALHA');
});

const ctx = (extra: Partial<{ telaCarregada: () => boolean; aindaValida: () => boolean; vivo: () => boolean }> = {}) => ({ telaCarregada: () => true, aindaValida: () => true, vivo: () => true, ...extra });
const json = (corpo: unknown, status = 200) => ({ resposta: new Response(JSON.stringify(corpo), { status }) });

test('leitura do shell: caminhos de hoje preservados fora de migração', async () => {
    const a = ambiente(['rede']);
    const valido = { ok: true, data: { usuarioId: 'u' } };
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json(valido), ctx()), valido);
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json({ ok: true, data: { usuarioId: null } }), ctx()), { ok: true, data: { usuarioId: null } });
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json({ ok: false }, 401), ctx()), { ok: false });
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json({ ok: false }, 500), ctx()), { ok: false }, 'como hoje: vai ao login por !b.ok');
    await assert.rejects(a.cli.conferirLeituraDaSessao({ resposta: new Response('<html>', { status: 502 }) }, ctx()), SyntaxError, 'corpo inválido: o .catch de hoje');
    const rede = new TypeError('rede');
    await assert.rejects(a.cli.conferirLeituraDaSessao({ erro: rede }, ctx()), (e) => e === rede);
    assert.equal(a.pedidos.length, 0, 'sem consulta');
});

test('leitura do shell: 401 nunca consulta, nem com a aba armada', async () => {
    const a = ambiente([consulta('ATIVA', true), consulta('ATIVA', false)]);
    await a.periodica();
    passar(INTERVALO_FORCADO());
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json({ ok: false }, 401), ctx()), { ok: false });
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json({ ok: true, data: { usuarioId: null } }), ctx()), { ok: true, data: { usuarioId: null } });
    assert.equal(a.pedidos.length, 1);
});

test('leitura do shell: aba armada mantém a tela em rede, 5xx e 200 com corpo inválido', async () => {
    for (const leitura of [{ erro: new TypeError('rede') }, json({ ok: false }, 500), { resposta: new Response('<html>', { status: 200 }) }, json({ ok: false })]) {
        const a = ambiente([consulta('ATIVA', true), 'rede']);
        await a.periodica();
        passar(INTERVALO_FORCADO());
        assert.equal(await a.cli.conferirLeituraDaSessao(leitura, ctx()), null);
        assert.equal(a.cli.estadoAviso(), 'SEM_RESPOSTA');
    }
});

test('leitura do shell: leitura válida retoma e zera o prazo', async () => {
    const a = ambiente([consulta('ATIVA', true), 'rede']);
    await a.periodica();
    passar(INTERVALO_FORCADO());
    assert.equal(await a.cli.conferirLeituraDaSessao(json({ ok: false }, 500), ctx()), null);
    passar(25 * MINUTO);
    const valido = { ok: true, data: { usuarioId: 'u' } };
    assert.deepEqual(await a.cli.conferirLeituraDaSessao(json(valido), ctx()), valido);
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
    assert.equal(await a.cli.conferirLeituraDaSessao(json({ ok: false }, 500), ctx()), null, 'prazo novo');
});

test('leitura do shell: precedência e estado final', async () => {
    // Estado final: resposta em andamento não atualiza a tela, nem com sessão válida ou encerrada.
    const f = ambiente([consulta('ATIVA', false)]);
    await f.periodica();
    for (const l of [json({ ok: true, data: { usuarioId: 'u' } }), json({ ok: false }, 401), { erro: new Error('x') }]) assert.equal(await f.cli.conferirLeituraDaSessao(l, ctx()), null);
    // Sessão obsoleta ou saída: sem consulta, caminho de hoje (a guarda da tela decide).
    const o = ambiente([consulta('ATIVA', true), consulta('ATIVA', false)]);
    await o.periodica();
    passar(INTERVALO_FORCADO());
    assert.deepEqual(await o.cli.conferirLeituraDaSessao(json({ ok: false }, 403), ctx({ aindaValida: () => false })), { ok: false });
    assert.equal(o.pedidos.length, 1);
    // Tela trocada durante a espera: o ciclo novo decide; sem espera, como hoje mesmo sem tela viva.
    let vivo = true;
    const m = ambiente([consulta('ATIVA', true)]);
    const espera = m.cli.conferirLeituraDaSessao(json({ ok: false }, 403), ctx({ vivo: () => { const v = vivo; vivo = false; return v; } }));
    assert.equal(await espera, null);
    const hoje = ambiente(['rede']);
    assert.deepEqual(await hoje.cli.conferirLeituraDaSessao(json({ ok: false }, 500), ctx({ vivo: () => false })), { ok: false });
    // 403 sem tela carregada: como hoje.
    const sem = ambiente([consulta('ATIVA', false)]);
    assert.deepEqual(await sem.cli.conferirLeituraDaSessao(json({ ok: false }, 403), ctx({ telaCarregada: () => false })), { ok: false });
    assert.equal(sem.pedidos.length, 0);
});

test('variante do aviso: sem botão onde recarregar perderia token ou link', () => {
    for (const c of ['/admin/dashboard', '/clientes', '/desenvolvedor/x', '/convites/criar', '/convite/abc', '/cadastro', '/cadastro/empresa', '/acesso/recuperar', '/admin/login'])
        assert.deepEqual(varianteDaRota(c), { texto: AVISO_ENDERECO_MUDOU, botao: true }, c);
    for (const c of ['/acesso/convite', '/acesso/redefinir', '/acesso/convite/abc']) assert.deepEqual(varianteDaRota(c), { texto: AVISO_ABRIR_LINK, botao: false }, c);
    assert.deepEqual(varianteDaRota('/cadastro/confirmar'), { texto: AVISO_ABRIR_CONFIRMACAO, botao: false });
});

test('aviso montado só nas árvores que dependem do painel', () => {
    for (const f of ['app/admin', 'app/clientes', 'app/desenvolvedor', 'app/cadastro', 'app/acesso', 'app/convite', 'app/convites'])
        assert.match(readFileSync(`${f}/layout.tsx`, 'utf8'), /<AvisoEndereco \/>/, f);
    assert.doesNotMatch(readFileSync('app/layout.tsx', 'utf8'), /AvisoEndereco/, 'nunca no layout raiz');
});

test('módulo cliente independente: não importa AdminShell nem adminFetch', () => {
    const fonte = readFileSync('lib/enderecos/cliente.ts', 'utf8');
    assert.doesNotMatch(fonte, /^import /m);
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /const ciclo = \(\) => \{ if \(!enderecoFinal\(\)\) void carregar\(\); \};/);
    assert.match(shell, /registrarContextoEmpresa\(b\.data\.sessaoId[^\n]*\n\s*telaCarregada\.current = true;/, 'contexto antes de atualizar a tela na retomada');
});

test('exceção de PREPARACAO no contrato: só falha de sessão numa aba do painel fora do host mostra o aviso', async () => {
    const a = ambiente([consulta('PREPARACAO', false)]);
    await a.periodica();
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
    agora += 31 * 1000;
    assert.equal(await a.falha('403'), 'ENDERECO_MUDOU');
    assert.equal(a.cli.estadoAviso(), 'ENDERECO_MUDOU');
});

test('decisão recusada na revalidação não deixa efeito: sem final, sem aviso e com o acompanhamento ativo', async (t) => {
    const parados: unknown[] = [];
    const original = globalThis.clearInterval;
    globalThis.clearInterval = ((id: never) => { parados.push(id); original(id); }) as typeof clearInterval;
    t.after(() => { globalThis.clearInterval = original; });
    const a = ambiente([consulta('DESLIGADO', null), consulta('ATIVA', false), consulta('ATIVA', false)]);
    const avisos: number[] = [];
    a.cli.assinarAviso(() => avisos.push(1));
    const parar = a.cli.iniciarAcompanhamento();
    t.after(parar);
    await ambienteEspera();
    agora += 31 * 1000;
    assert.equal(await a.falha('403', () => false), 'COMO_HOJE');
    assert.equal(a.pedidos.length, 2);
    assert.equal(a.cli.enderecoFinal(), false);
    assert.equal(a.cli.estadoAviso(), 'NENHUM');
    assert.deepEqual(avisos, []);
    assert.deepEqual(parados, []);
    // A consulta periódica seguinte continua valendo por conta própria.
    agora += 5 * MINUTO;
    for (const f of a.ouvintes) f();
    await ambienteEspera();
    assert.equal(a.cli.enderecoFinal(), true);
    assert.equal(parados.length, 1);
});

test('decisão recusada não desarma: o resultado fica de fora e a aba segue armada', async () => {
    const a = ambiente([consulta('ATIVA', true), consulta('DESLIGADO', null), 'rede']);
    await a.periodica();
    agora += 31 * 1000;
    assert.equal(await a.falha('falha', () => false), 'COMO_HOJE');
    agora += 31 * 1000;
    assert.equal(await a.falha('falha'), 'INCONCLUSIVO');
});

test('resultado guardado por uma decisão recusada vale para a seguinte dentro do intervalo', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    assert.equal(await a.falha('403', () => false), 'COMO_HOJE');
    assert.equal(a.cli.enderecoFinal(), false);
    assert.equal(await a.falha('403'), 'ENDERECO_MUDOU');
    assert.equal(a.pedidos.length, 1);
    assert.equal(a.cli.enderecoFinal(), true);
});

test('consulta compartilhada: a periódica aplica o que é dela, mesmo se a forçada que a aproveitou perdeu a validade', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    const parar = a.cli.iniciarAcompanhamento();
    assert.equal(await a.falha('403', () => false), 'COMO_HOJE');
    await ambienteEspera();
    assert.equal(a.pedidos.length, 1);
    assert.equal(a.cli.enderecoFinal(), true);
    parar();
});

test('consulta compartilhada: forçada primeiro, periódica depois, e a recusa da forçada não apaga a da periódica', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    const forcada = a.falha('403', () => false);
    const parar = a.cli.iniciarAcompanhamento();
    assert.equal(await forcada, 'COMO_HOJE');
    await ambienteEspera();
    assert.equal(a.pedidos.length, 1);
    assert.equal(a.cli.enderecoFinal(), true);
    parar();
});

test('leitura do shell: final vindo da consulta periódica enquanto a decisão perdia a validade não relança para o login', async () => {
    const a = ambiente([consulta('ATIVA', false)]);
    const parar = a.cli.iniciarAcompanhamento();
    let chamadas = 0;
    const r = await a.cli.conferirLeituraDaSessao({ resposta: new Response('{}', { status: 403 }) }, { telaCarregada: () => true, aindaValida: () => { chamadas += 1; return chamadas === 1; }, vivo: () => true });
    assert.equal(r, null);
    assert.equal(a.cli.enderecoFinal(), true);
    parar();
});
