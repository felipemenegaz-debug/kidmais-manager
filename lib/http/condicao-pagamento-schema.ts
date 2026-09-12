import { z } from "zod";
import { centavosComerciais } from "../comercial/condicao-pagamento";

export const valorComercialSchema = z.union([z.number(), z.string()]).refine((value) => {
  try { centavosComerciais(value); return true; } catch { return false; }
}, "Informe valor positivo com precisão de centavos.");
const entradaSchema = z.union([z.number(), z.string()]).refine((value) => {
  try { centavosComerciais(value, true); return true; } catch { return false; }
}, "Informe entrada não negativa com precisão de centavos.");
export const pretensaoPixSchema = z.object({
  entrada: entradaSchema.nullable().optional(),
  valorParcela: valorComercialSchema.nullable().optional(),
  quantidadeParcelas: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
