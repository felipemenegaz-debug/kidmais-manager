import { z } from 'zod';
import { camposComerciaisFechamento, mensagemPeriodoDoPedido, pacoteDaTelaPublicaSchema, temPeriodoDoPedido } from './comercial-schema';

// Dados pessoais, origem e ator nunca são aceitos neste contrato de entrada.
export const fechamentoAdministrativoSchema = z.object({
    ...camposComerciaisFechamento,
    /** Id V1 (dona da agenda pública) ou código do pacote da empresa (POCKET, P_…); conferido no serviço. */
    pacote: pacoteDaTelaPublicaSchema,
    aniversarianteId: z.string().uuid(),
    responsavelAdicionalId: z.string().uuid().nullable().optional(),
    idadeAniversariante: z.union([z.number().int().min(0).max(120), z.literal('')]),
    temaFesta: z.string().trim().max(200).optional(),
    observacoesEquipe: z.string().trim().max(2000).optional(),
    /** Unidade da festa (062). Conferida no servidor contra a empresa comprovada; obrigatória com mais de uma. */
    estabelecimentoId: z.string().uuid().nullable().optional(),
}).strict().refine(temPeriodoDoPedido, mensagemPeriodoDoPedido);
export type FechamentoAdministrativoInput = z.infer<typeof fechamentoAdministrativoSchema>;
