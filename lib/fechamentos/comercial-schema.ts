import { z } from "zod";
import { pretensaoPixSchema } from "../http/condicao-pagamento-schema";

export const camposComerciaisFechamento = {
  dataFesta: z.string().min(1),
  horarioBase: z.enum(["almoco", "noite"]),
  ajusteHorario: z.enum(["-30", "0", "30"]),
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
  alteracoesPacote: z.string().optional(),
  observacoesCliente: z.string().optional(),

  valorCombinado: z.string().min(1),

  formaPagamento: z.enum(["pix_avista", "pix_parcelado", "cartao_cielo"]),
  condicaoPixPretendida: pretensaoPixSchema.nullable().optional(),
  condicaoPagamento: z.never().optional(),
  condicaoAprovada: z.never().optional(),
  valorAprovado: z.never().optional(),
};
export const comercialFechamentoSchema = z.object(camposComerciaisFechamento);
export type ComercialFechamentoInput = z.infer<typeof comercialFechamentoSchema>;
