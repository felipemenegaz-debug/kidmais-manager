import { z } from "zod";

// Aceita números JSON e strings numéricas, sem converter booleanos/arrays em dinheiro.
export const valorMonetarioSchema = z.union([
  z.number(), z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
]).pipe(z.coerce.number<string | number>().positive());

const parcelaSchema = z.object({
  valor: valorMonetarioSchema,
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirmaReserva: z.boolean().optional(),
}).strict();

export const planoPagamentoSchema = z.object({
  meioPagamento: z.enum(["PIX", "CARTAO"]),
  modalidade: z.enum(["AVISTA", "PARCELADO"]),
  provedorPreferido: z.string().trim().max(50).nullable().optional(),
  observacoes: z.string().trim().max(1000).nullable().optional(),
  parcelas: z.array(parcelaSchema).min(1).max(60),
}).strict();
