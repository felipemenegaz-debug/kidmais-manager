/**
 * S-D — salão de preferência no assistente (D5.2/R-D1). A situação vem da mesma leitura pública da tela "Conheça os
 * salões" (só salões prontos, situação calculada no servidor); o envio é conferido de novo sob a trava da data.
 */
import { apiPublica, paginaPublica } from "../../lib/fechamentos/rota-publica.ts";
import type { FatosPacote } from "./pacotes-tela.ts";

export type SalaoPreferido = { id: string; nome: string };
export type SituacaoDoPreferido = { tipo: "livre"; salao: SalaoPreferido } | { tipo: "indisponivel" };

/** Situação do salão `salaoId` no horário e convidados: livre (com o nome) ou indisponível (qualquer outro caso). */
export async function situacaoDoPreferido(
  empresa: string, salaoId: string,
  consulta: { data: string; configuracaoId: string; inicio: string; fim: string; convidados: number },
  buscar: typeof fetch = fetch,
): Promise<SituacaoDoPreferido> {
  const q = new URLSearchParams({ ...consulta, convidados: String(consulta.convidados) });
  try {
    const r = await buscar(apiPublica(`/api/publico/saloes?${q}`, empresa), { cache: "no-store" });
    if (!r.ok) return { tipo: "indisponivel" };
    const corpo = await r.json() as { data?: { saloes?: Array<{ id: string; nome: string; situacao: string }> } };
    const s = corpo.data?.saloes?.find((x) => x.id === salaoId);
    return s && s.situacao === "livre" ? { tipo: "livre", salao: { id: s.id, nome: s.nome } } : { tipo: "indisponivel" };
  } catch {
    return { tipo: "indisponivel" };
  }
}

/** O destino exato que foi ao POST (data, horário configurado, ajuste, início/fim e convidados). */
export type DestinoEnviado = { data: string; configuracaoId: string; ajuste: string; inicio: string; fim: string; convidados: number };

/**
 * E2b (R2-P2-2): o envio foi recusado com SALAO_INDISPONIVEL e `detalhes.voltarParaSaloes` (só a E2b manda). Volta à
 * escolha de salões com o MESMO destino enviado no POST (revisão de código P2-C1: no horário livre o pacote muda o fim
 * sem mudar a URL de entrada), SEM o salão (nada é pré-selecionado) e com o aviso da recusa (`aviso=salao-recusado`,
 * mais o `motivo` quando houver). Na E2a não há volta: a tela mostra o erro, como antes.
 */
export function destinoDaRecusaDoSalao(
  empresa: string | null | undefined, atuais: URLSearchParams, enviado: DestinoEnviado, falha: { codigo?: string; detalhes?: { voltarParaSaloes?: boolean; motivo?: string } } | null,
) {
  if (falha?.codigo !== "SALAO_INDISPONIVEL" || falha.detalhes?.voltarParaSaloes !== true) return null;
  const p = new URLSearchParams(atuais);
  for (const [k, v] of [["data", enviado.data], ["configuracaoId", enviado.configuracaoId], ["ajuste", enviado.ajuste],
    ["inicio", enviado.inicio], ["fim", enviado.fim], ["convidados", String(enviado.convidados)]] as const) p.set(k, v);
  p.delete("salao");
  p.set("aviso", "salao-recusado");
  if (falha.detalhes.motivo && /^[A-Z_]{1,40}$/.test(falha.detalhes.motivo)) p.set("motivo", falha.detalhes.motivo);
  else p.delete("motivo");
  return `${paginaPublica("/saloes", empresa)}?${p.toString()}`;
}

/**
 * Candidato da entrada vinda da Disponibilidade/Salões. Horário fixo: início, fim e ajuste exatos (como antes). Horário
 * livre (E2b, P2-C1): o fim depende da duração do pacote — a volta de uma recusa traz o fim enviado, que a consulta sem
 * duração não lista; casa por início e ajuste (a mesma regra da revalidação do assistente) e mantém o fim pedido. O
 * servidor confere tudo de novo no envio.
 */
export function candidatoDaEntrada<H extends { inicio: string; fim: string; ajusteMinutos: number }>(
  periodo: { codigo?: string; horarios?: H[] } | undefined, pedido: { ajuste: number; inicio: string; fim: string },
): H | null {
  const livre = periodo?.codigo === "HORARIO_LIVRE";
  const c = periodo?.horarios?.find((h) => h.ajusteMinutos === pedido.ajuste && h.inicio === pedido.inicio && (livre || h.fim === pedido.fim));
  return c ? (livre ? { ...c, fim: pedido.fim } : c) : null;
}

/** Motivo de um pacote que não é do salão de preferência (null = é do salão, ou sem preferência/sem dado). */
export function motivoForaDoSalao(fatos: FatosPacote | null, codigo: string, salao: SalaoPreferido | null) {
  if (!salao) return null;
  return fatos?.[codigo]?.noSalao === false ? `Não é oferecido no ${salao.nome}.` : null;
}
