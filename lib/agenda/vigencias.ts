/**
 * Parecer do Astra (P2): juntar regras de vários horários num único horário (o horário livre) sem sobreposição e sem
 * perder trechos. A linha do tempo é cortada em todos os limites (início e dia seguinte ao término), a precedência é
 * resolvida em cada trecho e trechos vizinhos iguais são unidos. Datas ISO (AAAA-MM-DD); fim null = sem término.
 */
export type Trecho<T> = { inicio: string; fim: string | null; valor: T };

const diaSeguinte = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const diaAnterior = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * @param resolver valor do trecho a partir das regras ativas nele (null = sem regra no trecho)
 * @param preencher valor usado quando nenhuma regra está ativa (ex.: PADRAO), a partir de `hoje`
 */
export function linhaDoTempo<T, R>(
  regras: Trecho<T>[],
  hoje: string,
  resolver: (ativos: T[]) => R | null,
  igual: (a: R, b: R) => boolean,
  preencher?: R,
): Trecho<R>[] {
  const vigentes = regras
    .filter((r) => r.fim === null || r.fim >= hoje)
    .map((r) => ({ ...r, inicio: r.inicio < hoje ? hoje : r.inicio }));
  const cortes = new Set<string>(preencher !== undefined ? [hoje] : []);
  for (const r of vigentes) {
    cortes.add(r.inicio);
    if (r.fim !== null) cortes.add(diaSeguinte(r.fim));
  }
  const ordenados = [...cortes].sort();
  const saida: Trecho<R>[] = [];
  ordenados.forEach((inicio, i) => {
    const proximo = ordenados[i + 1];
    const fim = proximo ? diaAnterior(proximo) : null;
    const ativos = vigentes.filter((r) => r.inicio <= inicio && (r.fim === null || r.fim >= inicio)).map((r) => r.valor);
    const valor = ativos.length ? resolver(ativos) : preencher ?? null;
    if (valor === null || valor === undefined) return;
    const anterior = saida[saida.length - 1];
    if (anterior && anterior.fim !== null && diaSeguinte(anterior.fim) === inicio && igual(anterior.valor, valor)) {
      anterior.fim = fim;
      return;
    }
    saida.push({ inicio, fim, valor });
  });
  return saida;
}
