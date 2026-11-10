import type { DbExecutor } from "../db/contracts.ts";
import { estadoCombinados } from "./estado-combinados.ts";

/**
 * E2b — salões combinados para o cliente (plano técnico E2b rev. 2.1, aprovado; D-E2b-1 de Felipe, 31/10/2026).
 * O combinado só chega ao cliente com TRÊS condições: SALOES_PUBLICOS ligada, SALOES_COMBINADOS_PUBLICOS ligada e a
 * instalação NOVA (108 completa e íntegra). Qualquer outra combinação = comportamento da E2a, sem exceção (oferta,
 * seleção, campos novos do DTO, motivos da preferência e a trava compartilhada da configuração).
 */
type EnvCombinados = { SALOES_PUBLICOS?: string; SALOES_COMBINADOS_PUBLICOS?: string };

export function combinadosPublicosLigados(env: EnvCombinados = process.env as EnvCombinados) {
  return env.SALOES_PUBLICOS?.trim() === "true" && env.SALOES_COMBINADOS_PUBLICOS?.trim() === "true";
}

/** As três condições. AUSENTE, ANTIGA e PARCIAL = false (ANTIGA/PARCIAL continuam recusando onde já recusavam). */
export async function combinadosPublicos(db: DbExecutor, env?: EnvCombinados) {
  if (!combinadosPublicosLigados(env)) return false;
  return (await estadoCombinados(db)).estado === "NOVA";
}
