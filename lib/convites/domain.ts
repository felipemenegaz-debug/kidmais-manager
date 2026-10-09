import { z } from 'zod';

export const temas = {
  celebrar: { nome: 'Dia de celebrar', fundo: '#fff3df', tinta: '#703b29', destaque: '#d66045', simbolo: '✦' },
  jardim: { nome: 'Jardim encantado', fundo: '#eef3e5', tinta: '#334f3b', destaque: '#788d58', simbolo: '❀' },
  espaco: { nome: 'Uma aventura espacial', fundo: '#182849', tinta: '#ffffff', destaque: '#c5a6f5', simbolo: '✧' },
} as const;

export const conteudoSchema = z.object({
  tema: z.enum(['celebrar', 'jardim', 'espaco']),
  nome: z.string().trim().min(1).max(80),
  idade: z.string().trim().max(20),
  mensagem: z.string().trim().max(400),
  data: z.iso.date(),
  horario: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  local: z.string().trim().min(1).max(120),
  endereco: z.string().trim().min(1).max(240),
  arteId: z.uuid().nullable(),
  confirmarPresenca: z.boolean(),
  visual: z.object({
    modo: z.enum(['modelo', 'completa']),
    ajuste: z.enum(['conter', 'preencher']),
    x: z.number().min(0).max(100), y: z.number().min(0).max(100),
    cores: z.object({ fundo: z.string().regex(/^#[0-9a-f]{6}$/i), tinta: z.string().regex(/^#[0-9a-f]{6}$/i), destaque: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type Conteudo = z.infer<typeof conteudoSchema>;
export const rascunhoSchema = conteudoSchema.extend({
  nome: z.string().trim().max(80), data: z.union([z.iso.date(), z.literal('')]),
  horario: z.union([conteudoSchema.shape.horario, z.literal('')]),
  local: z.string().trim().max(120), endereco: z.string().trim().max(240),
});
export const comandoSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('salvar'), revisao: z.int().positive(), conteudo: rascunhoSchema }).strict(),
  z.object({ acao: z.literal('publicar'), revisao: z.int().positive(), conteudo: conteudoSchema }).strict(),
  z.object({ acao: z.literal('despublicar'), revisao: z.int().positive() }).strict(),
  z.object({ acao: z.literal('acesso'), habilitado: z.boolean() }).strict(),
  z.object({ acao: z.literal('cotas'), festa: z.int().min(0).max(100), cliente: z.int().min(0).max(100) }).strict(),
  z.object({ acao: z.literal('upload'), imagem: z.string().max(7_000_000) }).strict(),
  z.object({ acao: z.literal('excluir_arte'), arteId: z.uuid(), revisao: z.int().positive() }).strict(),
  z.object({ acao: z.literal('gerar'), chave: z.uuid(), prompt: z.string().trim().min(5).max(3000), referencias: z.array(z.uuid()).max(2) }).strict(),
]);
export const respostaSchema = z.object({
  chave: z.uuid(), nome: z.string().trim().min(2).max(100),
  presenca: z.boolean(), adultos: z.int().min(0).max(20), criancas: z.int().min(0).max(20),
  site: z.string().max(200).default(''),
}).strict().refine(v => !v.presenca || v.adultos + v.criancas > 0, 'Informe ao menos uma pessoa.');

export class ConviteError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
export function exigir(ok: unknown, mensagem: string, status = 409): asserts ok {
  if (!ok) throw new ConviteError(mensagem, status);
}
export type Cotas = { empresa: number; empresaUsado: number; festa: number; festaUsado: number; cliente: number; clienteUsado: number };
export function validarCredito(c: Cotas, cliente: boolean) {
  exigir(Object.values(c).every(n => Number.isSafeInteger(n) && n >= 0), 'Cotas inválidas.');
  exigir(c.empresaUsado < c.empresa, 'A franquia de imagens da empresa acabou. Solicite mais créditos ao buffet.', 402);
  exigir(c.festaUsado < c.festa, 'A cota desta festa acabou. Solicite mais créditos ao buffet.', 402);
  if (cliente) exigir(c.clienteUsado < c.cliente, 'Seu limite de gerações acabou. Solicite mais créditos ao buffet.', 402);
}
export function disponiveis(c: Cotas, cliente: boolean) {
  return Math.max(0, Math.min(c.empresa - c.empresaUsado, c.festa - c.festaUsado, cliente ? c.cliente - c.clienteUsado : Infinity));
}
export function inicioConteudo(snapshot: unknown): Conteudo {
  const s = snapshot as { aniversariante?: { nome?: string; idadeNoEvento?: number }; evento?: { data?: string; horarioInicio?: string } };
  return { tema: 'celebrar', nome: s?.aniversariante?.nome ?? '', idade: s?.aniversariante?.idadeNoEvento == null ? '' : `${s.aniversariante.idadeNoEvento} anos`,
    data: s?.evento?.data?.slice(0, 10) ?? '', horario: s?.evento?.horarioInicio?.slice(0, 5) ?? '',
    local: '', endereco: '', mensagem: 'Um dia especial fica ainda melhor com você. Venha comemorar com a gente!', arteId: null, confirmarPresenca: true };
}
