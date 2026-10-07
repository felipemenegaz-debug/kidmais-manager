import { z } from "zod";
import type { RevisaoTabela } from "./normalizar.ts";

/** Revisão editada pela tela: mesma forma que `normalizarLeitura` produz, conferida campo a campo. */
const inteiro = z.number().int().min(1).max(100000);
const faixa = z.object({ min: inteiro, max: inteiro.nullable(), valor: z.number().min(0).max(99_999_999), rotulo: z.string().max(80).nullable() }).strict();
const categoria = z.enum(["PADRAO", "NOBRE", "GERAL"]);
const uuid = z.string().uuid();
const grade = z.object({ categoria, faixas: z.array(faixa).max(60) }).strict();

export const revisaoSchema: z.ZodType<RevisaoTabela> = z.object({
  esquema: z.literal(1),
  pacotes: z.array(z.object({
    chave: z.string().max(20),
    nomePdf: z.string().max(160),
    pagina: z.number().int().nullable(),
    pacoteId: uuid.nullable(),
    convidadosMin: inteiro.nullable(),
    convidadosMax: inteiro.nullable(),
    cobranca: z.enum(["FAIXAS", "POR_CONVIDADO", "SOB_CONSULTA"]),
    grades: z.array(grade).max(4),
    porConvidado: z.number().min(0).max(1_000_000).nullable(),
    aPartirDe: z.number().nullable(),
    descricao: z.string().max(2000).nullable(),
    selo: z.string().max(80).nullable(),
    duracao: z.string().max(200).nullable(),
    aplicarDescricao: z.boolean(),
    inclusos: z.array(z.object({ texto: z.string().max(200), adicionalId: uuid.nullable() }).strict()).max(60),
    aplicarInclusos: z.boolean(),
    atual: z.object({ descricao: z.string().nullable(), grades: z.array(grade) }).strict().nullable(),
    pendencias: z.array(z.string().max(400)).max(40),
    confirmado: z.boolean(),
  }).strict()).max(30),
  adicionais: z.array(z.object({
    chave: z.string().max(20),
    nomePdf: z.string().max(160),
    pagina: z.number().int().nullable(),
    destino: z.discriminatedUnion("tipo", [
      z.object({ tipo: z.literal("EXISTENTE"), adicionalId: uuid }).strict(),
      z.object({ tipo: z.literal("NOVO"), nome: z.string().trim().min(1).max(160) }).strict(),
      z.object({ tipo: z.literal("IGNORAR") }).strict(),
    ]),
    categoria: z.string().max(40),
    unidade: z.enum(["PACOTE", "UNIDADE", "CENTO", "CONVIDADO", "HORA"]),
    faixas: z.array(faixa).max(20),
    atual: z.array(faixa).nullable(),
    pendencias: z.array(z.string().max(400)).max(40),
    confirmado: z.boolean(),
  }).strict()).max(120),
  comuns: z.array(z.string().max(300)).max(30),
  horarios: z.array(z.object({ horario: z.enum(["PROMOCIONAL", "NOBRE"]), descricao: z.string().max(300) }).strict()).max(10),
  informacoes: z.array(z.string().max(500)).max(40),
  naoImportavel: z.array(z.object({ texto: z.string().max(300), pagina: z.number().int().nullable(), motivo: z.string().max(300) }).strict()).max(40),
  conferencias: z.array(z.object({ ok: z.boolean(), texto: z.string().max(400) }).strict()).max(60),
}).strict();
