import { z } from "zod";
import { CAMPOS_OBRIGATORIOS, campoConhecido, camposUsados } from "./campos.ts";

/**
 * Conteúdo do modelo de contrato de uma empresa: o texto jurídico DA EMPRESA, com {{campos}} da lista fechada no
 * lugar dos dados de cada festa. É o que a equipe revisa e aprova; o contrato de cada versão é este texto com os
 * campos preenchidos pelo snapshot congelado.
 */
const linha = z.string().trim().min(1).max(4000);

export const conteudoModeloSchema = z.object({
  titulo: z.string().trim().min(3).max(160),
  contratada: z.object({
    nome: z.string().trim().min(2).max(200),
    documento: z.string().trim().max(40),
    endereco: z.string().trim().max(300),
    representante: z.string().trim().max(300),
  }).strict(),
  preambulo: z.array(linha).max(10),
  clausulas: z.array(z.object({ titulo: z.string().trim().max(160).nullable(), texto: linha }).strict()).min(1).max(80),
  observacoes: z.array(linha).max(20),
  cidadeAssinatura: z.string().trim().min(2).max(120),
}).strict();

export type ConteudoModelo = z.infer<typeof conteudoModeloSchema>;

function textos(c: ConteudoModelo) {
  return [c.titulo, ...c.preambulo, ...c.clausulas.flatMap((x) => [x.titulo ?? "", x.texto]), ...c.observacoes];
}

/** Problemas que impedem publicar: campo fora da lista e campos obrigatórios ausentes. */
export function problemasDoConteudo(c: ConteudoModelo): string[] {
  const usados = new Set(textos(c).flatMap(camposUsados));
  const problemas: string[] = [];
  for (const campo of usados) if (!campoConhecido(campo)) problemas.push(`O campo {{${campo}}} não existe. Use um campo da lista.`);
  for (const campo of CAMPOS_OBRIGATORIOS) if (!usados.has(campo)) problemas.push(`O contrato precisa usar {{${campo}}}.`);
  if (/\{\{(?![a-z_.\s]+\}\})/.test(textos(c).join("\n"))) problemas.push("Há um {{ sem fechamento ou com caracteres inválidos.");
  return problemas;
}
