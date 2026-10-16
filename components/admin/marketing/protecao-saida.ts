'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Para onde a pessoa tentou ir com alterações não salvas: um link interno, uma entrada do histórico pela chave
 * (Navigation API) ou pelo deslocamento relativo à entrada do editor (sem Navigation API), ou só "voltar" (entrada sem
 * índice conhecido).
 */
export type DestinoSaida = { tipo: 'link'; href: string } | { tipo: 'historico'; chave: string; url: string } | { tipo: 'relativo'; delta: number } | { tipo: 'voltar' };

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

/** Proteção ativa (um editor por vez): a entrada protegida (chave ou índice) e como avisar o editor. */
type Ativa = { chave: string | null; indice: number | null; liberado: () => boolean; aoTentarSair: (d: DestinoSaida) => void };
let ativa: Ativa | null = null;
let instalado = false;

// ---- Índice próprio do histórico (só SEM Navigation API) ----
// Cada entrada criada por pushState recebe __kidmaisIdx (posição relativa no documento); replaceState mantém a posição.
// Os campos existentes (inclusive os internos do Next: __NA, árvore) são PRESERVADOS — o objeto é copiado com um campo a
// mais; estado nulo continua nulo (o Next trata nulo e objeto sem __NA de formas diferentes). Entradas criadas antes da
// instalação não têm índice (ver limites em docs/MARKETING_UX_RH1F_20261016.md).
const CAMPO_INDICE = '__kidmaisIdx';
let indiceAtual = 0;
const indiceDe = (estado: unknown): number | null => {
  const v = (estado as Record<string, unknown> | null)?.[CAMPO_INDICE];
  return typeof v === 'number' ? v : null;
};
const comIndice = (estado: unknown, indice: number) => (estado && typeof estado === 'object' ? { ...(estado as Record<string, unknown>), [CAMPO_INDICE]: indice } : estado);
/** Espera curta para várias travessias seguidas (vários Voltar, history.go) assentarem antes de um retorno único. */
const ASSENTAR_MS = 40;

function instalarIndiceDoHistorico() {
  const empilhar = window.history.pushState.bind(window.history);
  const substituir = window.history.replaceState.bind(window.history);
  const existente = indiceDe(window.history.state);
  if (existente !== null) indiceAtual = existente; // recarregou: a posição continua no estado da entrada
  else if (window.history.state && typeof window.history.state === 'object') substituir(comIndice(window.history.state, indiceAtual), '');
  window.history.pushState = function pushState(dados: unknown, _nao: string, url?: string | URL | null) {
    indiceAtual += 1; return empilhar(comIndice(dados, indiceAtual), _nao, url);
  };
  window.history.replaceState = function replaceState(dados: unknown, _nao: string, url?: string | URL | null) {
    return substituir(comIndice(dados, indiceAtual), _nao, url);
  };
}

/**
 * Guardião do histórico (R-H1/R-H1-F). Precisa ouvir `popstate` ANTES do App Router do Next: no window, ouvintes de
 * popstate rodam na ordem de registro (a captura não passa na frente — medido em Chrome 155) e o Next registra o dele
 * num efeito do AppRouter. Por isso é instalado no LAYOUT RAIZ (components/InstalarGuardiaoHistorico.tsx, avaliado na
 * hidratação de qualquer documento) — inclusive quando se entra no painel por navegação cliente a partir de outro
 * layout (not-found, /acesso, /cadastro, /desenvolvedor), caso em que o módulo do AdminShell só é avaliado depois.
 *
 * Com uma proteção ativa, qualquer travessia que saia da entrada protegida — Voltar, Avançar, history.go(±n), várias
 * seguidas, com o diálogo aberto ou durante um salvamento — é barrada antes do roteador (stopImmediatePropagation: o
 * Next não navega nem desmonta o editor), a posição volta para a entrada protegida e o editor recebe o pedido com o
 * destino escolhido. Sem proteção ativa (ou liberada), nada é interceptado.
 *   - COM Navigation API: volta pela CHAVE (traverseTo, absoluto).
 *   - SEM Navigation API: volta pelo índice próprio (history.go(protegida − atual)), depois de as travessias seguidas
 *     assentarem (um retorno só, sem acumular deslocamentos).
 * Travessia para outro DOCUMENTO não passa por aqui: cai no aviso nativo (beforeunload).
 */
export function instalarGuardiaoDeHistorico() {
  if (instalado || typeof window === 'undefined') return;
  instalado = true;
  if (!navegacaoApi()) instalarIndiceDoHistorico();
  let reparo: number | null = null;
  // Uma TENTATIVA de saída (um ou vários Voltar/Avançar seguidos) e as travessias da própria correção até voltar.
  let corrigindo = false, passosSemIndice = 0, ultimoSemIndice = false;
  let destinoDaTentativa: DestinoSaida | null = null;
  window.addEventListener('popstate', (e) => {
    const nav = navegacaoApi(), a = ativa;
    const indice = indiceDe(e.state);
    if (!nav && indice !== null) indiceAtual = indice;
    if (!a || a.liberado()) return;
    if (nav?.currentEntry && a.chave) {
      e.stopImmediatePropagation();
      const atual = nav.currentEntry;
      if (atual.key === a.chave) return; // de volta à entrada protegida (correção nossa): o roteador nunca saiu dela
      irPara(nav, a.chave);
      a.aoTentarSair({ tipo: 'historico', chave: atual.key, url: atual.url ?? '' });
      return;
    }
    if (a.indice === null) return;
    e.stopImmediatePropagation();
    ultimoSemIndice = indice === null;
    if (indice === a.indice && reparo === null) {
      // De volta à entrada protegida (correção nossa): só agora o pedido vai ao editor — URL e página coerentes.
      corrigindo = false; passosSemIndice = 0;
      if (destinoDaTentativa) { const d = destinoDaTentativa; destinoDaTentativa = null; a.aoTentarSair(d); }
      return;
    }
    if (reparo !== null) window.clearTimeout(reparo);
    reparo = window.setTimeout(() => {
      reparo = null;
      if (ativa !== a || a.liberado()) return;
      if (ultimoSemIndice) {
        // Entrada criada antes da instalação (sem índice): só pode estar ATRÁS das indexadas — avança um passo por vez.
        passosSemIndice += 1; corrigindo = true;
        if (!destinoDaTentativa) destinoDaTentativa = { tipo: 'voltar' };
        window.history.go(1);
        return;
      }
      if (indiceAtual === a.indice) { if (destinoDaTentativa) { const d = destinoDaTentativa; destinoDaTentativa = null; corrigindo = false; a.aoTentarSair(d); } return; }
      const delta = indiceAtual - a.indice!;
      // Destino da TENTATIVA (não das paradas da própria correção); entradas sem índice: posição pelos passos dados.
      if (!corrigindo) destinoDaTentativa = { tipo: 'relativo', delta };
      else if (passosSemIndice > 0) destinoDaTentativa = { tipo: 'relativo', delta: indiceAtual - passosSemIndice - a.indice! };
      corrigindo = true; passosSemIndice = 0;
      window.history.go(-delta);
    }, ASSENTAR_MS);
  }, true);
}

/**
 * Ativa a proteção do histórico para a entrada ATUAL (a do editor) até a função devolvida ser chamada. Usada pelo hook;
 * exportada para os testes comportamentais (protecao-saida.test.ts) exercitarem o guardião sem React.
 */
export function protegerHistorico(opcoes: { liberado: () => boolean; aoTentarSair: (d: DestinoSaida) => void }): () => void {
  instalarGuardiaoDeHistorico(); // normalmente já instalado no layout raiz; aqui só cobre uso fora dele (sem garantia de ordem)
  const nav = navegacaoApi();
  let indice: number | null = null;
  if (!nav) {
    indice = indiceDe(window.history.state);
    // Entrada sem índice (criada antes da instalação) e com estado objeto: recebe o índice atual, preservando o estado.
    if (indice === null && window.history.state && typeof window.history.state === 'object') { window.history.replaceState(window.history.state, ''); indice = indiceDe(window.history.state); }
  }
  const minha: Ativa = { chave: nav?.currentEntry?.key ?? null, indice, ...opcoes };
  ativa = minha;
  return () => { if (ativa === minha) ativa = null; };
}

/**
 * Protege um editor com alterações não salvas contra saída silenciosa:
 * - recarregar/fechar a aba: aviso nativo do navegador (`beforeunload`);
 * - links internos (Next `<Link>` do cabeçalho, do menu lateral, de qualquer lugar da página): o clique é interceptado
 *   na fase de captura, antes do roteador, e vira um pedido de confirmação (`pendente`);
 * - histórico (Voltar/Avançar/history.go, uma ou várias vezes): ver `instalarGuardiaoDeHistorico`.
 * Não intercepta: nova aba/janela (Ctrl/⌘/Shift/botão do meio, `target`), download, link para a mesma página (âncora)
 * nem domínio externo (esse cai no `beforeunload`). Botões internos (abas do editor, prévia) não são links e não pedem nada.
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

    const desproteger = protegerHistorico({ liberado: () => liberado.current, aoTentarSair: (d) => setPendente(d) });
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
      if (destino.tipo === 'voltar') { window.history.back(); return; }
      navegarRef.current(destino.href, false);
    },
  };
}
