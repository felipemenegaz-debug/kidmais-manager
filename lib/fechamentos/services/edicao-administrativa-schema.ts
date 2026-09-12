import { z } from 'zod';
const texto = z.string().trim().max(2000);
const contato = z.string().trim().max(200);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
export const edicaoFestaSchema = z.object({
    acao: z.literal('editar_festa'), revisao: z.number().int().positive(), motivo: z.string().trim().min(3).max(500),
    fonteHash: z.string().regex(/^[a-f0-9]{64}$/),
    pacoteId: uuid, convidados: z.number().int().positive(),
    dataEvento: z.string().date(), configuracaoAgendaId: uuid,
    horarioInicio: z.string().regex(/^\d{2}:\d{2}(?::00)?$/), horarioFim: z.string().regex(/^\d{2}:\d{2}(?::00)?$/),
    adicionais: z.array(z.object({ codigo: z.string().trim().min(1).max(80).transform(value => value.toUpperCase()), quantidade: z.number().positive().finite() }).strict()).max(60),
    idadeAniversarianteEvento: z.number().int().min(0).max(120).nullable(), temaFesta: texto,
    buffetStatus: z.enum(['PENDENTE', 'DEFINIDO']), buffetSalgados: texto, buffetBebidas: texto, buffetDoces: texto, buffetBolo: texto, buffetOutros: texto, buffetLembrancinha: texto.optional(), buffetEmpratado: texto.optional(), buffetBombom: texto.optional(),
    observacoesEquipe: texto,
    vinculos: z.object({ clienteId: uuid, aniversarianteId: uuid, responsavelAdicionalId: uuid.nullable() }).strict().optional(),
    cliente: z.object({ nomeCompleto: contato.min(3), rg: contato, telefone: contato, whatsapp: contato, email: z.email(), cep: contato, logradouro: contato, numero: contato, complemento: contato, bairro: contato, cidade: contato, uf: z.string().length(2) }).strict().optional(),
    aniversariante: z.object({ nome: contato.min(2), dataNascimento: z.string().date().nullable() }).strict().optional(),
    comercial: z.object({ confirmarAprovacao: z.literal(true), forma: z.enum(['PIX_AVISTA', 'PIX_PARCELADO', 'CARTAO_CIELO']), baseNegociada: z.union([z.string(), z.number()]).nullable(), condicaoPix: z.object({ entrada: z.union([z.number(), z.string()]).nullable().optional(), valorParcela: z.union([z.number(), z.string()]).nullable().optional(), quantidadeParcelas: z.number().int().positive().nullable().optional() }).strict().nullable() }).strict().optional(),
}).strict();
export type EdicaoFestaInput = z.infer<typeof edicaoFestaSchema>;
