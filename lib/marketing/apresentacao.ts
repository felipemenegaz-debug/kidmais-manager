/**
 * Formatação das telas de Marketing (pura; testada sem navegador). Número desconhecido aparece como "indisponível",
 * nunca como zero inventado.
 */
export function reais(centavos: number | null | undefined) {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) return "indisponível";
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function percentual(fracao: number | null | undefined) {
  if (fracao === null || fracao === undefined || !Number.isFinite(fracao)) return "indisponível";
  return `${(fracao * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

export function dataBr(iso: string | null | undefined) {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : "—";
}

export function dataHoraBr(iso: string | null | undefined) {
  if (!iso) return "—";
  const t = Date.parse(iso.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (!Number.isFinite(t)) return dataBr(iso);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(t));
}

export const ROTULO_STATUS_CAMPANHA: Record<string, string> = { ATIVA: "Ativa", PAUSADA: "Pausada", ARQUIVADA: "Arquivada" };
export const ROTULO_STATUS_CONTATO: Record<string, string> = { NOVO: "Novo", EM_ATENDIMENTO: "Em atendimento", CONVERTIDO: "Virou negociação", DESCARTADO: "Descartado" };
export const ROTULO_ESTADO_SITE: Record<string, string> = { RASCUNHO: "Nunca publicado", PUBLICADO: "Publicado", DESPUBLICADO: "Despublicado" };
export const ROTULO_STATUS_DOMINIO: Record<string, string> = {
  PENDENTE_DNS: "Aguardando DNS", VERIFICADO: "Verificado", ATIVO: "Ativo", FALHOU: "Verificação falhou", REMOVIDO: "Removido",
};

/** Domínio simulado nunca é apresentado como ativo real. */
export function rotuloDominio(status: string, simulado: boolean) {
  const base = ROTULO_STATUS_DOMINIO[status] ?? status;
  return simulado && status !== "REMOVIDO" ? `${base} (simulado)` : base;
}

export function centavosDeTexto(texto: string): number | null {
  const limpo = texto.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!limpo.trim()) return null;
  const valor = Number(limpo);
  return Number.isFinite(valor) && valor >= 0 ? Math.round(valor * 100) : null;
}
