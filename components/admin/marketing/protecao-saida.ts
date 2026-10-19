'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Para onde a pessoa tentou ir com alterações não salvas: um link interno, uma entrada do histórico pela chave
 * (Navigation API) ou — sem Navigation API — a ENTRADA ATUAL: a página já está onde a pessoa chegou ("decisão primeiro").
 */
export type DestinoSaida = { tipo: 'link'; href: string } | { tipo: 'historico'; chave: string; url: string } | { tipo: 'aqui'; url: string };

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
type Ativa = { pagina: string; chave: string | null; indice: number | null; liberado: () => boolean; temPedido: () => boolean; aoTentarSair: (d: DestinoSaida | null) => void;
  /** O editor (instância do hook) dono da proteção: as reativações dele (salvar, reeditar) têm o mesmo dono (O-a). */
  dono: object | null };
/**
 * O que se sabe de uma entrada do histórico, SEM Navigation API (nada disso vai para o estado da entrada):
 *  - `idx`: o índice próprio (`__kidmaisIdx`), ou nulo;
 *  - `ancora`: a entrada indexada que a originou (a própria, se indexada; para um fragmento, a de onde ele nasceu);
 *  - `anterior`: a entrada imediatamente anterior, quando conhecida — um fragmento criado neste documento nasce logo depois
 *    da entrada em que a pessoa estava (indexada: `{ idx }`; outro fragmento: `{ url }`).
 */
type Anterior = { idx: number } | { url: string } | null;
type Pos = { idx: number | null; url: string; pagina: string; ancora: number | null; anterior: Anterior; inicial: boolean };
/**
 * Uma tentativa de saída interceptada SEM Navigation API ("decisão primeiro", A1/A2). Pertence à proteção que a interceptou.
 * O pedido está aberto e o guardião NÃO se move — a página fica onde a pessoa chegou, e esse é o destino (exato,
 * observado). Novas travessias dela só atualizam o destino; voltar à página do editor fecha o pedido. "Continuar editando"
 * também não volta pelo histórico (C1/C2, decisão de Felipe em 17/10/2026): cria uma entrada nova do editor na posição
 * atual (`continuarEditando`).
 */
type Tentativa = { a: Ativa };
/**
 * `inicial`: a entrada em que o documento começou, quando ela não tem índice (estado nulo antes da hidratação, ou não
 * objeto). Ela fica ATRÁS de todas as indexadas deste documento — dado que orienta a âncora de uma entrada sem índice.
 * `maior`: maior índice já dado. `incerto`: a entrada atual é sem índice e a indexada que a precede é desconhecida.
 * `comprimento`: último history.length visto (distingue fragmento NOVO, que muda o comprimento, de travessia). `atual`: o
 * que se sabe da entrada atual. `fragmentos`: entradas sem índice criadas neste documento, com a anterior e a âncora.
 */
type Guardiao = {
  instalado: boolean; ativa: Ativa | null; indiceAtual: number; maior: number; incerto: boolean; comprimento: number;
  paginas: Map<number, string>; inicial: { indice: number; pagina: string; url: string } | null; tentativa: Tentativa | null;
  atual: Pos | null; fragmentos: Array<{ url: string; anterior: Anterior; ancora: number | null }>;
  /** Estado (do Next) e URL de cada entrada indexada, como estavam quando ela foi a atual — para recriar a do editor em "Continuar". */
  estados: Map<number, { estado: unknown; url: string }>;
  /** O pushState do índice próprio (instalado antes de qualquer correção posterior do window.history, como a do Next). */
  empilharProprio: ((dados: unknown, nao: string, url?: string | URL | null) => void) | null;
};
/** Estado único por janela (Strict Mode e Fast Refresh reavaliam o módulo; o guardião e o índice são um só). */
function guardiao(): Guardiao {
  const w = window as unknown as { __kidmaisGuardiaoHistorico?: Guardiao };
  return (w.__kidmaisGuardiaoHistorico ??= {
    instalado: false, ativa: null, indiceAtual: 0, maior: 0, incerto: false, comprimento: 0, paginas: new Map(), inicial: null,
    tentativa: null, atual: null, fragmentos: [], estados: new Map(), empilharProprio: null,
  });
}

// ---- Índice próprio do histórico (só SEM Navigation API) ----
// Cada entrada criada por pushState recebe __kidmaisIdx; replaceState mantém o índice da entrada atual. Só OBJETOS SIMPLES
// recebem o campo — copiados, com os campos existentes (inclusive os internos do Next: __NA, árvore) PRESERVADOS. Estado
// nulo continua nulo (o Next ignora popstate nulo e recarrega objeto sem __NA); arrays/instâncias ficam como estão.
// Entradas SEM índice existem (fragmentos de âncora, location.hash, replaceState(null)) e podem estar ATRÁS, À FRENTE ou ser
// a própria entrada onde a edição começou: o índice dá ORDEM (monótono ao longo do histórico), nunca a posição exata.
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

/** Guarda o estado e a URL da entrada atual, se indexada. */
function registrarEstado(g: Guardiao) {
  const i = indiceDe(window.history.state);
  if (i !== null) g.estados.set(i, { estado: window.history.state, url: window.location.href });
}
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
  return { idx: null, url, pagina, ancora: null, anterior: null, inicial };
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
  registrarEstado(g);
  definirAtual(g, posicaoAtual(g, indiceDe(window.history.state)));
  window.history.pushState = function pushState(dados: unknown, _nao: string, url?: string | URL | null) {
    if (g.incerto) {
      // A entrada indexada que precede a atual é desconhecida: o índice novo é único e maior que todos os anteriores (a
      // ordem continua valendo), mas pode deixar lacuna.
      g.indiceAtual = g.maior + 1;
    } else {
      const ancora = g.indiceAtual;
      g.indiceAtual += 1;
      for (const i of [...g.paginas.keys()]) if (i >= g.indiceAtual) g.paginas.delete(i); // entradas à frente foram descartadas
      for (const i of [...g.estados.keys()]) if (i >= g.indiceAtual) g.estados.delete(i);
      if (g.atual) podarDepois(g, g.atual);
      else g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && f.ancora <= ancora);
    }
    g.maior = Math.max(g.maior, g.indiceAtual); g.incerto = false;
    const r = empilhar(comIndice(dados, g.indiceAtual), _nao, url);
    g.comprimento = window.history.length;
    registrarEstado(g);
    if (indiceDe(window.history.state) !== null) g.paginas.set(g.indiceAtual, paginaDe(window.location.href));
    g.atual = { idx: indiceDe(window.history.state), url: window.location.href, pagina: paginaDe(window.location.href), ancora: g.indiceAtual, anterior: null, inicial: false };
    return r;
  };
  g.empilharProprio = window.history.pushState;
  window.history.replaceState = function replaceState(dados: unknown, _nao: string, url?: string | URL | null) {
    // Mantém o índice da entrada; numa entrada sem índice de posição incerta não há índice certo a dar (não inventa um).
    const indice = indiceDe(window.history.state) ?? (g.incerto ? null : g.indiceAtual);
    const eraInicial = naInicial(g);
    const r = substituir(indice === null ? dados : comIndice(dados, indice), _nao, url);
    registrarEstado(g);
    if (indice !== null && indiceDe(window.history.state) !== null) {
      g.paginas.set(indice, paginaDe(window.location.href));
      if (g.inicial?.indice === indice) g.inicial = null; // a entrada inicial ganhou índice (ex.: hidratação do Next)
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
  if (p.ancora === null) return; // posição incerta: nada a afirmar
  const a = p.ancora, ch = cadeiaDe(g, a);
  const j = ch ? ch.findIndex((f) => f.url === p.url && mesmaAnterior(f.anterior, p.anterior)) : -1;
  const manter = ch && j >= 0 ? new Set(ch.slice(0, j + 1)) : null;
  g.fragmentos = g.fragmentos.filter((f) => f.ancora !== null && (f.ancora < a || (f.ancora === a && (!manter || manter.has(f)))));
}

// ---- Tentativa de saída SEM Navigation API ----
function encerrar(g: Guardiao, t: Tentativa) { if (g.tentativa === t) g.tentativa = null; }
/** A proteção VIGENTE do editor (se a de origem foi desativada e outra ativada na mesma página, é ela); nunca o callback antigo. */
function vigente(g: Guardiao, t: Tentativa) { return g.ativa && g.ativa.pagina === t.a.pagina ? g.ativa : t.a; }
/**
 * Pedido aberto: a página está onde a pessoa chegou. Na página do editor, o pedido fecha (ela voltou); em outra página, o
 * destino é a entrada atual.
 */
function assentarPedido(g: Guardiao, t: Tentativa, p: Pos) {
  const alvo = vigente(g, t);
  if (p.pagina === t.a.pagina) { encerrar(g, t); alvo.aoTentarSair(null); return; }
  if (!alvo.liberado() && !t.a.liberado()) alvo.aoTentarSair({ tipo: 'aqui', url: window.location.href });
}

/**
 * Guardião do histórico (R-H1 / R-H1-F / F1–F3 / H1 / H1-R1–R3). Precisa ouvir `popstate` ANTES do App Router do Next (no
 * window vale a ordem de registro — medido em Chrome 155). Instalado no LAYOUT RAIZ (components/InstalarGuardiaoHistorico.tsx).
 *
 * Proteção por PÁGINA (caminho + busca) do editor: com alterações não salvas,
 *  - travessia para uma entrada da PRÓPRIA página (ex.: fragmentos da prévia, #orcamento) é livre e silenciosa — barrada
 *    só para o roteador (que já está nesta página), sem diálogo;
 *  - travessia para OUTRA página (Voltar, Avançar, history.go(±n), várias seguidas, durante salvamento) é barrada antes do
 *    roteador e vira um pedido ao editor com o destino escolhido;
 *  - com um pedido aberto (diálogo), qualquer travessia que saia da entrada do editor conta como nova tentativa.
 *   COM Navigation API: volta na hora pela CHAVE (traverseTo, absoluto) e pergunta com a chave de destino.
 *   SEM Navigation API ("decisão primeiro", A1/A2): o guardião NÃO volta sozinho. Um history.go relativo não pode ser
 *   cancelado e é resolvido a partir de onde a página estiver quando for atendido; uma travessia da pessoa pedida pouco
 *   antes muda o ponto de partida dele, e o mesmo gesto dela produz as mesmas chegadas que o movimento — nenhum tamanho de
 *   movimento evita isso (colisões com Voltar, go(−n), saída do documento). Por isso o pedido abre já na chegada, com o
 *   destino = a entrada ATUAL (exata: onde ela está); novas travessias só o atualizam; voltar à página do editor o fecha.
 *   "Sair" não faz travessia (`sairNaEntradaAtual` + `mostrarEntradaAtual`); "Continuar editando"
 *   (`continuarEditando`) também não: cria uma entrada NOVA do editor na posição atual (pushState com o estado do Next da
 *   entrada indexada do editor) e as entradas à frente são descartadas, como em toda navegação nova. Uma travessia da pessoa
 *   já pedida é atendida a partir de onde ela estava (alvo atrás: chega, e o pedido abre ali; alvo à frente, descartado
 *   pelo push: no Chrome, não acontece). Nenhum history.go do guardião.
 * Enquanto o pedido está aberto, a barra de endereço mostra a página de destino e o editor continua montado: a coerência
 * URL × tela vale depois da decisão. Se a proteção cair (ex.: o salvamento terminou), o pedido continua — a pessoa decide.
 * Sem proteção ativa, nada é interceptado. Travessia para outro DOCUMENTO cai no beforeunload.
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
      if (idx !== null) { g.paginas.set(idx, paginaDe(window.location.href)); registrarEstado(g); }
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
      // Pedido aberto: todo popstate é da pessoa e não vai ao roteador (o editor continua montado).
      e.stopImmediatePropagation();
      if (t.a.liberado()) { encerrar(g, t); return; } // saída explícita direta já aconteceu (fora do hook)
      assentarPedido(g, t, p);
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
    // do editor conta como "ficar" — sair dela é nova tentativa).
    if (idx === a.indice || (paginaDe(window.location.href) === a.pagina && !a.temPedido())) { e.stopImmediatePropagation(); return; }
    e.stopImmediatePropagation();
    // Decisão primeiro (A1/A2): nenhum movimento — o destino é a entrada a que a pessoa chegou.
    const nova: Tentativa = { a };
    g.tentativa = nova;
    assentarPedido(g, nova, p ?? posicaoAtual(g, idx));
  }, true);
}

/**
 * "Continuar editando" com o pedido aberto, SEM Navigation API (C1/C2; decisão de Felipe em 17/10/2026): SEM travessia —
 * uma volta relativa na fila pode sair do documento ou trocar o destino (gesto concorrente), e não pode ser cancelada.
 * Custos aceitos: as entradas à frente da posição atual são descartadas; o editor pode ficar duas vezes no histórico; um
 * Avançar da pessoa pedido no mesmo instante pode não acontecer; na contingência (abaixo), voltar à entrada recarrega.
 */
export function continuarEditando() {
  if (typeof window === 'undefined') return;
  const g = guardiao(), t = g.tentativa;
  if (navegacaoApi() || !t) return;
  encerrar(g, t);
  // Entrada NOVA do editor na posição atual, com o estado do Next da entrada indexada do editor (o App Router a aceita sem
  // navegar: ele continua no editor, que nunca saiu da tela). Uma travessia da pessoa já na fila chega como chegada DELA.
  const reg = t.a.indice === null ? undefined : g.estados.get(t.a.indice);
  if (reg) window.history.pushState(reg.estado, '', reg.url);
  // Contingência, também sem travessia (estado do editor não registrado — não ocorre nos fluxos medidos): entrada nova só
  // com o índice próprio, pelo pushState próprio (o do Next copiaria a árvore da entrada atual, de outra página). Nenhum
  // campo do Next é fabricado; voltando a ela sem proteção, o Next recarrega o documento nela.
  else if (g.empilharProprio) g.empilharProprio({}, '', new URL(t.a.pagina, window.location.href).href);
  // Sem o pushState próprio (só se a Navigation API existia na instalação e sumiu depois — não ocorre num documento): não
  // há entrada a criar com segurança; o pedido termina sem travessia.
  else return;
  const novo = indiceDe(window.history.state);
  for (const a of [t.a, g.ativa]) if (a && a.pagina === t.a.pagina) a.indice = novo;
}
/** "Sair" com o pedido aberto, SEM Navigation API: nenhuma travessia — a página já está no destino. */
export function sairNaEntradaAtual(seguir: () => void) {
  if (typeof window === 'undefined') return;
  const g = guardiao(), t = g.tentativa;
  if (!navegacaoApi() && t) encerrar(g, t);
  seguir();
}
/**
 * O editor dono da tentativa foi DESMONTADO sem decidir (O-a): navegação programática do app com o pedido aberto — ex.: o
 * AdminShell troca a página pelo login quando a leitura da sessão falha na rede. A tentativa não pode sobreviver a ele:
 * barraria todo popstate seguinte (URL e tela incoerentes). Ela termina aqui (o guardião nunca tem movimento na fila). A
 * reativação da proteção no MESMO editor (salvar, reeditar) não passa por aqui; só a desmontagem do dono (`dono` do hook).
 */
export function abandonarTentativa(dono: object) {
  if (typeof window === 'undefined') return;
  const g = guardiao(), t = g.tentativa;
  if (t && t.a.dono === dono) encerrar(g, t);
}
/**
 * Mostra a entrada atual no roteador depois de "Sair" (sem travessia): o mesmo popstate que o navegador teria entregado
 * ao App Router (estado do Next intacto). Uma entrada sem estado do Next (nula: âncora nativa; ou de outro roteador) o App
 * Router ignora — o documento é recarregado nela (nada é escrito no estado).
 */
export function mostrarEntradaAtual() {
  if (typeof window === 'undefined') return;
  const estado = window.history.state as Record<string, unknown> | null;
  if (estado && typeof estado === 'object' && estado.__NA) window.dispatchEvent(new PopStateEvent('popstate', { state: estado }));
  else window.location.reload();
}

/**
 * Ativa a proteção do histórico para a PÁGINA atual (a do editor) até a função devolvida ser chamada. Usada pelo hook;
 * exportada para os testes comportamentais (protecao-saida.test.ts) exercitarem o guardião sem React.
 */
export function protegerHistorico(opcoes: { liberado: () => boolean; aoTentarSair: (d: DestinoSaida | null) => void; temPedido?: () => boolean; dono?: object }): () => void {
  instalarGuardiaoDeHistorico(); // normalmente já instalado no layout raiz; aqui só cobre uso fora dele (sem garantia de ordem)
  const g = guardiao();
  const nav = navegacaoApi();
  // Com o pedido aberto a URL mostra a página de destino, mas o roteador continua no editor: a proteção nova herda a
  // página e a entrada do editor da tentativa.
  if (!nav && g.tentativa) {
    const minha: Ativa = { pagina: g.tentativa.a.pagina, chave: null, indice: g.tentativa.a.indice, temPedido: () => false, dono: null, ...opcoes };
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
  const minha: Ativa = { pagina, chave: nav?.currentEntry?.key ?? null, indice, temPedido: () => false, dono: null, ...opcoes };
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
  // Dono das proteções deste editor: na DESMONTAGEM (não na reativação por `ativo`), uma tentativa dele que ainda esteja
  // aberta termina (O-a). No Strict Mode, a desmontagem simulada da montagem não encontra tentativa.
  const [dono] = useState(() => ({}));
  useEffect(() => () => abandonarTentativa(dono), [dono]);

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
    const desproteger = protegerHistorico({ liberado: () => liberado.current, temPedido: () => pendenteRef.current !== null, aoTentarSair: (d) => setPendente(d), dono });
    return () => {
      window.removeEventListener('beforeunload', antesDeSair);
      document.removeEventListener('click', aoClicar, true);
      desproteger();
    };
  }, [ativo, dono]);

  return {
    pendente,
    /** Número do pedido vigente: muda a cada pedido novo (link, Voltar/Avançar), não ao permanecer/sair. */
    pedidoAtual: () => pedido.current,
    /** Fica no editor. Sem Navigation API, com o pedido aberto, uma entrada nova do editor é criada na posição atual. */
    permanecer() { const d = pendenteRef.current; setPendente(null); if (d?.tipo === 'aqui') continuarEditando(); },
    /** Sai de fato (depois de descartar ou de salvar com sucesso), para o destino pedido. */
    sair() {
      const destino = pendenteRef.current;
      setPendente(null);
      if (!destino) return;
      liberado.current = true;
      if (destino.tipo === 'historico') { const nav = navegacaoApi(); if (nav) irPara(nav, destino.chave); return; }
      // Sem Navigation API: a página já está no destino (nenhuma travessia); só o roteador passa a mostrá-lo.
      if (destino.tipo === 'aqui') { sairNaEntradaAtual(mostrarEntradaAtual); return; }
      navegarRef.current(destino.href, false);
    },
  };
}
