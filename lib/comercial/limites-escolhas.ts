export function erroLimitesEscolhas(min: number, max: number) {
  if (!Number.isInteger(max) || max < 1 || max > 30) return "Informe um máximo inteiro entre 1 e 30.";
  if (!Number.isInteger(min) || min < 0 || min > max) return "Informe um mínimo inteiro entre zero e o máximo.";
  return null;
}

export function fraseEscolhas(min: number, max: number) {
  if (min === max) return `Escolha ${max}`;
  if (min === 0) return `Escolha até ${max}`;
  return `Escolha de ${min} a ${max}`;
}

export function faltaEscolha(categorias: readonly { codigo: string; nome: string; min: number; max: number }[], escolhas?: Record<string, string[]>) {
  const categoria = categorias.find(c => (escolhas?.[c.codigo]?.length ?? 0) < c.min);
  return categoria ? `${categoria.nome}: ${fraseEscolhas(categoria.min, categoria.max)}.` : null;
}
