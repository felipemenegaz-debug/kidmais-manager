import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * Guardião do histórico (R-H1/R-H1-F, 16/10/2026) — testes COMPORTAMENTAIS sem navegador: janela e histórico falsos com a
 * semântica que importa (ouvintes de popstate na ORDEM DE REGISTRO, stopImmediatePropagation, travessias assíncronas,
 * Navigation API opcional) e um "roteador" que, como o App Router, registra o popstate DEPOIS do guardião e navega no
 * que recebe. As provas em navegador (Chrome + Next real + AdminShell real) ficam no pacote de revisão.
 */
type Estado = Record<string, unknown> | null;
type Ouvinte = { tipo: string; f: (e: { state: Estado; stopImmediatePropagation(): void }) => void };

function ambiente({ comNavigation }: { comNavigation: boolean }) {
  const ouvintes: Ouvinte[] = [];
  const entradas: Array<{ url: string; state: Estado; key: string }> = [{ url: '/inicio', state: { __NA: true, arvore: ['inicio'] }, key: 'k0' }];
  let i = 0, chaves = 1;
  const disparar = () => {
    let parar = false;
    const e = { state: entradas[i].state, stopImmediatePropagation() { parar = true; } };
    for (const o of [...ouvintes]) { if (o.tipo !== 'popstate') continue; o.f(e); if (parar) break; }
  };
  const ir = (destino: (atual: number) => number) => setTimeout(() => { const alvo = Math.max(0, Math.min(entradas.length - 1, destino(i))); if (alvo === i) return; i = alvo; disparar(); }, 0);
  const history = {
    get state() { return entradas[i].state; },
    get length() { return entradas.length; },
    pushState(state: Estado, _: string, url?: string) { entradas.splice(i + 1); entradas.push({ url: url ?? entradas[i].url, state, key: `k${chaves++}` }); i += 1; },
    replaceState(state: Estado, _: string, url?: string) { entradas[i] = { ...entradas[i], state, url: url ?? entradas[i].url }; },
    go(d: number) { ir((atual) => atual + d); }, back() { this.go(-1); }, forward() { this.go(1); },
  };
  const travessias: string[] = [];
  const navigation = comNavigation ? {
    get currentEntry() { return { key: entradas[i].key, url: entradas[i].url, index: i }; },
    traverseTo(chave: string) { travessias.push(chave); const alvo = entradas.findIndex((x) => x.key === chave); ir(() => alvo); return { committed: Promise.resolve(), finished: Promise.resolve() }; },
  } : undefined;
  const janela = {
    history, navigation, setTimeout, clearTimeout,
    addEventListener(tipo: string, f: Ouvinte['f']) { ouvintes.push({ tipo, f }); },
    removeEventListener(tipo: string, f: Ouvinte['f']) { const k = ouvintes.findIndex((o) => o.tipo === tipo && o.f === f); if (k >= 0) ouvintes.splice(k, 1); },
  };
  const roteador: string[] = [];
  const registrarRoteador = () => janela.addEventListener('popstate', () => { roteador.push(entradas[i].url); });
  return { janela, entradas, roteador, travessias, registrarRoteador, posicao: () => i, url: () => entradas[i].url };
}
const esperar = (ms = 120) => new Promise((r) => setTimeout(r, ms));
let n = 0;
async function carregar(amb: ReturnType<typeof ambiente>) {
  (globalThis as unknown as { window: unknown }).window = amb.janela;
  return import(`./protecao-saida.ts?caso=${n++}`) as Promise<typeof import('./protecao-saida.ts')>;
}

for (const comNavigation of [false, true]) {
  const modo = comNavigation ? 'COM Navigation API' : 'SEM Navigation API';

  test(`${modo}: dois Voltar com o editor protegido — o roteador não recebe nada, volta ao editor, pedido com o destino; Sair vai ao destino`, async () => {
    const amb = ambiente({ comNavigation });
    const m = await carregar(amb);
    m.instalarGuardiaoDeHistorico(); amb.registrarRoteador(); // guardião ANTES do roteador (layout raiz × efeito do AppRouter)
    amb.janela.history.pushState({ __NA: true, arvore: ['dashboard'] }, '', '/dashboard');
    amb.janela.history.pushState({ __NA: true, arvore: ['editor'] }, '', '/editor');
    const pedidos: unknown[] = []; let liberado = false;
    const desproteger = m.protegerHistorico({ liberado: () => liberado, aoTentarSair: (d) => pedidos.push(d) });
    const tamanho = amb.entradas.length;
    amb.janela.history.back(); amb.janela.history.back();
    await esperar();
    assert.deepEqual(amb.roteador, [], 'o roteador não pode navegar enquanto há edição');
    assert.equal(amb.url(), '/editor');
    assert.equal(amb.entradas.length, tamanho, 'histórico não cresce');
    const ultimo = pedidos.at(-1) as { tipo: string; delta?: number; url?: string };
    if (comNavigation) { assert.equal(ultimo.tipo, 'historico'); assert.equal(ultimo.url, '/inicio'); assert.ok(amb.travessias.length > 0); }
    else assert.deepEqual(ultimo, { tipo: 'relativo', delta: -2 });
    // Sair (descartar ou salvo com sucesso): libera e vai ao destino pedido; agora o roteador recebe.
    liberado = true; desproteger();
    if (comNavigation) amb.janela.navigation!.traverseTo(amb.entradas[0].key); else amb.janela.history.go(-2);
    await esperar();
    assert.deepEqual(amb.roteador, ['/inicio']);
  });

  test(`${modo}: Avançar e history.go(-2) também voltam ao editor; sem proteção, Voltar/Avançar seguem direto ao roteador`, async () => {
    const amb = ambiente({ comNavigation });
    const m = await carregar(amb);
    m.instalarGuardiaoDeHistorico(); amb.registrarRoteador();
    for (const u of ['/a', '/b', '/editor', '/depois']) amb.janela.history.pushState({ __NA: true, arvore: [u] }, '', u);
    amb.janela.history.back(); await esperar(); // sem proteção: o roteador recebe (vai a /editor)
    assert.deepEqual(amb.roteador, ['/editor']);
    const pedidos: Array<{ tipo: string; delta?: number }> = [];
    const desproteger = m.protegerHistorico({ liberado: () => false, aoTentarSair: (d) => pedidos.push(d as { tipo: string; delta?: number }) });
    amb.janela.history.forward(); await esperar();
    assert.equal(amb.url(), '/editor'); assert.deepEqual(amb.roteador, ['/editor']);
    amb.janela.history.go(-2); await esperar();
    assert.equal(amb.url(), '/editor'); assert.deepEqual(amb.roteador, ['/editor']);
    if (!comNavigation) assert.deepEqual(pedidos.map((p) => p.delta), [1, -2]);
    desproteger();
    amb.janela.history.back(); await esperar();
    assert.deepEqual(amb.roteador, ['/editor', '/b'], 'sem proteção de novo, um Voltar basta');
  });
}

test('SEM Navigation API: o índice preserva os campos do roteador (__NA, árvore) e não transforma estado nulo em objeto', async () => {
  const amb = ambiente({ comNavigation: false });
  const m = await carregar(amb);
  m.instalarGuardiaoDeHistorico();
  amb.janela.history.pushState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['x'] }, '', '/x');
  assert.deepEqual(amb.janela.history.state, { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['x'], __kidmaisIdx: 1 });
  amb.janela.history.replaceState({ __NA: true, outra: 1 }, '', '/x');
  assert.deepEqual(amb.janela.history.state, { __NA: true, outra: 1, __kidmaisIdx: 1 });
  amb.janela.history.pushState(null, '', '/nulo');
  assert.equal(amb.janela.history.state, null);
});

test('risco demonstrado: guardião instalado DEPOIS do roteador não impede a navegação (por isso fica no layout raiz)', async () => {
  const amb = ambiente({ comNavigation: true });
  const m = await carregar(amb);
  amb.registrarRoteador(); m.instalarGuardiaoDeHistorico(); // ordem invertida: entrada tardia sem o instalador no layout raiz
  amb.janela.history.pushState({ __NA: true }, '', '/editor');
  m.protegerHistorico({ liberado: () => false, aoTentarSair: () => undefined });
  amb.janela.history.back(); await esperar();
  assert.deepEqual(amb.roteador.slice(0, 1), ['/inicio'], 'o roteador registrado antes recebeu a saída');
});

test('layout raiz instala o guardião (componente cliente avaliado na hidratação de qualquer documento)', () => {
  const ler = (f: string) => fs.readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
  const layout = ler('app/layout.tsx');
  assert.match(layout, /import InstalarGuardiaoHistorico from "@\/components\/InstalarGuardiaoHistorico";/);
  assert.match(layout, /<body[^>]*><InstalarGuardiaoHistorico \/>\{children\}<\/body>/);
  assert.match(ler('components/InstalarGuardiaoHistorico.tsx'), /^instalarGuardiaoDeHistorico\(\);$/m);
});
