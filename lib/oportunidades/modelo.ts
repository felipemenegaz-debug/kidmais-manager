import { z } from 'zod';

export const TIPOS_ACAO = ['Ligar', 'WhatsApp', 'Enviar proposta', 'Visita', 'Cobrar'] as const;
export const MOTIVOS_PERDA = ['Preço', 'Data ocupada', 'Fechou com outro buffet', 'Desistiu da festa', 'Parou de responder', 'Outro'] as const;
export const ETAPAS = ['Novo contato', 'Proposta', 'Contrato', 'Sinal'] as const;
export function etapaDoEstado(status: string, contato = false): typeof ETAPAS[number] | null {
  if (contato) return ['NOVO', 'EM_ATENDIMENTO'].includes(status) ? 'Novo contato' : null;
  if (['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADO'].includes(status)) return 'Proposta';
  if (status === 'AGUARDANDO_CONTRATO') return 'Contrato';
  if (['CONTRATO_ASSINADO', 'AGUARDANDO_PAGAMENTO'].includes(status)) return 'Sinal';
  return null;
}
export const alvoSchema = z.object({ tipo: z.enum(['CONTATO', 'FECHAMENTO']), id: z.string().uuid() }).strict();
const data = z.iso.date();
export const proximaSchema = z.object({ tipo: z.enum(TIPOS_ACAO), data, observacao: z.string().trim().max(1000).optional(), responsavelId: z.string().uuid() }).strict();
export const perdaSchema = z.object({ motivo: z.enum(MOTIVOS_PERDA), observacao: z.string().trim().max(1000).optional() }).strict()
  .refine(p => p.motivo !== "Outro" || Boolean(p.observacao), { path: ["observacao"], message: "Explique o motivo Outro." });
export const comandoSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('agendar'), alvo: alvoSchema, esperada: z.string().uuid().nullable(), proxima: proximaSchema }).strict(),
  z.object({ acao: z.literal('concluir'), alvo: alvoSchema, esperada: z.string().uuid(), proxima: proximaSchema }).strict(),
  z.object({ acao: z.literal('perder'), alvo: alvoSchema, esperada: z.string().uuid().nullable(), perda: perdaSchema, concluir: z.boolean().optional() }).strict(),
]);
export type Alvo = z.infer<typeof alvoSchema>;
export type Comando = z.infer<typeof comandoSchema>;
export type Acao = { id: string; tipo: string; data: string; observacao: string | null; responsavelId: string };
export type Oportunidade = { id: string; tipo: Alvo['tipo']; nome: string; clienteId: string | null; status: string; etapa: string; valor: string | null; dataEvento: string | null; responsavelId: string | null; proxima: Acao | null; sugerirPerda: boolean; href: string;
  /** Wall-e 1a: canal do contato (WHATSAPP, FORMULARIO_SITE…), se o cartão nasceu de uma conversa do Wall-e e qual. */
  canal?: string | null; origemWalle?: boolean; conversaId?: string | null };
