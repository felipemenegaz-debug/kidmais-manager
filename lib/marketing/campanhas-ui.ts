/** Constantes e montagem de link usadas pelas telas (sem dependência de servidor). */
export const CANAIS_CAMPANHA_UI = ["GOOGLE", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "EMAIL", "INDICACAO", "OFFLINE", "OUTRO"] as const;
export const ROTULO_CANAL_UI: Record<(typeof CANAIS_CAMPANHA_UI)[number], string> = {
  GOOGLE: "Google", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp", EMAIL: "E-mail",
  INDICACAO: "Indicação", OFFLINE: "Material impresso / offline", OUTRO: "Outro",
};

/** Link rastreável que a campanha divulga: passa pelo registro de clique antes da página do site. */
export function linkDaCampanha(origemPlataforma: string, slugSite: string, codigoCampanha: string) {
  return `${origemPlataforma.replace(/\/+$/, "")}/s/${encodeURIComponent(slugSite)}/c/${encodeURIComponent(codigoCampanha)}`;
}
