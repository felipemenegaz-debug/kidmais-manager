'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Para onde a pessoa tentou ir com alterações não salvas: um link interno, uma entrada do histórico pela chave
 * (Navigation API) ou pelo deslocamento REAL medido a partir da entrada do editor (sem Navigation API).
 */
export type DestinoSaida = { tipo: 'link'; href: string } | { tipo: 'historico'; chave: string; url: string } | { tipo: 'relativo'; delta: number };

type EntradaNavegacao = { key: string; url: string | null; index: number };
type NavegacaoApi = { currentEntry: EntradaNavegacao | null; traverseTo(chave: string): { committed?: Promise<unknown>; finished?: Promise<unknown> } };
/** Navigation API utilizável (currentEntry + traverseTo); sem ela, o guardião usa o índice próprio do histórico. */
function navegacaoApi(): NavegacaoApi | null {
  if (typeof window === 'undefined') return null;
  const n = (window as unknown as { navigation?: NavegacaoApi }).navigation;
  return n && typeof n.traverseTo === 'function' && n.currentEntry ? n : null;
}
/** traverseTo devolve promessas que rejeitam quando outra travessia a substitui (AbortError): esperado, não é erro. */
function irPara(nav: NavegacaoApi, chave: string) {
  const r = nav.traverseTo(chave);
  r?.committed?.catch(() => undefined); r?.finished?.catch(() => undefined);
}
/** A "página" de uma URL para a proteção: caminho + busca (o fragmento não muda a página nem a árvore do roteador). */
function paginaDe(url: string | null | undefined) {
  const u = new URL(url ?? window.location.href, window.location.href);
  return `${u.pathname}${u.search}`;
}

/**
 * Proteção ativa (um editor por vez): a página do editor, a entrada que o representa (chave com Navigation API; índice
 * da entrada INDEXADA do editor sem ela — mesmo quando a proteção começa numa entrada de fragmento com estado nulo) e
 * como avisar o editor.
 */
type Ativa = { pagina: string; chave: string | null; indice: number | null; liberado: () => boolean; temPedido: () => boolean; aoTentarSair: (d: DestinoSaida) => void };
/**
 * O que se sabe de uma entrada do histórico, SEM Navigation API (nada disso vai para o estado da entrada):
 *  - `idx`: o índice próprio (`__kidmaisIdx`), ou nulo;
 *  - `ancora`: a entrada indexada que a originou (a própria, se indexada; para um fragmento, a de onde ele nasceu);
 *  - `anterior`: a entrada imediatamente anterior, quando conhecida — um fragmento criado neste documento nasce logo depois
 *    da entrada em que a pessoa estava (indexada: `{ idx }`; outro fragmento: `{ url }`).
 */
type Anterior = { idx: number } | { url: string } | null;
type Pos = { idx: number | null; url: string; pagina: string; ancora: number | null; anterior: Anterior; inicial: boolean;
  /** Fragmentos com a MESMA URL criados de entradas diferentes: a posição é uma destas (todas registradas). */
  candidatos?: Array<{ anterior: Anterior; ancora: number | null }> };
/**
 * Uma tentativa de saída interceptada SEM Navigation API, do primeiro popstate barrado até a volta à entrada do editor.
 * Pertence à proteção que a interceptou e termina sempre na entrada do editor (com o pedido, ou com a saída explícita
 * que esperou por ela); nunca abandonada fora dela enquanto o editor estiver montado.
 */
type Tentativa = {
  a: Ativa;
  deslocamento: number;        // soma dos NOSSOS movimentos desde a entrada de destino (cada um confirmado pelo próprio popstate)
  emVoo: number | null;        // movimento pedido (history.go) ainda sem popstate
  origem: Pos | null;          // de onde o movimento em voo será resolvido (muda se uma travessia da pessoa for atendida antes)
  ultimo: { mov: number; chegada: Pos } | null; // último movimento nosso confirmado, antes do próximo pedido
  direcao: -1 | 1 | 0;         // passo quando a entrada atual não tem índice; 0 = ainda desconhecida (chegada da pessoa)
  inverteu: number;            // inversões da salvaguarda
  timer: number | null;        // espera para travessias seguidas assentarem
  vigia: number | null;        // salvaguarda: movimento sem popstate
  saida: (() => void) | null;  // saída explícita pedida durante a volta: segue quando a volta chegar ao editor
  compensando: boolean;        // movimento antigo atendido depois de uma saída explícita direta, sendo desfeito
};
/**
 * `inicial`: a entrada em que o documento começou, quando ela não tem índice (estado nulo antes da hidratação, ou não
 * objeto). Ela fica ATRÁS de todas as indexadas deste documento — dado que orienta a direção para uma entrada sem índice.
 * `maior`: maior índice já dado. `incerto`: a entrada atual é sem índice e a indexada que a precede é desconhecida.
 * `contiguo`: os índices não têm lacunas ao longo do histórico (um salto de k−j nunca passa da entrada k); deixa de valer se
 * uma entrada for criada a partir de uma posição incerta. `comprimento`: último history.length visto (distingue fragmento
 * NOVO, que muda o comprimento, de travessia). `atual`: o que se sabe da entrada atual. `fragmentos`: entradas sem índice
 * criadas neste documento, com a anterior e a âncora. `instalacao`: a entrada em que o guardião foi instalado e se ela é a
 * primeira do histórico da aba (history.length 1) — nada existe antes dela.
 */
type Guardiao = {
  instalado: boolean; ativa: Ativa | null; indiceAtual: number; maior: number; incerto: boolean; contiguo: boolean; comprimento: number;
  paginas: Map<number, string>; inicial: { indice: number; pagina: string; url: string } | null; tentativa: Tentativa | null;
  atual: Pos | null; fragmentos: Array<{ url: string; anterior: Anterior; ancora: number | null }>;
  instalacao: { idx: number | null; url: string; primeira: boolean } | null;
};
/** Estado único por janela (Strict Mode e Fast Refresh reavaliam o módulo; o guardião e o índice são um só). */
function guardiao(): Guardiao {
  const w = window as unknown as { __kidmaisGuardiaoHistorico?: Guardiao };
  return (w.__kidmaisGuardiaoHistorico ??= {
    instalado: false, ativa: null, indiceAtual: 0, maior: 0, incerto: false, contiguo: true, comprimento: 0, paginas: new Map(), inicial: null,
    tentativa: null, atual: null, fragmentos: [], instalacao: null,
  });
}

// ---- Índice próprio do histórico (só SEM Navigation API) ----
// Cada entrada criada por pushState recebe __kidmaisIdx; replaceState mantém o índice da entrada atual. Só OBJETOS SIMPLES
// recebem o campo — copiados, com os campos existentes (inclusive os internos do Next: __NA, árvore) PRESERVADOS. Estado
// nulo continua nulo (o Next ignora popstate nulo e recarrega objeto sem __NA); arrays/instâncias ficam como estão.
// Entradas SEM índice existem (fragmentos de âncora, location.hash, replaceState(null)) e podem estar ATRÁS, À FRENTE ou ser
// a própria entrada onde a edição começou: o índice dá ORDEM (monótono ao longo do histórico) e um limite inferior de
// distância, nunca a posição exata — o retorno mede os próprios movimentos.
const CAMPO_INDICE = '__kidmaisIdx';
const indiceDe = (estado: unknown): number | null => {
  const v = (estado as Record<string, unknown> | null)?.[CAMPO_INDICE];
  return typeof v === 'number' ? v : null;
};
const objetoSimples = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const comIndice = (estado: unknown, indice: number) => (objetoSimples(estado) ? { ...estado, [CAMPO_INDICE]: indice } : estado);
/** Espera curta para várias travessias seguidas (vários Voltar, history.go) assentarem antes de um retorno. */
const ASSENTAR_MS = 40;
/** Salvaguarda: sem popstate depois de um history.go, ele não tinha destino (no-op). */
const VIGIA_MS = 800;

function posicaoAtual(g: Guardiao, idx: number | null): Pos {
  const url = window.location.href, pagina = paginaDe(url);
  if (idx !== null) return { idx, url, pagina, ancora: idx, anterior: null, inicial: false };
  const inicial = naInicial(g, url);
  if (inicial) return { idx: null, url, pagina, ancora: null, anterior: null, inicial };
  // Travessia até uma entrada sem índice: identificada pelos fragmentos criados neste documento com a MESMA URL, se todos
  // concordarem sobre a anterior e a âncora (senão, posição desconhecida).
  const mesmos = g.fragmentos.filter((f) => f.url === url);
  const um = mesmos[0];
  if (um && mesmos.every((f) => f.ancora === um.ancora && JSON.stringify(f.anterior) === JSON.stringify(um.anterior))) {
    return { idx: null, url, pagina, ancora: um.ancora, anterior: um.anterior, inicial };
  }
  return { idx: null, url, pagina, ancora: null, anterior: null, inicial, candidatos: mesmos.length ? mesmos.map((f) => ({ anterior: f.anterior, ancora: f.ancora })) : undefined };
}
function definirAtual(g: Guardiao, p: Pos) {
  g.atual = p;
  if (p.ancora !== null) { g.indiceAtual = p.ancora; g.incerto = false; }
  else if (p.inicial && g.inicial) { g.indiceAtual = g.inicial.indice; g.incerto = false; } // a entrada nova nasce depois da inicial
  else g.incerto = p.idx === null;
}

function instalarIndiceDoHistorico(g: Guardiao) {
  const empilhar = window.history.pushState.bind(window.history);
  const substituir = window.history.replaceState.bind(window.history);
  const existente = indiceDe(window.history.state);
  if (existente !== null) g.indiceAtual = existente; // recarregou: a posição continua no estado da entrada
  else if (objetoSimples(window.history.state)) substituir(comIndice(window.history.state, g.indiceAtual), '');
  g.maior = g.indiceAtual;
  g.comprimento = window.history.length;
  if (indiceDe(window.history.state) !== null) g.paginas.set(g.indiceAtual, paginaDe(window.location.href));
  else g.inicial = { indice: g.indiceAtual, pagina: paginaDe(window.location.href), url: window.location.href };
  g.instalacao = { idx: indiceDe(window.history.state), url: window.location.href, primeira: window.history.length === 1 };
  definirAtual(g, posicaoAtual(g, indiceDe(window.history.state)));
  window.history.pushState = function pushState(dados: unknown, _nao: string, url?: string | URL | null) {
    if (g.incerto) {
      // A entrada indexada que precede a atual é desconhecida: o índice novo é único e maior que todos os anteriores (a
      // ordem continua valendo), mas pode deixar lacuna — os saltos dão lugar a passos.
      g.indiceAtual = g.maior + 1; g.contiguo = false;
    } else {
      const ancora = g.indiceAtual;
      g.indiceAtual += 1;
      for (const i of [...g.paginas.keys()]) if (i >= g.indiceAtual) g.paginas.delete(i); // entradas à frente foram descartadas
      if (g.atual) podarDepois(g, g.atual);
      else g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && f.ancora <= ancora);
    }
    g.maior = Math.max(g.maior, g.indiceAtual); g.incerto = false;
    const r = empilhar(comIndice(dados, g.indiceAtual), _nao, url);
    g.comprimento = window.history.length;
    if (indiceDe(window.history.state) !== null) g.paginas.set(g.indiceAtual, paginaDe(window.location.href));
    g.atual = { idx: indiceDe(window.history.state), url: window.location.href, pagina: paginaDe(window.location.href), ancora: g.indiceAtual, anterior: null, inicial: false };
    return r;
  };
  window.history.replaceState = function replaceState(dados: unknown, _nao: string, url?: string | URL | null) {
    // Mantém o índice da entrada; numa entrada sem índice de posição incerta não há índice certo a dar (não inventa um).
    const indice = indiceDe(window.history.state) ?? (g.incerto ? null : g.indiceAtual);
    const eraInicial = naInicial(g);
    const r = substituir(indice === null ? dados : comIndice(dados, indice), _nao, url);
    if (indice !== null && indiceDe(window.history.state) !== null) {
      g.paginas.set(indice, paginaDe(window.location.href));
      if (g.inicial?.indice === indice) g.inicial = null; // a entrada inicial ganhou índice (ex.: hidratação do Next)
      if (g.instalacao && eraInicial) g.instalacao = { ...g.instalacao, idx: indice, url: window.location.href };
    } else if (eraInicial && window.history.state === null) {
      g.inicial = { indice: g.inicial!.indice, pagina: paginaDe(window.location.href), url: window.location.href }; // continua sem estado
    }
    if (g.atual) {
      const i2 = indiceDe(window.history.state) ?? g.atual.idx;
      definirAtual(g, { ...g.atual, idx: i2, ancora: i2 ?? g.atual.ancora, url: window.location.href, pagina: paginaDe(window.location.href), inicial: naInicial(g) });
    }
    return r;
  };
}
/** A entrada atual é a inicial do documento (sem estado; a anterior a ela, se houver, é de outro documento). */
function naInicial(g: Guardiao, url = window.location.href) {
  return !!g.inicial && window.history.state === null && url === g.inicial.url;
}
/** Nada existe antes desta entrada: é a da instalação e ela foi a primeira da aba. */
function primeiraDaAba(g: Guardiao, p: Pos) {
  const i = g.instalacao;
  return !!i && i.primeira && (p.idx !== null ? p.idx === i.idx : p.inicial && p.url === i.url);
}

/**
 * Onde uma entrada sem índice está em relação à entrada indexada que a originou: `a` (índice da âncora) e `c` (quantas
 * entradas depois dela — 1 para um fragmento criado logo depois da indexada; +1 por fragmento encadeado). A entrada inicial
 * do documento ocupa o lugar do próprio índice dela (c = 0). Só com a cadeia registrada inteira; senão, desconhecida.
 */
function cadeia(g: Guardiao, p: Pos): { a: number; c: number } | null {
  if (p.idx !== null) return { a: p.idx, c: 0 };
  if (p.inicial) return g.inicial ? { a: g.inicial.indice, c: 0 } : null;
  let ant = p.anterior, c = 1;
  for (let n = 0; ant && n < 64; n++) {
    if ('idx' in ant) return { a: ant.idx, c };
    const url = ant.url, mesmos = g.fragmentos.filter((f) => f.url === url), um = mesmos[0];
    if (!um || !mesmos.every((f) => JSON.stringify(f.anterior) === JSON.stringify(um.anterior))) return null;
    ant = um.anterior; c++;
  }
  return null;
}
type Fragmento = Guardiao['fragmentos'][number];
const mesmaAnterior = (x: Anterior, y: Anterior) => JSON.stringify(x) === JSON.stringify(y);
/**
 * Os fragmentos registrados nascidos da entrada indexada `a`, na ordem do histórico (o 1º tem a própria `a` como anterior;
 * cada seguinte, o anterior por URL). Nulo se o registro não determina a ordem (ramos ou fragmentos fora da cadeia).
 */
function cadeiaDe(g: Guardiao, a: number): Fragmento[] | null {
  const lista: Fragmento[] = [];
  let ant: Anterior = { idx: a };
  for (let n = 0; n < 64; n++) {
    const prox = g.fragmentos.filter((f) => f.ancora === a && mesmaAnterior(f.anterior, ant));
    if (prox.length > 1) return null;
    if (!prox.length) break;
    lista.push(prox[0]); ant = { url: prox[0].url };
  }
  return g.fragmentos.filter((f) => f.ancora === a).length === lista.length ? lista : null;
}
/**
 * Mantém o registro de fragmentos fiel ao histórico: uma entrada nova (pushState ou fragmento) a partir de `p` descarta
 * tudo o que estava à frente de `p` — os fragmentos de âncora posterior e, na própria âncora, os que vinham depois de `p`.
 */
function podarDepois(g: Guardiao, p: Pos) {
  if (p.idx !== null) { g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && f.ancora < p.idx!); return; }
  if (p.inicial && g.inicial) { const i = g.inicial.indice; g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && f.ancora < i); return; }
  if (p.ancora === null) return; // posição incerta: nada a afirmar (a contiguidade cai no pushState seguinte)
  const a = p.ancora, ch = cadeiaDe(g, a);
  const j = ch ? ch.findIndex((f) => f.url === p.url && mesmaAnterior(f.anterior, p.anterior)) : -1;
  const manter = ch && j >= 0 ? new Set(ch.slice(0, j + 1)) : null;
  g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && (f.ancora < a || (f.ancora === a && (!manter || manter.has(f)))));
}
type Entrada = { idx: number } | { frag: Fragmento };
/**
 * A entrada EXATA a `passo` de `de`, percorrendo o histórico conhecido deste documento: as indexadas (contíguas, todas
 * registradas) e, depois de cada uma, a cadeia de fragmentos nascida dela. Nulo quando algo no caminho não é conhecido
 * (lacunas nos índices, posição incerta, cadeia ambígua, fora do que se conhece) — aí só cabe a conferência por faixa.
 */
function chegadaDe(g: Guardiao, de: Pos, passo: number): Entrada | null {
  if (!g.contiguo || passo === 0) return null;
  const existe = (i: number) => g.paginas.has(i) || g.inicial?.indice === i;
  let a: number, pos: number;
  if (de.idx !== null) { a = de.idx; pos = 0; }
  else if (de.inicial && g.inicial) { a = g.inicial.indice; pos = 0; }
  else {
    if (de.ancora === null) return null;
    const ch = cadeiaDe(g, de.ancora);
    const j = ch ? ch.findIndex((f) => f.url === de.url && mesmaAnterior(f.anterior, de.anterior)) : -1;
    if (j < 0) return null;
    a = de.ancora; pos = j + 1;
  }
  if (!existe(a)) return null;
  for (let n = Math.abs(passo); n > 0; n--) {
    if (passo > 0) {
      const ch = cadeiaDe(g, a);
      if (!ch) return null;
      if (pos < ch.length) pos++;
      else { a++; pos = 0; if (!existe(a)) return null; }
    } else if (pos > 0) pos--;
    else {
      a--; if (!existe(a)) return null;
      const ch = cadeiaDe(g, a);
      if (!ch) return null;
      pos = ch.length;
    }
  }
  if (pos === 0) return { idx: a };
  return { frag: cadeiaDe(g, a)![pos - 1] };
}
/** A chegada observada é a entrada calculada. */
function casa(g: Guardiao, e: Entrada, L: Pos): boolean {
  if ('idx' in e) return !g.paginas.has(e.idx) && g.inicial?.indice === e.idx ? L.inicial : L.idx === e.idx;
  return L.idx === null && !L.inicial && L.url === e.frag.url && (L.ancora === null || L.ancora === e.frag.ancora);
}

/**
 * Salto exato até o editor (índice k) a partir de uma entrada sem índice de cadeia conhecida, que nunca passa dele: para
 * trás, c + (a − k) (a entrada da âncora e as indexadas até k, sem contar entradas sem índice entre elas, que só aumentam a
 * distância real); para frente, k − a. Um único movimento, em vez de passos de 1 — que têm o mesmo tamanho de um Voltar ou
 * Avançar da pessoa e geram chegadas iguais nas duas ordens da fila.
 */
function saltoSemIndice(g: Guardiao, p: Pos, k: number): number | null {
  if (!g.contiguo || p.idx !== null) return null;
  const cd = cadeia(g, p);
  if (!cd) return null;
  const mov = cd.a >= k ? -(cd.c + (cd.a - k)) : k - cd.a;
  return mov === 0 ? null : mov;
}

/**
 * Volta para trás a partir de uma posição AMBÍGUA (fragmentos de mesma URL nascidos de entradas diferentes, todos de cadeia
 * conhecida): em vez do passo −1 — do tamanho de um Voltar da pessoa, com chegadas iguais nas duas ordens da fila —, o
 * maior salto (de 2 até o salto exato das posições à frente do editor) que, em TODAS as posições possíveis, não passa do
 * editor e não sai do que se conhece deste documento. O índice da chegada diz qual era a posição; a volta segue dali.
 */
function saltoAmbiguo(g: Guardiao, p: Pos, k: number): number | null {
  if (!g.contiguo || p.idx !== null || !p.candidatos?.length) return null;
  const cads = p.candidatos.map((c) => cadeia(g, { ...p, ...c, candidatos: undefined }));
  if (cads.some((c) => !c)) return null;
  const cs = cads as Array<{ a: number; c: number }>;
  const frente = cs.filter((x) => x.a >= k);
  if (!frente.length) return null;
  const menor = Math.min(...g.paginas.keys(), g.inicial?.indice ?? Infinity);
  const seguro = (m: number) => cs.every(({ a, c }) => m <= c || (a - (m - c) >= menor && (a < k || a - (m - c) >= k)));
  for (let m = Math.max(...frente.map(({ a, c }) => c + (a - k))); m >= 2; m--) if (seguro(m)) return -m;
  return null;
}

/** Nenhuma entrada sem índice registrada nasceu de uma entrada com índice em [lo, hi] (então nada há entre elas). */
function semFragmentosEntre(g: Guardiao, lo: number, hi: number) {
  return !g.fragmentos.some((f) => f.ancora === null || (f.ancora >= lo && f.ancora <= hi));
}
/**
 * Chegada de um movimento de `passo` a partir da entrada indexada `i` (índices contíguos): sem fragmentos registrados no
 * caminho, é EXATAMENTE a de índice i + passo; com fragmentos, qualquer entrada entre a origem e o alvo. `doFragmento`: o
 * movimento parte de um fragmento nascido de `i` (o único da âncora i): ele mesmo não está no caminho para frente.
 */
function possivelAPartirDe(g: Guardiao, i: number, passo: number, L: Pos, doFragmento = false): boolean {
  const [min, max] = passo > 0 ? [i + 1, i + passo] : [i + passo, i - 1];
  const [amin, amax] = passo > 0 ? [doFragmento ? i + 1 : i, i + passo - 1] : [i + passo, i - 1];
  if (semFragmentosEntre(g, amin, amax)) return L.idx === i + passo;
  if (L.idx !== null) return L.idx >= min && L.idx <= max;
  if (L.inicial) return passo < 0;
  if (L.ancora !== null) return L.ancora >= amin && L.ancora <= amax;
  for (let j = amin; j <= amax; j++) if (g.paginas.get(j) === L.pagina) return true;
  return false;
}

/**
 * A chegada `L` é possível para o NOSSO movimento `mov` resolvido a partir de `de`? Só o que a posição permite: o índice
 * (contíguo: um salto de k−j cai entre j e k; um passo, na vizinha), a entrada anterior registrada de um fragmento e a
 * âncora. Página igual não basta (H1-R1: Campanhas idx 1 não é a anterior do fragmento nascido de Campanhas idx 3).
 */
function possivel(g: Guardiao, de: Pos | null, mov: number, L: Pos): boolean {
  if (!de) return true;
  // Posição ambígua entre fragmentos de mesma URL: possível se for possível a partir de alguma das posições registradas.
  if (de.idx === null && de.candidatos?.length) return de.candidatos.some((c) => possivel(g, { ...de, ...c, candidatos: undefined }, mov, L));
  // Caminho inteiramente conhecido: a chegada é exatamente uma entrada.
  const e = chegadaDe(g, de, mov);
  if (e) return casa(g, e, L);
  if (de.idx !== null) {
    const i = de.idx;
    if (!g.contiguo) return L.idx === null ? true : mov > 0 ? L.idx > i : L.idx < i;
    return possivelAPartirDe(g, i, mov, L);
  }
  const cd = g.contiguo ? cadeia(g, de) : null;
  if (cd) {
    const { a, c } = cd;
    if (de.inicial && mov < 0) return false; // nada antes da inicial neste documento
    if (mov === -1 && de.anterior && 'url' in de.anterior) return L.idx === null && L.url === de.anterior.url;
    if (mov < 0 && -mov < c) return L.idx === null && L.pagina === de.pagina; // ainda na cadeia de fragmentos (mesma página)
    if (mov < 0 && -mov === c) return L.idx === a;
    // Além da âncora (para trás) ou depois do fragmento (para frente): como um movimento a partir da própria âncora. Para
    // frente, os fragmentos da própria âncora depois deste (cadeia) também ficam no caminho.
    const passo = mov < 0 ? mov + c : mov;
    if (passo > 0 && g.fragmentos.some((f) => f.ancora === a && f.url !== de.url)) {
      if (L.idx !== null) return L.idx >= a + 1 && L.idx <= a + passo;
      return L.ancora === null ? L.pagina === de.pagina : L.ancora >= a && L.ancora <= a + passo - 1;
    }
    return possivelAPartirDe(g, a, passo, L, passo > 0 && c === 1);
  }
  if (mov === -1) {
    const ant = de.anterior;
    if (ant && 'idx' in ant) return L.idx === ant.idx;
    if (ant && 'url' in ant) return L.idx === null && L.url === ant.url;
    if (de.inicial) return false; // nada antes da inicial neste documento
    return L.pagina === de.pagina; // anterior de um fragmento: mesma página
  }
  if (mov === 1) {
    if (!g.contiguo) return true;
    // A seguinte à inicial é a primeira indexada do documento (o índice logo depois do lugar dela) ou um fragmento dela.
    if (de.inicial) return L.idx !== null ? L.idx === (g.inicial?.indice ?? -1) + 1 : L.pagina === de.pagina;
    if (de.ancora === null) return true;
    return L.idx !== null ? L.idx === de.ancora + 1 : L.ancora === null ? L.pagina === de.pagina : L.ancora === de.ancora;
  }
  return true;
}

/**
 * A chegada `L` é EXATAMENTE a do nosso movimento `mov` aplicado a partir de `de` (não só uma das possíveis), pelo
 * caminho inteiramente conhecido (`chegadaDe`). Só então a outra ordem do par existe com a 1ª chegada como destino.
 */
function exatamente(g: Guardiao, de: Pos, mov: number, L: Pos): boolean {
  if (de.idx === null && de.candidatos?.length) return de.candidatos.some((c) => exatamente(g, { ...de, ...c, candidatos: undefined }, mov, L));
  const e = chegadaDe(g, de, mov);
  return !!e && casa(g, e, L);
}

// ---- Tentativa de saída SEM Navigation API ----
function limparTimers(t: Tentativa) {
  if (t.timer !== null) window.clearTimeout(t.timer);
  if (t.vigia !== null) window.clearTimeout(t.vigia);
  t.timer = null; t.vigia = null;
}
function encerrar(g: Guardiao, t: Tentativa) { limparTimers(t); if (g.tentativa === t) g.tentativa = null; }
/** Chegou de volta à entrada do editor: só agora o pedido (ou a saída explícita que esperava) segue — URL e página coerentes. */
function concluirRetorno(g: Guardiao, t: Tentativa) {
  encerrar(g, t);
  if (t.saida) { t.saida(); return; } // saída explícita pedida durante a volta: medida a partir do editor, sem pergunta
  // O pedido vai à proteção VIGENTE do editor (se a de origem foi desativada e outra ativada na mesma página, é ela que
  // decide); o callback antigo não é chamado. Saída explícita (liberado) já decidiu: nada a perguntar.
  const alvo = g.ativa && g.ativa.pagina === t.a.pagina ? g.ativa : t.a;
  if (alvo.liberado() || t.a.liberado() || t.deslocamento === 0) return;
  alvo.aoTentarSair({ tipo: 'relativo', delta: -t.deslocamento });
}
/**
 * Direção do primeiro passo a partir de uma entrada sem índice alcançada pela PESSOA. Só passos que TÊM destino:
 *  - a entrada inicial do documento está atrás de todas as indexadas: +1;
 *  - fragmento de âncora conhecida: atrás do editor (âncora < k) +1, senão −1 (a anterior sempre existe);
 *  - âncora desconhecida: −1, salvo quando todas as entradas indexadas desta página estão atrás do editor.
 */
function direcaoProvavel(g: Guardiao, p: Pos, a: Ativa): -1 | 1 {
  if (p.inicial) return 1;
  if (p.ancora !== null) return p.ancora < a.indice! ? 1 : -1;
  if (!g.contiguo) return -1;
  const da = [...g.paginas].filter(([, pg]) => pg === p.pagina).map(([i]) => i);
  return da.length > 0 && da.every((i) => i < a.indice!) ? 1 : -1;
}
function noEditor(t: Tentativa, p: Pos) { return p.idx === t.a.indice && p.pagina === t.a.pagina; }
function avancar(g: Guardiao, t: Tentativa) {
  t.timer = null;
  if (g.tentativa !== t) return;
  if (t.a.liberado() && !t.saida) { encerrar(g, t); return; } // saída explícita direta (fora do hook) venceu
  if (t.emVoo !== null) return; // um movimento nosso ainda está na fila: o popstate dele vem antes de qualquer outro passo
  const p = g.atual ?? posicaoAtual(g, indiceDe(window.history.state)), k = t.a.indice!;
  if (noEditor(t, p)) { concluirRetorno(g, t); return; }
  let mov: number;
  if (p.idx !== null && !t.inverteu) {
    // Salto que nunca passa da entrada do editor (entradas sem índice só aumentam a distância real); com lacunas nos índices,
    // passo. Daqui em diante a direção do editor é conhecida.
    mov = g.contiguo ? k - p.idx : Math.sign(k - p.idx);
    if (mov === 0) mov = t.direcao || -1; // índice do editor numa entrada de outra página (índice herdado duplicado)
    t.direcao = mov > 0 ? 1 : -1;
  } else {
    const salto = t.inverteu ? null : saltoSemIndice(g, p, k);
    if (salto !== null) { mov = salto; t.direcao = mov > 0 ? 1 : -1; }
    else {
      // Sem índice de cadeia desconhecida — ou índice que já se mostrou falso (a salvaguarda inverteu): passo na direção corrente.
      if (p.idx === null && p.inicial) t.direcao = 1;
      else if (!t.direcao) t.direcao = direcaoProvavel(g, p, t.a);
      mov = (t.direcao < 0 && !t.inverteu ? saltoAmbiguo(g, p, k) : null) ?? t.direcao;
    }
  }
  t.ultimo = null;
  // Índice que já se mostrou falso (inversão da salvaguarda): a origem não serve para conferir a chegada.
  t.emVoo = mov; t.origem = t.inverteu && p.idx !== null ? null : p;
  window.history.go(mov);
  armarVigia(g, t, mov);
}
function armarVigia(g: Guardiao, t: Tentativa, mov: number) {
  if (t.vigia !== null) window.clearTimeout(t.vigia);
  t.vigia = window.setTimeout(() => semMovimento(g, t, mov), VIGIA_MS);
}
/**
 * history.go sem popstate (no-op): o movimento NÃO aconteceu e não entra no deslocamento. A volta é replanejada a partir de
 * onde a página está; nunca abandonada fora do editor (H1-R2). Um salto sem destino mostra lacunas nos índices (passa a
 * passos); um passo sem destino a partir da posição atual inverte a direção.
 */
function semMovimento(g: Guardiao, t: Tentativa, mov: number) {
  t.vigia = null;
  if (g.tentativa !== t) return;
  const de = t.origem, aqui = g.atual;
  t.emVoo = null; t.origem = null;
  if (t.compensando) { t.compensando = false; encerrar(g, t); return; }
  if (t.a.liberado() && !t.saida) { encerrar(g, t); return; }
  if (Math.abs(mov) > 1) g.contiguo = false;
  else if (de && aqui && de.url === aqui.url && de.idx === aqui.idx) {
    if (t.inverteu >= 4) { encerrar(g, t); return; } // inalcançável: as duas pontas sem o editor
    t.inverteu += 1; t.direcao = mov > 0 ? -1 : 1;
  }
  avancar(g, t);
}
/** Movimento em voo que certamente não tem destino: para trás a partir da primeira entrada da aba. */
function semDestinoCerto(g: Guardiao, mov: number, de: Pos) { return mov < 0 && primeiraDaAba(g, de); }

/**
 * Guardião do histórico (R-H1 / R-H1-F / F1–F3 / H1 / H1-R1–R3). Precisa ouvir `popstate` ANTES do App Router do Next (no
 * window vale a ordem de registro — medido em Chrome 155). Instalado no LAYOUT RAIZ (components/InstalarGuardiaoHistorico.tsx).
 *
 * Proteção por PÁGINA (caminho + busca) do editor: com alterações não salvas,
 *  - travessia para uma entrada da PRÓPRIA página (ex.: fragmentos da prévia, #orcamento) é livre e silenciosa — barrada
 *    só para o roteador (que já está nesta página), sem diálogo;
 *  - travessia para OUTRA página (Voltar, Avançar, history.go(±n), várias seguidas, durante salvamento) é barrada antes do
 *    roteador; volta-se à entrada do editor e o pedido vai ao editor com o destino escolhido;
 *  - com um pedido aberto (diálogo), qualquer travessia que saia da entrada do editor conta como nova tentativa.
 *   COM Navigation API: volta pela CHAVE (traverseTo, absoluto).
 *   SEM Navigation API: volta à entrada INDEXADA do editor por saltos que nunca a ultrapassam e passos onde não há índice.
 *   As travessias são atendidas em FILA e o alvo de cada uma é resolvido no atendimento: uma travessia da pessoa pode ser
 *   atendida antes do nosso movimento já pedido. Cada chegada é conferida contra o que o nosso movimento poderia alcançar
 *   a partir de onde ele será resolvido (`possivel`); o que não pode ser nosso é da pessoa, e o nosso continua pendente,
 *   resolvido a partir de onde ela chegou. De um fragmento de cadeia conhecida (ou da entrada inicial) a volta é um salto
 *   exato, sem passos de 1 que colidam com Voltar/Avançar; de um fragmento AMBÍGUO (mesma URL em entradas diferentes), um
 *   salto ≥ 2 seguro em todas as posições possíveis, cuja chegada revela a posição. Um par de chegadas igual nas duas
 *   ordens em que a leitura pela fila deixaria a pessoa no editor é resolvido a favor de PERGUNTAR (nunca engolido); entre
 *   duas saídas, vale a fila.
 * Uma travessia interceptada sempre termina na entrada do editor: mesmo se a proteção cair durante a volta (ex.: o
 * salvamento terminou), a volta se completa e o pedido é apresentado (a pessoa decide). Uma saída explícita pedida
 * durante a volta espera a volta chegar ao editor e então segue (`executarSaida`). Sem proteção ativa, nada é
 * interceptado. Travessia para outro DOCUMENTO cai no beforeunload.
 */
export function instalarGuardiaoDeHistorico() {
  if (typeof window === 'undefined') return;
  const g = guardiao();
  if (g.instalado) return;
  g.instalado = true;
  if (!navegacaoApi()) instalarIndiceDoHistorico(g);
  window.addEventListener('popstate', (e) => {
    const nav = navegacaoApi();
    const idx = indiceDe(e.state);
    let p: Pos | null = null;
    if (!nav) {
      if (idx !== null) g.paginas.set(idx, paginaDe(window.location.href));
      if (idx === null && window.history.length !== g.comprimento && g.atual) {
        // Fragmento NOVO (o comprimento mudou): nasce logo depois da entrada em que a pessoa estava.
        const ant = g.atual;
        podarDepois(g, ant); // as entradas à frente de onde a pessoa estava foram descartadas pelo fragmento novo
        const f = { url: window.location.href, anterior: (ant.idx !== null ? { idx: ant.idx } : { url: ant.url }) as Anterior, ancora: ant.ancora };
        g.fragmentos.push(f);
        p = { idx: null, url: f.url, pagina: paginaDe(f.url), ancora: f.ancora, anterior: f.anterior, inicial: false };
      } else p = posicaoAtual(g, idx);
      definirAtual(g, p);
      g.comprimento = window.history.length;
    }

    const t = g.tentativa;
    if (!nav && t && p) {
      // Volta em andamento: todo popstate é da correção (ou da pessoa no meio dela) e não vai ao roteador.
      e.stopImmediatePropagation();
      if (t.vigia !== null) { window.clearTimeout(t.vigia); t.vigia = null; }
      if (t.compensando) { t.compensando = false; t.emVoo = null; encerrar(g, t); return; } // de volta à saída escolhida
      const emVoo = t.emVoo;
      if (t.a.liberado() && !t.saida) {
        // Saída explícita direta já aconteceu (fora do hook): o nosso movimento antigo, atendido depois dela, é desfeito.
        if (emVoo !== null) { t.emVoo = null; t.compensando = true; window.history.go(-emVoo); armarVigia(g, t, -emVoo); return; }
        encerrar(g, t); return;
      }
      if (emVoo !== null && possivel(g, t.origem, emVoo, p)) {
        t.deslocamento += emVoo; t.emVoo = null; t.origem = null;
        t.ultimo = { mov: emVoo, chegada: p };
      } else if (emVoo === null && t.ultimo && p.pagina === t.a.pagina && t.ultimo.chegada.pagina !== t.a.pagina
        && exatamente(g, t.ultimo.chegada, t.ultimo.mov, p)) {
        // Par de chegadas igual nas duas ordens da fila, antes do nosso próximo pedido, em que a leitura pela fila ("o nosso
        // primeiro, depois o da pessoa") deixaria a pessoa de volta ao editor e ENGOLIRIA a outra leitura possível ("a pessoa
        // chegou à 1ª entrada e o nosso movimento seguiu dali") — H1-R3. Só aqui a outra leitura é adotada, e só para
        // PERGUNTAR (destino = 1ª chegada; "Continuar editando" mantém tudo). Quando as duas leituras dão SAÍDAS diferentes,
        // vale a leitura pela fila (a chegada observada da pessoa): uma saída nunca é trocada por outra presumida.
        t.deslocamento = t.ultimo.mov; t.direcao = 0; t.ultimo = null;
      } else {
        // Travessia da pessoa: o destino é onde ela chegou agora; a posição volta a ser desconhecida. O nosso movimento, se
        // ainda na fila, será resolvido a partir daqui.
        t.deslocamento = 0; t.direcao = 0; t.ultimo = null;
        if (emVoo !== null) {
          t.origem = p;
          if (semDestinoCerto(g, emVoo, p)) { t.emVoo = null; t.origem = null; } // nada antes da 1ª entrada da aba: não virá
          else armarVigia(g, t, emVoo);
        }
      }
      if (noEditor(t, p) && t.emVoo === null) { concluirRetorno(g, t); return; }
      if (t.timer !== null) window.clearTimeout(t.timer);
      t.timer = window.setTimeout(() => avancar(g, t), ASSENTAR_MS);
      return;
    }

    const a = g.ativa;
    if (!a || a.liberado()) return;
    if (nav?.currentEntry && a.chave) {
      const atual = nav.currentEntry;
      if (atual.key === a.chave) { e.stopImmediatePropagation(); return; } // de volta à entrada protegida (correção nossa)
      if (paginaDe(atual.url) === a.pagina && !a.temPedido()) { e.stopImmediatePropagation(); return; } // mesma página: livre
      e.stopImmediatePropagation();
      irPara(nav, a.chave);
      a.aoTentarSair({ tipo: 'historico', chave: atual.key, url: atual.url ?? '' });
      return;
    }
    if (a.indice === null) return;
    // Mesma página do editor: o roteador já está nela; não há o que navegar nem perguntar (com pedido aberto, só a entrada
    // do editor conta como "ficar" — sair dela é nova tentativa e volta).
    if (idx === a.indice || (paginaDe(window.location.href) === a.pagina && !a.temPedido())) { e.stopImmediatePropagation(); return; }
    e.stopImmediatePropagation();
    const nova: Tentativa = { a, deslocamento: 0, emVoo: null, origem: null, ultimo: null, direcao: 0, inverteu: 0, timer: null, vigia: null, saida: null, compensando: false };
    g.tentativa = nova;
    nova.timer = window.setTimeout(() => avancar(g, nova), ASSENTAR_MS);
  }, true);
}

/**
 * Executa uma saída explícita (descartar, salvar e sair, link). SEM Navigation API e com uma volta em andamento, a página
 * está numa entrada que não é a do editor: o destino relativo foi medido a partir do editor e um movimento nosso pode estar
 * na fila. A saída espera a volta chegar ao editor e então segue — nada da correção acontece depois dela (O-2).
 */
export function executarSaida(seguir: () => void) {
  if (typeof window === 'undefined') return;
  const g = guardiao();
  const t = g.tentativa;
  if (!navegacaoApi() && t) { t.saida = seguir; if (t.emVoo === null && t.timer === null) avancar(g, t); return; }
  seguir();
}

/**
 * Ativa a proteção do histórico para a PÁGINA atual (a do editor) até a função devolvida ser chamada. Usada pelo hook;
 * exportada para os testes comportamentais (protecao-saida.test.ts) exercitarem o guardião sem React.
 */
export function protegerHistorico(opcoes: { liberado: () => boolean; aoTentarSair: (d: DestinoSaida) => void; temPedido?: () => boolean }): () => void {
  instalarGuardiaoDeHistorico(); // normalmente já instalado no layout raiz; aqui só cobre uso fora dele (sem garantia de ordem)
  const g = guardiao();
  const nav = navegacaoApi();
  // Durante uma volta em andamento a URL mostra a página de saída, mas o roteador continua no editor: a proteção nova
  // herda a página e a entrada do editor da tentativa.
  if (!nav && g.tentativa) {
    const minha: Ativa = { pagina: g.tentativa.a.pagina, chave: null, indice: g.tentativa.a.indice, temPedido: () => false, ...opcoes };
    g.ativa = minha;
    return () => { if (g.ativa === minha) g.ativa = null; };
  }
  const pagina = paginaDe(window.location.href);
  let indice: number | null = null;
  if (!nav) {
    indice = indiceDe(window.history.state);
    // Entrada com estado objeto sem índice (criada antes da instalação): recebe o índice atual, preservando o estado.
    if (indice === null && objetoSimples(window.history.state)) { window.history.replaceState(window.history.state, ''); indice = indiceDe(window.history.state); }
    // Entrada SEM estado (fragmento, estado nulo): a proteção usa a entrada indexada DESTA página que a precede.
    if (indice === null) {
      const ancora = g.atual?.ancora ?? null; // fragmento de origem conhecida: a âncora dele, se for desta página
      if (ancora !== null && g.paginas.get(ancora) === pagina) indice = ancora;
      else {
        const candidatos = [...g.paginas].filter(([i, p]) => p === pagina && i <= g.indiceAtual).map(([i]) => i);
        indice = candidatos.length ? Math.max(...candidatos) : null;
      }
    }
  }
  const minha: Ativa = { pagina, chave: nav?.currentEntry?.key ?? null, indice, temPedido: () => false, ...opcoes };
  g.ativa = minha;
  return () => { if (g.ativa === minha) g.ativa = null; };
}

/**
 * Protege um editor com alterações não salvas contra saída silenciosa:
 * - recarregar/fechar a aba: aviso nativo do navegador (`beforeunload`);
 * - links internos para OUTRA página (Next `<Link>` do cabeçalho, do menu lateral, de qualquer lugar da página): o clique é
 *   interceptado na fase de captura, antes do roteador, e vira um pedido de confirmação (`pendente`);
 * - histórico (Voltar/Avançar/history.go, uma ou várias vezes): ver `instalarGuardiaoDeHistorico`.
 * Não intercepta: nova aba/janela (Ctrl/⌘/Shift/botão do meio, `target`), download, âncora da própria página (nem no
 * clique nem na travessia do histórico) nem domínio externo (esse cai no `beforeunload`).
 */
export function useProtecaoDeSaida(ativo: boolean, navegar: (href: string, substituir: boolean) => void) {
  const [pendente, setPendenteEstado] = useState<DestinoSaida | null>(null);
  // Fonte da verdade do pedido pendente (C2): permanecer/sair leem a ref, não a cópia da renderização em que foram
  // criados — uma continuação antiga não pode sair com um pedido já cancelado nem sair duas vezes. `pedido` numera cada
  // pedido novo (um Voltar durante um salvamento é um pedido novo: a continuação antiga não o executa).
  const pendenteRef = useRef<DestinoSaida | null>(null);
  const pedido = useRef(0);
  const setPendente = (d: DestinoSaida | null) => { pendenteRef.current = d; if (d) pedido.current++; setPendenteEstado(d); };
  useEffect(() => () => { pendenteRef.current = null; }, []);
  const liberado = useRef(false);
  const navegarRef = useRef(navegar);
  useEffect(() => { navegarRef.current = navegar; });

  useEffect(() => {
    if (!ativo) return;
    liberado.current = false;
    const antesDeSair = (e: BeforeUnloadEvent) => { if (!liberado.current) e.preventDefault(); };
    const aoClicar = (e: MouseEvent) => {
      if (liberado.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
      const destino = new URL(a.href, window.location.href);
      if (destino.origin !== window.location.origin) return;
      if (destino.pathname === window.location.pathname && destino.search === window.location.search) return;
      e.preventDefault(); e.stopPropagation();
      setPendente({ tipo: 'link', href: `${destino.pathname}${destino.search}${destino.hash}` });
    };
    window.addEventListener('beforeunload', antesDeSair);
    document.addEventListener('click', aoClicar, true);
    const desproteger = protegerHistorico({ liberado: () => liberado.current, temPedido: () => pendenteRef.current !== null, aoTentarSair: (d) => setPendente(d) });
    return () => {
      window.removeEventListener('beforeunload', antesDeSair);
      document.removeEventListener('click', aoClicar, true);
      desproteger();
    };
  }, [ativo]);

  return {
    pendente,
    /** Número do pedido vigente: muda a cada pedido novo (link, Voltar/Avançar), não ao permanecer/sair. */
    pedidoAtual: () => pedido.current,
    /** Fica no editor (a posição no histórico já é a do editor). */
    permanecer() { setPendente(null); },
    /** Sai de fato (depois de descartar ou de salvar com sucesso), para o destino pedido. */
    sair() {
      const destino = pendenteRef.current;
      setPendente(null);
      if (!destino) return;
      liberado.current = true;
      if (destino.tipo === 'historico') { const nav = navegacaoApi(); if (nav) irPara(nav, destino.chave); return; }
      // Sem Navigation API e com uma volta em andamento, a saída espera a volta chegar ao editor (O-2).
      executarSaida(() => { if (destino.tipo === 'relativo') window.history.go(destino.delta); else navegarRef.current(destino.href, false); });
    },
  };
}
