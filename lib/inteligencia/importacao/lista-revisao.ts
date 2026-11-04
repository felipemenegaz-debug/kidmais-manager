import { z } from "zod";
import type { CursorRevisao, LinhaParaRevisao } from "../../importacao-contrato/repositorio-importacao.ts";

/**
 * Lista "Contratos aguardando revisão" do lote L1 (plano rev. 1, R1-4): DTO fechado e sanitizado.
 *
 * Nunca saem `dados`, evidências, decisões, candidatos, CPF/telefone/e-mail estruturados nem `resultado`. Nome do
 * arquivo e contratante são texto não confiável: sequências com 8 ou mais dígitos (com ou sem pontuação de CPF, CNPJ ou
 * telefone) e endereços de e-mail viram "•••", e o texto é cortado em 80 caracteres. O nome do contratante continua
 * sendo dado pessoal, autorizado para quem já pode importar.
 */
export type ItemParaRevisao = {
  grupo: "REVISAO" | "LIDO";
  documentoId: string;
  importacaoId: string | null;
  versao: number | null;
  arquivo: string;
  enviadoEm: string;
  contratante: string | null;
  dataFesta: string | null;
};

export const OCULTO = "•••";
const LIMITE_TEXTO = 80;
const EMAIL = /[^\s@<>()[\]{}"',;]+@[^\s@<>()[\]{}"',;]+/g;
// Trecho de dígitos com separadores comuns; só é ocultado se tiver 8 ou mais dígitos.
const TRECHO_NUMERICO = /\d(?:[\d.\-/\s()_+]*\d)?/g;

export function sanitizarTexto(texto: string | null | undefined): string | null {
  if (typeof texto !== "string") return null;
  const limpo = texto
    .replace(EMAIL, OCULTO)
    .replace(TRECHO_NUMERICO, (t) => ((t.match(/\d/g)?.length ?? 0) >= 8 ? OCULTO : t))
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo) return null;
  return limpo.length > LIMITE_TEXTO ? `${limpo.slice(0, LIMITE_TEXTO - 1)}…` : limpo;
}

/** Só uma data real no calendário sai; o resto vira null (ordena por último). */
function dataValida(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function itemParaRevisao(l: LinhaParaRevisao): ItemParaRevisao {
  return {
    grupo: l.grupo,
    documentoId: l.documentoId,
    importacaoId: l.grupo === "REVISAO" ? l.importacaoId : null,
    versao: l.grupo === "REVISAO" ? l.versao : null,
    arquivo: sanitizarTexto(l.arquivo) ?? "arquivo",
    enviadoEm: l.enviadoEm,
    contratante: sanitizarTexto(l.contratante),
    dataFesta: dataValida(l.dataFesta),
  };
}

const cursorSchema = z.object({
  k: z.string().regex(/^(\d{4}-\d{2}-\d{2}|~)$/),
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.string().uuid(),
}).strict();

export function codificarCursor(c: CursorRevisao | null): string | null {
  return c ? Buffer.from(JSON.stringify(c), "utf8").toString("base64url") : null;
}

/** Cursor ilegível ou adulterado ⇒ null (o chamador recusa com 400). */
export function lerCursor(texto: string): CursorRevisao | null {
  try {
    const r = cursorSchema.safeParse(JSON.parse(Buffer.from(texto, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
