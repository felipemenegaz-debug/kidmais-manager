import { z } from "zod";
import { pretensaoPixSchema } from "../http/condicao-pagamento-schema";

/**
 * Id do pacote na tela do fechamento PÚBLICO: id V1 (endereço atual) ou o código do pacote da empresa em /b/<código>
 * (POCKET, P_…). Só forma e tamanho aqui; a rota traduz com `codigoDoPacoteDaTela` pelo endereço e o banco prova que o
 * pacote é da empresa. O fechamento administrativo usa o mesmo formato; o serviço decide pela empresa comprovada.
 */
export const pacoteDaTelaPublicaSchema = z.string().min(1).max(50);

export const camposComerciaisFechamento = {
  dataFesta: z.string().min(1),
  /** Horário configurado da agenda (configuracao_agenda.id): qualquer quantidade de horários por empresa. */
  configuracaoId: z.string().uuid().optional(),
  /** Legado (TURNO_1/TURNO_2): aceito quando não vier configuracaoId; scripts e testes ainda enviam só ele. */
  horarioBase: z.enum(["almoco", "noite"]).optional(),
  // Deslocamento do candidato escolhido; tolerância e passo vêm de cada horário (só 0, ±15, ±30...).
  ajusteHorario: z.string().regex(/^-?\d{1,4}$/),
  horarioInicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  horarioFim: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  statusDisponibilidade: z.enum(["disponivel", "consulta", "excecao"]),

  pacote: z.enum([
    "pocket",
    "mini",
    "compacta",
    "essencial",
    "completa",
    "premium",
    "pizza_party_scienza",
  ]),

  convidadosPagantes: z.coerce.number().int().min(1).max(150),

  buffetDefinicao: z.enum(["agora", "depois"]),
  buffetSalgados: z.string().optional(),
  buffetBebidas: z.string().optional(),
  buffetDoces: z.string().optional(),
  buffetBolo: z.string().optional(),
  buffetOutros: z.string().optional(),
  buffetLembrancinha: z.string().trim().max(2000).optional(),
  buffetEmpratado: z.string().trim().max(2000).optional(),
  buffetBombom: z.string().trim().max(2000).optional(),

  adicionaisSelecionados: z.array(z.string()).default([]),
  adicionaisQuantidades: z.record(z.string(), z.number().int().positive().safe()).optional(),
  adicionaisEscolhas: z.record(z.string().max(80), z.array(z.uuid()).max(30)).optional(),
  alteracoesPacote: z.string().optional(),
  observacoesCliente: z.string().optional(),

  valorCombinado: z.string().min(1),

  formaPagamento: z.enum(["pix_avista", "pix_parcelado", "cartao_cielo"]),
  condicaoPixPretendida: pretensaoPixSchema.nullable().optional(),
  condicaoPagamento: z.never().optional(),
  condicaoAprovada: z.never().optional(),
  valorAprovado: z.never().optional(),
};
/** O pedido precisa identificar o horário: configuracaoId (atual) ou horarioBase (legado). */
export function temPeriodoDoPedido(d: { configuracaoId?: string; horarioBase?: string }) {
  return Boolean(d.configuracaoId || d.horarioBase);
}
export const mensagemPeriodoDoPedido = { message: "Selecione o horário da festa.", path: ["configuracaoId"] };

/** Chave da revalidação: configuracaoId quando houver; senão o código legado do turno (almoco→TURNO_1, noite→TURNO_2). */
export function periodoDoPedido(d: { configuracaoId?: string; horarioBase?: "almoco" | "noite" }): { configuracaoId: string } | { codigoPeriodo: string } {
  if (d.configuracaoId) return { configuracaoId: d.configuracaoId };
  return { codigoPeriodo: d.horarioBase === "almoco" ? "TURNO_1" : "TURNO_2" };
}

export const comercialFechamentoSchema = z.object(camposComerciaisFechamento).refine(temPeriodoDoPedido, mensagemPeriodoDoPedido);
export type ComercialFechamentoInput = z.infer<typeof comercialFechamentoSchema>;
