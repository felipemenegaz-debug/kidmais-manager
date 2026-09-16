import { z } from "zod";

const opcionalTexto = z.string().max(2000).nullable().optional();

const clienteCamposSchema = z.object({
  nomeCompleto: z.string().trim().min(3).max(180),
  cpf: z.string().max(20).nullable().optional(),
  rg: z.string().max(30).nullable().optional(),
  telefone: z.string().max(30).nullable().optional(),
  whatsapp: z.string().max(30).nullable().optional(),
  email: z.string().email().max(255).nullable().optional().or(z.literal("")),
  cep: z.string().max(12).nullable().optional(),
  logradouro: z.string().max(180).nullable().optional(),
  numero: z.string().max(30).nullable().optional(),
  complemento: z.string().max(120).nullable().optional(),
  bairro: z.string().max(120).nullable().optional(),
  cidade: z.string().max(120).nullable().optional(),
  uf: z.string().max(2).nullable().optional(),
  observacoes: opcionalTexto,
});

export const clienteCadastroSchema = clienteCamposSchema.superRefine((value, ctx) => {
  const telefone = (value.telefone ?? "").replace(/\D/g, "");
  const whatsapp = (value.whatsapp ?? "").replace(/\D/g, "");
  if (!telefone && !whatsapp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["whatsapp"],
      message: "Informe pelo menos WhatsApp ou telefone.",
    });
  }
});

export const clientePatchSchema = clienteCamposSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Informe ao menos um campo para atualizar." },
);

export const analiseCadastroSchema = z.object({
  email: z.string().max(254).nullable().optional(),
  nomeCompleto: z.string().trim().min(3).max(180),
  cpf: z.string().max(20).nullable().optional(),
  telefone: z.string().max(30).nullable().optional(),
  whatsapp: z.string().max(30).nullable().optional(),
  excluirClienteId: z.string().uuid().optional(),
});

export const aniversarianteSchema = z.object({
  nome: z.string().trim().min(2).max(200),
  dataNascimento: z.string().date().nullable().optional(),
  temaPadrao: z.string().trim().max(2000).nullable().optional(),
  observacoes: z.string().trim().max(2000).nullable().optional(),
}).strict();
