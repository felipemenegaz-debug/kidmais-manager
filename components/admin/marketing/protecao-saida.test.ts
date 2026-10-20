import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * Guardião do histórico (R-H1 / R-H1-F / F1–F3 / H1 / A1–A2) — testes COMPORTAMENTAIS sem navegador, com o código real.
 * Janela e histórico falsos com a semântica que importa: ouvintes de popstate na ORDEM DE REGISTRO, stopImmediatePropagation,
 * travessias assíncronas atendidas em FILA com o alvo resolvido no atendimento, entrada de FRAGMENTO (nova, com estado
 * nulo, dispara popstate), history.go sem entrada naquela direção (no-op, sem popstate), um DOCUMENTO ANTERIOR opcional
 * (a travessia até ele é saída do documento, registrada com o autor; aviso confirmado ou cancelado), Navigation API
 * opcional e um RELÓGIO controlado. Um "roteador" registrado DEPOIS do guardião, como o App Router, anota o que recebe e
 * IGNORA estado nulo (como o Next).
 *
 * Contrato SEM Navigation API desde A1/A2 ("decisão primeiro"): ao barrar uma saída da página do editor, o guardião NÃO se
 * move — o pedido abre com o destino = a entrada atual ({ tipo: 'aqui' }), exatamente onde a pessoa chegou; novas
 * travessias dela só o atualizam; voltar à página do editor fecha o pedido (null). "Sair" não faz travessia, e
 * "Continuar editando" também não (C1/C2, decisão de Felipe em 17/10/2026): cria uma entrada NOVA do editor na posição
 * atual (pushState com o estado do Next da entrada do editor; descarta as entradas à frente). O ambiente guarda a URL de
 * pushState/replaceState como o navegador (URL absoluta do documento → caminho). Ver o resto do texto original abaixo.
 *  "Sair" não faz travessia
 * (`sairNaEntradaAtual`); só "Continuar editando" (`continuarEditando`) volta à entrada do editor.
 */
type Estado = unknown;
type Ouvinte = { tipo: string; f: (e: { state: Estado; stopImmediatePropagation(): void }) => void };
type Entrada = { url: string; state: Estado; key: string; outro?: boolean };

function ambiente({ comNavigation, inicial, anterior = false, aviso = 'confirmar' }: { comNavigation: boolean; inicial?: { url: string; state: Estado }; anterior?: boolean; aviso?: 'confirmar' | 'cancelar' }) {
  // Relógio controlado
  let agora = 0, ids = 1;
  const fila: Array<{ id: number; quando: number; f: () => void }> = [];
  const setTimeout = (f: () => void, ms = 0) => { const id = ids++; fila.push({ id, quando: agora + Math.max(0, ms), f }); return id; };
  const clearTimeout = (id: number | null) => { const k = fila.findIndex((x) => x.id === id); if (k >= 0) fila.splice(k, 1); };
  const avancar = (ms: number) => {
    const fim = agora + ms;
    for (;;) {
      fila.sort((x, y) => x.quando - y.quando || x.id - y.id);
      const prox = fila[0];
      if (!prox || prox.quando > fim) break;
      fila.shift(); agora = prox.quando; prox.f();
    }
    agora = fim;
  };

  const ouvintes: Ouvinte[] = [];
  const doApp: Entrada = { ...(inicial ?? { url: '/inicio', state: { __NA: true, arvore: ['inicio'] } }), key: 'k0' };
  const entradas: Entrada[] = anterior ? [{ url: '/anterior', state: null, key: 'kA', outro: true }, doApp] : [doApp];
  let i = anterior ? 1 : 0, chaves = 1;
  /** Saídas do documento (travessia atendida para uma entrada de outro documento), com o autor; e avisos nativos. */
  const saidas: Array<{ quem: 'pessoa' | 'guardiao'; t: number }> = [];
  const avisos: Array<{ quem: 'pessoa' | 'guardiao'; t: number }> = [];
  let descarregado = false;
  /** O que QUALQUER algoritmo vê de cada popstate: URL e índice próprio (nulo sem ele). */
  const observados: string[] = [];
  const disparar = () => {
    const st = entradas[i].state as Record<string, unknown> | null;
    observados.push(`${entradas[i].url}|${st && typeof st === 'object' ? (st.__kidmaisIdx ?? null) : null}`);
    let parar = false;
    const e = { state: entradas[i].state, stopImmediatePropagation() { parar = true; } };
    for (const o of [...ouvintes]) { if (o.tipo !== 'popstate') continue; o.f(e); if (parar) break; }
  };
  /** Travessias atendidas em ordem (fila), como no navegador; as da PESSOA são registradas com a posição onde chegaram. */
  const chegadasHumanas: Array<{ pos: number; t: number }> = [];
  /** Todas as travessias por delta, na ordem de chamada: quem pediu, quando, de onde para onde. */
  const travessiasDelta: Array<{ quem: 'pessoa' | 'guardiao'; d: number; em: number; seq: number; at?: number; de?: number; para?: number; noop?: boolean }> = [];
  let seqT = 0;
  const ir = (alvoDe: (atual: number) => number, humano = false, d: number | null = null) => {
    if (descarregado) return 0;
    const quem = (humano ? 'pessoa' : 'guardiao') as 'pessoa' | 'guardiao';
    const reg = d === null ? null : { quem, d, em: agora, seq: seqT++ };
    if (reg) travessiasDelta.push(reg);
    return setTimeout(() => {
      if (descarregado) return;
      const alvo = alvoDe(i);
      let noop = alvo < 0 || alvo >= entradas.length || alvo === i;
      if (!noop && entradas[alvo].outro) {
        avisos.push({ quem, t: agora });
        if (aviso === 'confirmar') { saidas.push({ quem, t: agora }); descarregado = true; i = alvo; if (reg) Object.assign(reg, { at: agora, de: i, para: alvo, noop: false }); return; }
        noop = true; // aviso cancelado: a travessia não acontece
      }
      if (reg) Object.assign(reg, { at: agora, de: i, para: noop ? i : alvo, noop });
      if (noop) return; // sem entrada: no-op, sem popstate (como o navegador)
      i = alvo;
      if (humano) chegadasHumanas.push({ pos: i, t: agora });
      disparar();
    }, 1);
  };
  /** history.go feito pela PESSOA (botões, menu do histórico): mesma fila, mas a chegada fica registrada como objetivo. */
  const humano = (d: number) => { ir((atual) => atual + d, true, d); };
  const history = {
    get state() { return entradas[i].state; },
    get length() { return entradas.length; },
    pushState(state: Estado, _: string, url?: string) { url = url?.replace(/^http:\/\/teste\.local/, ''); entradas.splice(i + 1); entradas.push({ url: url ?? entradas[i].url, state, key: `k${chaves++}` }); i += 1; },
    replaceState(state: Estado, _: string, url?: string) { url = url?.replace(/^http:\/\/teste\.local/, ''); entradas[i] = { ...entradas[i], state, url: url ?? entradas[i].url }; },
    go(d: number) { ir((atual) => atual + d, false, d); }, back() { this.go(-1); }, forward() { this.go(1); },
  };
  /** Clique numa âncora <a href="#x">: entrada NOVA com estado nulo (descarta as da frente) + popstate. */
  const fragmento = (h: string) => { entradas.splice(i + 1); entradas.push({ url: entradas[i].url.split('#')[0] + h, state: null, key: `k${chaves++}` }); i += 1; disparar(); };
  const travessias: string[] = [];
  const navigation = comNavigation ? {
    get currentEntry() { return { key: entradas[i].key, url: `http://teste.local${entradas[i].url}`, index: i }; },
    traverseTo(chave: string) { travessias.push(chave); const alvo = entradas.findIndex((x) => x.key === chave); ir(() => alvo); return { committed: Promise.resolve(), finished: Promise.resolve() }; },
  } : undefined;
  const janela = {
    history, navigation, setTimeout, clearTimeout, performance: { now: () => agora },
    get location() { return { href: `http://teste.local${entradas[i].url}` }; },
    addEventListener(tipo: string, f: Ouvinte['f']) { ouvintes.push({ tipo, f }); },
    removeEventListener(tipo: string, f: Ouvinte['f']) { const k = ouvintes.findIndex((o) => o.tipo === tipo && o.f === f); if (k >= 0) ouvintes.splice(k, 1); },
  };
  const roteador: string[] = [];
  const registrarRoteador = () => janela.addEventListener('popstate', (e) => { if (e.state) roteador.push(entradas[i].url); });
  return { janela, entradas, roteador, travessias, registrarRoteador, fragmento, avancar, humano, chegadasHumanas, travessiasDelta, observados, saidas, avisos,
    agora: () => agora, url: () => entradas[i].url, posicao: () => i, descarregado: () => descarregado };
}
let n = 0;
type Pedido = { tipo: string; url?: string; href?: string; chave?: string } | null;
async function preparar(comNavigation: boolean, paginas: string[] = ['/dashboard', '/editor'], inicial?: { url: string; state: Estado }, opcoes: { anterior?: boolean; aviso?: 'confirmar' | 'cancelar' } = {}) {
  const amb = ambiente({ comNavigation, inicial, ...opcoes });
  (globalThis as unknown as { window: unknown }).window = amb.janela;
  const m = await import(`./protecao-saida.ts?caso=${n++}`) as typeof import('./protecao-saida.ts');
  m.instalarGuardiaoDeHistorico(); amb.registrarRoteador(); // guardião ANTES do roteador (layout raiz × efeito do AppRouter)
  for (const p of paginas) amb.janela.history.pushState({ __NA: true, arvore: [p] }, '', p);
  const pedidos: Pedido[] = [];
  const quandoPedidos: number[] = [];
  let liberado = false;
  const proteger = () => m.protegerHistorico({ liberado: () => liberado, aoTentarSair: (d) => { pedidos.push(d as Pedido); quandoPedidos.push(amb.agora()); } });
  return { amb, m, pedidos, quandoPedidos, proteger, liberar: () => { liberado = true; } };
}
type Cenario = Awaited<ReturnType<typeof preparar>>;
const aqui = (url: string) => ({ tipo: 'aqui', url: `http://teste.local${url}` });
const tentativaDe = (c: Cenario) => (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { tentativa: unknown } }).__kidmaisGuardiaoHistorico.tentativa;
/** Movimentos do guardião (history.go) pedidos a partir de `desde`. */
const movimentosDoGuardiao = (c: Cenario, desde: number) => c.amb.travessiasDelta.filter((x) => x.quem === 'guardiao' && x.em >= desde);
/**
 * "Sair" do jeito do hook: libera e sai. Com a Navigation API, vai à chave; sem ela, nenhuma travessia — o roteador passa a
 * mostrar a entrada atual (no app, `mostrarEntradaAtual`; aqui o roteador falso anota a URL).
 */
function sair(c: Cenario, desproteger: () => void) {
  const d = c.pedidos.at(-1)!;
  c.liberar(); desproteger();
  if (d!.tipo === 'aqui') c.m.sairNaEntradaAtual(() => c.amb.roteador.push(c.amb.url()));
  else { const alvo = c.amb.entradas.find((x) => `http://teste.local${x.url}` === d!.url)!; c.amb.janela.navigation!.traverseTo(alvo.key); }
  c.amb.avancar(50);
}
/** A página atual é a do editor ("Continuar" cria uma entrada nova do editor; a posição original não importa). */
const estaNoEditor = (c: { amb: { url(): string } }) => c.amb.url().split('#')[0] === '/editor';
/** "Continuar editando" do jeito do hook: fecha o pedido e, sem Navigation API, cria a entrada nova do editor. */
function continuar(c: Cenario, ms = 3000) { c.m.continuarEditando(); c.amb.avancar(ms); }

// ---------------------------------------------------------------------------------------------------------------------
// COM Navigation API (inalterado): volta na hora pela chave e pergunta com a chave de destino.
{
  const modo = 'COM Navigation API';
  test(`${modo}: dois Voltar com edição — o roteador não recebe nada, volta ao editor, pedido com o destino; Sair vai ao destino`, async () => {
    const c = await preparar(true);
    const desproteger = c.proteger(); const tamanho = c.amb.entradas.length;
    c.amb.janela.history.back(); c.amb.janela.history.back(); c.amb.avancar(300);
    assert.deepEqual(c.amb.roteador, [], 'o roteador não pode navegar enquanto há edição');
    assert.equal(c.amb.url(), '/editor'); assert.equal(c.amb.entradas.length, tamanho, 'histórico não cresce');
    assert.equal(c.pedidos.at(-1)!.url, 'http://teste.local/inicio');
    sair(c, desproteger);
    assert.deepEqual(c.amb.roteador, ['/inicio']);
  });
  test(`${modo}: Avançar e history.go(-2) voltam ao editor; sem proteção, Voltar/Avançar seguem direto ao roteador`, async () => {
    const c = await preparar(true, ['/a', '/b', '/editor', '/depois']);
    c.amb.janela.history.back(); c.amb.avancar(10);
    assert.deepEqual(c.amb.roteador, ['/editor']);
    const desproteger = c.proteger();
    c.amb.janela.history.forward(); c.amb.avancar(300);
    assert.equal(c.amb.url(), '/editor');
    c.amb.janela.history.go(-2); c.amb.avancar(300);
    assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.roteador, ['/editor']);
    desproteger();
    c.amb.janela.history.back(); c.amb.avancar(10);
    assert.deepEqual(c.amb.roteador, ['/editor', '/b'], 'sem proteção de novo, um Voltar basta');
  });
  test(`${modo} — F1: âncora da prévia ANTES da edição: dois Voltar não saem; um pedido, só ao sair da página do editor`, async () => {
    const c = await preparar(true);
    c.amb.fragmento('#orcamento'); c.amb.avancar(100);
    const desproteger = c.proteger();
    c.amb.janela.history.back(); c.amb.avancar(200); c.amb.janela.history.back(); c.amb.avancar(300);
    assert.deepEqual(c.amb.roteador, []); assert.match(c.amb.url(), /^\/editor/); assert.equal(c.pedidos.length, 1);
    sair(c, desproteger);
    assert.equal(c.amb.url(), '/dashboard');
  });
  test(`${modo} — F3: âncora com edição não abre diálogo; o Voltar seguinte (fragmento → editor) não pergunta`, async () => {
    const c = await preparar(true);
    const desproteger = c.proteger();
    c.amb.fragmento('#orcamento'); c.amb.avancar(1000);
    c.amb.janela.history.back(); c.amb.avancar(1000);
    assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, []); assert.deepEqual(c.amb.roteador, []);
    c.amb.janela.history.back(); c.amb.avancar(300);
    assert.equal(c.pedidos.length, 1); assert.equal(c.amb.url(), '/editor');
    desproteger();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// SEM Navigation API: "decisão primeiro".
test('SEM Navigation API — dois Voltar com edição: nenhum movimento do guardião; o pedido aponta para onde a pessoa está (/inicio); o roteador não recebe nada', async () => {
  const c = await preparar(false);
  const desproteger = c.proteger(); const t0 = c.amb.agora(); const tamanho = c.amb.entradas.length;
  c.amb.humano(-1); c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(movimentosDoGuardiao(c, t0), [], 'nenhum movimento antes da decisão');
  assert.deepEqual(c.amb.roteador, [], 'o roteador não navega: o editor continua montado');
  assert.equal(c.amb.url(), '/inicio'); assert.equal(c.amb.entradas.length, tamanho, 'histórico não cresce');
  assert.deepEqual(c.pedidos.at(-1), aqui('/inicio'), 'destino = a entrada atual, exata');
  sair(c, desproteger);
  assert.deepEqual(movimentosDoGuardiao(c, t0), [], '"Sair" não faz travessia');
  assert.deepEqual(c.amb.roteador, ['/inicio'], 'o roteador passa a mostrar a entrada atual');
  assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — "Continuar editando" cria uma entrada NOVA do editor na posição atual (ramo à frente descartado); nenhum history.go; nada pendente; sem pedido no fim', async () => {
  const c = await preparar(false, ['/a', '/b', '/editor', '/depois']);
  c.amb.janela.history.back(); c.amb.avancar(10);
  const desproteger = c.proteger(); const t0 = c.amb.agora();
  c.amb.humano(1); c.amb.avancar(300);
  assert.equal(c.amb.url(), '/depois'); assert.deepEqual(c.pedidos, [aqui('/depois')]);
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.equal(tentativaDe(c), null); assert.deepEqual(c.pedidos, [aqui('/depois')]);
  assert.deepEqual(c.amb.entradas.map((e) => e.url), ['/inicio', '/a', '/b', '/editor', '/depois', '/editor'], 'entrada nova do editor depois de /depois');
  assert.deepEqual(movimentosDoGuardiao(c, t0), [], 'nenhum history.go do guardião');
  c.amb.humano(-4); c.amb.avancar(300);
  assert.equal(c.amb.url(), '/a'); assert.deepEqual(c.pedidos.at(-1), aqui('/a'));
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.entradas.map((e) => e.url), ['/inicio', '/a', '/editor'], 'ramo à frente de /a descartado (custo aceito)');
  assert.deepEqual(c.amb.roteador, ['/editor'], 'só o Voltar do preparo: depois dele o roteador nunca navegou (o editor ficou na tela)');
  desproteger();
  c.amb.janela.history.back(); c.amb.avancar(10);
  assert.deepEqual(c.amb.roteador, ['/editor', '/a'], 'sem proteção de novo, um Voltar basta');
});
test('SEM Navigation API — com o pedido aberto, voltar à página do editor fecha o pedido (null) e nada fica pendente', async () => {
  const c = await preparar(false, ['/dashboard', '/editor']);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(300);
  assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
  c.amb.humano(1); c.amb.avancar(300);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos.at(-1), null, 'pedido fechado'); assert.equal(tentativaDe(c), null);
  assert.deepEqual(c.amb.roteador, []);
  desproteger();
});
test('SEM Navigation API — novas travessias com o pedido aberto só atualizam o destino (nova intenção substitui a antiga)', async () => {
  const c = await preparar(false, ['/a', '/b', '/editor']);
  const desproteger = c.proteger(); const t0 = c.amb.agora();
  c.amb.humano(-1); c.amb.avancar(100); c.amb.humano(-1); c.amb.avancar(100); c.amb.humano(1); c.amb.avancar(100);
  assert.deepEqual(c.pedidos, [aqui('/b'), aqui('/a'), aqui('/b')]);
  assert.deepEqual(movimentosDoGuardiao(c, t0), []);
  sair(c, desproteger);
  assert.deepEqual(c.amb.roteador, ['/b']);
});

test('SEM Navigation API — F1: âncora da prévia ANTES da edição: o 1º Voltar (para o editor) é livre; o 2º sai da página → pedido para /dashboard', async () => {
  const c = await preparar(false);
  c.amb.fragmento('#orcamento'); c.amb.avancar(100);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(200);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, []);
  c.amb.janela.history.back(); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, []); assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
  sair(c, desproteger);
  assert.deepEqual(c.amb.roteador, ['/dashboard']);
});
test('SEM Navigation API — F1 (RV-1b): editar, âncora, salvar (proteção cai), editar de novo na entrada do fragmento, dois Voltar → protegido; Continuar volta ao fragmento do editor', async () => {
  const c = await preparar(false);
  let desproteger = c.proteger();
  c.amb.fragmento('#orcamento'); c.amb.avancar(100);
  assert.deepEqual(c.pedidos, [], 'âncora da própria página: sem diálogo');
  desproteger(); desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(200); c.amb.janela.history.back(); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, []); assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
  continuar(c);
  assert.match(c.amb.url(), /^\/editor/); assert.equal(tentativaDe(c), null);
  desproteger();
});
test('SEM Navigation API — F3: âncora com edição não abre diálogo nem deixa estado preso; o Voltar seguinte (fragmento → editor) não pergunta', async () => {
  const c = await preparar(false);
  const desproteger = c.proteger();
  c.amb.fragmento('#orcamento'); c.amb.avancar(1000);
  c.amb.janela.history.back(); c.amb.avancar(1000);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, []); assert.deepEqual(c.amb.roteador, []);
  c.amb.janela.history.back(); c.amb.avancar(300);
  assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
  desproteger();
});
test('SEM Navigation API — F3 (M-3/RV-6b): [dashboard, campanhas, editor, #orcamento] + go(-2) chega a campanhas → pedido para campanhas; Sair mostra campanhas', async () => {
  const c = await preparar(false, ['/campanhas', '/editor']);
  const desproteger = c.proteger();
  c.amb.fragmento('#orcamento'); c.amb.avancar(100);
  c.amb.janela.history.go(-2); c.amb.avancar(300);
  assert.equal(c.amb.url(), '/campanhas'); assert.deepEqual(c.pedidos, [aqui('/campanhas')]);
  sair(c, desproteger);
  assert.deepEqual(c.amb.roteador, ['/campanhas']);
});
test('SEM Navigation API — entradas sem índice À FRENTE: Avançar +2 → pedido para /dashboard#x; Continuar volta ao editor', async () => {
  const c = await preparar(false, ['/editor', '/dashboard']);
  c.amb.fragmento('#x');
  c.amb.janela.history.go(-2); c.amb.avancar(10);
  const desproteger = c.proteger();
  c.amb.janela.history.go(2); c.amb.avancar(400);
  assert.equal(c.amb.url(), '/dashboard#x'); assert.deepEqual(c.pedidos, [aqui('/dashboard#x')]);
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.equal(tentativaDe(c), null);
  desproteger();
});
test('SEM Navigation API — H1: fragmento de página com entradas dos dois lados; Continuar volta sem movimento sem destino; uma tentativa nova funciona (nada preso)', async () => {
  const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
  c.amb.fragmento('#x');
  c.amb.janela.history.go(-2); c.amb.avancar(10);
  const desproteger = c.proteger();
  c.amb.janela.history.go(2); c.amb.avancar(300);
  assert.deepEqual(c.pedidos, [aqui('/dashboard#x')]);
  const t1 = c.amb.agora(); continuar(c, 300);
  assert.equal(c.amb.url(), '/editor'); assert.equal(tentativaDe(c), null);
  assert.deepEqual(movimentosDoGuardiao(c, t1), [], 'nenhum history.go do guardião');
  c.amb.janela.history.back(); c.amb.avancar(300);
  assert.deepEqual(c.pedidos.at(-1), aqui('/dashboard#x'), 'a entrada nova do editor nasceu depois de #x: Voltar leva a ela');
  desproteger();
});
test('SEM Navigation API — H-9: entrada INICIAL sem estado: pedido para ela; Continuar cria a entrada do editor depois dela (ramo à frente descartado); Avançar sem destino; alternar não prende; depois de salvar o histórico segue livre', async () => {
  const c = await preparar(false, ['/editor', '/dashboard'], { url: '/dashboard', state: null });
  c.amb.janela.history.back(); c.amb.avancar(10);
  assert.deepEqual(c.amb.roteador, ['/editor']);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(200);
  assert.equal(c.amb.posicao(), 0); assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
  continuar(c, 200); assert.equal(c.amb.url(), '/editor');
  assert.deepEqual(c.amb.entradas.map((e) => e.url), ['/dashboard', '/editor'], 'o editor e o /dashboard que estavam à frente foram descartados');
  c.amb.janela.history.forward(); c.amb.avancar(200);
  assert.equal(c.amb.posicao(), 1, 'Avançar não tem destino'); assert.equal(c.pedidos.length, 1);
  c.amb.janela.history.back(); c.amb.avancar(200); assert.deepEqual(c.pedidos.at(-1), aqui('/dashboard'));
  continuar(c, 200);
  assert.equal(c.amb.url(), '/editor'); assert.equal(c.pedidos.length, 2);
  desproteger();
  assert.equal(tentativaDe(c), null, 'nenhuma correção pendente');
  c.amb.janela.history.back(); c.amb.avancar(10); assert.equal(c.amb.url(), '/dashboard');
  c.amb.janela.history.forward(); c.amb.avancar(10);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.roteador, ['/editor', '/editor'], 'entrada inicial nula: o roteador a ignora; a do editor ele mostra');
});

for (const ms of [5, 15, 25, 35, 60, 120]) {
  test(`SEM Navigation API — F2: salvamento conclui ${ms} ms depois do Voltar (proteção cai): o pedido continua aberto com o destino; Continuar volta ao editor`, async () => {
    const c = await preparar(false);
    const desproteger = c.proteger();
    c.amb.janela.history.back(); c.amb.avancar(ms); desproteger(); c.amb.avancar(400);
    assert.deepEqual(c.amb.roteador, []); assert.deepEqual(c.pedidos, [aqui('/dashboard')]);
    continuar(c);
    assert.equal(c.amb.url(), '/editor', 'URL coerente com a página depois da decisão'); assert.equal(tentativaDe(c), null);
  });
}
test('SEM Navigation API — F2: saída explícita direta (liberado, fora do hook) com o pedido aberto: a tentativa termina, sem navegação dupla nem pedido tardio', async () => {
  const c = await preparar(false);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(10);
  c.liberar(); desproteger(); c.amb.janela.history.go(1); // ex.: outro fluxo navegou
  c.amb.avancar(400);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [aqui('/dashboard')]); assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — F2: proteção reativada com o pedido aberto (salvou e digitou de novo): herda a página do editor; o pedido seguinte vai à proteção vigente, não ao callback antigo', async () => {
  const c = await preparar(false, ['/a', '/dashboard', '/editor']);
  const antigo: unknown[] = [], novo: unknown[] = [];
  const d1 = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => antigo.push(d) });
  c.amb.janela.history.back(); c.amb.avancar(10);
  assert.deepEqual(antigo, [aqui('/dashboard')]);
  d1(); const d2 = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => novo.push(d) });
  c.amb.janela.history.back(); c.amb.avancar(10);
  assert.deepEqual(novo, [aqui('/a')]); assert.equal(antigo.length, 1, 'callback antigo não é chamado de novo');
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.roteador, []); assert.equal(novo.length, 1);
  d2();
});

test('SEM Navigation API: o índice preserva os campos do roteador (__NA, árvore); nulo continua nulo; array e instância não são reescritos', async () => {
  const c = await preparar(false, []);
  const h = c.amb.janela.history;
  h.pushState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['x'] }, '', '/x');
  assert.deepEqual(h.state, { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['x'], __kidmaisIdx: 1 });
  h.replaceState({ __NA: true, outra: 1 }, '', '/x');
  assert.deepEqual(h.state, { __NA: true, outra: 1, __kidmaisIdx: 1 });
  h.pushState(null, '', '/nulo'); assert.equal(h.state, null);
  const lista = [1, 2]; h.pushState(lista, '', '/lista'); assert.equal(h.state, lista);
  const data = new Date(0); h.pushState(data, '', '/data'); assert.equal(h.state, data);
});
test('risco demonstrado: guardião instalado DEPOIS do roteador não impede a navegação (por isso fica no layout raiz)', async () => {
  const amb = ambiente({ comNavigation: true });
  (globalThis as unknown as { window: unknown }).window = amb.janela;
  const m = await import(`./protecao-saida.ts?caso=${n++}`) as typeof import('./protecao-saida.ts');
  amb.registrarRoteador(); m.instalarGuardiaoDeHistorico();
  amb.janela.history.pushState({ __NA: true }, '', '/editor');
  m.protegerHistorico({ liberado: () => false, aoTentarSair: () => undefined });
  amb.janela.history.back(); amb.avancar(50);
  assert.deepEqual(amb.roteador.slice(0, 1), ['/inicio'], 'o roteador registrado antes recebeu a saída');
});
test('layout raiz instala o guardião (componente cliente avaliado na hidratação de qualquer documento)', () => {
  const ler = (f: string) => fs.readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
  const layout = ler('app/layout.tsx');
  assert.match(layout, /import InstalarGuardiaoHistorico from "@\/components\/InstalarGuardiaoHistorico";/);
  assert.match(layout, /<body[^>]*><InstalarGuardiaoHistorico \/>\{children\}<\/body>/);
  assert.match(ler('components/InstalarGuardiaoHistorico.tsx'), /^instalarGuardiaoDeHistorico\(\);$/m);
});

// ---------------------------------------------------------------------------------------------------------------------
// Varreduras (H1, N1, A1, A2): históricos montados por passos; a pessoa sai do editor (`ida`, chegada em +1) e, `ms` depois,
// faz uma ação. ORÁCULO (independente do produto): o destino é a entrada onde a ÚLTIMA travessia da pessoa chegou de fato.
// Antes da decisão: nenhum movimento do guardião; a página está nessa entrada; o pedido aponta exatamente para ela (ou fechou,
// se ela voltou à página do editor); saída do documento só pela própria travessia dela. Depois: "Continuar" termina na
// entrada do editor sem nada pendente; "Sair" não move nada e mostra a entrada atual.
type Historico = { nome: string; passos: string[]; volta: number; ida: number };
const HISTORICOS = {
  rvI1: { nome: 'RV-I1 [início, Dashboard, Campanhas, editor, Campanhas, Campanhas#fim]', passos: ['/dashboard', '/campanhas', '/editor', '/campanhas', '#fim'], volta: -2, ida: 2 },
  i1: { nome: 'I-1/I-4 [início, Dashboard, editor, Dashboard, Dashboard#x]', passos: ['/dashboard', '/editor', '/dashboard', '#x'], volta: -2, ida: 2 },
  B: { nome: 'B [início, Dashboard, editor, Campanhas, Automações, Automações#fim]', passos: ['/dashboard', '/editor', '/campanhas', '/automacoes', '#fim'], volta: -3, ida: 3 },
  sucessivos: { nome: 'fragmentos sucessivos [início, Dashboard, editor, Campanhas, Campanhas#a, Campanhas#b]', passos: ['/dashboard', '/editor', '/campanhas', '#a', '#b'], volta: -3, ida: 3 },
  ambiguaFrente: { nome: 'âncora ambígua, #fim à frente', passos: ['/dashboard', '/campanhas', '#fim', '/editor', '/campanhas', '#fim'], volta: -2, ida: 2 },
  AT: { nome: 'AT (A1): âncora ambígua, #fim atrás', passos: ['/dashboard', '/campanhas', '#fim', '/editor', '/campanhas', '#fim'], volta: -2, ida: -1 },
  b2: { nome: 'B2 [início, Automações, Automações#fim, editor, Campanhas, Automações, Automações#fim]', passos: ['/automacoes', '#fim', '/editor', '/campanhas', '/automacoes', '#fim'], volta: -3, ida: 3 },
  A: { nome: 'A (A2): [Dashboard, Campanhas, editor, Campanhas, Campanhas#fim]', passos: ['/campanhas', '/editor', '/campanhas', '#fim'], volta: -2, ida: 2 },
} satisfies Record<string, Historico>;
async function prepararPassos(h: Historico, opcoes: { anterior?: boolean; aviso?: 'confirmar' | 'cancelar' } = {}) {
  const c = await preparar(false, [], undefined, opcoes);
  for (const x of h.passos) { if (x.startsWith('#')) c.amb.fragmento(x); else c.amb.janela.history.pushState({ __NA: true, arvore: [x] }, '', x); }
  c.amb.avancar(10);
  c.amb.janela.history.go(h.volta); c.amb.avancar(10);
  assert.equal(c.amb.url(), '/editor', `${h.nome}: preparo no editor`);
  const posEditor = c.amb.posicao(), rotas = c.amb.roteador.length;
  const desproteger = c.proteger();
  const t0 = c.amb.agora();
  c.amb.humano(h.ida); c.amb.avancar(1);
  return { c, posEditor, rotas, desproteger, t0 };
}
/** Classe pelo oráculo; `decisao` executa "continuar" ou "sair" depois de conferir o estado antes da decisão. */
function classificar(c: Cenario, posEditor: number, rotas: number, t0: number, desproteger: () => void, decisao: 'continuar' | 'sair') {
  const saida = c.amb.saidas.at(-1);
  if (saida) { desproteger(); return saida.quem === 'guardiao' ? 'SAIU_PELA_CORRECAO' : 'SAIU_PELA_PESSOA'; }
  if (movimentosDoGuardiao(c, t0).length) { desproteger(); return 'MOVEU_ANTES_DA_DECISAO'; }
  const ultima = c.amb.chegadasHumanas.at(-1)!;
  if (c.amb.posicao() !== ultima.pos || c.amb.roteador.length !== rotas) { desproteger(); return 'INCOERENTE'; }
  const naPaginaDoEditor = c.amb.entradas[ultima.pos].url.split('#')[0] === '/editor';
  const pedido = c.pedidos.at(-1);
  if (naPaginaDoEditor) { desproteger(); return pedido === null && tentativaDe(c) === null ? 'OK' : 'PEDIDO_INDEVIDO'; }
  if (JSON.stringify(pedido) !== JSON.stringify(aqui(c.amb.entradas[ultima.pos].url))) { desproteger(); return 'DESTINO_ERRADO'; }
  if (decisao === 'continuar') {
    const nPedidos = c.pedidos.length;
    continuar(c);
    const ok = !c.amb.saidas.length && estaNoEditor(c) && tentativaDe(c) === null && c.amb.roteador.length === rotas && c.pedidos.length === nPedidos;
    desproteger();
    return ok ? 'OK' : (c.amb.saidas.length ? 'SAIU_PELA_CORRECAO' : 'CONTINUAR_FALHOU');
  }
  const pos = c.amb.posicao(), t1 = c.amb.agora();
  sair(c, desproteger);
  return movimentosDoGuardiao(c, t1).length === 0 && c.amb.posicao() === pos && tentativaDe(c) === null && c.amb.roteador.at(-1) === c.amb.url() ? 'OK' : 'SAIR_ERRADO';
}
async function varrer(h: Historico, opcoes: { anterior?: boolean; aviso?: 'confirmar' | 'cancelar' } = {}, acoes = [-1, 1, -2, 2, -3, -4], momentos = Array.from({ length: 131 }, (_, k) => k)) {
  const contagem: Record<string, number> = {}, exemplos: string[] = [];
  for (const d of acoes) for (const ms of momentos) for (const decisao of ['continuar', 'sair'] as const) {
    const { c, posEditor, rotas, desproteger, t0 } = await prepararPassos(h, opcoes);
    c.amb.avancar(ms); c.amb.humano(d); c.amb.avancar(3000);
    const classe = classificar(c, posEditor, rotas, t0, desproteger, decisao);
    contagem[classe] = (contagem[classe] ?? 0) + 1;
    if (classe !== 'OK' && classe !== 'SAIU_PELA_PESSOA' && exemplos.length < 5) exemplos.push(`${d}@${ms} ${decisao} ${classe}: ${c.amb.travessiasDelta.map((x) => `${x.quem[0]}${x.d > 0 ? '+' : ''}${x.d}@${x.em}`).join(' ')}`);
  }
  return { contagem, exemplos };
}
for (const [chave, h] of Object.entries(HISTORICOS)) {
  test(`SEM Navigation API — decisão primeiro [${h.nome}]: 6 gestos × 0–130 ms × Continuar/Sair → destino exato, nenhum movimento antes da decisão, Continuar sempre volta`, async (t) => {
    const { contagem, exemplos } = await varrer(h);
    t.diagnostic(JSON.stringify(contagem));
    assert.deepEqual(Object.keys(contagem).filter((k) => k !== 'OK'), [], `${chave}: ${exemplos.join(' | ')}`);
  });
}
for (const aviso of ['confirmar', 'cancelar'] as const) {
  test(`SEM Navigation API — A2 [${HISTORICOS.A.nome}] com documento anterior (aviso ${aviso}): nenhuma saída do documento causada pela correção; as que existem são gestos da própria pessoa`, async (t) => {
    const { contagem, exemplos } = await varrer(HISTORICOS.A, { anterior: true, aviso });
    t.diagnostic(JSON.stringify(contagem));
    assert.equal(contagem.SAIU_PELA_CORRECAO ?? 0, 0, exemplos.join(' | '));
    assert.deepEqual(Object.keys(contagem).filter((k) => k !== 'OK' && k !== 'SAIU_PELA_PESSOA'), [], exemplos.join(' | '));
  });
}
test('SEM Navigation API — A1 (AT): go(−2) da pessoa em qualquer instante → o pedido aponta para o Dashboard, onde ela chegou; "Sair" fica nele', async () => {
  for (const ms of [36, 38, 39, 40, 41, 42, 44]) {
    const { c, desproteger } = await prepararPassos(HISTORICOS.AT);
    c.amb.avancar(ms); c.amb.humano(-2); c.amb.avancar(3000);
    assert.equal(c.amb.url(), '/dashboard', `${ms} ms`); assert.deepEqual(c.pedidos.at(-1), aqui('/dashboard'), `${ms} ms`);
    sair(c, desproteger); assert.equal(c.amb.url(), '/dashboard');
  }
});
test('SEM Navigation API — A2 (A, documento anterior, aviso confirmado): go(−3) da pessoa em qualquer instante → pedido para Campanhas, sem aviso nem saída do documento', async () => {
  for (const ms of [38, 39, 40, 41]) {
    const { c, desproteger } = await prepararPassos(HISTORICOS.A, { anterior: true, aviso: 'confirmar' });
    c.amb.avancar(ms); c.amb.humano(-3); c.amb.avancar(3000);
    assert.deepEqual(c.amb.avisos, [], `${ms} ms: nenhum aviso de saída`); assert.equal(c.amb.descarregado(), false);
    assert.equal(c.amb.url(), '/campanhas'); assert.deepEqual(c.pedidos.at(-1), aqui('/campanhas'));
    sair(c, desproteger); assert.equal(c.amb.url(), '/campanhas');
  }
});

// ---- Depois da decisão "Continuar editando": a pessoa atravessa DURANTE a volta ----
/**
 * Depois de "Continuar editando", a volta é um movimento ativo de novo — e um gesto da pessoa do MESMO tamanho, pedido no
 * mesmo instante do nosso, produz as mesmas chegadas nas duas ordens (o limite de qualquer volta ativa). O resíduo fica
 * restrito a isso: só depois de uma decisão explícita, só na largura do atendimento. Classes: OK; RESIDUO_POS_DECISAO (o
 * gesto dela tem o tamanho do nosso movimento, atendido no mesmo instante, e o resultado é um pedido novo — nunca saída do
 * documento, nunca volta presa); qualquer outra falha é defeito.
 */
// Depois de "Continuar editando" a volta é um movimento ATIVO (history.go relativo, não cancelável). Classes pela
// CONSEQUÊNCIA medida, sem classificar nada de antemão pelo tamanho ou instante do gesto (O-c do parecer de cda9464):
//  SAIU_PELA_CORRECAO / +AVISO_PELA_CORRECAO — travessia do guardião cruzou para outro documento (aviso confirmado/cancelado);
//  DESTINO_TROCADO — pedido aberto, mas não na entrada aonde a pessoa chegou por último;
//  PEDIDO_NOVO — a última chegada dela foi à página do editor, mas termina com pedido;
//  ENGOLIDO — ela chegou a outra página e termina no editor sem pedido; PRESO — algo pendente, ou fora do editor sem pedido.
// C1/C2 (parecer de cda9464) aparecem aqui; a janela "gesto já na fila no 1º movimento" com atendimento de 1–10 ms fica no
// modelo da revisora (este ambiente atende cada travessia em 1 ms). Com "Continuar" sem travessia (decisão de Felipe,
// 17/10/2026; docs/MARKETING_HISTORICO_CONTINUAR_20261017.md), nenhuma dessas classes pode aparecer.
function classificarCruzamento(c: Cenario, posEditor: number, tc: number) {
  const guard = (x: { quem: string }) => x.quem === 'guardiao';
  if (c.amb.saidas.some(guard)) return 'SAIU_PELA_CORRECAO';
  if (c.amb.saidas.length) return 'SAIU_PELA_PESSOA';
  const aviso = c.amb.avisos.some(guard) ? '+AVISO_PELA_CORRECAO' : '';
  const ultima = c.amb.chegadasHumanas.filter((x) => x.t >= tc).at(-1);
  const tent = tentativaDe(c), pedido = c.pedidos.at(-1);
  const pendente = tent !== null && pedido?.tipo === 'aqui';
  let classe: string;
  if (!ultima || c.amb.entradas[ultima.pos].url.split('#')[0] === '/editor') classe = !pendente && tent === null && estaNoEditor(c) ? 'OK' : pendente ? 'PEDIDO_NOVO' : 'PRESO';
  else if (pendente) classe = c.amb.posicao() === ultima.pos && JSON.stringify(pedido) === JSON.stringify(aqui(c.amb.entradas[ultima.pos].url)) ? 'OK' : 'DESTINO_TROCADO';
  else classe = tent === null && estaNoEditor(c) ? 'ENGOLIDO' : 'PRESO';
  return classe + aviso;
}
test('SEM Navigation API — depois de "Continuar", gesto da pessoa (±1…±5, 0–130 ms; com e sem documento anterior): consequência medida — sem saída pela correção, destino trocado, pedido indevido ou volta presa', async (t) => {
  const contagem: Record<string, number> = {}, exemplos: string[] = [];
  for (const h of [HISTORICOS.A, HISTORICOS.AT, HISTORICOS.B, HISTORICOS.b2, HISTORICOS.rvI1]) for (const opcoes of [{}, { anterior: true, aviso: 'confirmar' as const }]) for (const d of [-1, 1, -2, 2, -3, 3, -4, -5]) for (let ms = 0; ms <= 130; ms += (ms < 60 ? 1 : 5)) {
    const { c, posEditor, desproteger } = await prepararPassos(h, opcoes);
    c.amb.avancar(200);
    const tc = c.amb.agora();
    c.m.continuarEditando(); c.amb.avancar(ms); c.amb.humano(d); c.amb.avancar(3000);
    const classe = classificarCruzamento(c, posEditor, tc);
    contagem[classe] = (contagem[classe] ?? 0) + 1;
    if (classe !== 'OK' && classe !== 'SAIU_PELA_PESSOA' && exemplos.length < 8) exemplos.push(`${h.nome.slice(0, 12)}${'anterior' in opcoes ? ' doc' : ''} ${d}@${ms} ${classe}: ${c.amb.travessiasDelta.map((x) => `${x.quem[0]}${x.d > 0 ? '+' : ''}${x.d}@${x.em}${x.noop ? 'n' : ''}`).join(' ')}`);
    desproteger();
  }
  t.diagnostic(JSON.stringify(contagem));
  assert.deepEqual(Object.keys(contagem).filter((k) => k !== 'OK' && k !== 'SAIU_PELA_PESSOA'), [], exemplos.join(' | '));
});
test('SEM Navigation API — "Sair" depois de "Continuar" e de uma travessia da pessoa: sai na entrada que ela escolheu e não move nada depois', async () => {
  const { c, desproteger } = await prepararPassos(HISTORICOS.B);
  c.amb.avancar(100);
  c.m.continuarEditando(); c.amb.avancar(0); // entrada nova do editor (nenhum movimento do guardião)
  c.amb.humano(-1);                           // a pessoa atravessa
  c.amb.avancar(2);                           // chega ela: o pedido reabre ali
  assert.ok(c.pedidos.at(-1) && c.pedidos.at(-1)!.tipo === 'aqui', 'pedido reaberto');
  const escolhida = c.amb.chegadasHumanas.at(-1)!.pos;
  c.liberar(); desproteger();
  let mostrou: string | null = null;
  c.m.sairNaEntradaAtual(() => { mostrou = c.amb.url(); });
  c.amb.avancar(3000);
  assert.equal(mostrou, c.amb.entradas[escolhida].url, 'sai na entrada que ela escolheu');
  assert.equal(c.amb.posicao(), escolhida); assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — O-2: saída por link depois de "Continuar" parte da entrada do editor (nenhum movimento do guardião a esperar); nada depois dela', async () => {
  const { c, desproteger } = await prepararPassos(HISTORICOS.rvI1);
  c.amb.avancar(100);
  c.m.continuarEditando(); c.amb.avancar(0);
  let posNaSaida = -1;
  c.liberar();
  // Como o hook: a saída por link segue direto (não há volta a esperar).
  posNaSaida = c.amb.posicao(); desproteger(); c.amb.janela.history.pushState({ __NA: true }, '', '/saida-escolhida');
  c.amb.avancar(3000);
  assert.equal(c.amb.entradas[posNaSaida].url, '/editor', 'a saída parte da entrada do editor');
  assert.equal(c.amb.url(), '/saida-escolhida'); assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — O-2 direto (saída fora do hook logo depois de "Continuar"): nenhum movimento do guardião; a URL termina na saída escolhida', async () => {
  const { c, desproteger } = await prepararPassos(HISTORICOS.rvI1);
  c.amb.avancar(100);
  c.m.continuarEditando(); c.amb.avancar(0);
  c.liberar(); desproteger(); c.amb.janela.history.pushState({ __NA: true }, '', '/saida-escolhida');
  c.amb.avancar(3000);
  assert.equal(c.amb.url(), '/saida-escolhida'); assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — H1-R2: com o pedido aberto, a pessoa vai à 1ª entrada da aba: nada se move; Continuar termina no editor (não fica presa)', async () => {
  const { c, desproteger } = await prepararPassos(HISTORICOS.rvI1);
  c.amb.avancar(39); c.amb.humano(-5); c.amb.avancar(300);
  assert.equal(c.amb.posicao(), 0); assert.deepEqual(c.pedidos.at(-1), aqui('/inicio'));
  continuar(c);
  assert.ok(estaNoEditor(c)); assert.equal(tentativaDe(c), null);
  desproteger();
});

test('SEM Navigation API — representação: entrada criada a partir de posição incerta não duplica índice; Continuar termina na página do editor', async () => {
  const c = await preparar(false, ['/a', '/b', '/c']);
  c.amb.fragmento('#f');
  c.amb.janela.history.go(-3); c.amb.avancar(10);
  c.amb.janela.history.go(3); c.amb.avancar(10);
  c.amb.janela.history.pushState({ __NA: true }, '', '/d');
  const estado = c.amb.janela.history.state as Record<string, unknown>;
  assert.equal(estado.__kidmaisIdx, 4, 'índice único (antes: 2, igual ao de /b)');
  c.amb.janela.history.go(-2); c.amb.avancar(10);
  const off = c.proteger();
  c.amb.humano(2); c.amb.avancar(1000);
  assert.equal(c.amb.url(), '/d'); assert.deepEqual(c.pedidos, [aqui('/d')]);
  continuar(c);
  assert.equal(c.amb.url(), '/c'); assert.equal(tentativaDe(c), null);
  off();
});
test('SEM Navigation API — índices duplicados herdados (premissa quebrada) → Continuar ainda termina no editor', async () => {
  const c = await preparar(false, ['/a', '/b', '/editor', '/c']);
  c.amb.entradas[4].state = { __NA: true, __kidmaisIdx: 1 };
  c.amb.janela.history.go(-1); c.amb.avancar(10);
  const off = c.proteger();
  c.amb.humano(1); c.amb.avancar(100);
  assert.deepEqual(c.pedidos, [aqui('/c')]);
  continuar(c, 5000);
  assert.equal(c.amb.url(), '/editor', 'termina no editor'); assert.equal(tentativaDe(c), null);
  off();
});
test('SEM Navigation API — mostrarEntradaAtual: estado do Next → o mesmo popstate ao roteador (estado intacto); estado nulo → recarrega o documento; nada é escrito no estado', async () => {
  const c = await preparar(false, ['/dashboard', '/editor']);
  const enviados: unknown[] = []; let recargas = 0;
  const g = globalThis as unknown as { PopStateEvent?: unknown };
  const antes = g.PopStateEvent;
  g.PopStateEvent = class { type: string; state: unknown; constructor(type: string, init: { state: unknown }) { this.type = type; this.state = init.state; } };
  const j = c.amb.janela as unknown as { dispatchEvent: (e: unknown) => boolean; location: { href: string; reload?: () => void } };
  j.dispatchEvent = (e) => { enviados.push(e); return true; };
  Object.defineProperty(c.amb.janela, 'location', { get: () => ({ href: `http://teste.local${c.amb.url()}`, reload: () => { recargas++; } }) });
  try {
    c.amb.janela.history.back(); c.amb.avancar(10); // /dashboard, estado do Next
    const estado = c.amb.janela.history.state;
    c.m.mostrarEntradaAtual();
    assert.equal(enviados.length, 1); assert.equal((enviados[0] as { type: string }).type, 'popstate');
    assert.equal((enviados[0] as { state: unknown }).state, estado, 'o estado da entrada, sem cópia nem campo novo');
    c.amb.fragmento('#ancora'); // entrada nula
    c.m.mostrarEntradaAtual();
    assert.equal(recargas, 1); assert.equal(c.amb.janela.history.state, null, 'nulo continua nulo');
  } finally { g.PopStateEvent = antes; }
});

// ---------------------------------------------------------------------------------------------------------------------
// O-a (parecer de cda9464): tentativa ÓRFÃ. A tentativa pertence ao editor (`dono`, a instância do hook); na DESMONTAGEM
// dele sem decisão (navegação programática do app — o AdminShell troca para o login quando a leitura da sessão falha), ela
// termina. A reativação no mesmo editor não passa por aqui. Aqui, "router.replace" = replaceState da entrada atual pelo
// login; a desmontagem = desproteger + abandonarTentativa(dono), como os efeitos do hook.
const desmontarParaLogin = (c: Cenario, desproteger: () => void, dono: object) => {
  c.amb.janela.history.replaceState({ __NA: true, arvore: ['/login'] }, '', '/login');
  desproteger(); c.m.abandonarTentativa(dono);
};
const protegerComDono = (c: Cenario, dono: object) => c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => { c.pedidos.push(d as Pedido); }, dono });
test('SEM Navigation API — O-a: pedido aberto e o editor DESMONTADO por navegação programática (login): a tentativa termina; Voltar/Avançar seguintes vão ao roteador; nada se move', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor']);
  const dono = {}; const desproteger = protegerComDono(c, dono); const t0 = c.amb.agora();
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.pedidos.at(-1), aqui('/campanhas'));
  desmontarParaLogin(c, desproteger, dono);
  assert.equal(tentativaDe(c), null, 'a tentativa termina com o editor');
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, ['/dashboard'], 'Voltar: o roteador mostra o Dashboard (URL e tela coerentes)');
  c.amb.humano(1); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, ['/dashboard', '/login'], 'Avançar: o login');
  c.amb.humano(1); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, ['/dashboard', '/login', '/editor'], 'a entrada do editor é uma entrada comum: o roteador a mostra');
  assert.deepEqual(movimentosDoGuardiao(c, t0), []); assert.equal(c.pedidos.length, 1, 'nenhum pedido tardio');
});
test('SEM Navigation API — O-a: editor desmontado logo depois de "Continuar" (nenhum movimento a desfazer): a tentativa já terminou; o roteador segue a navegação; o editor desmontado não revive', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor']);
  const dono = {}; const desproteger = protegerComDono(c, dono); const t0 = c.amb.agora();
  c.amb.humano(-1); c.amb.avancar(300);
  c.m.continuarEditando(); c.amb.avancar(0);
  assert.deepEqual(movimentosDoGuardiao(c, t0), [], '"Continuar" sem travessia');
  desmontarParaLogin(c, desproteger, dono);
  c.amb.avancar(3000);
  assert.equal(c.amb.url(), '/login'); assert.deepEqual(c.amb.roteador, []); assert.equal(tentativaDe(c), null);
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.amb.roteador, ['/campanhas'], 'Voltar a partir do login: Campanhas, normal');
});
test('SEM Navigation API — O-a: "Continuar", Voltar da pessoa no mesmo instante e desmontagem: a chegada dela vai ao roteador; nada é desfeito nem revive', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor']);
  const dono = {}; const desproteger = protegerComDono(c, dono);
  c.amb.humano(-1); c.amb.avancar(300);
  c.m.continuarEditando(); c.amb.humano(-1); c.amb.avancar(0);
  desmontarParaLogin(c, desproteger, dono);
  c.amb.avancar(3000);
  assert.equal(c.amb.url(), '/campanhas'); assert.deepEqual(c.amb.roteador, ['/campanhas'], 'Voltar a partir da entrada nova do editor (agora o login): Campanhas');
  assert.equal(tentativaDe(c), null);
});
test('SEM Navigation API — O-a: reativação no MESMO editor (salvou e editou de novo) não abandona; abandono de outro dono não afeta; a desmontagem simulada do Strict Mode na montagem é inofensiva', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor']);
  const dono = {};
  c.m.abandonarTentativa(dono); // Strict Mode: desmontagem simulada antes de qualquer tentativa
  const d1 = protegerComDono(c, dono);
  c.amb.humano(-1); c.amb.avancar(300);
  d1(); const d2 = protegerComDono(c, dono); // salvou (ativo falso) e editou de novo (ativo verdadeiro)
  c.m.abandonarTentativa({}); // outro editor
  assert.notEqual(tentativaDe(c), null, 'o pedido continua');
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.equal(tentativaDe(c), null); assert.deepEqual(c.amb.roteador, []);
  d2();
});

// ---------------------------------------------------------------------------------------------------------------------
// "Continuar" sem travessia (decisão de Felipe, 17/10/2026): estado da entrada nova e contingência.
test('SEM Navigation API — "Continuar" cria a entrada nova com o estado do Next da entrada do editor (mesmos campos e árvore, índice próprio novo); nenhum campo inventado', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor', '/automacoes']);
  c.amb.janela.history.back(); c.amb.avancar(10);
  const estadoEditor = c.amb.janela.history.state as Record<string, unknown>;
  const desproteger = c.proteger();
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.pedidos.at(-1), aqui('/campanhas'));
  continuar(c);
  const novo = c.amb.janela.history.state as Record<string, unknown>;
  assert.deepEqual(Object.keys(novo).sort(), Object.keys(estadoEditor).sort(), 'mesmos campos');
  assert.deepEqual(novo.arvore, estadoEditor.arvore); assert.equal(novo.__NA, true);
  assert.notEqual(novo.__kidmaisIdx, undefined); assert.equal(novo.__kidmaisIdx, (estadoEditor.__kidmaisIdx as number));
  assert.deepEqual(c.amb.entradas.map((e) => e.url), ['/inicio', '/dashboard', '/campanhas', '/editor'], 'a entrada do editor recriada; /automacoes à frente descartada');
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.pedidos.at(-1), aqui('/campanhas'), 'a proteção segue a entrada nova');
  desproteger();
});
test('SEM Navigation API — contingência (estado do editor não registrado — INJEÇÃO do teste): "Continuar" ainda sem travessia; entrada nova só com o índice próprio (nada do Next)', async () => {
  const c = await preparar(false, ['/dashboard', '/campanhas', '/editor']);
  const desproteger = c.proteger(); const t0 = c.amb.agora();
  c.amb.humano(-1); c.amb.avancar(300);
  (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { estados: Map<number, unknown> } }).__kidmaisGuardiaoHistorico.estados.clear();
  continuar(c);
  assert.equal(c.amb.url(), '/editor'); assert.equal(tentativaDe(c), null);
  assert.deepEqual(movimentosDoGuardiao(c, t0), [], 'nenhum history.go do guardião');
  assert.deepEqual(Object.keys(c.amb.janela.history.state as object), ['__kidmaisIdx'], 'só o índice próprio');
  c.amb.humano(-1); c.amb.avancar(300);
  assert.deepEqual(c.pedidos.at(-1), aqui('/campanhas'), 'a proteção segue a entrada nova');
  desproteger();
});
