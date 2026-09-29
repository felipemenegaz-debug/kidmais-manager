import { createHash } from "node:crypto";

/** JSON canônico: chaves ordenadas, sem undefined. Mesmo payload ⇒ mesmo hash, em qualquer processo. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`;
}

/**
 * Hash do que será confirmado: capacidade, ferramenta, tenant, ator, versão e payload.
 * Qualquer alteração no rascunho depois do preview muda o hash e invalida a confirmação.
 */
export function hashPayload(partes: { capacidade: string; ferramenta: string; empresaId: string; usuarioId: string; versao: number; payload: Record<string, unknown> }) {
  return createHash("sha256").update(jsonCanonico(partes)).digest("hex");
}
