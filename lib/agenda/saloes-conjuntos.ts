/**
 * 098 (fase 1 dos salões, proposta rev. 3 aprovada com ressalvas pelo Astra em 23/10/2026): mesma regra de
 * kidmais098_conjunto, kidmais098_saloes_cruzam e kidmais098_salao_elegivel, sem banco.
 * O conjunto de um salão simples é ele mesmo; o de um combinado ("salão inteiro" = A+B), os membros. Dois salões
 * cruzam quando um deles é nulo (festa sem salão ocupa todos), são o mesmo ou os conjuntos se cruzam: A × B não
 * cruzam; A × AB e AB × BC cruzam.
 */
export type SalaoDoEscopo = { id: string; ativo: boolean; combinado: boolean; membros: string[] | null };

/** Conjunto de salões simples de cada salão do escopo (inclusive inativos: uma ocupação pode apontar para eles). */
export type ConjuntosSaloes = Record<string, string[]>;

export function conjuntosDosSaloes(saloes: SalaoDoEscopo[]): ConjuntosSaloes {
  return Object.fromEntries(saloes.map((s) => [s.id, s.combinado && s.membros ? [...s.membros] : [s.id]]));
}

/** Salão desconhecido (sem a 098 ou fora do escopo lido) vale por ele mesmo, como no SQL. */
export function conjuntoDe(salao: string, conjuntos?: ConjuntosSaloes | null) {
  return conjuntos?.[salao] ?? [salao];
}

export function saloesCruzam(a: string | null | undefined, b: string | null | undefined, conjuntos?: ConjuntosSaloes | null) {
  if (a == null || b == null || a === b) return true;
  const de = new Set(conjuntoDe(a, conjuntos));
  return conjuntoDe(b, conjuntos).some((s) => de.has(s));
}

/** Elegível para ocupação: ativo e, se combinado, com todos os membros presentes, simples e ativos. */
export function salaoElegivel(salao: SalaoDoEscopo, todos: SalaoDoEscopo[]) {
  if (!salao.ativo) return false;
  if (!salao.combinado) return true;
  const porId = new Map(todos.map((s) => [s.id, s]));
  return (salao.membros ?? []).length >= 2
    && (salao.membros ?? []).every((m) => porId.get(m)?.ativo === true && porId.get(m)?.combinado === false);
}

/** Forma canônica gravada no INSERT (kidmais098_membros_canonicos): sem repetidos, em ordem crescente. */
export function membrosCanonicos(membros: string[]) {
  return [...new Set(membros.map((m) => m.toLowerCase()))].sort();
}
