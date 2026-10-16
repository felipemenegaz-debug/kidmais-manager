'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Para onde a pessoa tentou ir com alterações não salvas: um link interno, uma entrada do histórico (Voltar, Avançar,
 * history.go — destino pela chave da entrada) ou, sem Navigation API, o "voltar" da entrada-guarda.
 */
export type DestinoSaida = { tipo: 'link'; href: string } | { tipo: 'historico'; chave: string; url: string } | { tipo: 'voltar' };

type EntradaNavegacao = { key: string; url: string | null; index: number };
type NavegacaoApi = { currentEntry: EntradaNavegacao | null; traverseTo(chave: string): { committed?: Promise<unknown>; finished?: Promise<unknown> } };
const navegacaoApi = (): NavegacaoApi | null =>
  (typeof window !== 'undefined' && 'navigation' in window ? (window as unknown as { navigation: NavegacaoApi }).navigation : null);
/** traverseTo devolve promessas que rejeitam quando outra travessia a substitui (AbortError): esperado, não é erro. */
function irPara(nav: NavegacaoApi, chave: string) {
  const r = nav.traverseTo(chave);
  r?.committed?.catch(() => undefined); r?.finished?.catch(() => undefined);
}

/** Proteção ativa (um editor por vez): a entrada do histórico protegida e como avisar o editor. */
type Ativa = { chave: string; liberado: () => boolean; aoTentarSair: (d: DestinoSaida) => void };
let ativa: Ativa | null = null;
let instalado = false;

/**
 * Guardião do histórico (R-H1). Precisa ser instalado ANTES do ouvinte de `popstate` do App Router do Next: no window,
 * ouvintes de popstate rodam na ordem de registro (a captura não passa na frente — medido em Chrome 155) e o Next
 * registra o dele num efeito do AppRouter, depois de avaliar os módulos dos componentes. Por isso é chamado no topo de
 * components/admin/AdminShell.tsx (módulo avaliado na hidratação de qualquer página do painel).
 *
 * Com uma proteção ativa, qualquer travessia que saia da entrada protegida — Voltar, Avançar, history.go(±n), várias
 * seguidas, com o diálogo aberto ou durante um salvamento — é barrada ANTES do roteador (stopImmediatePropagation: o
 * Next não navega nem desmonta o editor), a posição volta para a entrada protegida pela CHAVE (traverseTo, absoluto: não
 * acumula deslocamentos nem cria entradas) e o editor recebe o pedido com o destino escolhido. O popstate de volta à
 * entrada protegida também é barrado (o Next nunca saiu dela). Sem proteção ativa (ou liberada), nada é interceptado.
 * Limites: precisa da Navigation API (Chrome/Edge; demais navegadores conforme suporte) — sem ela, vale o modo antigo
 * de entrada-guarda (protege só o primeiro Voltar); travessia para outro DOCUMENTO cai no aviso nativo (beforeunload).
 */
export function instalarGuardiaoDeHistorico() {
  if (instalado || typeof window === 'undefined') return;
  instalado = true;
  window.addEventListener('popstate', (e) => {
    const nav = navegacaoApi(), a = ativa;
    if (!nav?.currentEntry || !a || a.liberado()) return;
    e.stopImmediatePropagation();
    const atual = nav.currentEntry;
    if (atual.key === a.chave) return; // de volta à entrada protegida (correção nossa): o roteador nunca saiu dela
    irPara(nav, a.chave);
    a.aoTentarSair({ tipo: 'historico', chave: atual.key, url: atual.url ?? '' });
  }, true);
}

const MARCA = '__kidmaisProtecaoSaida';

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
  const geracao = useRef(0);
  const navegarRef = useRef(navegar);
  useEffect(() => { navegarRef.current = navegar; });

  useEffect(() => {
    if (!ativo) return;
    liberado.current = false;
    const contador = geracao; // contador de ativações (não é nó do React): a limpeza adiada confere se outra ativação veio depois
    contador.current++;
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

    const nav = navegacaoApi();
    if (nav?.currentEntry) {
      // Histórico pelo guardião (instalado cedo no AdminShell; a chamada aqui só cobre uso fora dele).
      instalarGuardiaoDeHistorico();
      const minha: Ativa = { chave: nav.currentEntry.key, liberado: () => liberado.current, aoTentarSair: (d) => setPendente(d) };
      ativa = minha;
      return () => {
        window.removeEventListener('beforeunload', antesDeSair);
        document.removeEventListener('click', aoClicar, true);
        if (ativa === minha) ativa = null;
      };
    }

    // Sem Navigation API: modo antigo de entrada-guarda (mesma URL e estado do roteador); protege só o primeiro Voltar.
    const armar = () => { if (!(window.history.state as Record<string, unknown> | null)?.[MARCA]) window.history.pushState({ ...(window.history.state ?? {}), [MARCA]: true }, '', window.location.href); };
    armar();
    const aoVoltar = (e: PopStateEvent) => {
      if (liberado.current) return;
      e.stopImmediatePropagation();
      setPendente({ tipo: 'voltar' });
    };
    window.addEventListener('popstate', aoVoltar, true);
    return () => {
      window.removeEventListener('beforeunload', antesDeSair);
      document.removeEventListener('click', aoClicar, true);
      window.removeEventListener('popstate', aoVoltar, true);
      // Ficou sem alterações e a guarda é a entrada atual: volta uma posição (mesma URL). Adiado: se a pessoa escolheu
      // "Salvar e sair", `sair()` roda antes (microtarefa) e libera — aí nada é desfeito aqui.
      const minhaSaida = ++contador.current;
      window.setTimeout(() => {
        if (liberado.current || contador.current !== minhaSaida || !(window.history.state as Record<string, unknown> | null)?.[MARCA]) return;
        const engolir = (ev: PopStateEvent) => { ev.stopImmediatePropagation(); window.removeEventListener('popstate', engolir, true); };
        window.addEventListener('popstate', engolir, true);
        window.history.back();
      }, 0);
    };
  }, [ativo]);

  return {
    pendente,
    /** Número do pedido vigente: muda a cada pedido novo (link, Voltar/Avançar), não ao permanecer/sair. */
    pedidoAtual: () => pedido.current,
    /** Fica no editor. No modo antigo (sem Navigation API), recoloca a entrada-guarda. */
    permanecer() {
      const atual = pendenteRef.current;
      if (atual?.tipo === 'voltar' && !(window.history.state as Record<string, unknown> | null)?.[MARCA]) {
        window.history.pushState({ ...(window.history.state ?? {}), [MARCA]: true }, '', window.location.href);
      }
      setPendente(null);
    },
    /** Sai de fato (depois de descartar ou de salvar com sucesso), para o destino pedido. */
    sair() {
      const destino = pendenteRef.current;
      setPendente(null);
      if (!destino) return;
      liberado.current = true;
      if (destino.tipo === 'historico') { const nav = navegacaoApi(); if (nav) irPara(nav, destino.chave); return; }
      if (destino.tipo === 'voltar') { window.history.back(); return; }
      // Modo antigo: com a guarda como entrada atual, o destino a substitui. Com Navigation API não há guarda: push.
      navegarRef.current(destino.href, Boolean((window.history.state as Record<string, unknown> | null)?.[MARCA]));
    },
  };
}
