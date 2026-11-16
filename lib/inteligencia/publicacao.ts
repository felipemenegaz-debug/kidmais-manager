import type { Workload } from "./contratos.ts";
import type { Ambiente } from "./flags.ts";
import { orcamentoDoAmbiente } from "./modelos/orcamento.ts";
import { ordemProvedores, politicaDoAmbiente } from "./modelos/roteador.ts";

/**
 * Estado da IA do atendimento pelo WhatsApp para a conferência pré-publicação dos textos legais (D-OF-1). O Core não
 * importa a IA: o script de conferência calcula isto e entrega só booleanos (nenhum valor do ambiente sai daqui).
 *
 * - provedorOpenAi: todo workload do atendimento (Wall-e e fase B) só pode chamar a OpenAI, a única descrita nos textos.
 *   Fallback ligado inclui o DeepSeek e reprova.
 * - tetoEmpresa / tetoCapacidade: AI_BUDGET_JSON válido com um limite MENSAL positivo (custoMensal ou tokensMensal) em
 *   `porEmpresa` e em `porCapacidade.whatsapp_atendimento` (a capacidade usada pelo atendimento). Os Termos prometem
 *   "um teto mensal de processamento" (Astra r3, P2-3): limite só diário não basta.
 */
export const WORKLOADS_WHATSAPP_ATENDIMENTO: readonly Workload[] = ["INTERPRETAR_CONVERSA", "FAQ"];
export const CAPACIDADE_WHATSAPP_ATENDIMENTO = "whatsapp_atendimento";

type Limites = { custoDiario?: number; custoMensal?: number; tokensDiario?: number; tokensMensal?: number } | undefined;
const temLimiteMensal = (l: Limites) => !!l && [l.custoMensal, l.tokensMensal].some((v) => v !== undefined && v > 0);

export function estadoWhatsappIaParaPublicacao(env: Ambiente) {
  const politica = politicaDoAmbiente(env);
  const provedorOpenAi = WORKLOADS_WHATSAPP_ATENDIMENTO.every((w) => {
    const ordem = ordemProvedores(politica, w);
    return ordem.length > 0 && ordem.every((id) => id === "OPENAI");
  });
  const orcamento = orcamentoDoAmbiente(env);
  const valido = typeof orcamento !== "string";
  return {
    provedorOpenAi,
    tetoEmpresa: valido && temLimiteMensal(orcamento.porEmpresa),
    tetoCapacidade: valido && temLimiteMensal(orcamento.porCapacidade?.[CAPACIDADE_WHATSAPP_ATENDIMENTO]),
  };
}
