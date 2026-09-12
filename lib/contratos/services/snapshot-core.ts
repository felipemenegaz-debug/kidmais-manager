import { createHash } from "node:crypto";
import { calcularCondicaoComercial, type CondicaoPagamento } from "../../comercial/condicao-pagamento.ts";

function canonicalizar(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizar);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalizar(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * SHA-256 do conteúdo canônico do snapshot.
 * A ordenação de chaves evita gerar nova versão apenas por diferença de
 * ordem de propriedades no objeto JavaScript.
 */
export function hashSnapshotContrato(snapshot: unknown) {
  const json = JSON.stringify(canonicalizar(snapshot));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** Valor negociado sem aprovação nunca pode virar valor contratual. */
export function valorFinalContrato(input: {
  valorAprovado: number | null;
  valorTabela: number;
  condicaoPagamento?: CondicaoPagamento | null;
}) {
  const base = input.valorAprovado ?? input.valorTabela;
  // NULL identifica registros anteriores à nova regra; não reinterpretar legado.
  return input.condicaoPagamento
    ? calcularCondicaoComercial(base, input.condicaoPagamento.forma).valorFinalContrato
    : base;
}
