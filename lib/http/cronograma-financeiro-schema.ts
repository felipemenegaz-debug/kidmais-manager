import { z } from 'zod';
export const cronogramaFinanceiroSchema=z.object({
 posicaoHash:z.string().regex(/^[a-f0-9]{64}$/),modo:z.enum(['REPROGRAMAR','MANTER_E_COMPLEMENTAR','PERSONALIZADO','SEM_SALDO']),
 parcelas:z.array(z.object({parcelaId:z.string().uuid().transform(x=>x.toLowerCase()).optional(),valorCentavos:z.string().regex(/^[1-9]\d{0,11}$/),vencimento:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict()).max(60),
 credito:z.enum(['NAO_SE_APLICA','MANTER','APROVEITAR']),decisaoContratante:z.enum(['NAO_SE_APLICA','MANTER_APROVEITAMENTO','APROVEITAMENTO_AUTORIZADO','DEVOLUCAO_AO_PAGADOR_ANTERIOR']),justificativa:z.string().trim().min(1).max(2000),
}).strict();
