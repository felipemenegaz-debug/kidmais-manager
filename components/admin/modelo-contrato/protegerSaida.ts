/**
 * Saídas que a tela do modelo de contrato controla (plano modelo de contrato v3, D6): cliques em links internos,
 * capturados no document antes do onClick do Link do Next, perguntam "Ficar | Sair sem salvar" quando há alteração
 * não salva. Ignorados, sem perguntar: clique já tratado, botão não principal, modificadores, target diferente de
 * _self, download, outra origem (o beforeunload cobre), âncora na própria página e data-sem-protecao (as abas de
 * Importar documentos perguntam por conta própria). Voltar do navegador, troca de empresa, Sair e sessão expirada
 * ficam fora (limite declarado).
 */
export type CliqueSaida = {
  defaultPrevented: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ancora: { href: string; target: string; download: boolean; semProtecao: boolean } | null;
};
export type LocalPagina = { origin: string; pathname: string; search: string };

/** Clique simples (sem modificador, botão principal, não tratado). */
export function cliqueComum(e: Pick<CliqueSaida, "defaultPrevented" | "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">) {
  return !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/** Destino interno (caminho + busca + hash) que pede a pergunta, ou null para deixar o clique seguir. */
export function deveConfirmarSaida(e: CliqueSaida, alterado: boolean, local: LocalPagina): string | null {
  if (!alterado || !e.ancora || !cliqueComum(e)) return null;
  const a = e.ancora;
  if (a.semProtecao || a.download || (a.target && a.target !== "_self") || !a.href) return null;
  let url: URL;
  try { url = new URL(a.href, `${local.origin}${local.pathname}${local.search}`); } catch { return null; }
  if (url.origin !== local.origin) return null;
  if (url.hash && url.pathname === local.pathname && url.search === local.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Callback das abas de Importar documentos: a tela com alteração não salva registra quem pergunta; a aba (marcada
 * data-sem-protecao, para a captura não perguntar duas vezes) chama antes de navegar. true = a tela vai perguntar.
 */
let perguntaDasAbas: ((destino: string) => boolean) | null = null;
export function registrarPerguntaDasAbas(fn: ((destino: string) => boolean) | null) { perguntaDasAbas = fn; }
export function abaPrecisaPerguntar(destino: string) { return perguntaDasAbas?.(destino) ?? false; }

export const PERGUNTA_SAIDA ="Você tem alterações não salvas.";
export const PERGUNTA_SAIDA_ENVIO = "O último salvamento ainda não foi confirmado e pode ser concluído depois que você sair.";
export const AJUDA_LIMITE = "Salve antes de sair. Voltar pelo navegador, trocar de empresa, sair da conta ou a sessão expirar podem perder alterações não salvas sem a pergunta desta tela.";
