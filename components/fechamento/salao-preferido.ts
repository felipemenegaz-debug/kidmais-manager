/**
 * S-D — salão de preferência no assistente (D5.2/R-D1). A situação vem da mesma leitura pública da tela "Conheça os
 * salões" (só salões prontos, situação calculada no servidor); o envio é conferido de novo sob a trava da data.
 */
import { apiPublica } from "../../lib/fechamentos/rota-publica.ts";
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

/** Motivo de um pacote que não é do salão de preferência (null = é do salão, ou sem preferência/sem dado). */
export function motivoForaDoSalao(fatos: FatosPacote | null, codigo: string, salao: SalaoPreferido | null) {
  if (!salao) return null;
  return fatos?.[codigo]?.noSalao === false ? `Não é oferecido no ${salao.nome}.` : null;
}
