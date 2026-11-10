import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Lote de importação (plano rev. 2, R2-3): cada caminho de erro do adminFetch leva a causa tipada (`tipo`, `enviado`)
 * sem mudar a mensagem que as telas já mostram. Módulos reais com globais falsos, como avisos-prioridade.test.ts.
 */
type Erro = Error & { tipo?: string; enviado?: boolean };
function ambiente() {
    const g = globalThis as unknown as Record<string, unknown>;
    const armazenado = new Map<string, string>();
    g.window = { location: { pathname: '/admin/importacao', replace() {}, assign() {} } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    let sessao: { sessaoId: string; empresa: string; logado: boolean } = { sessaoId: 's1', empresa: 'alfa', logado: true };
    const confirmacoes: Array<'rede' | 'http500'> = [];
    const envios: string[] = [];
    let resposta: (() => Response) | 'rede' = () => Response.json({ ok: true });
    let depois: (() => void) | null = null;
    const redeOriginal = new TypeError('Failed to fetch');
    g.fetch = async (input: string, init: RequestInit = {}) => {
        if (String(input) === '/api/admin/autenticacao' && (init.method ?? 'GET') === 'GET') {
            const f = confirmacoes.shift();
            if (f === 'rede') throw new TypeError('Failed to fetch');
            if (f === 'http500') return new Response('{}', { status: 500 });
            return Response.json({ ok: true, data: { usuarioId: sessao.logado ? 'u' : null, sessaoId: sessao.sessaoId, csrf: 'c', contexto: { empresaAtual: { id: sessao.empresa } } } });
        }
        envios.push(`${init.method ?? 'GET'} ${input}`);
        if (resposta === 'rede') throw redeOriginal;
        const r = resposta();
        depois?.();
        return r;
    };
    const cache = new Map();
    const contexto = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as { iniciarTrocaDeEmpresa: () => void; lerAvisoDeContexto: () => string | null };
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; AVISO_RESULTADO_INCERTO: string; AVISO_LEITURA_NAO_CONFIRMADA: string; ErroContextoAdmin: new (...a: unknown[]) => Error };
    return {
        mod, contexto, envios, confirmacoes, redeOriginal,
        responder: (r: (() => Response) | 'rede') => { resposta = r; },
        aoResponder: (f: () => void) => { depois = f; },
        trocarEmpresa: (empresa: string) => { sessao = { ...sessao, empresa }; },
        sair: () => { sessao = { ...sessao, logado: false }; },
    };
}
const URL_ESCRITA = '/api/admin/inteligencia/importacoes';
const URL_LEITURA = '/api/admin/inteligencia/importacoes?x=1';
const POST = { method: 'POST', body: '{}' };
async function falha(p: Promise<unknown>): Promise<Erro> {
    try { await p; } catch (e) { return e as Erro; }
    throw Error('era para falhar');
}
// 18º parecer, P3: uma espera sem prazo não pode só deixar o teste pendurado (o Node cancela, e cancelamento não é falha
// do oráculo). O relógio de guarda mantém o laço vivo e transforma a espera interminável numa asserção que falha.
async function dentroDe<T>(p: Promise<T>, ms: number, oQue: string): Promise<T> {
    let guarda: ReturnType<typeof setTimeout> | undefined;
    const estouro = new Promise<never>((_, rejeitar) => { guarda = setTimeout(() => rejeitar(new assert.AssertionError({ message: oQue + ': não terminou em ' + ms + ' ms' })), ms); });
    try { return await Promise.race([p, estouro]); } finally { clearTimeout(guarda); }
}

test('confirmação prévia falha → SESSAO_NAO_CONFIRMADA, não enviado, mesma mensagem, zero envio', async () => {
    const a = ambiente();
    a.confirmacoes.push('rede');
    const e = await falha(a.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado, e.message], ['SESSAO_NAO_CONFIRMADA', false, 'Não foi possível confirmar a sessão antes do envio. Nada foi enviado.']);
    assert.ok(e instanceof a.mod.ErroContextoAdmin);
    assert.equal(a.envios.length, 0);
    const b = ambiente(); b.confirmacoes.push('http500');
    const l = await falha(b.mod.adminFetch(URL_LEITURA));
    assert.deepEqual([l.tipo, l.enviado, l.message], ['SESSAO_NAO_CONFIRMADA', false, 'Não foi possível confirmar a sessão. Tente novamente.']);
});

test('sessão encerrada antes do envio → SESSAO_ENCERRADA, não enviado', async () => {
    const a = ambiente(); a.sair();
    const e = await falha(a.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado, e.message], ['SESSAO_ENCERRADA', false, 'Faça login para continuar.']);
    assert.equal(a.envios.length, 0);
});

test('rede na escrita → RESULTADO_INCERTO enviado; rede na leitura → o MESMO erro original, com tipo REDE', async () => {
    const a = ambiente(); a.responder('rede');
    const e = await falha(a.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado, e.message], ['RESULTADO_INCERTO', true, a.mod.AVISO_RESULTADO_INCERTO]);
    assert.equal(a.envios.length, 1, 'nunca repete');
    const b = ambiente(); b.responder('rede');
    const l = await falha(b.mod.adminFetch(URL_LEITURA));
    assert.equal(l, b.redeOriginal, 'mesmo objeto: nome, pilha e instanceof preservados');
    assert.ok(l instanceof TypeError);
    assert.deepEqual([l.tipo, l.enviado, l.message], ['REDE', true, 'Failed to fetch']);
});

test('409 AUTENTICACAO_ADMINISTRATIVA → RECUSADA_PELO_CONTEXTO, enviado, mesma mensagem', async () => {
    const a = ambiente();
    a.responder(() => Response.json({ ok: false, codigo: 'AUTENTICACAO_ADMINISTRATIVA' }, { status: 409 }));
    const e = await falha(a.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado, e.message], ['RECUSADA_PELO_CONTEXTO', true, 'A empresa ou a sessão mudou. Nada foi alterado.']);
});

test('depois da resposta: confirmação falha → SESSAO_NAO_CONFIRMADA enviado; empresa mudou → CONTEXTO_MUDOU; saiu → SESSAO_ENCERRADA', async () => {
    const a = ambiente();
    a.aoResponder(() => a.confirmacoes.push('rede'));
    const e = await falha(a.mod.adminFetch(URL_LEITURA));
    assert.deepEqual([e.tipo, e.enviado, e.message], ['SESSAO_NAO_CONFIRMADA', true, a.mod.AVISO_LEITURA_NAO_CONFIRMADA]);

    const b = ambiente();
    await b.mod.adminFetch(URL_LEITURA); // registra a empresa da página
    b.aoResponder(() => b.trocarEmpresa('beta'));
    const m = await falha(b.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([m.tipo, m.enviado], ['CONTEXTO_MUDOU', true]);
    assert.match(m.message, /concluída antes da mudança/);

    const c = ambiente();
    c.aoResponder(() => c.sair());
    const s = await falha(c.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([s.tipo, s.enviado], ['SESSAO_ENCERRADA', true]);
});

function comSinal() {
    const a = ambiente();
    const g = globalThis as unknown as { fetch: unknown; window: { location: { replace: (d?: string) => void; assign: (d?: string) => void } } };
    const original = g.fetch as (i: string, init?: RequestInit) => Promise<Response>;
    const navegacoes: string[] = [];
    g.window.location.replace = (destino?: string) => { navegacoes.push(String(destino)); };
    g.window.location.assign = (destino?: string) => { navegacoes.push(String(destino)); };
    const sinais: Array<AbortSignal | null | undefined> = [];
    let antesDaChamada: (n: number) => void = () => undefined;
    let entregaMesmoCancelado = false;
    g.fetch = async (input: string, init: RequestInit = {}) => {
        sinais.push(init.signal);
        antesDaChamada(sinais.length);
        if (!entregaMesmoCancelado) init.signal?.throwIfAborted();
        return original(input, init);
    };
    return { ...a, navegacoes, sinais, aoChamar: (f: (n: number) => void) => { antesDaChamada = f; }, entregarMesmoCancelado: () => { entregaMesmoCancelado = true; } };
}

test('sinal chega às duas confirmações de sessão e ao pedido; sem cancelamento, nada muda', async () => {
    const a = comSinal();
    const c = new AbortController();
    const r = await a.mod.adminFetch(URL_LEITURA, { signal: c.signal });
    assert.equal(r.ok, true);
    assert.deepEqual(a.sinais, [c.signal, c.signal, c.signal]);
});

test('leitura cancelada na confirmação prévia: nada enviado, página intacta', async () => {
    const a = comSinal();
    const c = new AbortController();
    a.aoChamar(() => c.abort());
    const e = await falha(a.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    assert.equal(e.name, 'AbortError');
    assert.equal(a.envios.length, 0);
    assert.deepEqual(a.navegacoes, []);
});

test('leitura cancelada na confirmação posterior: não descarta a página nem guarda aviso', async () => {
    const a = comSinal();
    const c = new AbortController();
    a.aoChamar((n) => { if (n === 3) c.abort(); });
    const e = await falha(a.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    assert.equal(e.name, 'AbortError');
    assert.deepEqual(a.navegacoes, []);
});

test('falha de confirmação sem cancelamento continua descartando a leitura', async () => {
    const a = comSinal();
    a.confirmacoes.push('rede');
    const c = new AbortController();
    const e = await falha(a.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
});

// A resposta da confirmação já trouxe a evidência quando o sinal é abortado: a evidência vence o cancelamento.
async function cancelarComEvidencia(momento: 'previa' | 'posterior', evidencia: (a: ReturnType<typeof comSinal>) => void) {
    const a = comSinal();
    const c = new AbortController();
    await a.mod.adminFetch(URL_LEITURA); // registra o contexto inicial
    a.entregarMesmoCancelado();
    const base = a.sinais.length;
    const alvo = base + (momento === 'previa' ? 1 : 3);
    const enviosAntes = a.envios.length;
    a.aoChamar((n) => { if (n === alvo) { evidencia(a); c.abort(); } });
    const e = await falha(a.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    return { a, e, novosEnvios: a.envios.length - enviosAntes };
}

for (const momento of ['previa', 'posterior'] as const) {
    const enviados = momento === 'previa' ? 0 : 1;
    test(`aborto na confirmação ${momento} com outra empresa: descarta a página`, async () => {
        const { a, e, novosEnvios } = await cancelarComEvidencia(momento, (x) => x.trocarEmpresa('beta'));
        assert.equal(e.tipo, 'CONTEXTO_MUDOU');
        assert.equal(novosEnvios, enviados);
        assert.equal(a.navegacoes.length, 1);
    });
    test(`aborto na confirmação ${momento} com sessão encerrada: vai ao login`, async () => {
        const { a, e } = await cancelarComEvidencia(momento, (x) => x.sair());
        assert.equal(e.tipo, 'SESSAO_ENCERRADA');
        assert.equal(a.navegacoes.length, 1);
        assert.match(a.navegacoes[0], /login/);
    });
    test(`aborto na confirmação ${momento} com troca em curso: sessão obsoleta não vai ao login`, async () => {
        const { a, e } = await cancelarComEvidencia(momento, (x) => { x.sair(); x.contexto.iniciarTrocaDeEmpresa(); });
        if (momento === 'posterior') {
            // 14º parecer, P2: depois da resposta, a troca pendente ainda não diz se foi aceita; a leitura cancelada
            // termina com o motivo do cancelamento e nada navega daqui (a troca decide).
            assert.equal(e.name, 'AbortError');
            assert.deepEqual(a.navegacoes, []);
        } else assert.equal(e.tipo, 'CONTEXTO_MUDOU');
        assert.equal(a.navegacoes.some((d) => /login/.test(d)), false);
    });
    test(`aborto na confirmação ${momento} com a mesma sessão: motivo do cancelamento, página intacta`, async () => {
        const { a, e, novosEnvios } = await cancelarComEvidencia(momento, () => undefined);
        assert.equal(e.name, 'AbortError');
        assert.equal(novosEnvios, enviados);
        assert.deepEqual(a.navegacoes, []);
    });
}

test('POST com sinal, mesma sessão confirmada e aborto depois da resposta: devolve a resposta', async () => {
    const a = comSinal();
    await a.mod.adminFetch(URL_LEITURA);
    a.entregarMesmoCancelado();
    const c = new AbortController();
    const alvo = a.sinais.length + 3;
    a.aoChamar((n) => { if (n === alvo) c.abort(); });
    const r = await a.mod.adminFetch(URL_ESCRITA, { ...POST, signal: c.signal });
    assert.equal(r.ok, true);
    assert.deepEqual(a.navegacoes, []);
});

// 9º parecer, P2: cancelar a espera depois do envio nunca descarta a página. A confirmação posterior da escrita roda sem o
// sinal (como na base), então o aborto nesse momento não a interrompe e a resposta chega a quem chamou.
test('POST com sinal, aborto durante a confirmação posterior: confirmação conclui sem o sinal, resposta devolvida, página intacta', async () => {
    for (const status of [200, 503, 404]) {
        const a = comSinal();
        await a.mod.adminFetch(URL_LEITURA);
        a.responder(() => new Response('{}', { status }));
        const c = new AbortController();
        const alvo = a.sinais.length + 3;
        a.aoChamar((n) => { if (n === alvo) c.abort(); });
        const r = await a.mod.adminFetch(URL_ESCRITA, { ...POST, signal: c.signal });
        assert.equal(r.status, status);
        assert.equal(a.sinais[alvo - 1], undefined);
        assert.deepEqual(a.navegacoes, []);
        assert.equal(a.contexto.lerAvisoDeContexto(), null);
    }
});

test('POST com sinal, confirmação posterior falha sem cancelamento: descarta e preserva o resultado pelo status', async () => {
    for (const [status, trecho] of [[200, 'AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO'], [503, 'AVISO_RESULTADO_INCERTO'], [404, 'AVISO_RECUSADA_SEM_CONTEXTO']] as const) {
        const a = comSinal();
        await a.mod.adminFetch(URL_LEITURA);
        a.responder(() => new Response('{}', { status }));
        a.aoResponder(() => { a.confirmacoes.push('rede'); });
        const c = new AbortController();
        const e = await falha(a.mod.adminFetch(URL_ESCRITA, { ...POST, signal: c.signal }));
        assert.equal(e.tipo, 'SESSAO_NAO_CONFIRMADA');
        assert.equal(a.navegacoes.length, 1);
        assert.equal(a.contexto.lerAvisoDeContexto(), (a.mod as unknown as Record<string, string>)[trecho]);
    }
});

test('gaveta do assistente: cancelar a pergunta depois do 200 não descarta a página', async () => {
    const a = comSinal();
    const cache = new Map();
    const cliente = carregarModulo('components/admin/inteligencia/cliente-inteligencia.ts', {}, cache) as { conversar: (b: unknown, p: { texto: string }, s?: AbortSignal) => Promise<{ tipo: string; resposta?: { tipo: string } }>; ENDPOINT_CONVERSA: string };
    await a.mod.adminFetch(URL_LEITURA);
    a.responder(() => Response.json({ ok: true, data: { tipo: 'nao_suportado', mensagem: 'Ainda não sei responder isso.' } }));
    const c = new AbortController();
    const alvo = a.sinais.length + 3;
    a.aoChamar((n) => { if (n === alvo) c.abort(); });
    const resultado = await cliente.conversar(a.mod.adminFetch, { texto: 'pergunta' }, c.signal);
    assert.ok(a.envios.includes('POST ' + cliente.ENDPOINT_CONVERSA));
    assert.equal(c.signal.aborted, true);
    assert.equal(resultado.tipo, 'ok');
    assert.deepEqual(a.navegacoes, []);
    assert.equal(a.contexto.lerAvisoDeContexto(), null);
});

test('POST com sinal, aborto antes do envio sem evidência: nada enviado, sem aviso de resultado', async () => {
    const a = comSinal();
    await a.mod.adminFetch(URL_LEITURA);
    a.entregarMesmoCancelado();
    const c = new AbortController();
    const alvo = a.sinais.length + 1;
    a.aoChamar((n) => { if (n === alvo) c.abort(); });
    const e = await falha(a.mod.adminFetch(URL_ESCRITA, { ...POST, signal: c.signal }));
    assert.equal(e.name, 'AbortError');
    assert.equal(a.envios.filter((x) => x.startsWith('POST')).length, 0);
    assert.equal(a.contexto.lerAvisoDeContexto(), null);
});

// 10º parecer, P2 (preexistente na base): a confirmação posterior sai com a sessão A, a troca para B termina e só então a
// leitura VÁLIDA de A chega. Ela não pode liberar a resposta antiga: a confirmação espera a troca e lê de novo.
async function corridaComTroca(metodo: 'POST' | 'GET', trocaConcluida: boolean) {
    const a = ambiente();
    const ctx = a.contexto as unknown as { iniciarTrocaDeEmpresa: () => void; encerrarTrocaDeEmpresa: () => void; lerAvisoDeContexto: () => string | null };
    const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response>; window: { location: { replace: (d?: string) => void; assign: (d?: string) => void } } };
    const navegacoes: string[] = [];
    g.window.location.replace = (d?: string) => { navegacoes.push(String(d)); };
    g.window.location.assign = (d?: string) => { navegacoes.push(String(d)); };
    await a.mod.adminFetch(URL_LEITURA); // registra a sessão A
    const original = g.fetch;
    let leiturasDaSessao = 0;
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const resposta = await original(input, init); // já calculada com a sessão A
        if (String(input) === '/api/admin/autenticacao' && (init.method ?? 'GET') === 'GET') {
            leiturasDaSessao += 1;
            if (leiturasDaSessao === 2) {
                ctx.iniciarTrocaDeEmpresa();
                if (trocaConcluida) a.trocarEmpresa('beta');
                ctx.encerrarTrocaDeEmpresa();
            }
        }
        return resposta;
    };
    const init = metodo === 'POST' ? POST : {};
    const url = metodo === 'POST' ? URL_ESCRITA : URL_LEITURA;
    let resultado: Response | Erro;
    try { resultado = await a.mod.adminFetch(url, init); } catch (e) { resultado = e as Erro; }
    return { resultado, navegacoes, leiturasDaSessao, aviso: ctx.lerAvisoDeContexto() };
}

test('corrida: POST com confirmação válida de A atrasada até depois da troca para B não entrega a resposta antiga', async () => {
    const r = await corridaComTroca('POST', true);
    assert.ok(!(r.resultado instanceof Response), 'a resposta antiga não chega ao chamador');
    assert.equal((r.resultado as Erro).tipo, 'CONTEXTO_MUDOU');
    assert.equal((r.resultado as Erro).enviado, true);
    assert.equal(r.leiturasDaSessao, 3, 'releu a sessão depois da troca');
    assert.equal(r.navegacoes.length, 1);
    assert.match(r.aviso ?? '', /concluída antes da mudança/);
});

test('corrida: leitura com confirmação válida de A atrasada até depois da troca para B é descartada', async () => {
    const r = await corridaComTroca('GET', true);
    assert.equal((r.resultado as Erro).tipo, 'CONTEXTO_MUDOU');
    assert.equal(r.navegacoes.length, 1);
});

test('corrida: troca recusada durante a confirmação posterior relê a mesma sessão e entrega a resposta', async () => {
    const r = await corridaComTroca('POST', false);
    assert.ok(r.resultado instanceof Response);
    assert.equal(r.leiturasDaSessao, 3);
    assert.deepEqual(r.navegacoes, []);
});

// 11º parecer, P2 e P3: a espera da troca tem prazo e cancelamento, nada sai depois do início da saída, e contexto
// indeterminado (troca pendurada, trocas sucessivas) não vira "mudou".
type Ctx = { iniciarTrocaDeEmpresa: () => void; encerrarTrocaDeEmpresa: () => void; marcarSaidaDaSessao: () => void; lerAvisoDeContexto: () => string | null };
function comRoteiro(roteiro: (leitura: number, ctx: Ctx, a: ReturnType<typeof ambiente>) => void) {
    const a = ambiente();
    const ctx = a.contexto as unknown as Ctx;
    const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response>; window: { location: { replace: (d?: string) => void; assign: (d?: string) => void } } };
    const navegacoes: string[] = [];
    g.window.location.replace = (d?: string) => { navegacoes.push(String(d)); };
    g.window.location.assign = (d?: string) => { navegacoes.push(String(d)); };
    const original = g.fetch;
    let leituras = 0;
    let ativo = false;
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const resposta = await original(input, init);
        if (ativo && String(input) === '/api/admin/autenticacao' && (init.method ?? 'GET') === 'GET') roteiro(++leituras, ctx, a);
        return resposta;
    };
    const mod = a.mod as typeof a.mod & { ESPERA_DA_TROCA: { prazoMs: number }; AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO: string };
    return { a, ctx, mod, navegacoes, ligar: async () => { await a.mod.adminFetch(URL_LEITURA); ativo = true; }, leituras: () => leituras };
}

test('troca pendurada: leitura cancelada durante a espera termina na hora com o motivo, sem descartar a página', async () => {
    const r = comRoteiro((n, ctx) => { if (n === 2) ctx.iniciarTrocaDeEmpresa(); });
    r.mod.ESPERA_DA_TROCA.prazoMs = 60_000;
    await r.ligar();
    const c = new AbortController();
    const inicio = Date.now();
    const pedido = falha(r.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    setTimeout(() => c.abort(), 50);
    const e = await pedido;
    assert.equal(e.name, 'AbortError');
    assert.ok(Date.now() - inicio < 2000, 'não ficou preso na troca');
    assert.deepEqual(r.navegacoes, []);
});

test('troca pendurada: POST respondido 200 sai no prazo da espera com o resultado conhecido, sem afirmar mudança', async () => {
    const r = comRoteiro((n, ctx) => { if (n === 2) ctx.iniciarTrocaDeEmpresa(); });
    r.mod.ESPERA_DA_TROCA.prazoMs = 100;
    await r.ligar();
    const inicio = Date.now();
    const e = await dentroDe(falha(r.mod.adminFetch(URL_ESCRITA, POST)), 2000, 'POST com troca pendurada');
    assert.ok(Date.now() - inicio < 2000);
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', true]);
    assert.equal(r.ctx.lerAvisoDeContexto(), r.mod.AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO);
    // 14º parecer, P2: a troca segue pendente; a navegação é dela, não do adminFetch.
    assert.deepEqual(r.navegacoes, []);
    assert.equal(r.leituras(), 2, 'prazo vencido não vale como troca terminada: nenhuma releitura');
});

test('troca pendurada na confirmação prévia de um POST: nada é enviado', async () => {
    const r = comRoteiro((n, ctx) => { if (n === 1) ctx.iniciarTrocaDeEmpresa(); });
    r.mod.ESPERA_DA_TROCA.prazoMs = 100;
    await r.ligar();
    const enviosAntes = r.a.envios.length;
    const e = await dentroDe(falha(r.mod.adminFetch(URL_ESCRITA, POST)), 2000, 'confirmação prévia com troca pendurada');
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', false]);
    assert.equal(r.a.envios.length, enviosAntes);
});

test('saída pedida durante a confirmação prévia (com troca recusada no meio): o POST não sai', async () => {
    const r = comRoteiro((n, ctx) => { if (n === 1) { ctx.iniciarTrocaDeEmpresa(); ctx.marcarSaidaDaSessao(); ctx.encerrarTrocaDeEmpresa(); } });
    await r.ligar();
    const enviosAntes = r.a.envios.length;
    const e = await falha(r.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_ENCERRADA', false]);
    assert.equal(r.a.envios.length, enviosAntes, 'nenhum envio depois do início da saída');
    assert.equal(r.leituras(), 2, 'a releitura confirmou a sessão antiga e mesmo assim nada saiu');
});

test('duas trocas recusadas em sequência: contexto indeterminado, nunca o aviso de mudança', async () => {
    const r = comRoteiro((n, ctx) => { if (n === 2 || n === 3) { ctx.iniciarTrocaDeEmpresa(); ctx.encerrarTrocaDeEmpresa(); } });
    await r.ligar();
    const e = await falha(r.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', true]);
    assert.equal(r.ctx.lerAvisoDeContexto(), r.mod.AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO);
    assert.doesNotMatch(r.ctx.lerAvisoDeContexto() ?? '', /antes da mudança/);
});

test('troca pendurada e sinal cancelado antes da espera começar: termina na hora, sem esperar o prazo', async () => {
    const c = new AbortController();
    const r = comRoteiro((n, ctx) => { if (n === 2) { ctx.iniciarTrocaDeEmpresa(); c.abort(); } });
    r.mod.ESPERA_DA_TROCA.prazoMs = 60_000;
    await r.ligar();
    const inicio = Date.now();
    const e = await falha(r.mod.adminFetch(URL_LEITURA, { signal: c.signal }));
    assert.equal(e.name, 'AbortError');
    assert.ok(Date.now() - inicio < 2000, 'não esperou o prazo da troca');
    assert.equal(r.leituras(), 2);
});

test('releitura que também cruzou uma troca e veio sem usuário: falha (contexto indeterminado), nunca mudou nem encerrada', async () => {
    const r = comRoteiro((n, ctx, a) => {
        if (n === 2) { ctx.iniciarTrocaDeEmpresa(); a.sair(); setTimeout(() => ctx.encerrarTrocaDeEmpresa(), 5); }
        if (n === 3) ctx.iniciarTrocaDeEmpresa();
    });
    await r.ligar();
    const e = await falha(r.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', true]);
    assert.equal(r.ctx.lerAvisoDeContexto(), r.mod.AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO);
    assert.equal(r.leituras(), 3);
});

test('troca concluída durante a saída: a saída tem precedência (SESSAO_ENCERRADA), nada sai e não há aviso de mudança', async () => {
    const r = comRoteiro((n, ctx, a) => { if (n === 1) { ctx.iniciarTrocaDeEmpresa(); ctx.marcarSaidaDaSessao(); a.trocarEmpresa('beta'); ctx.encerrarTrocaDeEmpresa(); } });
    await r.ligar();
    const enviosAntes = r.a.envios.length;
    const e = await falha(r.mod.adminFetch(URL_ESCRITA, POST));
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_ENCERRADA', false]);
    assert.equal(r.a.envios.length, enviosAntes);
    assert.doesNotMatch(r.ctx.lerAvisoDeContexto() ?? '', /mudou|mudança/);
});

// 12º parecer, P2: entre a confirmação prévia validar a sessão e o envio não pode caber uma troca de empresa desta página.
// Fluxos REAIS (adminFetch e trocarEmpresaAtiva) partindo juntos; a resposta da leitura de sessão do POST de negócio
// demora de 0 a 40 microtarefas, e a resposta da troca demora 5 ms (ela fica pendente). Em algum atraso a troca começa
// exatamente entre a validação e o envio; em nenhum o POST de negócio pode sair com a troca pendente.
test('corrida real: o POST de negócio nunca sai com uma troca de empresa pendente, qualquer que seja o atraso', async () => {
    const resultados = new Set<string>();
    for (let atraso = 0; atraso <= 40; atraso++) {
        const a = ambiente();
        const mod = a.mod as typeof a.mod & { trocarEmpresaAtiva: (id: string) => Promise<Response> };
        await a.mod.adminFetch(URL_LEITURA);
        const contexto = a.contexto as unknown as { fimDaTrocaEmCurso: () => Promise<void> | null };
        const enviadosDuranteTroca: string[] = [];
        const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response> };
        const original = g.fetch;
        let leiturasDeSessao = 0;
        g.fetch = async (input: string, init: RequestInit = {}) => {
            const url = String(input);
            if (url === URL_ESCRITA && contexto.fimDaTrocaEmCurso()) enviadosDuranteTroca.push(url);
            if (url === '/api/admin/autenticacao' && init.method === 'POST') await new Promise((ok) => setTimeout(ok, 5));
            const r = await original(input, init);
            if (url === '/api/admin/autenticacao' && (init.method ?? 'GET') === 'GET' && ++leiturasDeSessao === 1)
                for (let i = 0; i < atraso; i++) await Promise.resolve();
            return r;
        };
        const negocio = a.mod.adminFetch(URL_ESCRITA, POST).then(() => 'enviado', (e: Erro) => e.tipo ?? e.name);
        const troca = mod.trocarEmpresaAtiva('beta').then(() => 'ok', () => 'falhou');
        const [r] = await Promise.all([negocio, troca]);
        resultados.add(r);
        assert.deepEqual(enviadosDuranteTroca, [], 'atraso ' + atraso + ': POST de negócio saiu com a troca pendente');
    }
    // Controle: a varredura cobre os dois lados (enviado antes da troca) e o cruzamento barrado antes do envio.
    assert.ok(resultados.has('enviado') && resultados.has('SESSAO_NAO_CONFIRMADA'), [...resultados].join(','));
});

// 13º e 14º pareceres, P2: a confirmação POSTERIOR tem uma janela entre validar a marca (dentro de confirmarSessao) e
// o adminFetch retomar. Fluxos REAIS: uma leitura ou escrita e trocarEmpresaAtiva lançada k microtarefas depois de a
// leitura de sessão posterior sair. A troca fica pendente por 5 ms e é aceita (o servidor passa para Beta).
// 14º parecer, P3: o disparo é marcado ANTES de chamar a troca (sem reentrar no próprio mock) e cada posição exige
// exatamente um POST de troca, concluído com sucesso.
type Mod = { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; trocarEmpresaAtiva: (id: string) => Promise<Response>; AVISO_LEITURA_NAO_CONFIRMADA: string };
type Navegacao = { destino: string; trocaPendente: boolean };
function registrarNavegacoes(contexto: { fimDaTrocaEmCurso: () => Promise<void> | null }) {
    const navegacoes: Navegacao[] = [];
    (globalThis as unknown as { window: { location: { replace: (d: string) => void } } }).window.location.replace =
        (destino: string) => { navegacoes.push({ destino, trocaPendente: contexto.fimDaTrocaEmCurso() !== null }); };
    return navegacoes;
}
async function corridaPosterior(k: number, url: string, init: RequestInit) {
    const a = ambiente();
    const mod = a.mod as unknown as Mod;
    await mod.adminFetch(URL_LEITURA);
    const contexto = a.contexto as unknown as { fimDaTrocaEmCurso: () => Promise<void> | null };
    const navegacoes = registrarNavegacoes(contexto);
    const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response> };
    const original = g.fetch;
    let negocioFeito = false;
    let disparada = false;
    let postsDaTroca = 0;
    let troca: Promise<string> = Promise.resolve('nao-disparada');
    g.fetch = async (input: string, i: RequestInit = {}) => {
        const u = String(input);
        if (u === '/api/admin/autenticacao' && i.method === 'POST') {
            postsDaTroca++;
            await new Promise((ok) => setTimeout(ok, 5));
            a.trocarEmpresa('beta');
        }
        if (u === url) negocioFeito = true;
        else if (negocioFeito && !disparada && u === '/api/admin/autenticacao') {
            disparada = true;
            troca = (async () => {
                for (let n = 0; n < k; n++) await Promise.resolve();
                return mod.trocarEmpresaAtiva('beta').then(() => 'ok', (e: Error) => 'falhou: ' + e.message);
            })();
        }
        return original(input, i);
    };
    let trocaNoReturn = false;
    const sinal = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {},
        throwIfAborted() { trocaNoReturn = contexto.fimDaTrocaEmCurso() !== null; } } as unknown as AbortSignal;
    const r = await mod.adminFetch(url, { ...init, signal: sinal }).then(() => null, (e: Erro) => e);
    const resultadoDaTroca = await troca;
    g.fetch = original;
    return { a, r, trocaNoReturn, navegacoes, postsDaTroca, resultadoDaTroca };
}

test('corrida real na confirmação posterior: a leitura nunca é entregue com a troca pendente e nada navega antes de ela terminar', async () => {
    const resultados = new Set<string>();
    for (let k = 0; k <= 60; k++) {
        const c = await corridaPosterior(k, URL_LEITURA, {});
        assert.equal(c.postsDaTroca, 1, 'k ' + k + ': exatamente um POST de troca');
        assert.equal(c.resultadoDaTroca, 'ok', 'k ' + k);
        assert.ok(!(c.r === null && c.trocaNoReturn), 'k ' + k + ': leitura entregue com a troca pendente');
        assert.deepEqual(c.navegacoes.filter((n) => n.trocaPendente), [], 'k ' + k + ': navegou com a troca pendente');
        resultados.add(c.r === null ? 'entregue' : String(c.r.tipo));
    }
    // Controle: a varredura alcança a leitura entregue antes da troca e a leitura descartada depois da troca aceita.
    assert.ok(resultados.has('entregue') && resultados.has('CONTEXTO_MUDOU'), [...resultados].join(','));
});

test('corrida real na confirmação posterior de escrita: resultado conhecido preservado e nada navega com a troca pendente', async () => {
    const resultados = new Set<string>();
    for (let k = 0; k <= 60; k++) {
        const c = await corridaPosterior(k, URL_ESCRITA, POST);
        assert.equal(c.postsDaTroca, 1, 'k ' + k + ': exatamente um POST de troca');
        assert.equal(c.resultadoDaTroca, 'ok', 'k ' + k);
        assert.deepEqual(c.navegacoes.filter((n) => n.trocaPendente), [], 'k ' + k + ': navegou com a troca pendente');
        if (c.r) {
            assert.deepEqual([c.r.tipo, c.r.enviado], ['CONTEXTO_MUDOU', true], 'k ' + k);
            assert.match(c.r.message, /concluída antes da mudança/, 'k ' + k + ': escrita respondida com sucesso continua concluída');
        }
        resultados.add(c.r === null ? 'entregue' : String(c.r.tipo));
    }
    assert.ok(resultados.has('entregue') && resultados.has('CONTEXTO_MUDOU'), [...resultados].join(','));
});

// 14º parecer, P2: com a resposta da troca RETIDA, o adminFetch não pode navegar antes de ela chegar. Troca recusada
// (403): a sessão original continua e uma releitura limitada a confirma; a leitura é entregue, sem navegação.
for (const [status, aceita] of [[200, true], [403, false]] as const) {
    test(`troca retida e ${aceita ? 'aceita' : 'recusada (403)'}: a leitura espera a troca, sem navegar antes da resposta dela`, async () => {
        const a = ambiente();
        const mod = a.mod as unknown as Mod;
        await mod.adminFetch(URL_LEITURA);
        const contexto = a.contexto as unknown as { fimDaTrocaEmCurso: () => Promise<void> | null };
        const navegacoes = registrarNavegacoes(contexto);
        const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response> };
        const original = g.fetch;
        let liberarTroca!: () => void;
        const trocaRetida = new Promise<void>((ok) => { liberarTroca = ok; });
        let leituraFeita = false;
        let disparada = false;
        let troca: Promise<string> = Promise.resolve('nao-disparada');
        g.fetch = async (input: string, i: RequestInit = {}) => {
            const u = String(input);
            if (u === '/api/admin/autenticacao' && i.method === 'POST') {
                await trocaRetida;
                if (aceita) a.trocarEmpresa('beta');
                return Response.json({ ok: aceita }, { status });
            }
            if (u === URL_LEITURA) leituraFeita = true;
            else if (leituraFeita && !disparada && u === '/api/admin/autenticacao') {
                disparada = true;
                troca = mod.trocarEmpresaAtiva('beta').then((r) => String(r.status), () => 'falhou');
            }
            return original(input, i);
        };
        const leitura = mod.adminFetch(URL_LEITURA).then(() => 'entregue', (e: Erro) => String(e.tipo));
        // A troca fica pendente enquanto o adminFetch processa a confirmação posterior.
        for (let n = 0; n < 50; n++) await new Promise((ok) => setTimeout(ok, 0));
        assert.ok(contexto.fimDaTrocaEmCurso() !== null, 'a troca está pendente');
        assert.equal(navegacoes.length, 0, 'nada navegou antes da resposta da troca');
        liberarTroca();
        const [r, t] = await Promise.all([leitura, troca]);
        g.fetch = original;
        assert.equal(t, String(status));
        assert.deepEqual(navegacoes.filter((n) => n.trocaPendente), []);
        if (aceita) assert.equal(r, 'CONTEXTO_MUDOU');
        else {
            assert.equal(r, 'entregue', 'troca recusada: a releitura confirma a sessão original e entrega a leitura');
            assert.deepEqual(navegacoes, []);
            assert.equal(a.contexto.lerAvisoDeContexto(), null);
        }
    });
}

// 14º parecer: releitura da confirmação PRÉVIA que também cruzou uma troca e veio sem usuário continua "não confirmada"
// (nada enviado), nunca "mudou". Na posterior o adminFetch trata 'obsoleta' e 'falha' com a mesma espera limitada;
// aqui a diferença aparece.
test('releitura prévia que cruzou outra troca e veio sem usuário: não confirmada, nada enviado, nunca mudou', async () => {
    const r = comRoteiro((n, ctx, a) => {
        if (n === 1) { ctx.iniciarTrocaDeEmpresa(); a.sair(); setTimeout(() => ctx.encerrarTrocaDeEmpresa(), 5); }
        if (n === 2) { ctx.iniciarTrocaDeEmpresa(); setTimeout(() => ctx.encerrarTrocaDeEmpresa(), 5); }
    });
    await r.ligar();
    const enviosAntes = r.a.envios.length;
    const inicio = Date.now();
    const e = await falha(r.mod.adminFetch(URL_ESCRITA, POST));
    assert.ok(Date.now() - inicio < 2000, 'não esperou o prazo da troca');
    assert.deepEqual([e.tipo, e.enviado], ['SESSAO_NAO_CONFIRMADA', false]);
    assert.equal(r.a.envios.length, enviosAntes);
    assert.equal(r.leituras(), 2);
});

// 14º parecer, P2: a releitura limitada da confirmação posterior também tem uma volta de await. Uma SEGUNDA troca desta
// página que começa nessa volta torna a releitura obsoleta: a resposta não pode ser entregue com ela pendente. A leitura
// de sessão posterior volta sem usuário durante a 1ª troca (obsoleta); a 1ª troca termina recusada (mesma empresa); a 2ª
// começa k microtarefas depois de a releitura sair.
test('releitura limitada que cruza uma segunda troca ao retomar: nunca entregue com a troca pendente, sem navegar', async () => {
    const resultados = new Set<string>();
    for (let k = 0; k <= 40; k++) {
        const a = ambiente();
        await a.mod.adminFetch(URL_LEITURA);
        const ctx = a.contexto as unknown as { iniciarTrocaDeEmpresa: () => void; encerrarTrocaDeEmpresa: () => void; fimDaTrocaEmCurso: () => Promise<void> | null };
        const navegacoes = registrarNavegacoes(ctx);
        const g = globalThis as unknown as { fetch: (i: string, init?: RequestInit) => Promise<Response> };
        const original = g.fetch;
        let leituraFeita = false;
        let sessoesDepois = 0;
        let segundaDisparada = false;
        g.fetch = async (input: string, i: RequestInit = {}) => {
            const u = String(input);
            if (u === URL_LEITURA) leituraFeita = true;
            else if (leituraFeita && u === '/api/admin/autenticacao' && (i.method ?? 'GET') === 'GET') {
                sessoesDepois++;
                if (sessoesDepois === 1) {
                    ctx.iniciarTrocaDeEmpresa();
                    setTimeout(() => ctx.encerrarTrocaDeEmpresa(), 5);
                    return Response.json({ ok: true, data: { usuarioId: null, csrf: 'c' } });
                }
                if (sessoesDepois === 2 && !segundaDisparada) {
                    segundaDisparada = true;
                    void (async () => { for (let n = 0; n < k; n++) await Promise.resolve(); ctx.iniciarTrocaDeEmpresa(); })();
                }
            }
            return original(input, i);
        };
        let trocaNoReturn = false;
        const sinal = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {},
            throwIfAborted() { trocaNoReturn = ctx.fimDaTrocaEmCurso() !== null; } } as unknown as AbortSignal;
        const r = await a.mod.adminFetch(URL_LEITURA, { signal: sinal }).then(() => 'entregue', (e: Erro) => String(e.tipo));
        g.fetch = original;
        ctx.encerrarTrocaDeEmpresa();
        assert.equal(sessoesDepois, 2, 'k ' + k + ': uma leitura posterior e uma releitura');
        assert.ok(!(r === 'entregue' && trocaNoReturn), 'k ' + k + ': entregue com a segunda troca pendente');
        assert.deepEqual(navegacoes.filter((n) => n.trocaPendente), [], 'k ' + k + ': navegou com a troca pendente');
        resultados.add(r);
    }
    // Controle: a varredura alcança a entrega (2ª troca depois do return) e o descarte (2ª troca antes).
    assert.ok(resultados.has('entregue') && resultados.has('SESSAO_NAO_CONFIRMADA'), [...resultados].join(','));
});

// 15º parecer, P2: nenhum ramo do adminFetch navega com a troca desta página pendente — 409 administrativo, confirmação
// "encerrada" que só vira obsoleta na volta do await (prévia e posterior) e o cruzamento com trocarEmpresaAtiva real.
// Reproduções do revisor (evidencias-mcp-experiencia-20261106/revisao15-r17/prova-revisor.ts) com as asserções do
// comportamento desejado. `replace` e `assign` registram se havia troca pendente.
type CtxTroca = { registrarContextoEmpresa: (s: string, e: string | null) => boolean; fimDaTrocaEmCurso: () => Promise<void> | null; iniciarTrocaDeEmpresa: () => void; encerrarTrocaDeEmpresa: () => void; lerAvisoDeContexto: () => string | null };
type ModTroca = { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; trocarEmpresaAtiva: (id: string) => Promise<Response>; ESPERA_DA_TROCA: { prazoMs: number } };
function prepararTrocaPendente() {
    const navegacoes: Array<{ destino: string; pendente: boolean }> = [];
    const avisos = new Map<string, string>();
    const cache = new Map();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as unknown as CtxTroca;
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as unknown as ModTroca;
    const registrar = (destino: string) => { navegacoes.push({ destino, pendente: ctx.fimDaTrocaEmCurso() !== null }); };
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/importacao', replace: registrar, assign: registrar } };
    g.sessionStorage = { getItem: (k: string) => avisos.get(k) ?? null, setItem: (k: string, v: string) => avisos.set(k, v), removeItem: (k: string) => avisos.delete(k) };
    ctx.registrarContextoEmpresa('s1', 'alfa');
    return { ctx, mod, navegacoes };
}
const sessaoS1 = () => ({ ok: true, data: { usuarioId: 'u', sessaoId: 's1', csrf: 'c', contexto: { empresaAtual: { id: 'alfa' } } } });
const definirFetch = (f: (u: string, i: RequestInit) => Promise<unknown>) => {
    (globalThis as unknown as { fetch: (u: string, i?: RequestInit) => Promise<unknown> }).fetch = (u: string, i: RequestInit = {}) => f(String(u), i);
};

for (const metodo of ['POST', 'GET'] as const) {
    test(`15º parecer: ${metodo} recusado com 409 administrativo durante a troca retida não navega; a troca decide`, async () => {
        const { ctx, mod, navegacoes } = prepararTrocaPendente();
        let liberarTroca!: () => void; let liberarNegocio!: () => void; let trocaEnviada!: () => void; let negocioEnviado!: () => void;
        const retida = new Promise<void>((r) => { liberarTroca = r; });
        const negocio = new Promise<void>((r) => { liberarNegocio = r; });
        const sinalTroca = new Promise<void>((r) => { trocaEnviada = r; });
        const sinalNegocio = new Promise<void>((r) => { negocioEnviado = r; });
        definirFetch(async (u, i) => {
            if (u === '/api/admin/autenticacao') {
                if (i.method === 'POST') { trocaEnviada(); await retida; return Response.json({ ok: true }); }
                return Response.json(sessaoS1());
            }
            negocioEnviado(); await negocio;
            return Response.json({ ok: false, codigo: 'AUTENTICACAO_ADMINISTRATIVA' }, { status: 409 });
        });
        const p = mod.adminFetch('/api/admin/x', metodo === 'POST' ? { method: 'POST', body: '{}' } : {}).then(() => null, (e: Erro) => e);
        await sinalNegocio;
        const t = mod.trocarEmpresaAtiva('beta');
        await sinalTroca;
        liberarNegocio();
        const erro = await p;
        assert.ok(ctx.fimDaTrocaEmCurso() !== null, 'a troca ainda está pendente');
        assert.deepEqual([erro?.tipo, erro?.enviado], ['RECUSADA_PELO_CONTEXTO', true]);
        assert.equal(navegacoes.length, 0, 'nada navegou com a troca pendente');
        // Escrita: a recusa (nada alterado) fica guardada para a tela seguinte; leitura não guarda aviso.
        if (metodo === 'POST') assert.match(ctx.lerAvisoDeContexto() ?? '', /Nada foi alterado/);
        else assert.equal(ctx.lerAvisoDeContexto(), null);
        liberarTroca();
        await t;
        assert.equal(navegacoes.length, 0, 'trocarEmpresaAtiva não navega no sucesso: quem navega é o AdminShell');
    });
}

for (const fase of ['previa', 'posterior'] as const) {
    test(`15º parecer: confirmação "encerrada" na volta do await (${fase}) com troca começando: nunca vai ao login com a troca pendente`, async () => {
        const vistos = new Set<string>();
        for (let k = 0; k <= 12; k++) {
            const { ctx, mod, navegacoes } = prepararTrocaPendente();
            mod.ESPERA_DA_TROCA.prazoMs = 30;
            let leituras = 0;
            let disparo: Promise<void> | undefined;
            definirFetch(async (u) => {
                if (u !== '/api/admin/autenticacao') return Response.json({ ok: true });
                leituras++;
                if (leituras !== (fase === 'previa' ? 1 : 2)) return Response.json(sessaoS1());
                return { ok: true, json: async () => {
                    disparo = (async () => { for (let n = 0; n < k; n++) await Promise.resolve(); ctx.iniciarTrocaDeEmpresa(); })();
                    return { ok: true, data: { usuarioId: null } };
                } };
            });
            const r = await mod.adminFetch('/api/admin/x').then(() => 'entregue', (e: Erro) => String(e.tipo));
            await disparo;
            assert.deepEqual(navegacoes.filter((n) => n.pendente), [], 'k ' + k + ': navegou com a troca pendente');
            vistos.add(r + (navegacoes.some((n) => /login/.test(n.destino)) ? '+login' : ''));
            ctx.encerrarTrocaDeEmpresa();
        }
        // Controle: a varredura alcança o fim real da sessão (troca começa depois do return → login sem troca pendente)
        // e o cruzamento (troca começa antes da retomada → nada navega).
        // O cruzamento não é sessão encerrada: na prévia é a troca em curso (nada enviado); na posterior, a espera pela troca
        // ainda pendente termina pelo prazo (contexto não confirmado). Nenhum dos dois é "SESSAO_ENCERRADA" sem login.
        const cruzado = fase === 'previa' ? 'CONTEXTO_MUDOU' : 'SESSAO_NAO_CONFIRMADA';
        assert.deepEqual([...vistos].sort(), ['SESSAO_ENCERRADA+login', cruzado].sort());
    });
}

test('15º parecer: "encerrada" cruzada com trocarEmpresaAtiva real não vai ao login; a leitura espera a troca e relê', async () => {
    const { mod, navegacoes } = prepararTrocaPendente();
    let soltarConfirmacaoTroca!: (v: unknown) => void; let avisarGet!: () => void; let soltarPost!: () => void; let postChegou!: () => void;
    const confirmacaoTroca = new Promise((r) => { soltarConfirmacaoTroca = r; });
    const primeiroGet = new Promise<void>((r) => { avisarGet = r; });
    const post = new Promise<void>((r) => { soltarPost = r; });
    const chegouPost = new Promise<void>((r) => { postChegou = r; });
    let n = 0;
    definirFetch(async (u, i) => {
        if (u !== '/api/admin/autenticacao') return Response.json({ ok: true });
        if (i.method === 'POST') { postChegou(); await post; return Response.json({ ok: true }); }
        n++;
        if (n === 1) { avisarGet(); return { ok: true, json: () => confirmacaoTroca }; }
        if (n === 2) return Response.json(sessaoS1());
        if (n === 3) return { ok: true, json: async () => { soltarConfirmacaoTroca(sessaoS1()); return { ok: true, data: { usuarioId: null } }; } };
        return Response.json(sessaoS1());
    });
    const t = mod.trocarEmpresaAtiva('beta');
    await primeiroGet;
    const r = mod.adminFetch('/api/admin/x').then(() => 'entregue', (e: Erro) => String(e.tipo));
    await chegouPost;
    for (let k = 0; k < 20; k++) await new Promise((ok) => setTimeout(ok, 0));
    assert.equal(navegacoes.length, 0, 'nada navegou com o POST da troca retido');
    soltarPost();
    await t;
    // Troca terminada (o servidor sintético mantém s1): a releitura confirma a mesma sessão e entrega a leitura.
    assert.equal(await r, 'entregue');
    assert.deepEqual(navegacoes, []);
});

// 16º parecer, P2-1: registrarContextoEmpresa navega quando o contexto registrado difere (sessão renovada noutra aba).
// Uma troca desta página que começa entre a validação da confirmação prévia e a retomada do adminFetch é conferida antes
// desse registro. Reproduções do revisor (evidencias-mcp-experiencia-20261106/revisao16-r18/prova-revisor.ts).
const sessaoS2 = () => ({ ok: true, data: { usuarioId: 'u', sessaoId: 's2', csrf: 'c', contexto: { empresaAtual: { id: 'alfa' } } } });

test('16º parecer: sessão renovada noutra aba e troca entre a validação e a retomada: o registro do contexto não navega com a troca pendente', async () => {
    const vistos = new Set<string>();
    for (let k = 0; k <= 12; k++) {
        const { ctx, mod, navegacoes } = prepararTrocaPendente();
        mod.ESPERA_DA_TROCA.prazoMs = 2;
        let disparo: Promise<void> | undefined;
        let envios = 0;
        definirFetch(async (u) => {
            if (u !== '/api/admin/autenticacao') { envios++; return Response.json({ ok: true }); }
            return { ok: true, json: async () => {
                disparo = (async () => { for (let n = 0; n < k; n++) await Promise.resolve(); ctx.iniciarTrocaDeEmpresa(); })();
                return sessaoS2();
            } };
        });
        const erro = await mod.adminFetch('/api/admin/x', { method: 'POST', body: '{}' }).then(() => null, (e: Erro) => e);
        await disparo;
        assert.deepEqual(navegacoes.filter((n) => n.pendente), [], 'k ' + k + ': navegou com a troca pendente');
        assert.equal(envios, 0, 'k ' + k + ': nenhum POST de negócio');
        assert.equal(erro?.enviado, false);
        vistos.add(String(erro?.tipo) + (navegacoes.length ? '+painel' : ''));
        ctx.encerrarTrocaDeEmpresa();
    }
    // Controle: troca antes da retomada → recusa antes do envio, sem navegar; troca depois do registro → o registro
    // descarta a página como antes (sem troca pendente).
    assert.deepEqual([...vistos].sort(), ['CONTEXTO_MUDOU+painel', 'SESSAO_NAO_CONFIRMADA'].sort());
});

for (const status of [200, 403] as const) {
    test(`16º parecer: registro do contexto cruzado com trocarEmpresaAtiva real retida e ${status === 200 ? 'aceita' : 'recusada'}: nada navega com a troca pendente`, async () => {
        const vistos = new Set<string>();
        for (let k = 0; k <= 12; k++) {
            const { ctx, mod, navegacoes } = prepararTrocaPendente();
            mod.ESPERA_DA_TROCA.prazoMs = 2;
            let soltarConfirmacao!: (v: unknown) => void; let primeiroGet!: () => void; let soltarPost!: () => void; let postChegou!: () => void;
            const confirmacao = new Promise((r) => { soltarConfirmacao = r; });
            const getIniciado = new Promise<void>((r) => { primeiroGet = r; });
            const post = new Promise<void>((r) => { soltarPost = r; });
            const chegouPost = new Promise<void>((r) => { postChegou = r; });
            let gets = 0; let posts = 0; let envios = 0;
            let disparo: Promise<void> | undefined;
            definirFetch(async (u, i) => {
                if (u !== '/api/admin/autenticacao') { envios++; return Response.json({ ok: true }); }
                if (i.method === 'POST') { posts++; postChegou(); await post; return Response.json(status === 200 ? { ok: true } : { ok: false, erro: 'recusada' }, { status }); }
                gets++;
                if (gets === 1) { primeiroGet(); return { ok: true, json: () => confirmacao }; }
                return { ok: true, json: async () => {
                    disparo = (async () => { for (let n = 0; n < k; n++) await Promise.resolve(); soltarConfirmacao(sessaoS1()); })();
                    return sessaoS2();
                } };
            });
            const troca = mod.trocarEmpresaAtiva('beta').then((r) => r.status, () => 'erro');
            await getIniciado;
            const erro = await mod.adminFetch('/api/admin/x', { method: 'POST', body: '{}' }).then(() => null, (e: Erro) => e);
            await disparo;
            if (posts === 0) await Promise.race([chegouPost, new Promise((ok) => setTimeout(ok, 20))]);
            assert.deepEqual(navegacoes.filter((n) => n.pendente), [], 'k ' + k + ': navegou com a troca pendente');
            assert.equal(envios, 0, 'k ' + k + ': nenhum POST de negócio');
            vistos.add(String(erro?.tipo) + (navegacoes.length ? '+painel' : ''));
            soltarPost();
            await troca;
            assert.deepEqual(navegacoes.filter((n) => n.pendente), [], 'k ' + k + ': navegou depois de soltar a troca');
            ctx.encerrarTrocaDeEmpresa();
        }
        assert.ok(vistos.has('SESSAO_NAO_CONFIRMADA'), [...vistos].join(','));
    });
}
