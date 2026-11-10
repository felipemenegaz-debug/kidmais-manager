/**
 * D-LIB-1 (decisão de Felipe, 31/10/2026): a ida a "mais de um salão" é liberada por ambiente, em tempo de execução,
 * pela env AGENDA_MAIS_DE_UM_SALAO lida só no servidor. Só "true" libera; ausente ou qualquer outro valor = desligada.
 * Desligada: recusa novas idas, mantém a edição de quem já está por salão e nunca libera a volta.
 */
export function maisDeUmSalaoLiberado(env: Record<string, string | undefined> = process.env) {
  return env.AGENDA_MAIS_DE_UM_SALAO === "true";
}
