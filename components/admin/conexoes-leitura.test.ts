import assert from 'node:assert/strict';
import test from 'node:test';
import { AVISO_PRAZO_COM_DADOS, AVISO_PRAZO_SEM_DADOS, AVISO_REVOGACAO_SEM_CONFIRMACAO, AVISO_REVOGACOES_SEM_CONFIRMACAO, avisosDaVista, criarControladorDeConexoes, criarCoordenadorDeLeitura, type VistaConexoes } from './conexoes-leitura.ts';

function ambiente() {
    const resolvers: Array<() => void> = [];
    let hora = 1_000_000;
    const c = criarCoordenadorDeLeitura(() => new Promise<void>((r) => { resolvers.push(r); }), () => hora, 15_000);
    const terminar = async () => { resolvers[resolvers.length - 1](); await new Promise((r) => setImmediate(r)); };
    return { c, resolvers, terminar, avancar: (ms: number) => { hora += ms; } };
}

test('pedidos durante uma leitura viram uma só leitura ao final', async () => {
    const { c, resolvers, terminar } = ambiente();
    c.pedir();
    c.pedir();
    c.pedir();
    assert.equal(resolvers.length, 1);
    await terminar();
    assert.equal(resolvers.length, 2, 'a tela relê depois de desconectar, mesmo com leitura em curso');
    await terminar();
    assert.equal(resolvers.length, 2);
});

test('voltar à janela não sobrepõe leitura nem repete dentro do intervalo', async () => {
    const { c, resolvers, terminar, avancar } = ambiente();
    c.pedir();
    c.aoFocar();
    assert.equal(resolvers.length, 1);
    await terminar();
    assert.equal(resolvers.length, 1, 'foco durante a leitura não deixa releitura pendente');
    avancar(14_999);
    c.aoFocar();
    assert.equal(resolvers.length, 1);
    avancar(1);
    c.aoFocar();
    assert.equal(resolvers.length, 2);
});

test('Atualizar situação ignora o intervalo do foco', async () => {
    const { c, resolvers, terminar } = ambiente();
    c.pedir();
    await terminar();
    c.pedir();
    assert.equal(resolvers.length, 2);
});

test('leitura que falha libera a próxima', async () => {
    let chamadas = 0;
    const c = criarCoordenadorDeLeitura(async () => { chamadas += 1; throw new Error('rede'); });
    c.pedir();
    await new Promise((r) => setImmediate(r));
    c.pedir();
    await new Promise((r) => setImmediate(r));
    assert.equal(chamadas, 2);
});

test('encerrada a tela, nada mais é lido', async () => {
    const { c, resolvers, terminar } = ambiente();
    c.pedir();
    c.pedir();
    c.encerrar();
    await terminar();
    c.pedir();
    c.aoFocar();
    assert.equal(resolvers.length, 1);
});

test('leitura mais longa que o intervalo: voltar à janela ainda não sobrepõe', async () => {
    const { c, resolvers, terminar, avancar } = ambiente();
    c.pedir();
    avancar(60_000);
    c.aoFocar();
    assert.equal(resolvers.length, 1);
    await terminar();
    assert.equal(resolvers.length, 1);
});

type E = { conexoes: string[] };
const lista = (...conexoes: string[]) => Response.json({ ok: true, data: { conexoes } });
const espera = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function controlador(respostas: Array<() => Promise<Response> | Response>, prazoMs = 1000, esperaRevogacaoMs = 1000) {
    const pedidos: Array<{ metodo: string; signal: AbortSignal | null }> = [];
    const publicadas: Array<VistaConexoes<E>> = [];
    const c = criarControladorDeConexoes<E>({
        prazoMs,
        esperaRevogacaoMs,
        publicar: (v) => { publicadas.push(v); },
        buscar: async (_url, init = {}) => {
            pedidos.push({ metodo: init.method ?? 'GET', signal: init.signal ?? null });
            const proxima = respostas.shift();
            if (!proxima) throw Error('pedido inesperado');
            return proxima();
        },
    });
    return { c, pedidos, publicadas, ultima: () => publicadas[publicadas.length - 1] };
}
const pendurada = () => new Promise<Response>(() => undefined);

test('POST falha e GET 200 com a conexão ativa: o aviso de Desconectar continua na tela', async () => {
    const t = controlador([() => lista('c1'), () => Response.json({ ok: false, erro: 'Não foi possível desconectar agora.' }, { status: 500 }), () => lista('c1')]);
    t.c.iniciar();
    await espera();
    await t.c.revogar('c1');
    await espera();
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['GET', 'POST', 'GET']);
    const v = t.ultima();
    assert.deepEqual(v.estado, { conexoes: ['c1'] });
    assert.equal(v.erroLeitura, '');
    assert.equal(v.erroRevogacao, 'Não foi possível desconectar agora.');
    assert.equal(avisosDaVista(v), 'Não foi possível desconectar agora.');
    assert.equal(v.ocupado, null);
});

test('POST sem resposta: resultado incerto sobrevive à releitura', async () => {
    const t = controlador([() => { throw new TypeError('rede'); }, () => lista('c1')]);
    await t.c.revogar('c1');
    await espera();
    assert.match(avisosDaVista(t.ultima()), /Resultado incerto/);
});

test('nova tentativa de Desconectar limpa o aviso anterior; sucesso não deixa aviso', async () => {
    const t = controlador([() => new Response('{}', { status: 500 }), () => lista('c1'), () => Response.json({ ok: true }), () => lista()]);
    await t.c.revogar('c1');
    await espera();
    assert.notEqual(t.ultima().erroRevogacao, '');
    await t.c.revogar('c1');
    await espera();
    assert.equal(avisosDaVista(t.ultima()), '');
    assert.deepEqual(t.ultima().estado, { conexoes: [] });
});

test('leitura bem-sucedida limpa o próprio erro; os dois avisos aparecem juntos enquanto valem', async () => {
    const t = controlador([() => new Response('{}', { status: 500 }), () => new Response('{}', { status: 500 }), () => new Response('{}', { status: 500 }), () => lista('c1')]);
    t.c.iniciar();
    await espera();
    assert.match(t.ultima().erroLeitura, /Não foi possível carregar/);
    await t.c.revogar('c1');
    await espera();
    assert.match(avisosDaVista(t.ultima()), /desconectar.*carregar/s);
    t.c.atualizar();
    await espera();
    assert.equal(t.ultima().erroLeitura, '');
    assert.match(t.ultima().erroRevogacao, /desconectar/);
});

test('GET pendurado: o prazo aborta, avisa e a fila volta a andar', async () => {
    const t = controlador([pendurada, () => lista('c1')], 5);
    t.c.iniciar();
    await espera(30);
    assert.equal(t.pedidos[0].signal?.aborted, true);
    assert.equal(t.ultima().erroLeitura, AVISO_PRAZO_SEM_DADOS);
    t.c.atualizar();
    await espera();
    assert.equal(t.pedidos.length, 2);
    assert.equal(t.ultima().erroLeitura, '');
    assert.equal(t.ultima().atualizando, false);
});

test('Desconectar durante leitura pendurada: a releitura acontece depois do prazo', async (ctx) => {
    // 15º parecer, P3: relógio controlado. A ordem é conferida antes e depois de avançar o prazo, sem depender de a
    // asserção rodar em menos de 20 ms reais (sob carga, a releitura correta já tinha acontecido).
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const fila = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    const t = controlador([pendurada, () => Response.json({ ok: true }), () => lista()], 20);
    t.c.iniciar();
    await fila();
    await t.c.revogar('c1');
    await fila();
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['GET', 'POST'], 'antes do prazo: a releitura espera a leitura pendurada');
    ctx.mock.timers.tick(19);
    await fila();
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['GET', 'POST'], 'em 19 ms o prazo ainda não venceu');
    assert.equal(t.pedidos[0].signal?.aborted, false);
    ctx.mock.timers.tick(1);
    await fila();
    assert.equal(t.pedidos[0].signal?.aborted, true, 'em 20 ms o prazo aborta a leitura pendurada');
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['GET', 'POST', 'GET']);
    assert.deepEqual(t.ultima().estado, { conexoes: [] });
});

test('corpo da resposta pendurado também vence o prazo; a última leitura fica na tela e é avisada', async () => {
    const corpoPendurado = () => new Response(new ReadableStream({ start() { /* nunca termina */ } }));
    const t = controlador([() => lista('c1'), corpoPendurado], 5);
    t.c.iniciar();
    await espera();
    t.c.atualizar();
    await espera(30);
    assert.equal(t.ultima().erroLeitura, AVISO_PRAZO_COM_DADOS);
    assert.deepEqual(t.ultima().estado, { conexoes: ['c1'] });
    assert.equal(t.ultima().atualizando, false);
});

test('resposta que chega depois do prazo, de quem ignora o sinal, não grava nada', async () => {
    let soltar: (r: Response) => void = () => undefined;
    const atrasada = () => new Promise<Response>((r) => { soltar = r; });
    const t = controlador([atrasada], 5);
    t.c.iniciar();
    await espera(30);
    soltar(lista('velha'));
    await espera();
    assert.equal(t.ultima().estado, null);
    assert.equal(t.ultima().erroLeitura, AVISO_PRAZO_SEM_DADOS);
});

test('sair da tela aborta a leitura em curso e nada mais é publicado', async () => {
    const t = controlador([pendurada]);
    t.c.iniciar();
    await espera();
    const antes = t.publicadas.length;
    t.c.encerrar();
    await espera();
    assert.equal(t.pedidos[0].signal?.aborted, true);
    assert.equal(t.publicadas.length, antes);
});

test('POST não recebe prazo nem cancelamento', async () => {
    const t = controlador([() => Response.json({ ok: true }), () => lista()]);
    await t.c.revogar('c1');
    assert.equal(t.pedidos[0].signal, null);
    t.c.encerrar();
});

test('POST pendente: avisa sem chamar de falha, relê, solta os outros botões e nunca reenvia', async () => {
    let soltar: (r: Response) => void = () => undefined;
    const t = controlador([() => new Promise<Response>((r) => { soltar = r; }), () => lista('c1', 'c2'), () => Response.json({ ok: true }), () => lista('c1')], 1000, 5);
    const primeiro = t.c.revogar('c1');
    assert.equal(t.ultima().ocupado, 'c1');
    await espera(30);
    assert.equal(t.ultima().ocupado, null);
    assert.deepEqual(t.ultima().emEspera, ['c1']);
    assert.equal(avisosDaVista(t.ultima()), AVISO_REVOGACAO_SEM_CONFIRMACAO);
    assert.equal(t.ultima().erroRevogacao, '');
    assert.match(AVISO_REVOGACAO_SEM_CONFIRMACAO, /não foi repetido/);
    assert.doesNotMatch(AVISO_REVOGACAO_SEM_CONFIRMACAO, /Não foi possível|falhou/);
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['POST', 'GET'], 'releitura para conferir, sem repetir o POST');
    await t.c.revogar('c1');
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['POST', 'GET'], 'a mesma conexão não é reenviada');
    await t.c.revogar('c2');
    await espera();
    assert.deepEqual(t.pedidos.map((p) => p.metodo), ['POST', 'GET', 'POST', 'GET'], 'outra conexão pode ser desconectada');
    assert.deepEqual(t.ultima().emEspera, ['c1']);
    soltar(Response.json({ ok: true }));
    await primeiro;
    assert.deepEqual(t.ultima().emEspera, []);
});

test('POST pendente que termina bem: o aviso sai e a lista é relida', async () => {
    let soltar: (r: Response) => void = () => undefined;
    const t = controlador([() => new Promise<Response>((r) => { soltar = r; }), () => lista('c1'), () => lista()], 1000, 5);
    const p = t.c.revogar('c1');
    await espera(30);
    soltar(Response.json({ ok: true }));
    await p;
    await espera();
    assert.equal(avisosDaVista(t.ultima()), '');
    assert.deepEqual(t.ultima().emEspera, []);
    assert.deepEqual(t.ultima().estado, { conexoes: [] });
});

test('POST pendente que termina mal: o erro real substitui o aviso de espera', async () => {
    let soltar: (r: Response) => void = () => undefined;
    const t = controlador([() => new Promise<Response>((r) => { soltar = r; }), () => lista('c1'), () => lista('c1')], 1000, 5);
    const p = t.c.revogar('c1');
    await espera(30);
    soltar(Response.json({ ok: false, erro: 'Recusado.' }, { status: 500 }));
    await p;
    await espera();
    assert.equal(t.ultima().erroRevogacao, 'Recusado.');
    assert.deepEqual(t.ultima().emEspera, []);
});

test('POST rápido não dispara o aviso de espera depois', async () => {
    const t = controlador([() => Response.json({ ok: true }), () => lista()], 1000, 5);
    await t.c.revogar('c1');
    await espera(30);
    assert.equal(avisosDaVista(t.ultima()), '');
});

test('Desconectar com outro pedido em andamento é ignorado', async () => {
    const t = controlador([pendurada], 1000, 1000);
    void t.c.revogar('c1');
    await t.c.revogar('c2');
    assert.equal(t.pedidos.length, 1);
    t.c.encerrar();
});

test('iniciar outro Desconectar não apaga o aviso de quem segue em espera', async () => {
    const t = controlador([pendurada, () => lista('a', 'b'), pendurada], 1000, 5);
    void t.c.revogar('a');
    await espera(30);
    void t.c.revogar('b');
    assert.equal(t.ultima().ocupado, 'b');
    assert.equal(avisosDaVista(t.ultima()), AVISO_REVOGACAO_SEM_CONFIRMACAO);
    t.c.encerrar();
});

test('dois em espera: aviso no plural; erro de um coexiste com a espera do outro; ao fim, só o erro', async () => {
    const soltar: Array<(r: Response) => void> = [];
    const adiado = () => new Promise<Response>((r) => { soltar.push(r); });
    const t = controlador([adiado, () => lista('a', 'b'), adiado, () => lista('a', 'b'), () => lista('a', 'b'), () => lista('b')], 1000, 5);
    const a = t.c.revogar('a');
    await espera(30);
    const b = t.c.revogar('b');
    await espera(30);
    assert.deepEqual(t.ultima().emEspera, ['a', 'b']);
    assert.equal(avisosDaVista(t.ultima()), AVISO_REVOGACOES_SEM_CONFIRMACAO);
    soltar[1](Response.json({ ok: false, erro: 'Recusado.' }, { status: 500 }));
    await b;
    await espera();
    assert.deepEqual(t.ultima().emEspera, ['a']);
    assert.equal(avisosDaVista(t.ultima()), AVISO_REVOGACAO_SEM_CONFIRMACAO + ' Recusado.');
    soltar[0](Response.json({ ok: true }));
    await a;
    await espera();
    assert.equal(avisosDaVista(t.ultima()), 'Recusado.');
});

test('outro pedido entrar em espera não apaga o erro já mostrado', async () => {
    const soltar: Array<(r: Response) => void> = [];
    const adiado = () => new Promise<Response>((r) => { soltar.push(r); });
    const t = controlador([adiado, () => lista('a', 'b'), adiado, () => lista('a', 'b'), () => lista('a', 'b')], 1000, 30);
    const a = t.c.revogar('a');
    await espera(60);
    void t.c.revogar('b');
    soltar[0](Response.json({ ok: false, erro: 'Recusado.' }, { status: 500 }));
    await a;
    assert.equal(t.ultima().erroRevogacao, 'Recusado.');
    await espera(60);
    assert.deepEqual(t.ultima().emEspera, ['b']);
    assert.equal(t.ultima().erroRevogacao, 'Recusado.');
    t.c.encerrar();
});
