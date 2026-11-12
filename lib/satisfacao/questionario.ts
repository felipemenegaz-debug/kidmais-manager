import { z } from "zod";

/**
 * Questionário v1 (fixo no código, versionado; telas aprovadas por Felipe em 30/10/2026). Sem editor de perguntas na V1.
 * Notas: indicação 0–10 (obrigatória), aspectos 1–5 (opcionais), comentário até 2.000 caracteres (opcional).
 */
export const VERSAO_QUESTIONARIO = 1;
export const QUESTIONARIO_V1 = {
  versao: VERSAO_QUESTIONARIO,
  indicacao: (buffet: string) => `De 0 a 10, quanto você indicaria o ${buffet} a um amigo?`,
  aspectos: [
    { campo: "notaComida", rotulo: "Comida e bebida" },
    { campo: "notaEquipe", rotulo: "Equipe e atendimento" },
    { campo: "notaEspaco", rotulo: "Espaço e decoração" },
  ],
  comentario: "Quer contar mais alguma coisa? (opcional)",
} as const;

const aspecto = z.number().int().min(1).max(5).nullable().optional().transform((v) => v ?? null);

export const esquemaResposta = z.object({
  token: z.string().max(200),
  notaIndicacao: z.number({ message: "Escolha uma nota de 0 a 10." }).int().min(0).max(10),
  notaComida: aspecto,
  notaEquipe: aspecto,
  notaEspaco: aspecto,
  comentario: z.string().max(4000).nullable().optional()
    .transform((v) => (v ?? "").trim() || null)
    .refine((v) => v === null || v.length <= 2000, { message: "O comentário pode ter até 2.000 caracteres." }),
}).strict();
export type RespostaQuestionario = z.infer<typeof esquemaResposta>;

/** Faixa NPS de uma nota de indicação. */
export function faixaNps(nota: number): "PROMOTOR" | "NEUTRO" | "DETRATOR" {
  return nota >= 9 ? "PROMOTOR" : nota >= 7 ? "NEUTRO" : "DETRATOR";
}

/** Nota de 0 a 6 abre tarefa para a gerência da unidade (D-PS4). */
export function precisaDeTarefa(nota: number) {
  return nota <= 6;
}

/** NPS (−100 a 100, inteiro arredondado) de uma lista de notas; null sem respostas. */
export function calcularNps(notas: readonly number[]): number | null {
  if (notas.length === 0) return null;
  const promotores = notas.filter((n) => n >= 9).length;
  const detratores = notas.filter((n) => n <= 6).length;
  return Math.round(((promotores - detratores) / notas.length) * 100);
}

/** Primeiro nome para a página pública (só o primeiro nome aparece). */
export function primeiroNome(nomeCompleto: string | null | undefined) {
  return (nomeCompleto ?? "").trim().split(/\s+/)[0] || "Olá";
}
