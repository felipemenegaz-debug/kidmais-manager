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

/**
 * Receita contratada para a tela (R3): sem valor legível nunca aparece como R$ 0,00 conhecido.
 *   COMPLETA → valor; PARCIAL → "R$ X (subtotal; N sem valor)"; INDISPONIVEL → "indisponível (N sem valor)".
 */
export function receitaContratadaTexto(l: { receitaContratadaCentavos: number | null; contratosSemValor: number; receitaContratadaSituacao: string }) {
  if (l.receitaContratadaSituacao === "INDISPONIVEL" || l.receitaContratadaCentavos === null) {
    return `indisponível${l.contratosSemValor ? ` (${l.contratosSemValor} sem valor)` : ""}`;
  }
  if (l.receitaContratadaSituacao === "PARCIAL") return `${reais(l.receitaContratadaCentavos)} (subtotal; ${l.contratosSemValor} sem valor)`;
  return reais(l.receitaContratadaCentavos);
}

type ClienteBusca = { id?: string; nomeCompleto?: string; nome_completo?: string };

/**
 * Resultados de `GET /api/admin/clientes?q=…` para os seletores do Marketing. Com termo, o CRM devolve
 * `{ cliente, cadastroCompleto, camposFaltantes }`; sem termo, o cliente direto (e já houve `{ itens }`). Achado na
 * validação de UI de 15/10/2026: os seletores liam só o formato direto e não mostravam nenhum cliente encontrado.
 */
export function clientesDaBusca(corpo: unknown): Array<{ id: string; nome: string }> {
  const data = (corpo as { data?: unknown } | null)?.data;
  const lista: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { itens?: unknown })?.itens) ? (data as { itens: unknown[] }).itens : [];
  return lista.flatMap((item) => {
    const c = ((item as { cliente?: ClienteBusca })?.cliente ?? item) as ClienteBusca;
    return typeof c?.id === "string" ? [{ id: c.id, nome: c.nomeCompleto ?? c.nome_completo ?? "Cliente" }] : [];
  });
}
