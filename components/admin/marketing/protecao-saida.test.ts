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
  /** Todas as travessias por delta, na ordem de chamada: quem pediu, quando, de onde para onde (oráculo de ordem trocada). */
  const travessiasDelta: Array<{ quem: 'pessoa' | 'guardiao'; d: number; em: number; seq: number; at?: number; de?: number; para?: number; noop?: boolean }> = [];
  let seqT = 0;
  const ir = (alvoDe: (atual: number) => number, humano = false, d: number | null = null) => {
    const reg = d === null ? null : { quem: (humano ? 'pessoa' : 'guardiao') as 'pessoa' | 'guardiao', d, em: agora, seq: seqT++ };
    if (reg) travessiasDelta.push(reg);
    return setTimeout(() => {
      const alvo = alvoDe(i);
      const noop = alvo < 0 || alvo >= entradas.length || alvo === i;
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
    pushState(state: Estado, _: string, url?: string) { entradas.splice(i + 1); entradas.push({ url: url ?? entradas[i].url, state, key: `k${chaves++}` }); i += 1; },
    replaceState(state: Estado, _: string, url?: string) { entradas[i] = { ...entradas[i], state, url: url ?? entradas[i].url }; },
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
  return { janela, entradas, roteador, travessias, registrarRoteador, fragmento, avancar, humano, chegadasHumanas, travessiasDelta, observados, agora: () => agora, url: () => entradas[i].url, posicao: () => i };
}
let n = 0;
async function preparar(comNavigation: boolean, paginas: string[] = ['/dashboard', '/editor'], inicial?: { url: string; state: Estado }) {
  const amb = ambiente({ comNavigation, inicial });
  (globalThis as unknown as { window: unknown }).window = amb.janela;
  const m = await import(`./protecao-saida.ts?caso=${n++}`) as typeof import('./protecao-saida.ts');
  m.instalarGuardiaoDeHistorico(); amb.registrarRoteador(); // guardião ANTES do roteador (layout raiz × efeito do AppRouter)
  for (const p of paginas) amb.janela.history.pushState({ __NA: true, arvore: [p] }, '', p);
  const pedidos: Array<{ tipo: string; delta?: number; url?: string }> = [];
  const quandoPedidos: number[] = [];
  let liberado = false;
  const proteger = () => m.protegerHistorico({ liberado: () => liberado, aoTentarSair: (d) => { pedidos.push(d as never); quandoPedidos.push(amb.agora()); } });
  return { amb, m, pedidos, quandoPedidos, proteger, liberar: () => { liberado = true; } };
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

test('SEM Navigation API — entrada sem índice de página com entradas dos dois lados (H1): passo −1, que sempre existe, sem movimento sem destino; volta antes do vigia e não fica presa', async () => {
  const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
  c.amb.fragmento('#x');                                   // [inicio, dashboard, editor, dashboard, dashboard#x]
  c.amb.janela.history.go(-2); c.amb.avancar(10);           // editor, sem edição
  const desproteger = c.proteger();
  c.amb.janela.history.go(2); c.amb.avancar(300);           // dashboard#x: página dos dois lados → −1 (a entrada que o originou), depois salto
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

// ---- H1 (revisão de 30b93fb): travessia da PESSOA durante a volta ----
// Oráculo objetivo: o destino é a entrada onde a ÚLTIMA travessia da pessoa chegou de fato (posição registrada pelo
// histórico falso), não a soma dos comandos. Se ela chegou de volta à entrada do editor, não há pedido depois disso.
type Cenario = Awaited<ReturnType<typeof preparar>>;
const LAYOUTS: Array<{ nome: string; paginas: string[]; fragmento: string; voltaAoEditor: number; ida: number }> = [
  // RV-I1 da revisora: [início, Dashboard, Campanhas, editor, Campanhas, Campanhas#fim] — Campanhas dos dois lados.
  { nome: 'Dashboard→Campanhas→editor→Campanhas#fim', paginas: ['/dashboard', '/campanhas', '/editor', '/campanhas'], fragmento: '#fim', voltaAoEditor: -2, ida: 2 },
  // I-1/I-4 da revisora: [início, Dashboard, editor, Dashboard, Dashboard#x].
  { nome: 'Dashboard→editor→Dashboard#x', paginas: ['/dashboard', '/editor', '/dashboard'], fragmento: '#x', voltaAoEditor: -2, ida: 2 },
];
async function prepararLayout(l: (typeof LAYOUTS)[number]) {
  const c = await preparar(false, l.paginas);
  c.amb.fragmento(l.fragmento);
  c.amb.janela.history.go(l.voltaAoEditor); c.amb.avancar(10); // sem edição: volta ao editor normalmente
  const posEditor = c.amb.posicao(), rotas = c.amb.roteador.length;
  const desproteger = c.proteger();
  c.amb.humano(l.ida); c.amb.avancar(1); // a pessoa chega à entrada sem índice (fragmento de página com entradas dos dois lados)
  return { c, posEditor, rotas, desproteger };
}
/**
 * Oráculo de ordem trocada: as MESMAS travessias por delta, com a última da pessoa trocada de lugar com a do guardião
 * vizinha na fila — só se a troca for REALIZÁVEL na fila: a 2ª chamada foi feita antes de a 1ª ser atendida (as duas
 * estiveram juntas na fila; o atendimento pode tê-las servido em qualquer das ordens). Nenhum limiar de tempo. Se a
 * sequência VISÍVEL ao guardião (URL e índice de cada chegada) for idêntica, as duas ordens são indistinguíveis; devolve
 * onde a pessoa terminaria na outra ordem.
 */
function outraOrdem(c: Cenario, posEditor: number): { alvo: number | null } | null {
  const chamadas = c.amb.travessiasDelta.filter((x) => x.at !== undefined).slice().sort((a, b) => a.em - b.em || a.seq - b.seq);
  const k = chamadas.map((x) => x.quem).lastIndexOf('pessoa');
  const pos0 = chamadas[0]?.de ?? posEditor;
  const idxDe = (st: unknown) => ((st as Record<string, unknown> | null)?.__kidmaisIdx ?? null);
  const reproduzir = (lista: typeof chamadas) => {
    let pos = pos0; const vis: string[] = []; let fim: number | null = null;
    lista.forEach((x, j) => {
      const alvo = pos + x.d;
      if (alvo < 0 || alvo >= c.amb.entradas.length || alvo === pos) return;
      pos = alvo; vis.push(`${c.amb.entradas[pos].url}|${idxDe(c.amb.entradas[pos].state)}`); void j;
      if (x.quem === 'pessoa') fim = pos;
    });
    return { vis, fim };
  };
  const real = reproduzir(chamadas);
  for (const viz of [k - 1, k + 1]) {
    if (k < 1 || viz < 0 || viz >= chamadas.length || chamadas[viz].quem !== 'guardiao') continue;
    const [c1, c2] = viz < k ? [chamadas[viz], chamadas[k]] : [chamadas[k], chamadas[viz]];
    if (!(c2.em <= (c1.at ?? -Infinity))) continue; // a 2ª chamada só depois de a 1ª ser atendida: a troca não é realizável
    const troc = chamadas.slice(); [troc[k], troc[viz]] = [troc[viz], troc[k]];
    const alt = reproduzir(troc);
    if (JSON.stringify(alt.vis) === JSON.stringify(real.vis)) return { alvo: alt.fim };
  }
  return null;
}
/**
 * Destino observado: a entrada onde a ÚLTIMA travessia da pessoa chegou de fato. Sempre: termina no editor, roteador sem
 * nada, nenhuma correção pendente. Se a pessoa terminou no editor e a outra ordem — INDISTINGUÍVEL — a deixaria em outra
 * página, o pedido conservador com esse destino é aceito e marcado (nunca o silêncio no caso contrário).
 */
function conferirDestino(c: Cenario, posEditor: number, rotas: number, rotulo: string, conservadores?: string[]) {
  const g = (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { tentativa: unknown } }).__kidmaisGuardiaoHistorico;
  assert.equal(g.tentativa, null, `${rotulo}: nenhuma correção pendente`);
  assert.equal(c.amb.posicao(), posEditor, `${rotulo}: termina na entrada do editor (URL coerente com a página)`);
  assert.equal(c.amb.roteador.length, rotas, `${rotulo}: o roteador não recebeu nada (editor montado, edição preservada)`);
  const ultima = c.amb.chegadasHumanas.at(-1)!;
  const naPaginaDoEditor = (pos: number) => c.amb.entradas[pos].url.split('#')[0] === '/editor';
  const depois = c.pedidos.filter((_, i) => c.quandoPedidos[i] >= ultima.t);
  if (naPaginaDoEditor(ultima.pos)) {
    if (depois.length) {
      const alt = outraOrdem(c, posEditor);
      assert.ok(alt && alt.alvo !== null && !naPaginaDoEditor(alt.alvo), `${rotulo}: a pessoa voltou ao editor — pedido só se a outra ordem, indistinguível, a deixar fora dele`);
      assert.deepEqual(c.pedidos.at(-1), { tipo: 'relativo', delta: alt!.alvo! - posEditor }, `${rotulo}: pedido conservador = destino da outra ordem`);
      conservadores?.push(rotulo);
      return alt!.alvo!;
    }
    return null;
  }
  assert.ok(depois.length >= 1, `${rotulo}: pedido depois da última travessia da pessoa (nunca engolido)`);
  assert.deepEqual(c.pedidos.at(-1), { tipo: 'relativo', delta: ultima.pos - posEditor }, `${rotulo}: destino = onde a pessoa chegou`);
  return ultima.pos;
}
const ACOES = [{ nome: 'Voltar', d: -1 }, { nome: 'Avançar', d: 1 }, { nome: 'go(-3)', d: -3 }, { nome: 'go(-4)', d: -4 }, { nome: 'go(+2)', d: 2 }];
// Momentos em ms depois da chegada à entrada sem índice, INCLUINDO a janela de atendimento: os movimentos da correção
// saem em 40 e 81 ms (espera de 40 ms + 1 ms de atendimento) e a travessia da pessoa leva 1 ms — em 39 e 80 ms a dela
// ainda está na fila quando a correção pede o movimento (H1-R1/R2/R3); 40/41 e 81/82 ficam logo depois.
const MOMENTOS = [0, 5, 20, 38, 39, 40, 41, 42, 45, 60, 79, 80, 81, 82, 85, 100, 150, 900];
for (const l of LAYOUTS) {
  test(`SEM Navigation API — H1 [${l.nome}], sem nova ação: volta sem movimento sem destino e "Sair" vai ao fragmento tentado`, async () => {
    const { c, posEditor, rotas, desproteger } = await prepararLayout(l);
    c.amb.avancar(300); // bem antes do vigia de 800 ms: nenhum movimento ficou sem popstate
    const alvo = conferirDestino(c, posEditor, rotas, 'sem ação')!;
    sair(c, desproteger);
    assert.equal(c.amb.posicao(), alvo); assert.equal(c.amb.url(), `${l.paginas.at(-1)}${l.fragmento}`);
  });
  for (const a of ACOES) {
    test(`SEM Navigation API — H1 [${l.nome}]: ${a.nome} da pessoa em ${MOMENTOS.join('/')} ms durante/depois da volta → destino = onde ela chegou`, async () => {
      for (const ms of MOMENTOS) {
        const { c, posEditor, rotas, desproteger } = await prepararLayout(l);
        c.amb.avancar(ms); c.amb.humano(a.d); c.amb.avancar(3000);
        const rotulo = `${a.nome} em ${ms} ms (chegadas ${JSON.stringify(c.amb.chegadasHumanas.map((x) => x.pos))}, pedidos ${JSON.stringify(c.pedidos)})`;
        const alvo = conferirDestino(c, posEditor, rotas, rotulo);
        if (alvo === null) { desproteger(); continue; }
        sair(c, desproteger);
        assert.equal(c.amb.posicao(), alvo, `${rotulo}: "Sair" chega exatamente à entrada escolhida`);
      }
    });
  }
}

// Réplicas das provas I-1/I-4/I-5/I-6 da revisora com a ação no instante em que o guardião AINDA está fora do editor
// (20 ms: na entrada sem índice, antes do movimento; 40 ms: com o movimento da correção já na fila). As originais agiam
// em +100 ms, quando a volta já terminou. Desde a correção da rajada, a volta de Dashboard#x (cadeia conhecida) é UM salto
// exato (−2, pedido aos 41 ms): não há mais entrada intermediária — os 60 ms antigos já encontrariam a volta concluída.
for (const ms of [20, 40]) {
  test(`SEM Navigation API — H1/I-1 em ${ms} ms: Voltar da pessoa durante a volta → pedido com o destino observado (não engolido)`, async () => {
    const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
    c.amb.fragmento('#x'); c.amb.janela.history.go(-2); c.amb.avancar(10);
    const off = c.proteger();
    c.amb.humano(2); c.amb.avancar(1 + ms);
    c.amb.humano(-1); c.amb.avancar(1000);
    const alvo = conferirDestino(c, 2, 1, `I-1 em ${ms} ms`);
    if (ms === 20) assert.equal(alvo, 3, 'de #x, Voltar chega ao Dashboard logo à frente do editor: delta +1 (critério da revisora)');
    if (alvo === null) { off(); return; }
    sair(c, off); assert.equal(c.amb.posicao(), alvo);
  });
  test(`SEM Navigation API — H1/I-4 em ${ms} ms: go(-3) da pessoa durante a volta substitui o destino`, async () => {
    const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
    c.amb.fragmento('#x'); c.amb.janela.history.go(-2); c.amb.avancar(10);
    const off = c.proteger();
    c.amb.humano(2); c.amb.avancar(1 + ms);
    c.amb.humano(-3); c.amb.avancar(1000);
    const alvo = conferirDestino(c, 2, 1, `I-4 em ${ms} ms`);
    if (alvo === null) { off(); return; }
    sair(c, off); assert.equal(c.amb.posicao(), alvo);
    if (ms === 20) assert.equal(c.amb.url(), '/dashboard', 'de #x, go(-3) chega ao Dashboard anterior ao editor');
  });
  test(`SEM Navigation API — H1/I-5 em ${ms} ms: proteção reativada durante a volta → só o callback vigente recebe`, async () => {
    const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
    c.amb.fragmento('#x'); c.amb.janela.history.go(-2); c.amb.avancar(10);
    const antigos: unknown[] = [], novos: unknown[] = [];
    const off = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => antigos.push(d) });
    c.amb.humano(2); c.amb.avancar(1 + ms); off();
    const off2 = c.m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => novos.push(d) });
    c.amb.avancar(2000);
    assert.equal(c.amb.url(), '/editor'); assert.deepEqual(antigos, []); assert.deepEqual(novos, [{ tipo: 'relativo', delta: 2 }]);
    off2();
  });
  test(`SEM Navigation API — H1/I-6 em ${ms} ms: saída explícita durante a volta → nenhum retorno nem pedido tardio`, async () => {
    const c = await preparar(false, ['/dashboard', '/editor', '/dashboard']);
    c.amb.fragmento('#x'); c.amb.janela.history.go(-2); c.amb.avancar(10);
    const off = c.proteger(); c.amb.humano(2); c.amb.avancar(1 + ms);
    c.liberar(); off(); c.amb.janela.history.pushState({ __NA: true }, '', '/saida-escolhida');
    c.amb.avancar(3000);
    assert.equal(c.amb.url(), '/saida-escolhida'); assert.deepEqual(c.pedidos, []);
  });
}

// ---- Rajada (revisão de 4a5dac4, N1/N3): históricos de PÁGINAS distintas e de âncora ambígua ----
// Fixtures montadas por passos (páginas por pushState, fragmentos por âncora nativa). Sem edição, volta-se ao editor; com a
// proteção, a pessoa sai (`ida`, chegada em +1). A correção pede o 1º movimento 40 ms depois dessa chegada; em passos, o
// 2º 40 ms depois da chegada do 1º. Atendimento do histórico falso: 1 ms.
type Historico = { nome: string; passos: string[]; volta: number; ida: number };
const HISTORICOS = {
  // N1 da revisão de 4a5dac4 (Chrome, histórico B). #fim nasceu de Automações neste documento: a volta é UM salto exato.
  B: { nome: 'B [início, Dashboard, editor, Campanhas, Automações, Automações#fim]', passos: ['/dashboard', '/editor', '/campanhas', '/automacoes', '#fim'], volta: -3, ida: 3 },
  sucessivos: { nome: 'fragmentos sucessivos [início, Dashboard, editor, Campanhas, Campanhas#a, Campanhas#b]', passos: ['/dashboard', '/editor', '/campanhas', '#a', '#b'], volta: -3, ida: 3 },
  // Dois #fim de MESMA URL nascidos de entradas diferentes: a chegada a #fim não diz qual — a volta é em passos de 1.
  ambiguaFrente: { nome: 'âncora ambígua, #fim à frente [início, Dashboard, Campanhas, Campanhas#fim, editor, Campanhas, Campanhas#fim]', passos: ['/dashboard', '/campanhas', '#fim', '/editor', '/campanhas', '#fim'], volta: -2, ida: 2 },
  ambiguaTras: { nome: 'âncora ambígua, #fim atrás [o mesmo histórico; a pessoa vai ao #fim anterior ao editor]', passos: ['/dashboard', '/campanhas', '#fim', '/editor', '/campanhas', '#fim'], volta: -2, ida: -1 },
  // N1 com volta em passos: o 1º passo chega a Automações e o Voltar da pessoa, a Campanhas (páginas distintas).
  bAmbiguo: { nome: "B' em passos [início, Dashboard, Automações, Automações#fim, editor, Campanhas, Automações, Automações#fim]", passos: ['/dashboard', '/automacoes', '#fim', '/editor', '/campanhas', '/automacoes', '#fim'], volta: -3, ida: 3 },
  // A forma do B2 do Chrome (sem página antes de Automações): o salto −3 sairia do documento na outra posição → −2.
  b2: { nome: 'B2 do Chrome [início, Automações, Automações#fim, editor, Campanhas, Automações, Automações#fim]', passos: ['/automacoes', '#fim', '/editor', '/campanhas', '/automacoes', '#fim'], volta: -3, ida: 3 },
} satisfies Record<string, Historico>;
async function prepararPassos(h: Historico) {
  const c = await preparar(false, []);
  for (const x of h.passos) { if (x.startsWith('#')) c.amb.fragmento(x); else c.amb.janela.history.pushState({ __NA: true, arvore: [x] }, '', x); }
  c.amb.avancar(10);
  c.amb.janela.history.go(h.volta); c.amb.avancar(10); // sem edição: volta ao editor normalmente
  assert.equal(c.amb.url(), '/editor', `${h.nome}: preparo no editor`);
  const posEditor = c.amb.posicao(), rotas = c.amb.roteador.length;
  const desproteger = c.proteger();
  c.amb.humano(h.ida); c.amb.avancar(1);
  return { c, posEditor, rotas, desproteger };
}
/**
 * Classe de um cenário pelo oráculo independente (onde a ÚLTIMA travessia da pessoa chegou de fato; troca de ordem
 * realizável com observações iguais). Invariantes sempre: termina no editor, roteador intocado, nada pendente.
 */
function classificar(c: Cenario, posEditor: number, rotas: number, rotulo: string) {
  const g = (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { tentativa: unknown } }).__kidmaisGuardiaoHistorico;
  assert.equal(g.tentativa, null, `${rotulo}: nenhuma correção pendente`);
  assert.equal(c.amb.posicao(), posEditor, `${rotulo}: termina na entrada do editor`);
  assert.equal(c.amb.roteador.length, rotas, `${rotulo}: o roteador não recebeu nada`);
  const ultima = c.amb.chegadasHumanas.at(-1)!;
  const editor = (pos: number) => c.amb.entradas[pos].url.split('#')[0] === '/editor';
  const depois = c.pedidos.filter((_, i) => c.quandoPedidos[i] >= ultima.t);
  const pedido = depois.at(-1);
  if (editor(ultima.pos)) {
    if (!pedido) return 'OK';
    const alt = outraOrdem(c, posEditor);
    return alt && alt.alvo !== null && !editor(alt.alvo) && pedido.delta === alt.alvo - posEditor ? 'CONSERVADOR' : 'PEDIDO_INDEVIDO';
  }
  if (!pedido) return 'ENGOLIDO';
  return pedido.tipo === 'relativo' && pedido.delta === ultima.pos - posEditor ? 'OK' : 'DESTINO_ERRADO';
}
type Linha = { h: string; d: number; ms: number; classe: string; obs: string; pedidos: string; ordem: string };
async function varrer(h: Historico, acoes = [-1, 1, -2, 2, -3, -4], momentos = Array.from({ length: 131 }, (_, k) => k)) {
  const linhas: Linha[] = [];
  for (const d of acoes) for (const ms of momentos) {
    const { c, posEditor, rotas, desproteger } = await prepararPassos(h);
    c.amb.avancar(ms); c.amb.humano(d); c.amb.avancar(3000);
    const rotulo = `${h.nome} ${d > 0 ? '+' : ''}${d} em ${ms} ms`;
    const classe = classificar(c, posEditor, rotas, rotulo);
    const fim = c.amb.chegadasHumanas.at(-1)!.pos;
    const ordem = c.amb.travessiasDelta.filter((x) => x.at !== undefined).map((x) => `${x.quem[0]}${x.d > 0 ? '+' : ''}${x.d}@${x.em}→${x.at}${x.noop ? '(noop)' : `:${x.para}`}`).join(' ');
    const linha = { h: h.nome, d, ms, classe, obs: c.amb.observados.join(' '), pedidos: JSON.stringify(c.pedidos), ordem };
    if (classe === 'OK' && c.pedidos.length && fim !== posEditor && !c.amb.entradas[fim].url.startsWith('/editor')) {
      sair(c, desproteger); assert.equal(c.amb.posicao(), fim, `${rotulo}: "Sair" chega exatamente à entrada escolhida`);
    } else desproteger();
    linhas.push(linha);
  }
  return linhas;
}
const contar = (ls: Linha[]) => ls.reduce<Record<string, number>>((a, l) => ({ ...a, [l.classe]: (a[l.classe] ?? 0) + 1 }), {});

for (const chave of ['B', 'sucessivos'] as const) {
  test(`SEM Navigation API — rajada [${HISTORICOS[chave].nome}]: 6 gestos × 0–130 ms → só OK ou CONSERVADOR (nunca destino de outra página, engolido ou incoerente)`, async (t) => {
    const ls = await varrer(HISTORICOS[chave]);
    t.diagnostic(JSON.stringify(contar(ls)));
    const ruins = ls.filter((l) => l.classe !== 'OK' && l.classe !== 'CONSERVADOR');
    assert.deepEqual(ruins.map((l) => `${l.d}@${l.ms} ${l.classe} ${l.ordem}`), [], JSON.stringify(contar(ls)));
  });
}
test('SEM Navigation API — N1 (histórico B): Voltar logo DEPOIS do movimento da correção → destino onde a pessoa chegou, nunca Automações', async () => {
  for (const ms of [40, 41, 42, 45, 49, 53]) { // a correção pede o salto aos 41 (40 ms após a chegada a #fim) e chega ao editor aos 42
    const { c, posEditor, rotas, desproteger } = await prepararPassos(HISTORICOS.B);
    c.amb.avancar(ms); c.amb.humano(-1); c.amb.avancar(3000);
    assert.equal(classificar(c, posEditor, rotas, `N1 ${ms}`), 'OK', `${ms} ms: ${JSON.stringify(c.pedidos)}`);
    assert.notEqual(c.amb.entradas[posEditor + c.pedidos.at(-1)!.delta!].url, '/automacoes', `${ms} ms`);
    desproteger();
  }
});
test("SEM Navigation API — N1 com âncora ambígua (B'): a volta de Automações#fim (dois de mesma URL) é um salto ≥ 2 seguro nas duas posições, nunca um passo do tamanho de um Voltar; Voltar antes, junto ou depois do pedido → destino onde a pessoa chegou", async () => {
  for (const ms of [38, 39, 40, 41, 42, 45, 53, 60, 79]) { // a correção pede o movimento aos 41
    const { c, posEditor, rotas, desproteger } = await prepararPassos(HISTORICOS.bAmbiguo);
    c.amb.avancar(ms); c.amb.humano(-1); c.amb.avancar(3000);
    const g1 = c.amb.travessiasDelta.find((x) => x.quem === 'guardiao' && x.em > 30);
    assert.ok(g1 && Math.abs(g1.d) >= 2, `${ms} ms: o 1º movimento da correção não é passo de 1 (${g1?.d})`);
    assert.equal(classificar(c, posEditor, rotas, `N1 âncora ambígua ${ms}`), 'OK', `${ms} ms: ${JSON.stringify(c.pedidos)}`);
    const alvo = c.amb.chegadasHumanas.at(-1)!.pos;
    sair(c, desproteger); assert.equal(c.amb.posicao(), alvo);
  }
});
test('SEM Navigation API — âncora ambígua e passos: sem engolido nem incoerente; PEDIDO_INDEVIDO só com a pessoa terminando no editor; DESTINO_ERRADO só onde OUTRO cenário realizável produz as MESMAS observações e exige a resposta dada', async (t) => {
  const pool: Linha[] = [];
  for (const chave of ['ambiguaFrente', 'ambiguaTras', 'bAmbiguo', 'b2'] as const) pool.push(...await varrer(HISTORICOS[chave]));
  const resumo = JSON.stringify(Object.fromEntries((['ambiguaFrente', 'ambiguaTras', 'bAmbiguo', 'b2'] as const).map((k) => [k, contar(pool.filter((l) => l.h === HISTORICOS[k].nome))])));
  for (const l of pool) {
    const rot = `${l.h} ${l.d}@${l.ms} (${l.ordem})`;
    assert.ok(['OK', 'CONSERVADOR', 'PEDIDO_INDEVIDO', 'DESTINO_ERRADO'].includes(l.classe), `${rot}: ${l.classe}`);
    if (l.classe === 'PEDIDO_INDEVIDO') {
      // A pessoa terminou no editor e houve pergunta (relativa): nunca destino inventado fora do histórico.
      const obs = l.obs.split(' '), ped = JSON.parse(l.pedidos).at(-1);
      assert.match(obs.at(-1)!, /^\/editor\|/, `${rot}: termina com a chegada ao editor`);
      assert.ok(ped && ped.tipo === 'relativo', `${rot}: pedido relativo`);
    }
    if (l.classe === 'DESTINO_ERRADO') {
      const gemeo = pool.find((x) => x !== l && x.classe === 'OK' && x.obs === l.obs && x.pedidos === l.pedidos);
      assert.ok(gemeo, `${rot}: DESTINO_ERRADO sem cenário gêmeo de observações iguais`);
    }
  }
  // Destino trocado só quando a travessia da pessoa já estava na fila ANTES do pedido da correção (a ambiguidade real,
  // largura = atendimento), nunca depois dele.
  const erros = pool.filter((l) => l.classe === 'DESTINO_ERRADO');
  t.diagnostic(resumo); for (const l of erros) t.diagnostic(`${l.h} ${l.d}@${l.ms}: ${l.ordem}`);
  for (const l of pool.filter((x) => x.classe === 'CONSERVADOR' || x.classe === 'PEDIDO_INDEVIDO')) t.diagnostic(`${l.classe} ${l.h.slice(0, 30)} ${l.d}@${l.ms}: ${l.ordem}`);
  assert.ok(erros.length <= 3 && pool.filter((l) => l.classe === 'PEDIDO_INDEVIDO').length <= 2, resumo);
});

// ---- H1-R1/R2/R3 e O-2 (revisão de f37a965): histórico da RV-I1 [0 início, 1 Dashboard, 2 Campanhas, 3 editor,
// 4 Campanhas, 5 Campanhas#fim (nulo)]. A pessoa vai a #fim (chegada em +1); a correção pede o salto exato go(−2) aos 41 ms
// (atendido aos 42) — #fim nasceu de Campanhas(4) neste documento, cadeia conhecida. "Antes" = a travessia da pessoa já
// está na fila quando a correção pede o movimento (atendida antes dele); "depois" = pedida depois dele.
async function janelaRvI1() {
  const r = await prepararLayout(LAYOUTS[0]);
  assert.equal(r.posEditor, 3);
  return r;
}
test('SEM Navigation API — H1-R1, a pessoa ANTES: go(−3) chega a Campanhas(2); o passo −1 da correção só poderia chegar a Campanhas(4) → destino Campanhas(2), não Dashboard', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  c.amb.avancar(39); c.amb.humano(-3); c.amb.avancar(3000);
  assert.deepEqual(c.amb.chegadasHumanas.map((x) => x.pos), [5, 2]);
  assert.equal(conferirDestino(c, posEditor, rotas, 'R1 antes'), 2);
  sair(c, desproteger); assert.equal(c.amb.posicao(), 2); assert.equal(c.amb.url(), '/campanhas');
});
test('SEM Navigation API — H1-R1, a pessoa DEPOIS (mesmo go(−3) logo depois do pedido do salto): parte do editor e chega ao início(0) → destino início', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  c.amb.avancar(40); c.amb.humano(-3); c.amb.avancar(3000);
  assert.deepEqual(c.amb.chegadasHumanas.map((x) => x.pos), [5, 0]);
  assert.equal(conferirDestino(c, posEditor, rotas, 'R1 depois'), 0);
  sair(c, desproteger); assert.equal(c.amb.url(), '/inicio');
});
test('SEM Navigation API — H1-R2: a pessoa chega à 1ª entrada da aba e o passo −1 já pedido vira no-op → a volta NÃO é abandonada: editor, URL coerente, pedido para lá', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  c.amb.avancar(39); c.amb.humano(-5); c.amb.avancar(200); // bem antes do vigia: o no-op é certo (nada antes da 1ª entrada)
  assert.deepEqual(c.amb.chegadasHumanas.map((x) => x.pos), [5, 0]);
  assert.equal(conferirDestino(c, posEditor, rotas, 'R2'), 0);
  sair(c, desproteger); assert.equal(c.amb.posicao(), 0);
});
test('SEM Navigation API — H1-R2 sem saber que é a 1ª entrada: o movimento sem destino é detectado pela salvaguarda e a volta é replanejada (não encerrada fora do editor)', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  const g = (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { instalacao: { primeira: boolean } } }).__kidmaisGuardiaoHistorico;
  g.instalacao.primeira = false; // como se houvesse entradas de outro documento antes (o no-op deixa de ser certo)
  c.amb.avancar(39); c.amb.humano(-5); c.amb.avancar(3000);
  assert.equal(conferirDestino(c, posEditor, rotas, 'R2 com vigia'), 0);
  desproteger();
});
test('SEM Navigation API — H1-R3, a pessoa ANTES: Voltar chega a Campanhas(4) e o passo da correção leva ao editor → pedido para Campanhas(4) (não engolido)', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  c.amb.avancar(39); c.amb.humano(-1); c.amb.avancar(3000);
  assert.deepEqual(c.amb.chegadasHumanas.map((x) => x.pos), [5, 4], 'a pessoa chegou a Campanhas(4)');
  assert.equal(conferirDestino(c, posEditor, rotas, 'R3 antes'), 4);
  sair(c, desproteger); assert.equal(c.amb.posicao(), 4);
});
test('SEM Navigation API — H1-R3, a pessoa DEPOIS do pedido do salto: o salto a leva ao editor e o Voltar dela sai de novo → destino Campanhas(2), observado', async () => {
  const { c, posEditor, rotas, desproteger } = await janelaRvI1();
  c.amb.avancar(40); c.amb.humano(-1); c.amb.avancar(3000);
  assert.deepEqual(c.amb.chegadasHumanas.map((x) => x.pos), [5, 2]);
  assert.equal(conferirDestino(c, posEditor, rotas, 'R3 depois'), 2);
  sair(c, desproteger); assert.equal(c.amb.posicao(), 2);
});
test('SEM Navigation API — H1-R3, par "passo da correção → editor" (âncora ambígua, #fim atrás): Avançar da pessoa junto do último passo → pergunta pelo destino da outra ordem (troca realizável), nunca o silêncio; Avançar depois de um passo que não podia levar ao editor → nenhum pedido', async () => {
  // A correção aposta para trás (salto −2 até o Dashboard), volta +2 até o #fim vizinho do editor (aos 103) e dá o passo
  // +1 final aos 143 (atendido aos 144). Avançar da pessoa pedido aos 142 (junto do passo) e aos 102 (logo depois da
  // chegada intermediária: o salto +2 a partir do Dashboard só podia chegar ao #fim, não ao editor — a chegada é dela).
  for (const [ms, classe, pedido] of [[121, 'CONSERVADOR', { tipo: 'relativo', delta: 1 }], [81, 'OK', null]] as const) {
    const { c, posEditor, rotas, desproteger } = await prepararPassos(HISTORICOS.ambiguaTras);
    c.amb.avancar(ms); c.amb.humano(1); c.amb.avancar(3000);
    const ultima = c.amb.chegadasHumanas.at(-1)!;
    assert.equal(ultima.pos, posEditor, `${ms} ms: a pessoa terminou no editor`);
    assert.equal(classificar(c, posEditor, rotas, `R3 par ${ms}`), classe);
    const depois = c.pedidos.filter((_, k) => c.quandoPedidos[k] >= ultima.t);
    assert.deepEqual(depois.at(-1) ?? null, pedido, `${ms} ms: 121 → Campanhas(5), o destino da outra ordem; 81 → nada`);
    desproteger();
  }
});
test('SEM Navigation API — O-2: "Sair" pelo hook DURANTE a volta (movimento da correção já na fila) → a saída espera chegar ao editor e segue dali; nenhum movimento depois dela', async () => {
  const { c, desproteger } = await janelaRvI1();
  c.amb.avancar(40); // a correção acabou de pedir go(−1)
  let posNaSaida = -1;
  c.liberar();
  c.m.executarSaida(() => { posNaSaida = c.amb.posicao(); desproteger(); c.amb.janela.history.pushState({ __NA: true }, '', '/saida-escolhida'); });
  const n = c.amb.travessiasDelta.length;
  c.amb.avancar(3000);
  assert.equal(posNaSaida, 3, 'a saída parte da entrada do editor (o destino relativo foi medido de lá)');
  assert.equal(c.amb.url(), '/saida-escolhida'); assert.deepEqual(c.pedidos, []);
  assert.ok(c.amb.travessiasDelta.slice(n).every((x) => (x.at ?? 0) <= c.amb.agora()) && c.amb.posicao() === c.amb.entradas.length - 1, 'nada depois da saída');
});
test('SEM Navigation API — O-2 direto (saída fora do hook com um movimento antigo na fila): o movimento antigo é desfeito e a URL termina na saída escolhida', async () => {
  const { c, desproteger } = await janelaRvI1();
  c.amb.avancar(40);
  c.liberar(); desproteger(); c.amb.janela.history.pushState({ __NA: true }, '', '/saida-escolhida');
  c.amb.avancar(3000);
  assert.equal(c.amb.url(), '/saida-escolhida'); assert.deepEqual(c.pedidos, []);
  const g = (c.amb.janela as unknown as { __kidmaisGuardiaoHistorico: { tentativa: unknown } }).__kidmaisGuardiaoHistorico;
  assert.equal(g.tentativa, null);
});

test('SEM Navigation API — representação: entrada criada a partir de posição incerta não duplica índice; a volta usa passos e não passa do editor', async () => {
  const c = await preparar(false, ['/a', '/b', '/c']);       // [início, a1, b2, c3]
  c.amb.fragmento('#f');                                     // c#f (nova: o comprimento muda)
  c.amb.janela.history.go(-3); c.amb.avancar(10);            // a1
  c.amb.janela.history.go(3); c.amb.avancar(10);             // c#f por TRAVESSIA: posição incerta
  c.amb.janela.history.pushState({ __NA: true }, '', '/d');  // [início, a1, b2, c3, c#f, d]
  const estado = c.amb.janela.history.state as Record<string, unknown>;
  assert.equal(estado.__kidmaisIdx, 4, 'índice único (antes: 2, igual ao de /b)');
  c.amb.janela.history.go(-2); c.amb.avancar(10);            // c3 = editor
  const off = c.proteger();
  c.amb.humano(2); c.amb.avancar(1000);                      // a pessoa vai a /d
  assert.equal(c.amb.url(), '/c'); assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: 2 }]);
  sair(c, off); assert.equal(c.amb.url(), '/d');
});

test('SEM Navigation API — salvaguarda: índices duplicados herdados (premissa quebrada) → o salto sem destino não entra no deslocamento; passos; termina no editor', async () => {
  const c = await preparar(false, ['/a', '/b', '/editor', '/c']);   // [início, a1, b2, editor3, c4]
  c.amb.entradas[4].state = { __NA: true, __kidmaisIdx: 1 };          // estado herdado de versão anterior: c com índice 1 (como a)
  c.amb.janela.history.go(-1); c.amb.avancar(10);                    // editor
  const off = c.proteger();
  c.amb.humano(1); c.amb.avancar(5000);                              // a pessoa vai a c; salto 3−1=+2 não tem destino
  assert.equal(c.amb.url(), '/editor', 'termina no editor');
  assert.deepEqual(c.pedidos, [{ tipo: 'relativo', delta: 1 }], 'o salto sem popstate não foi contado');
  sair(c, off); assert.equal(c.amb.url(), '/c');
});
