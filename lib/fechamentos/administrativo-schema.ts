import { z } from 'zod';
import { camposComerciaisFechamento } from './comercial-schema';

// Dados pessoais, origem e ator nunca são aceitos neste contrato de entrada.
export const fechamentoAdministrativoSchema = z.object({
    ...camposComerciaisFechamento,
    aniversarianteId: z.string().uuid(),
    responsavelAdicionalId: z.string().uuid().nullable().optional(),
    idadeAniversariante: z.union([z.number().int().min(0).max(120), z.literal('')]),
    temaFesta: z.string().trim().max(200).optional(),
    observacoesEquipe: z.string().trim().max(2000).optional(),
}).strict();
export type FechamentoAdministrativoInput = z.infer<typeof fechamentoAdministrativoSchema>;
