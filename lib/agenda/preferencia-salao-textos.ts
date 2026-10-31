/**
 * E2b — textos da recusa da preferência de salão (sem banco: usados pelo servidor e pela tela "Conheça os salões").
 * Nunca dizem quem ocupa nem dados de terceiros.
 */
export type MotivoPreferencia = "INELEGIVEL" | "HORARIO_NAO_PERMITE" | "PACOTE_NAO_PERMITE" | "ABAIXO_DO_MINIMO"
  | "ACIMA_DA_CAPACIDADE" | "OCUPADO_OU_LIMITE";

export const TEXTO_MOTIVO_PREFERENCIA: Record<MotivoPreferencia, string> = {
  INELEGIVEL: "Um dos salões deste conjunto não está disponível agora.",
  HORARIO_NAO_PERMITE: "Este salão não atende o horário escolhido.",
  PACOTE_NAO_PERMITE: "Este salão não é oferecido com o pacote escolhido.",
  ABAIXO_DO_MINIMO: "Este salão pede mais convidados do que o número informado.",
  ACIMA_DA_CAPACIDADE: "Este salão não comporta o número de convidados informado.",
  OCUPADO_OU_LIMITE: "Este salão não está mais livre neste horário.",
};

export const MOTIVOS_PREFERENCIA = Object.keys(TEXTO_MOTIVO_PREFERENCIA) as MotivoPreferencia[];

export const ehMotivoPreferencia = (valor: string | null | undefined): valor is MotivoPreferencia =>
  valor != null && (MOTIVOS_PREFERENCIA as string[]).includes(valor);
