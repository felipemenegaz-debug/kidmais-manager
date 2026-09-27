export type FaseAcao = "idle" | "editing" | "submitting" | "error";

export type AcaoFinanceira = {
  fase: FaseAcao;
  chave: string | null;
};

export function acaoInicial(): AcaoFinanceira {
  return { fase: "idle", chave: null };
}

/**
 * idle → editing. Durante submitting a ação não reabre e a chave não muda.
 * editing/error mantêm a chave já gerada.
 */
export function abrirAcao(acao: AcaoFinanceira, novaChave: () => string): AcaoFinanceira {
  if (acao.fase === "submitting") return acao;
  if (acao.chave && (acao.fase === "editing" || acao.fase === "error")) return acao;
  return { fase: "editing", chave: novaChave() };
}

/** editing/error → submitting. Uma segunda confirmação enquanto envia não dispara outra operação. */
export function confirmarAcao(acao: AcaoFinanceira): AcaoFinanceira | null {
  if ((acao.fase !== "editing" && acao.fase !== "error") || !acao.chave) return null;
  return { fase: "submitting", chave: acao.chave };
}

export function finalizarAcao(acao: AcaoFinanceira, resultado: "sucesso" | "erro"): AcaoFinanceira {
  if (acao.fase !== "submitting" || !acao.chave) return acao;
  if (resultado === "sucesso") return acaoInicial();
  return { fase: "error", chave: acao.chave };
}
