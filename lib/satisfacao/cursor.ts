import { SatisfacaoError } from "./erros.ts";

/**
 * Cursor das listas da pesquisa (PS-4 R3): `base64url("<instante UTC com microssegundos>|<uuid>")`. O instante sai do SQL
 * como texto (`INSTANTE_SQL`) e volta ao SQL como texto: NUNCA passa por `Date` (perderia os microssegundos). Não carrega
 * escopo nem filtros: só posiciona dentro do escopo recalculado na requisição. Formato inválido → 400.
 */
export const INSTANTE_SQL = (coluna: string) => `to_char(${coluna} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const FORMATO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAXIMO = 120;

export type Cursor = { instante: string; id: string };

export function codificarCursor(instante: string, id: string) {
  return Buffer.from(`${instante}|${id}`, "utf8").toString("base64url");
}

const invalido = () => new SatisfacaoError("DADOS_INVALIDOS", "Cursor inválido.", 400);

/** null/ausente → sem cursor. O instante ainda é conferido pelo PostgreSQL (`::timestamptz`); erro de data vira 400. */
export function lerCursor(bruto: string | null | undefined): Cursor | null {
  if (bruto === null || bruto === undefined || bruto === "") return null;
  if (bruto.length > MAXIMO || !/^[A-Za-z0-9_-]+$/.test(bruto)) throw invalido();
  const m = FORMATO.exec(Buffer.from(bruto, "base64url").toString("utf8"));
  if (!m) throw invalido();
  return { instante: m[1], id: m[2] };
}

/** Erros de conversão de data/uuid do PostgreSQL (cursor ou período fora do calendário) → 400. */
export function erroDeDataInvalida(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return code === "22008" || code === "22007" || code === "22P02";
}
