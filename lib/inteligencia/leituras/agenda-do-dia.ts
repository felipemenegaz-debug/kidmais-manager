import { z } from "zod";
import { agendaDoTenant, type FestaAgenda } from "../../festas/leitura-tenant.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, dataCurta, evidencia, fato, montarResposta, plural, somarDias } from "./comum.ts";

/** `agenda_do_dia`: festas de hoje (ou amanhã), com horário, pacote e convidados. */
const FONTE = "festas.agenda";
const parametrosSchema = z.object({ dia: z.enum(["hoje", "amanha"]).optional() }).strict();

const STATUS: Readonly<Record<string, string>> = { ASSINADO: "Confirmada", AGUARDANDO_ASSINATURA: "Contrato pendente", CANCELADO: "Cancelada" };

export function montarAgenda(festas: readonly FestaAgenda[], dia: string, contexto: ContextoFerramenta): RespostaLeitura {
  const rotuloDia = dia === contexto.hoje ? "hoje" : `em ${dataCurta(dia)}`;
  const ativas = festas.filter((f) => f.contratoStatus !== "CANCELADO");
  if (ativas.length === 0) {
    return montarResposta("agenda_do_dia", contexto, {
      estado: "sem_dados",
      resumo: `Nenhuma festa ${rotuloDia}.`,
      fatos: [ausencia(`Nenhuma festa ativa registrada ${rotuloDia}.`, FONTE)],
      fontes: [FONTE],
    });
  }
  const pendentes = ativas.filter((f) => f.contratoStatus !== "ASSINADO");
  const convidados = ativas.reduce((total, f) => total + f.convidados, 0);
  return montarResposta("agenda_do_dia", contexto, {
    estado: pendentes.length ? "atencao" : "informativo",
    resumo: `${ativas.length} ${plural(ativas.length, "festa", "festas")} ${rotuloDia}, ${convidados} convidados no total${pendentes.length ? `; ${pendentes.length} com contrato ainda não assinado` : ""}.`,
    fatos: [
      fato(`${ativas.length} ${plural(ativas.length, "festa ativa", "festas ativas")} ${rotuloDia}.`, FONTE),
      { natureza: "CALCULO", texto: `Soma de convidados contratados: ${convidados}.`, fonte: FONTE },
      ...(pendentes.length ? [fato(`${pendentes.length} sem contrato assinado.`, FONTE)] : []),
    ],
    itens: ativas.map((f) => ({
      id: f.festaId,
      prioridade: f.contratoStatus === "ASSINADO" ? "baixa" as const : "alta" as const,
      titulo: `${f.horaInicio}${f.horaFim ? `–${f.horaFim}` : ""} · ${f.cliente}`,
      detalhe: `${f.pacote} · ${f.convidados} convidados · ${STATUS[f.contratoStatus] ?? f.contratoStatus}`,
      destino: `/admin/festas/${f.festaId}`,
    })),
    evidencias: [evidencia(FONTE, `Festas ${rotuloDia}`, ativas.length, "/admin/disponibilidade")],
    fontes: [FONTE],
  });
}

export const agendaDoDia: Ferramenta<RespostaLeitura> = {
  nome: "festas.agenda.dia",
  capacidade: "agenda_do_dia",
  classe: "READ",
  grupo: "READ",
  entrada: parametrosSchema,
  papeis: PAPEIS_ADMIN,
  descricao: "Festas de hoje com horário, pacote, convidados e situação do contrato.",
  preparar(parametros) {
    const { dia } = parametrosSchema.parse(parametros);
    return async (tx, tenant, contexto) => {
      const alvo = dia === "amanha" ? somarDias(contexto.hoje, 1) : contexto.hoje;
      return montarAgenda(await agendaDoTenant(tx, tenant.empresaComprovada, alvo, alvo, 50), alvo, contexto);
    };
  },
};
