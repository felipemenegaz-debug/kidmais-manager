/**
 * Erros de formulário (N1/N2, plano rev. 2.1, R2-9): um mecanismo só para as telas de cliente, importação e fechamento.
 *
 * Cada erro aponta para o ID estável de um controle (parcela pelo ID gerado na criação, nunca pelo índice). O controle
 * recebe `aria-invalid` e `aria-describedby` para a mensagem logo abaixo dele; o resumo lista os erros com link; ao
 * falhar, a etapa que contém o campo é aberta antes e o primeiro campo com erro recebe rolagem e foco.
 */
export type ErroCampo = { campo: string; mensagem: string };

export const idMensagemErro = (id: string) => `${id}-erro`;

/** Primeira mensagem de cada campo, na ordem recebida (que deve ser a ordem visual do formulário). */
export function mapaErros(erros: readonly ErroCampo[]): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const e of erros) if (!(e.campo in mapa)) mapa[e.campo] = e.mensagem;
  return mapa;
}

/** Atributos do controle: `id`, `aria-invalid` e a descrição apontando para a mensagem (e para a dica, se houver). */
export function propsCampo(id: string, mensagem: string | null | undefined, dicaId?: string) {
  const descritores = [mensagem ? idMensagemErro(id) : null, dicaId ?? null].filter(Boolean).join(" ");
  return { id, "aria-invalid": mensagem ? (true as const) : undefined, "aria-describedby": descritores || undefined };
}

/** Mensagens únicas para o resumo, mantendo o vínculo com o primeiro campo de cada uma. */
export function resumoErros(erros: readonly ErroCampo[]): ErroCampo[] {
  const vistos = new Set<string>();
  return erros.filter((e) => (vistos.has(e.mensagem) ? false : (vistos.add(e.mensagem), true)));
}

type Documento = Pick<Document, "getElementById"> & { defaultView?: (Pick<Window, "matchMedia" | "requestAnimationFrame">) | null };

/** Rola até o controle e dá foco nele. Sem o controle na tela, devolve false (quem chamou decide o fallback). */
export function focarCampo(id: string, doc: Documento = document): boolean {
  const el = doc.getElementById(id) as HTMLElement | null;
  if (!el) return false;
  const reduzido = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView?.({ block: "center", behavior: reduzido ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
  return true;
}

/**
 * Foca o primeiro erro depois de a etapa/seção que o contém ser aberta (`abrir` muda o estado da tela): espera dois
 * quadros para o React pintar a etapa. Sem campo localizável, foca o resumo (`resumoId`).
 */
export function focarPrimeiroErro(erros: readonly ErroCampo[], opcoes: { abrir?: (campo: string) => void; resumoId?: string; doc?: Documento } = {}) {
  const primeiro = erros[0];
  if (!primeiro) return;
  opcoes.abrir?.(primeiro.campo);
  // Sem DOM (renderização no servidor ou teste de componente): só a etapa é aberta.
  const doc = opcoes.doc ?? (typeof document === "undefined" ? null : document);
  if (!doc) return;
  const quadro = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView) ?? ((f: FrameRequestCallback) => setTimeout(() => f(0), 16));
  quadro(() => quadro(() => {
    if (!focarCampo(primeiro.campo, doc) && opcoes.resumoId) focarCampo(opcoes.resumoId, doc);
  }));
}
