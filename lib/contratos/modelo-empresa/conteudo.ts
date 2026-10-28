import { z } from "zod";
import { CAMPOS_CONTRATO, CAMPOS_OBRIGATORIOS, campoConhecido, camposUsados, rotuloDoCampo } from "./campos.ts";

/**
 * Conteúdo do modelo de contrato de uma empresa: o texto jurídico DA EMPRESA, com {{campos}} da lista fechada no
 * lugar dos dados de cada festa. É o que a equipe revisa e aprova; o contrato de cada versão é este texto com os
 * campos preenchidos pelo snapshot congelado.
 */
const linha = z.string().trim().min(1).max(4000);

/** De onde veio o bloco da contratada publicado (plano v3, 1.2). ERRO nunca é publicado. */
export const ORIGENS_CONTRATADA = ["PERFIL", "MODELO_INCOMPLETO", "MODELO_SEM_PERFIL"] as const;

export const conteudoModeloSchema = z.object({
  titulo: z.string().trim().min(3).max(160),
  contratada: z.object({
    nome: z.string().trim().min(2).max(200),
    documento: z.string().trim().max(40),
    // 500: o endereço composto do perfil (sede) chega a cerca de 450 caracteres; conteúdos antigos (≤ 300) seguem válidos.
    endereco: z.string().trim().max(500),
    representante: z.string().trim().max(300),
  }).strict(),
  preambulo: z.array(linha).max(10),
  clausulas: z.array(z.object({ titulo: z.string().trim().max(160).nullable(), texto: linha }).strict()).min(1).max(80),
  observacoes: z.array(linha).max(20),
  cidadeAssinatura: z.string().trim().min(2).max(120),
  // Só no conteúdo publicado a partir desta versão (entra no conteudo_sha256). Rascunhos e modelos legados não têm.
  // O renderizador ignora.
  contratadaOrigem: z.object({ origem: z.enum(ORIGENS_CONTRATADA), perfilVersao: z.number().int().nullable() }).strict().optional(),
}).strict();

export type ConteudoModelo = z.infer<typeof conteudoModeloSchema>;

/** Todos os textos do modelo que aceitam {{campos}}. */
export function textosDoConteudo(c: ConteudoModelo) {
  return [c.titulo, ...c.preambulo, ...c.clausulas.flatMap((x) => [x.titulo ?? "", x.texto]), ...c.observacoes];
}

/**
 * Campos usados NAS CLÁUSULAS (título e texto de cada cláusula). É a única contagem dos obrigatórios: diagnóstico,
 * contador da tela e publicação. Um campo só no título geral, no preâmbulo ou nas observações não conta.
 */
export function usadosNasClausulas(c: Pick<ConteudoModelo, "clausulas">) {
  return new Set(c.clausulas.flatMap((x) => [...camposUsados(x.titulo ?? ""), ...camposUsados(x.texto)]));
}

export type DiagnosticoObrigatorio = { chave: string; rotulo: string; clausulas: number[] };

/** Cada obrigatório com as cláusulas (número, a partir de 1) em que aparece; lista vazia = falta. */
export function diagnosticoModelo(c: Pick<ConteudoModelo, "clausulas">) {
  const itens: DiagnosticoObrigatorio[] = CAMPOS_OBRIGATORIOS.map((chave) => ({
    chave,
    rotulo: rotuloDoCampo(chave),
    clausulas: c.clausulas.flatMap((x, i) => ([...camposUsados(x.titulo ?? ""), ...camposUsados(x.texto)].includes(chave) ? [i + 1] : [])),
  }));
  return { itens, incluidos: itens.filter((i) => i.clausulas.length).length, total: itens.length };
}

/** Campos da lista que não aparecem nas cláusulas, fora os obrigatórios (determinístico; nunca dos avisos da IA). */
export function opcionaisNaoUsados(c: Pick<ConteudoModelo, "clausulas">) {
  const usados = usadosNasClausulas(c);
  const obrigatorios = new Set<string>(CAMPOS_OBRIGATORIOS);
  return CAMPOS_CONTRATO.filter((x) => !obrigatorios.has(x.chave) && !usados.has(x.chave)).map(({ chave, rotulo }) => ({ chave, rotulo }));
}

/**
 * Problemas que impedem publicar: campo fora da lista ou mal fechado em QUALQUER texto, e obrigatório ausente nas
 * cláusulas. 7 de 7 é necessário, não suficiente.
 */
export function problemasDoConteudo(c: ConteudoModelo): string[] {
  const usados = new Set(textosDoConteudo(c).flatMap(camposUsados));
  const nasClausulas = usadosNasClausulas(c);
  const problemas: string[] = [];
  for (const campo of usados) if (!campoConhecido(campo)) problemas.push(`O campo {{${campo}}} não existe. Use um campo da lista.`);
  for (const campo of CAMPOS_OBRIGATORIOS) if (!nasClausulas.has(campo)) problemas.push(`Falta nas cláusulas: ${rotuloDoCampo(campo)}.`);
  if (/\{\{(?![a-z_.\s]+\}\})/.test(textosDoConteudo(c).join("\n"))) problemas.push("Há um {{ sem fechamento ou com caracteres inválidos.");
  return problemas;
}
