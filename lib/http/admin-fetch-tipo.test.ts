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
    carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache);
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; AVISO_RESULTADO_INCERTO: string; AVISO_LEITURA_NAO_CONFIRMADA: string; ErroContextoAdmin: new (...a: unknown[]) => Error };
    return {
        mod, envios, confirmacoes, redeOriginal,
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
