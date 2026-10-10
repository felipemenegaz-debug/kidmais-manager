import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * G16 (pacote c7b647f, 10/10/2026): o aviso que a próxima tela mostra depois de um descarte precisa dizer o resultado
 * REAL de uma escrita. Antes da correção, o último `reiniciarContextoEmpresa` vencia: uma leitura concorrente cuja
 * confirmação de sessão falhava (por exemplo, abortada pela própria navegação de descarte) apagava "A operação foi
 * concluída…" e a pessoa podia repetir a escrita. Sem navegador: globais falsos e os módulos reais (admin-fetch e
 * contexto-empresa-cliente, na MESMA instância), com respostas liberadas em ordem controlada.
 */
type Sessao = { sessaoId: string; empresa: string };
function ambiente() {
    const armazenado = new Map<string, string>();
    const navegacoes: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { location: { pathname: '/admin/configuracoes/perfil-empresa', replace: (u: string) => navegacoes.push(`replace:${u}`), assign: (u: string) => navegacoes.push(`assign:${u}`) } };
    g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => armazenado.set(k, v), removeItem: (k: string) => armazenado.delete(k) };
    let sessao: Sessao = { sessaoId: 's1', empresa: 'alfa' };
    /** Falhas programadas da PRÓXIMA confirmação de sessão (GET /api/admin/autenticacao). */
    const falhasDeConfirmacao: Array<'rede' | 'http500'> = [];
    const envios: Array<{ url: string; metodo: string }> = [];
    const portas = new Map<string, { abrir: () => void; aberta: Promise<void> }>();
    /** Porta: a resposta daquele recurso só sai quando o teste abre. `depois` roda no servidor antes de responder. */
    const porta = (url: string) => {
        let abrir!: () => void;
        const aberta = new Promise<void>((r) => { abrir = r; });
        portas.set(url, { abrir, aberta });
        return abrir;
    };
    const respostas = new Map<string, { status: number; corpo: unknown; depois?: () => void } | 'rede'>();
    g.fetch = async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        const metodo = (init.method ?? 'GET').toUpperCase();
        if (url === '/api/admin/autenticacao' && metodo === 'GET') {
            const falha = falhasDeConfirmacao.shift();
            if (falha === 'rede') throw new TypeError('Failed to fetch');
            if (falha === 'http500') return new Response('{}', { status: 500 });
            return new Response(JSON.stringify({ ok: true, data: { usuarioId: 'u', sessaoId: sessao.sessaoId, csrf: 'c', contexto: { empresaAtual: { id: sessao.empresa } } } }));
        }
        envios.push({ url, metodo });
        await portas.get(url)?.aberta;
        const r = respostas.get(url);
        if (!r) throw new Error(`rota sem resposta no teste: ${url}`);
        if (r === 'rede') throw new TypeError('Failed to fetch');
        r.depois?.();
        return new Response(JSON.stringify(r.corpo), { status: r.status });
    };
    const cache = new Map();
    const ctx = carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache) as Record<string, (...a: unknown[]) => unknown>;
    const mod = carregarModulo('lib/http/admin-fetch.ts', {}, cache) as { adminFetch: (u: string, i?: RequestInit) => Promise<Response>; AVISO_LEITURA_NAO_CONFIRMADA: string; AVISO_RESULTADO_INCERTO: string };
    const lido = () => (ctx.lerAvisoDeContexto as () => string | null)();
    return {
        mod, envios, navegacoes, porta, respostas, falhasDeConfirmacao, lido,
        /** Descarte iniciado pela própria página SEM aviso (ex.: troca de empresa pelo AdminShell). */
        descartarSemAviso: () => (ctx.reiniciarContextoEmpresa as () => void)(),
        trocarEmpresa: (empresa: string) => { sessao = { ...sessao, empresa }; },
        enviosDe: (url: string, metodo: string) => envios.filter((e) => e.url === url && e.metodo === metodo).length,
    };
}
const ESCRITA = '/api/admin/configuracoes/perfil-empresa';
const LEITURA = '/api/admin/configuracoes/perfil-empresa/logo';
const mensagem = (p: Promise<unknown>) => p.then(() => 'OK', (e: Error) => e.message);
const tique = () => new Promise((r) => setTimeout(r, 5));

test('G16: escrita concluída antes da troca + leitura concorrente cuja confirmação falha DEPOIS → fica o aviso da escrita; um único envio', async () => {
    const a = ambiente();
    const abrirEscrita = a.porta(ESCRITA); const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(ESCRITA, { status: 200, corpo: { ok: true }, depois: () => a.trocarEmpresa('beta') });
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('rede') });
    const escrita = mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' }));
    const leitura = mensagem(a.mod.adminFetch(LEITURA));
    await tique();
    abrirEscrita(); assert.match(await escrita, /concluída antes da mudança/);
    abrirLeitura(); assert.equal(await leitura, a.mod.AVISO_LEITURA_NAO_CONFIRMADA, 'a leitura continua descartada (o componente não recebe os dados)');
    assert.match(a.lido() ?? '', /concluída antes da mudança/, 'o descarte da leitura não apaga o resultado da escrita');
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1, 'executada uma única vez, sem repetição automática');
    assert.ok(a.navegacoes.length >= 1 && a.navegacoes.every((n) => n === 'replace:/admin/dashboard'), 'a página é descartada');
});

test('G16: ordem inversa — a leitura falha primeiro e a escrita conclui depois → aviso da escrita; um único envio', async () => {
    const a = ambiente();
    const abrirEscrita = a.porta(ESCRITA); const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(ESCRITA, { status: 200, corpo: { ok: true }, depois: () => a.trocarEmpresa('beta') });
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('http500') });
    const escrita = mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' }));
    const leitura = mensagem(a.mod.adminFetch(LEITURA));
    await tique();
    abrirLeitura(); await leitura;
    abrirEscrita(); assert.match(await escrita, /concluída antes da mudança/);
    assert.match(a.lido() ?? '', /concluída antes da mudança/);
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1);
});

test('leitura falha SEM escrita concluída → aviso de leitura descartada; dados não entregues; nada é enviado de novo', async () => {
    const a = ambiente();
    a.respostas.set(LEITURA, { status: 200, corpo: { segredo: 'dados da alfa' }, depois: () => a.falhasDeConfirmacao.push('rede') });
    assert.equal(await mensagem(a.mod.adminFetch(LEITURA)), a.mod.AVISO_LEITURA_NAO_CONFIRMADA, 'a resposta nunca chega ao componente');
    assert.equal(a.lido(), a.mod.AVISO_LEITURA_NAO_CONFIRMADA);
    assert.equal(a.enviosDe(LEITURA, 'GET'), 1);
    assert.deepEqual(a.navegacoes, ['replace:/admin/dashboard']);
});

test('troca de empresa ANTES do envio → nada é enviado (zero POST); aviso "Nada foi enviado" não é apagado por leitura concorrente', async () => {
    const a = ambiente();
    a.respostas.set(LEITURA, { status: 200, corpo: {} });
    await a.mod.adminFetch(LEITURA); // registra o contexto da página (alfa)
    a.trocarEmpresa('beta');
    const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('rede') });
    const leitura = mensagem(a.mod.adminFetch(LEITURA));
    assert.match(await mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' })), /mudou/);
    abrirLeitura(); await leitura;
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 0, 'nada enviado com o contexto antigo');
    assert.match(a.lido() ?? '', /antes do envio\. Nada foi enviado/);
});

test('troca de empresa DEPOIS da resposta confirmada → a escrita retorna normalmente (uma vez); a leitura seguinte descarta a tela', async () => {
    const a = ambiente();
    a.respostas.set(ESCRITA, { status: 200, corpo: { ok: true } });
    a.respostas.set(LEITURA, { status: 200, corpo: { segredo: 'dados da alfa' } });
    const r = await a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' });
    assert.equal(r.status, 200, 'resultado entregue ao componente: a escrita terminou antes da troca');
    assert.deepEqual(a.navegacoes, []);
    a.trocarEmpresa('beta');
    assert.match(await mensagem(a.mod.adminFetch(LEITURA)), /mudou/);
    assert.match(a.lido() ?? '', /Os dados da tela anterior foram descartados/);
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1);
});

test('resultado DESCONHECIDO da escrita (5xx + troca) → "Resultado incerto", nunca "concluída"; leitura posterior não apaga', async () => {
    const a = ambiente();
    const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(ESCRITA, { status: 503, corpo: {}, depois: () => a.trocarEmpresa('beta') });
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('rede') });
    const leitura = mensagem(a.mod.adminFetch(LEITURA));
    const escrita = await mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' }));
    assert.equal(escrita, a.mod.AVISO_RESULTADO_INCERTO);
    abrirLeitura(); await leitura;
    assert.equal(a.lido(), a.mod.AVISO_RESULTADO_INCERTO);
    assert.doesNotMatch(a.lido() ?? '', /concluída/);
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1, 'sem nova tentativa automática');
});

test('resultado DESCONHECIDO sem troca (rede no envio) → erro "incerto" ao componente, sem confirmação falsa e sem repetir', async () => {
    const a = ambiente();
    a.respostas.set(ESCRITA, 'rede');
    assert.equal(await mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' })), a.mod.AVISO_RESULTADO_INCERTO);
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1);
    assert.equal(a.lido(), null, 'nenhum aviso de "concluída" guardado');
});

test('duas escritas com resultados diferentes antes do descarte → os dois resultados ficam no aviso; leitura não apaga nenhum', async () => {
    const a = ambiente();
    const E2 = '/api/admin/outra-escrita';
    const abrir1 = a.porta(ESCRITA); const abrir2 = a.porta(E2); const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(ESCRITA, { status: 200, corpo: { ok: true }, depois: () => a.trocarEmpresa('beta') });
    a.respostas.set(E2, { status: 502, corpo: {} });
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('rede') });
    const p1 = mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' }));
    const p2 = mensagem(a.mod.adminFetch(E2, { method: 'POST', body: '{}' }));
    const pl = mensagem(a.mod.adminFetch(LEITURA));
    await tique();
    abrir1(); await p1; abrir2(); await p2; abrirLeitura(); await pl;
    const aviso = a.lido() ?? '';
    assert.match(aviso, /concluída antes da mudança/);
    assert.match(aviso, /Resultado incerto/);
    assert.deepEqual([a.enviosDe(ESCRITA, 'POST'), a.enviosDe(E2, 'POST')], [1, 1]);
});

test('descarte iniciado pela página SEM aviso (troca de empresa) + leitura abortada pela navegação depois → nenhum aviso de leitura fica para a próxima tela', async () => {
    const a = ambiente();
    const abrirLeitura = a.porta(LEITURA);
    a.respostas.set(LEITURA, { status: 200, corpo: {}, depois: () => a.falhasDeConfirmacao.push('rede') });
    const leitura = mensagem(a.mod.adminFetch(LEITURA));
    await tique();
    a.descartarSemAviso();                 // a troca de empresa navega ao painel, sem aviso próprio
    abrirLeitura(); await leitura;         // a confirmação da leitura falha (abortada pela navegação)
    assert.equal(a.lido(), null, 'a falha causada pela própria navegação não deixa aviso');
    assert.equal(a.enviosDe(LEITURA, 'GET'), 1);
});

test('descarte iniciado SEM aviso e, depois, o resultado de uma escrita chega → o aviso da escrita é guardado (resultado real nunca se perde)', async () => {
    const a = ambiente();
    const abrirEscrita = a.porta(ESCRITA);
    a.respostas.set(ESCRITA, { status: 200, corpo: { ok: true }, depois: () => a.trocarEmpresa('beta') });
    const escrita = mensagem(a.mod.adminFetch(ESCRITA, { method: 'POST', body: '{}' }));
    await tique();
    a.descartarSemAviso();
    abrirEscrita(); assert.match(await escrita, /concluída antes da mudança/);
    assert.match(a.lido() ?? '', /concluída antes da mudança/);
    assert.equal(a.enviosDe(ESCRITA, 'POST'), 1);
});
