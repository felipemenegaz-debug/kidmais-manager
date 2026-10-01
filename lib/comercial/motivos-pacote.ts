/** Justificativas técnicas. A tela não pede texto ao usuário. */
export const MOTIVOS_PACOTE = {
  editado: "PACOTE_EDITADO",
  composicao: "PACOTE_COMPOSICAO_ATUALIZADA",
  ativado: "PACOTE_ATIVADO",
  desativado: "PACOTE_DESATIVADO",
  arquivado: "PACOTE_ARQUIVADO",
  duplicado: "PACOTE_DUPLICADO",
  excluido: "PACOTE_EXCLUIDO",
} as const;

export function motivoOu(informado: string | undefined, automatico: string) {
  const texto = informado?.trim() ?? "";
  return texto.length >= 3 ? texto : automatico;
}

export function motivoDaSituacao(situacao: "ativar" | "desativar" | "arquivar", informado?: string) {
  const automatico = situacao === "ativar"
    ? MOTIVOS_PACOTE.ativado
    : situacao === "desativar"
      ? MOTIVOS_PACOTE.desativado
      : MOTIVOS_PACOTE.arquivado;
  return motivoOu(informado, automatico);
}
