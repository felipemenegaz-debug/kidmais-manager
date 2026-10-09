import { z } from 'zod';
const campos = { nome: z.string().trim().min(2).max(100), adultos: z.int().min(0).max(20), criancas: z.int().min(0).max(20) };
const temPessoas = (v: { adultos: number; criancas: number }) => v.adultos + v.criancas > 0;
export const comandosFamilia = [
  z.object({ acao: z.literal('familia_adicionar'), id: z.uuid(), ...campos }).strict().refine(temPessoas, 'Informe ao menos uma pessoa.'),
  z.object({ acao: z.literal('familia_editar'), id: z.uuid(), revisao: z.int().positive(), ...campos }).strict().refine(temPessoas, 'Informe ao menos uma pessoa.'),
  z.object({ acao: z.literal('familia_link'), id: z.uuid(), revisao: z.int().positive(), habilitado: z.boolean() }).strict(),
  z.object({ acao: z.literal('familia_status'), id: z.uuid(), revisao: z.int().positive(), ativa: z.boolean() }).strict(),
] as const;
export const comandoFamiliaSchema = z.discriminatedUnion('acao', comandosFamilia);
export type ComandoFamilia = z.infer<typeof comandoFamiliaSchema>;
export type Familia = { id: string; nome: string; adultos: number; criancas: number; ativa: boolean; revisao: number; linkAtivo: boolean;
  presenca: boolean | null; adultosConfirmados: number | null; criancasConfirmadas: number | null };
export type FamiliaPublica = { nome: string; presenca: boolean | null; adultos: number; criancas: number };
