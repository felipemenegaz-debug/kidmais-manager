import { z } from "zod";
import { ORIGENS_CONTRATADA, conteudoModeloSchema } from "./conteudo.ts";

/** Corpos aceitos por app/api/admin/configuracoes/modelo-contrato/[id] (estritos; testados sem servidor). */
const empresaId = z.string().uuid().nullable().optional();
// envioId (plano v3, rev. 10): dentro de revisao, opcional (clientes antigos); o corpo externo do PATCH não muda.
const revisao = z.object({ conteudo: conteudoModeloSchema, avisos: z.array(z.string().max(400)).max(40), envioId: z.string().uuid().optional() }).strict();
export const corpoPatchModeloSchema = z.object({ versao: z.number().int().min(1), revisao, empresaId }).strict();

const contratadaConferida = z.object({
  origem: z.enum(ORIGENS_CONTRATADA), perfilVersao: z.number().int().nullable(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const acaoModeloSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("publicar"), versao: z.number().int().min(1), revisadoPorPessoa: z.literal(true), contratadaConferida, empresaId }).strict(),
  z.object({ acao: z.literal("descartar"), empresaId }).strict(),
  z.object({ acao: z.literal("previa"), conteudo: conteudoModeloSchema, empresaId }).strict(),
]);
