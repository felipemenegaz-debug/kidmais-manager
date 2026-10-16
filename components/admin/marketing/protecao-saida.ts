'use client';
import { useEffect, useRef, useState } from 'react';

/** Para onde a pessoa tentou ir com alterações não salvas. */
export type DestinoSaida = { tipo: 'link'; href: string } | { tipo: 'voltar' };

const MARCA = '__kidmaisProtecaoSaida';

/**
 * Protege um editor com alterações não salvas contra saída silenciosa:
 * - recarregar/fechar a aba: aviso nativo do navegador (`beforeunload`);
 * - links internos (Next `<Link>` do cabeçalho, do menu lateral, de qualquer lugar da página): o clique é interceptado
 *   na fase de captura, antes do roteador, e vira um pedido de confirmação (`pendente`);
 * - voltar do navegador: enquanto há alterações, uma entrada-guarda (mesma URL) fica no histórico; voltar sai dela e vira
 *   pedido de confirmação, sem o roteador desmontar o editor.
 * Não intercepta: nova aba/janela (Ctrl/⌘/Shift/botão do meio, `target`), download, link para a mesma página (âncora)
 * nem domínio externo (esse cai no `beforeunload`). Botões internos (abas do editor, prévia) não são links e não pedem nada.
 */
export function useProtecaoDeSaida(ativo: boolean, navegar: (href: string, substituir: boolean) => void) {
  const [pendente, setPendente] = useState<DestinoSaida | null>(null);
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
    // Entrada-guarda: mesma URL, estado do roteador preservado (o Next guarda a árvore no history.state).
    const armar = () => { if (!(window.history.state as Record<string, unknown> | null)?.[MARCA]) window.history.pushState({ ...(window.history.state ?? {}), [MARCA]: true }, '', window.location.href); };
    armar();
    const aoVoltar = (e: PopStateEvent) => {
      if (liberado.current) return;
      // Captura no window: roda antes do ouvinte do roteador e o impede de navegar; a URL é a mesma (saímos da guarda).
      e.stopImmediatePropagation();
      setPendente({ tipo: 'voltar' });
    };
    window.addEventListener('beforeunload', antesDeSair);
    document.addEventListener('click', aoClicar, true);
    window.addEventListener('popstate', aoVoltar, true);
    return () => {
      window.removeEventListener('beforeunload', antesDeSair);
      document.removeEventListener('click', aoClicar, true);
      window.removeEventListener('popstate', aoVoltar, true);
      // Ficou sem alterações (salvou/descartou) e a guarda é a entrada atual: volta uma posição sem o roteador reagir.
      // Adiado: se a pessoa escolheu "Salvar e sair", `sair()` roda antes (microtarefa) e libera — aí nada é desfeito aqui.
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
    /** Fica no editor. Se veio do "voltar", recoloca a guarda. */
    permanecer() {
      if (pendente?.tipo === 'voltar' && !(window.history.state as Record<string, unknown> | null)?.[MARCA]) {
        window.history.pushState({ ...(window.history.state ?? {}), [MARCA]: true }, '', window.location.href);
      }
      setPendente(null);
    },
    /** Sai de fato (depois de descartar ou de salvar com sucesso). */
    sair() {
      const destino = pendente;
      setPendente(null);
      if (!destino) return;
      liberado.current = true;
      if (destino.tipo === 'voltar') { window.history.back(); return; }
      // Com a guarda como entrada atual, o destino a substitui: o histórico fica [..., editor, destino].
      navegarRef.current(destino.href, Boolean((window.history.state as Record<string, unknown> | null)?.[MARCA]));
    },
  };
}
