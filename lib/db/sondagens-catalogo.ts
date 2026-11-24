import type { DbExecutor, DbQueryResult } from "./contracts.ts";

/**
 * Sondagem de catálogo: "a função/tabela X existe?", sem parâmetros e sem ler dado de empresa. Só estas formas exatas
 * (uma única to_regprocedure/to_regclass com nome literal) são reaproveitadas; qualquer outra consulta vai ao banco.
 */
const SONDAGEM_DE_CATALOGO = /^SELECT to_reg(?:procedure|class)\('[A-Za-z0-9_.(), ]+'\) IS NOT NULL AS [a-z0-9_]+$/;

export function ehSondagemDeCatalogo(sql: string, params?: readonly unknown[]): boolean {
  return !params?.length && SONDAGEM_DE_CATALOGO.test(sql);
}

/**
 * Agenda lenta F1 (23/11/2026): dentro de UMA requisição de leitura, a mesma sondagem de catálogo (062, 094, 133,
 * pré-reserva…) era repetida até 7 vezes, cada uma uma ida ao banco. Este executor guarda a resposta da primeira e
 * devolve a mesma às seguintes. Vale só para o executor devolvido (uma requisição): nada fica entre requisições, e uma
 * migration aplicada passa a valer na requisição seguinte, como antes. Use só em leitura: sem DDL no meio, o catálogo
 * visto pela transação não muda até o fim dela.
 */
export function comSondagensDeCatalogoReutilizadas(executor: DbExecutor): DbExecutor {
  const lidas = new Map<string, Promise<DbQueryResult<object>>>();
  return {
    query<Row extends object>(sql: string, params?: readonly unknown[]) {
      if (!ehSondagemDeCatalogo(sql, params)) return executor.query<Row>(sql, params);
      const lida = lidas.get(sql);
      if (lida) return lida as Promise<DbQueryResult<Row>>;
      const consulta = executor.query<Row>(sql, params);
      lidas.set(sql, consulta);
      // Falha não fica guardada: a próxima chamada tenta de novo (e a transação abortada responde o próprio erro).
      consulta.catch(() => { if (lidas.get(sql) === consulta) lidas.delete(sql); });
      return consulta;
    },
  };
}
