import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * Guardião do histórico (R-H1 / R-H1-F / F1–F3, 16/10/2026) — testes COMPORTAMENTAIS sem navegador, com o código real.
 * Janela e histórico falsos com a semântica que importa: ouvintes de popstate na ORDEM DE REGISTRO, stopImmediatePropagation,
 * travessias assíncronas, entrada de FRAGMENTO (nova, com estado nulo, dispara popstate), history.go sem entrada naquela
 * direção (no-op, sem popstate), Navigation API opcional e um RELÓGIO controlado (temporizadores e travessias no mesmo
 * relógio: intercalação determinística, sem depender do tempo de parede). Um "roteador" registrado DEPOIS do guardião,
 * como o App Router, anota o que recebe e IGNORA estado nulo (como o Next).
 */
type Estado = unknown;
type Ouvinte = { tipo: string; f: (e: { state: Estado; stopImmediatePropagation(): void }) => void };

function ambiente({ comNavigation, inicial }: { comNavigation: boolean; inicial?: { url: string; state: Estado } }) {
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
  const entradas: Array<{ url: string; state: Estado; key: string }> = [{ ...(inicial ?? { url: '/inicio', state: { __NA: true, arvore: ['inicio'] } }), key: 'k0' }];
  let i = 0, chaves = 1;
  const disparar = () => {
    let parar = false;
    const e = { state: entradas[i].state, stopImmediatePropagation() { parar = true; } };
    for (const o of [...ouvintes]) { if (o.tipo !== 'popstate') continue; o.f(e); if (parar) break; }
  };
  const ir = (alvoDe: (atual: number) => number) => setTimeout(() => {
    const alvo = alvoDe(i);
    if (alvo < 0 || alvo >= entradas.length || alvo === i) return; // sem entrada: no-op, sem popstate (como o navegador)
    i = alvo; disparar();
  }, 1);
  const history = {
    get state() { return entradas[i].state; },
    get length() { return entradas.length; },
    pushState(state: Estado, _: string, url?: string) { entradas.splice(i + 1); entradas.push({ url: url ?? entradas[i].url, state, key: `k${chaves++}` }); i += 1; },
    replaceState(state: Estado, _: string, url?: string) { entradas[i] = { ...entradas[i], state, url: url ?? entradas[i].url }; },
    go(d: number) { ir((atual) => atual + d); }, back() { this.go(-1); }, forward() { this.go(1); },
  };
  /** Clique numa âncora <a href="#x">: entrada NOVA com estado nulo (descarta as da frente) + popstate. */
  const fragmento = (h: string) => { entradas.splice(i + 1); entradas.push({ url: entradas[i].url.split('#')[0] + h, state: null, key: `k${chaves++}` }); i += 1; disparar(); };
  const travessias: string[] = [];
  const navigation = comNavigation ? {
    get currentEntry() { return { key: entradas[i].key, url: `http://teste.local${entradas[i].url}`, index: i }; },
    traverseTo(chave: string) { travessias.push(chave); const alvo = entradas.findIndex((x) => x.key === chave); ir(() => alvo); return { committed: Promise.resolve(), finished: Promise.resolve() }; },
  } : undefined;
  const janela = {
    history, navigation, setTimeout, clearTimeout,
    get location() { return { href: `http://teste.local${entradas[i].url}` }; },
    addEventListener(tipo: string, f: Ouvinte['f']) { ouvintes.push({ tipo, f }); },
    removeEventListener(tipo: string, f: Ouvinte['f']) { const k = ouvintes.findIndex((o) => o.tipo === tipo && o.f === f); if (k >= 0) ouvintes.splice(k, 1); },
  };
  const roteador: string[] = [];
  const registrarRoteador = () => janela.addEventListener('popstate', (e) => { if (e.state) roteador.push(entradas[i].url); });
  return { janela, entradas, roteador, travessias, registrarRoteador, fragmento, avancar, url: () => entradas[i].url, posicao: () => i };
}
let n = 0;
async function preparar(comNavigation: boolean, paginas: string[] = ['/dashboard', '/editor'], inicial?: { url: string; state: Estado }) {
  const amb = ambiente({ comNavigation, inicial });
  (globalThis as unknown as { window: unknown }).window = amb.janela;
  const m = await import(`./protecao-saida.ts?caso=${n++}`) as typeof import('./protecao-saida.ts');
  m.instalarGuardiaoDeHistorico(); amb.registrarRoteador(); // guardião ANTES do roteador (layout raiz × efeito do AppRouter)
  for (const p of paginas) amb.janela.history.pushState({ __NA: true, arvore: [p] }, '', p);
  const pedidos: Array<{ tipo: string; delta?: number; url?: string }> = [];
  let liberado = false;
  const proteger = () => m.protegerHistorico({ liberado: () => liberado, aoTentarSair: (d) => pedidos.push(d as never) });
  return { amb, m, pedidos, proteger, liberar: () => { liberado = true; } };
}
/** Executa "Sair" do jeito do hook: libera e vai ao destino pedido. */
function sair(c: Awaited<ReturnType<typeof preparar>>, desproteger: () => void) {
  const d = c.pedidos.at(-1)!;
  c.liberar(); desproteger();
  if (d.tipo === 'relativo') c.amb.janela.history.go(d.delta!);
  else { const alvo = c.amb.entradas.find((x) => `http://teste.local${x.url}` === d.url)!; c.amb.janela.navigation!.traverseTo(alvo.key); }
  c.amb.avancar(50);
}

for (const comNavigation of [false, true]) {
  const modo = comNavigation ? 'COM Navigation API' : 'SEM Navigation API';

  test(`${modo}: dois Voltar com edição — o roteador não recebe nada, volta ao editor, pedido com o destino; Sair vai ao destino`, async () => {
    const c = await preparar(comNavigation);
    const desproteger = c.proteger(); const tamanho = c.amb.entradas.length;
    c.amb.janela.history.back(); c.amb.janela.history.back(); c.amb.avancar(300);
    assert.deepEqual(c.amb.roteador, [], 'o roteador não pode navegar enquanto há edição');
    assert.equal(c.amb.url(), '/editor'); assert.equal(c.amb.entradas.length, tamanho, 'histórico não cresce');
    const ultimo = c.pedidos.at(-1)!;
    if (comNavigation) assert.equal(ultimo.url, 'http://teste.local/inicio'); else assert.deepEqual(ultimo, { tipo: 'relativo', delta: -2 });
    sair(c, desproteger);
    assert.deepEqual(c.amb.roteador, ['/inicio']);
  });

  test(`${modo}: Avançar e history.go(-2) voltam ao editor; sem proteção, Voltar/Avançar seguem direto ao roteador`, async () => {
    const c = await preparar(comNavigation, ['/a', '/b', '/editor', '/depois']);
    c.amb.janela.history.back(); c.amb.avancar(10);
    assert.deepEqual(c.amb.roteador, ['/editor']);
    const desproteger = c.proteger();
    c.amb.janela.history.forward(); c.amb.avancar(300);
    assert.equal(c.amb.url(), '/editor');
    c.amb.janela.history.go(-2); c.amb.avancar(300);
    assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.roteador, ['/editor']);
    if (!comNavigation) assert.deepEqual(c.pedidos.map((p) => p.delta), [1, -2]);
    desproteger();
    c.amb.janela.history.back(); c.amb.avancar(10);
    assert.deepEqual(c.amb.roteador, ['/editor', '/b'], 'sem proteção de novo, um Voltar basta');
  });

  test(`${modo} — F1: âncora da prévia ANTES da edição (entrada protegida com estado nulo): dois Voltar não saem; destino −1 a partir do editor`, async () => {
    const c = await preparar(comNavigation);
    c.amb.fragmento('#orcamento'); c.amb.avancar(100);
    const desproteger = c.proteger();
    c.amb.janela.history.back(); c.amb.avancar(200); c.amb.janela.history.back(); c.amb.avancar(300);
    assert.deepEqual(c.amb.roteador, [], 'nada chega ao roteador');
    assert.match(c.amb.url(), /^\/editor/);
    assert.equal(c.pedidos.length, 1, 'um pedido, só ao sair da página do editor');
    sair(c, desproteger);
    assert.equal(c.amb.url(), '/dashboard');
  });

  test(`${modo} — F1 (RV-1b): editar, âncora, salvar (proteção cai), editar de novo (proteção na entrada do fragmento), dois Voltar → protegido`, async () => {
    const c = await preparar(comNavigation);
    let desproteger = c.proteger();
    c.amb.fragmento('#orcamento'); c.amb.avancar(100);
    assert.deepEqual(c.pedidos, [], 'âncora da própria página: sem diálogo');
    desproteger(); // salvou
    desproteger = c.proteger(); // editou de novo, na entrada do fragmento
    c.amb.janela.history.back(); c.amb.avancar(200); c.amb.janela.history.back(); c.amb.avancar(300);
    assert.deepEqual(c.amb.roteador, []); assert.match(c.amb.url(), /^\/editor/); assert.equal(c.pedidos.length, 1);
    desproteger();
  });

  test(`${modo} — F3: âncora com edição não abre diálogo nem deixa estado preso; o Voltar seguinte (fragmento → editor) não pergunta`, async () => {
    const c = await preparar(comNavigation);
    const desproteger = c.proteger();
    c.amb.fragmento('#orcamento'); c.amb.avancar(1000);
    c.amb.janela.history.back(); c.amb.avancar(1000);
    assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [], 'sem diálogo residual'); assert.deepEqual(c.amb.roteador, []);
    c.amb.janela.history.back(); c.amb.avancar(300); // agora sai da página: aí sim pergunta
    assert.equal(c.pedidos.length, 1); assert.equal(c.amb.url(), '/editor');
    desproteger();
  });
}

test('SEM Navigation API — F3 (M-3/RV-6b): [dashboard, campanhas, editor, #orcamento] + go(-2) chega a campanhas: destino −1; Sair vai a campanhas', async () => {
  const c = await preparar(false, ['/campanhas', '/editor']);
  const desproteger = c.proteger();
  c.amb.fragmento('#orcamento'); c.amb.avancar(100);
  c.amb.janela.history.go(-2); c.amb.avancar(300);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: -1 }]);
  sair(c, desproteger);
  assert.equal(c.amb.url(), '/campanhas'); assert.deepEqual(c.amb.roteador, ['/campanhas']);
});

test('SEM Navigation API — entradas sem índice À FRENTE (fragmento de outra página): Avançar +2 volta e o destino é exatamente +2', async () => {
  const c = await preparar(false, ['/editor', '/dashboard']);
  c.amb.fragmento('#x'); // /dashboard#x, nulo, à frente
  c.amb.janela.history.go(-2); c.amb.avancar(10); // de volta ao editor, sem edição
  const desproteger = c.proteger();
  c.amb.janela.history.go(2); c.amb.avancar(400);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: 2 }]);
  sair(c, desproteger);
  assert.equal(c.amb.url(), '/dashboard#x');
});

test('SEM Navigation API — entrada sem índice de página com entradas dos dois lados e history.go sem entrada (no-op): inverte, volta e não fica presa', async () => {
  const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
  c.amb.fragmento('#x');                                   // [inicio, dashboard, editor, dashboard, dashboard#x]
  c.amb.janela.history.go(-2); c.amb.avancar(10);           // editor, sem edição
  const desproteger = c.proteger();
  c.amb.janela.history.go(2); c.amb.avancar(3000);          // dashboard#x: página com entradas dos dois lados → tenta +1 (no-op), inverte
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: 2 }]);
  c.amb.janela.history.back(); c.amb.avancar(300);          // tentativa nova funciona (nada preso)
  assert.equal(c.pedidos.length, 2); assert.equal(c.amb.url(), '/editor');
  desproteger();
});

test('SEM Navigation API — H-9: entrada INICIAL do documento sem estado (atrás de todas) de uma página que também está à frente: volta direto, sem no-op; alternar não prende; depois de salvar o histórico segue livre', async () => {
  const c = await preparar(false, ['/editor', '/dashboard'], { url: '/dashboard', state: null }); // [dashboard(nulo), editor, dashboard]
  c.amb.janela.history.back(); c.amb.avancar(10);
  assert.deepEqual(c.amb.roteador, ['/editor']);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(200);            // até a entrada inicial: volta antes do vigia (sem no-op)
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: -1 }]);
  c.amb.janela.history.forward(); c.amb.avancar(200);
  c.amb.janela.history.back(); c.amb.avancar(200);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos.map((p) => p.delta), [-1, 1, -1]);
  desproteger();                                              // salvou
  const g = (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { tentativa: unknown } }).__kidmaisGuardiaoHistorico;
  assert.equal(g.tentativa, null, 'nenhuma correção pendente');
  c.amb.janela.history.back(); c.amb.avancar(10); assert.equal(c.amb.url(), '/dashboard');
  c.amb.janela.history.forward(); c.amb.avancar(10); c.amb.janela.history.forward(); c.amb.avancar(10);
  assert.equal(c.amb.url(), '/dashboard'); assert.deepEqual(c.amb.roteador, ['/editor', '/editor', '/dashboard']);
  assert.equal(c.pedidos.length, 3);
});

for (const ms of [5, 15, 25, 35, 60, 120]) {
  test(`SEM Navigation API — F2: salvamento conclui ${ms} ms depois do Voltar (proteção cai): a volta termina no editor e o pedido é apresentado`, async () => {
    const c = await preparar(false);
    const desproteger = c.proteger();
    c.amb.janela.history.back(); c.amb.avancar(ms); desproteger(); c.amb.avancar(400);
    assert.equal(c.amb.url(), '/editor', 'URL coerente com a página (o roteador nunca saiu do editor)');
    assert.deepEqual(c.amb.roteador, []); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: -1 }]);
  });
}

test('SEM Navigation API — F2: saída explícita (liberado) durante a espera abandona a correção; a navegação escolhida vence, sem navegação dupla', async () => {
  const c = await preparar(false);
  const desproteger = c.proteger();
  c.amb.janela.history.back(); c.amb.avancar(10);
  c.liberar(); desproteger(); c.amb.janela.history.go(1); // ex.: "Salvar e sair" de outro pedido navegou
  c.amb.avancar(400);
  assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.pedidos, []);
});

test('SEM Navigation API — F2: proteção reativada DURANTE a volta (salvou e digitou de novo): herda a página do editor; o pedido vai à proteção vigente, não ao callback antigo', async () => {
  const c = await preparar(false);
  const antigo: unknown[] = [], novo: unknown[] = [];
  const d1 = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => antigo.push(d) });
  c.amb.janela.history.back(); c.amb.avancar(10);
  d1(); const d2 = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => novo.push(d) });
  c.amb.avancar(400);
  assert.equal(c.amb.url(), '/editor'); assert.equal(antigo.length, 0, 'callback antigo não é chamado'); assert.equal(novo.length, 1);
  c.amb.janela.history.back(); c.amb.avancar(400);
  assert.equal(novo.length, 2); assert.equal(antigo.length, 0); assert.equal(c.amb.url(), '/editor'); assert.deepEqual(c.amb.roteador, []);
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
  amb.registrarRoteador(); m.instalarGuardiaoDeHistorico(); // ordem invertida: entrada tardia sem o instalador no layout raiz
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
