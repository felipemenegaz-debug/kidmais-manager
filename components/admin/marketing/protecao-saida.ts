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
 * Uma tentativa de saída interceptada SEM Navigation API, do primeiro popstate barrado até a volta à entrada do editor.
 * Pertence à proteção que a interceptou e termina sempre: na entrada do editor (com o pedido) ou, se houve saída
 * explícita (liberado), abandonada para a navegação escolhida vencer.
 */
type Tentativa = {
  a: Ativa;
  deslocamento: number;        // soma dos NOSSOS movimentos desde a entrada de destino (cada um confirmado pelo próprio popstate)
  emVoo: number | null;        // movimento pedido (history.go) ainda sem popstate
  faixa: [number, number] | null; // índices possíveis na chegada do salto em voo (fora dela, o popstate é de outra travessia)
  pagina: string | null;       // página certa da chegada do passo −1 em voo a partir de um fragmento (a entrada que o originou)
  direcao: -1 | 1 | 0;         // passo quando a entrada atual não tem índice; 0 = ainda desconhecida (chegada da pessoa)
  inverteu: boolean;
  timer: number | null;        // espera para travessias seguidas assentarem
  vigia: number | null;        // salvaguarda: movimento sem popstate (só se uma premissa da representação falhar)
};
/**
 * `inicial`: a entrada em que o documento começou, quando ela não tem índice (estado nulo antes da hidratação, ou não
 * objeto). Ela fica ATRÁS de todas as indexadas deste documento — dado que orienta a direção para uma entrada sem índice.
 * `maior`: maior índice já dado. `incerto`: a entrada atual é sem índice e foi alcançada por travessia — a entrada indexada
 * que a precede é desconhecida. `contiguo`: os índices não têm lacunas ao longo do histórico (um salto de k−j nunca passa
 * da entrada k); deixa de valer se uma entrada for criada a partir de uma posição incerta. `comprimento`: último
 * history.length visto (distingue fragmento NOVO, que muda o comprimento, de travessia).
 */
type Guardiao = {
  instalado: boolean; ativa: Ativa | null; indiceAtual: number; maior: number; incerto: boolean; contiguo: boolean; comprimento: number;
  paginas: Map<number, string>; inicial: { indice: number; pagina: string; url: string } | null; tentativa: Tentativa | null;
};
/** Estado único por janela (Strict Mode e Fast Refresh reavaliam o módulo; o guardião e o índice são um só). */
function guardiao(): Guardiao {
  const w = window as unknown as { __kidmaisGuardiaoHistorico?: Guardiao };
  return (w.__kidmaisGuardiaoHistorico ??= { instalado: false, ativa: null, indiceAtual: 0, maior: 0, incerto: false, contiguo: true, comprimento: 0, paginas: new Map(), inicial: null, tentativa: null });
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
/** Sem popstate depois de um history.go: não havia entrada naquela direção (no-op). */
const VIGIA_MS = 800;

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
  window.history.pushState = function pushState(dados: unknown, _nao: string, url?: string | URL | null) {
    if (g.incerto) {
      // A entrada indexada que precede a atual é desconhecida: o índice novo é único e maior que todos os anteriores (a
      // ordem continua valendo), mas pode deixar lacuna — os saltos dão lugar a passos.
      g.indiceAtual = g.maior + 1; g.contiguo = false;
    } else {
      g.indiceAtual += 1;
      for (const i of [...g.paginas.keys()]) if (i >= g.indiceAtual) g.paginas.delete(i); // entradas à frente foram descartadas
    }
    g.maior = Math.max(g.maior, g.indiceAtual); g.incerto = false;
    const r = empilhar(comIndice(dados, g.indiceAtual), _nao, url);
    g.comprimento = window.history.length;
    if (indiceDe(window.history.state) !== null) g.paginas.set(g.indiceAtual, paginaDe(window.location.href));
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
    } else if (eraInicial && window.history.state === null) {
      g.inicial = { indice: g.inicial!.indice, pagina: paginaDe(window.location.href), url: window.location.href }; // continua sem estado
    }
    return r;
  };
}
/** A entrada atual é a inicial do documento (sem estado; a anterior a ela, se houver, é de outro documento). */
function naInicial(g: Guardiao, url = window.location.href) {
  return !!g.inicial && window.history.state === null && url === g.inicial.url;
}

// ---- Tentativa de saída SEM Navigation API ----
function limparTimers(t: Tentativa) {
  if (t.timer !== null) window.clearTimeout(t.timer);
  if (t.vigia !== null) window.clearTimeout(t.vigia);
  t.timer = null; t.vigia = null;
}
function encerrar(g: Guardiao, t: Tentativa) { limparTimers(t); if (g.tentativa === t) g.tentativa = null; }
/** Chegou de volta à entrada do editor: só agora o pedido vai ao editor (URL e página coerentes). */
function concluirRetorno(g: Guardiao, t: Tentativa) {
  encerrar(g, t);
  // O pedido vai à proteção VIGENTE do editor (se a de origem foi desativada e outra ativada na mesma página, é ela que
  // decide); o callback antigo não é chamado. Saída explícita (liberado) já decidiu: nada a perguntar.
  const alvo = g.ativa && g.ativa.pagina === t.a.pagina ? g.ativa : t.a;
  if (alvo.liberado() || t.a.liberado() || t.deslocamento === 0) return;
  alvo.aoTentarSair({ tipo: 'relativo', delta: -t.deslocamento });
}
/**
 * Direção do primeiro passo a partir de uma entrada sem índice alcançada pela PESSOA (posição desconhecida). Só escolhe
 * passos que TÊM destino, para que todo movimento da correção produza o próprio popstate (H1):
 *  - a entrada inicial do documento está atrás de todas as indexadas: +1 (o editor está à frente);
 *  - qualquer outra entrada sem índice nasceu de uma entrada anterior DESTE documento (fragmento, location.hash): −1 sempre
 *    existe — mesmo que se afaste do editor, chega à entrada que a originou e de lá a volta segue por índice;
 *  - +1 só quando é certo que o editor está à frente: todas as entradas indexadas desta página estão atrás dele.
 */
function direcaoProvavel(g: Guardiao, pagina: string, a: Ativa): -1 | 1 {
  if (naInicial(g)) return 1;
  if (!g.contiguo) return -1; // mapa de páginas pode não refletir mais a ordem: só o passo que sempre existe
  const da = [...g.paginas].filter(([, p]) => p === pagina).map(([i]) => i);
  return da.length > 0 && da.every((i) => i < a.indice!) ? 1 : -1;
}
function avancar(g: Guardiao, t: Tentativa) {
  t.timer = null;
  if (g.tentativa !== t) return;
  if (t.a.liberado()) { encerrar(g, t); return; } // saída explícita (descartar/salvar e sair/link) venceu
  if (t.emVoo !== null) return; // um movimento nosso ainda está na fila: o popstate dele vem antes de qualquer outro passo
  const idx = indiceDe(window.history.state), k = t.a.indice!;
  if (idx === k) { concluirRetorno(g, t); return; }
  let mov: number;
  if (idx !== null && !t.inverteu) {
    // Salto que nunca passa da entrada do editor (entradas sem índice só aumentam a distância real); com lacunas nos índices,
    // passo. Daqui em diante a direção do editor é conhecida.
    mov = g.contiguo ? k - idx : Math.sign(k - idx);
    t.direcao = mov > 0 ? 1 : -1;
    t.faixa = mov > 0 ? [idx + 1, k] : [k, idx - 1]; t.pagina = null;
  } else {
    // Sem índice — ou índice que já se mostrou falso (a salvaguarda inverteu): passo na direção corrente.
    if (idx === null && naInicial(g)) t.direcao = 1;
    else if (!t.direcao) t.direcao = direcaoProvavel(g, paginaDe(window.location.href), t.a);
    mov = t.direcao; t.faixa = null;
    // A entrada anterior a um fragmento é a que o originou: mesma página (caminho + busca).
    t.pagina = mov === -1 && idx === null ? paginaDe(window.location.href) : null;
  }
  t.emVoo = mov;
  window.history.go(mov);
  armarVigia(g, t, mov);
}
function armarVigia(g: Guardiao, t: Tentativa, mov: number) {
  if (t.vigia !== null) window.clearTimeout(t.vigia);
  t.vigia = window.setTimeout(() => semMovimento(g, t, mov), VIGIA_MS);
}
/**
 * Salvaguarda: history.go sem popstate. Pela escolha dos movimentos isso só ocorre se uma premissa da representação falhar
 * (ex.: índices duplicados de antes desta versão). Um salto vira passos; um passo inverte uma vez; depois, desiste sem
 * deixar estado preso. O movimento sem popstate NUNCA entra no deslocamento.
 */
function semMovimento(g: Guardiao, t: Tentativa, mov: number) {
  t.vigia = null;
  if (g.tentativa !== t) return;
  t.emVoo = null; t.faixa = null; t.pagina = null;
  if (Math.abs(mov) > 1) { g.contiguo = false; avancar(g, t); return; }
  if (!t.inverteu && t.direcao) { t.inverteu = true; t.direcao = t.direcao === 1 ? -1 : 1; avancar(g, t); return; }
  encerrar(g, t);
}

/**
 * Guardião do histórico (R-H1 / R-H1-F / F1–F3). Precisa ouvir `popstate` ANTES do App Router do Next (no window vale a
 * ordem de registro — medido em Chrome 155). Instalado no LAYOUT RAIZ (components/InstalarGuardiaoHistorico.tsx).
 *
 * Proteção por PÁGINA (caminho + busca) do editor: com alterações não salvas,
 *  - travessia para uma entrada da PRÓPRIA página (ex.: fragmentos da prévia, #orcamento) é livre e silenciosa — barrada
 *    só para o roteador (que já está nesta página), sem diálogo;
 *  - travessia para OUTRA página (Voltar, Avançar, history.go(±n), várias seguidas, durante salvamento) é barrada antes do
 *    roteador; volta-se à entrada do editor e o pedido vai ao editor com o destino escolhido;
 *  - com um pedido aberto (diálogo), qualquer travessia que saia da entrada do editor conta como nova tentativa.
 *   COM Navigation API: volta pela CHAVE (traverseTo, absoluto).
 *   SEM Navigation API: volta à entrada INDEXADA do editor por saltos que nunca a ultrapassam e passos onde não há índice,
 *   escolhidos para SEMPRE ter destino (H1): cada movimento nosso produz o próprio popstate, e um popstate da pessoa no
 *   meio da volta redefine o destino para onde ela chegou. O destino é o deslocamento REAL medido pelos próprios movimentos.
 * Uma travessia interceptada sempre termina: mesmo se a proteção cair durante a volta (ex.: o salvamento terminou), a volta
 * se completa e o pedido é apresentado (a pessoa decide). Só uma saída explícita (liberado) a abandona — a navegação
 * escolhida vence. Sem proteção ativa, nada é interceptado. Travessia para outro DOCUMENTO cai no beforeunload.
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
    if (!nav) {
      if (idx !== null) { g.indiceAtual = idx; g.incerto = false; g.paginas.set(idx, paginaDe(window.location.href)); }
      else if (window.history.length === g.comprimento) g.incerto = true; // travessia até entrada sem índice (fragmento novo muda o comprimento)
      g.comprimento = window.history.length;
    }

    const t = g.tentativa;
    if (!nav && t) {
      // Volta em andamento: todo popstate é da correção (ou da pessoa no meio dela) e não vai ao roteador.
      e.stopImmediatePropagation();
      if (t.vigia !== null) { window.clearTimeout(t.vigia); t.vigia = null; }
      // As travessias são atendidas em ordem e todo movimento nosso tem destino (direcaoProvavel/avancar): o popstate seguinte
      // ao nosso history.go é dele — salvo se a chegada for impossível para ele (fora da faixa do salto, ou outra página
      // depois de um passo −1 a partir de fragmento). Aí é uma travessia da pessoa que já estava na fila; o nosso movimento
      // continua pendente e será aplicado a partir de onde ela chegou.
      const emVoo = t.emVoo;
      const nosso = emVoo !== null
        && (idx === null || !t.faixa || (idx >= t.faixa[0] && idx <= t.faixa[1]))
        && (!t.pagina || paginaDe(window.location.href) === t.pagina);
      if (nosso) { t.deslocamento += emVoo; t.emVoo = null; }
      else {
        t.deslocamento = 0; t.direcao = 0; // travessia da pessoa: o destino é onde ela chegou agora; a posição volta a ser desconhecida
        if (emVoo !== null) armarVigia(g, t, emVoo); // o nosso, ainda na fila, chega depois (ou não tem destino: a salvaguarda o descarta)
      }
      t.faixa = null; t.pagina = null;
      if (idx === t.a.indice && t.emVoo === null) { concluirRetorno(g, t); return; }
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
    const nova: Tentativa = { a, deslocamento: 0, emVoo: null, faixa: null, pagina: null, direcao: 0, inverteu: false, timer: null, vigia: null };
    g.tentativa = nova;
    nova.timer = window.setTimeout(() => avancar(g, nova), ASSENTAR_MS);
  }, true);
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
      const candidatos = [...g.paginas].filter(([i, p]) => p === pagina && i <= g.indiceAtual).map(([i]) => i);
      indice = candidatos.length ? Math.max(...candidatos) : null;
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
      if (destino.tipo === 'relativo') { window.history.go(destino.delta); return; }
      navegarRef.current(destino.href, false);
    },
  };
}
