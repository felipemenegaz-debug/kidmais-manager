/**
 * Alvo do cluster PostgreSQL descartável das suítes `*.postgres.test.ts` (mesmo padrão de `alvo-054.ts`).
 * Módulo puro (sem driver): testado sem banco.
 *
 * Porta padrão histórica 55498. Outra porta só com variáveis próprias e a autorização literal
 * `127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel`. DATABASE_URL e PG* genéricas nunca escolhem o
 * destino; o host é sempre 127.0.0.1 e o conector confere `inet_server_port()` antes de qualquer SQL.
 */
export const PORTA_PADRAO = 55498;

export function portaDescartavel(env: Record<string, string | undefined> = process.env): number {
  const texto = env.KIDMAIS_DESCARTAVEL_PORTA;
  if (texto === undefined || texto === "") return PORTA_PADRAO;
  if (!/^[0-9]{4,5}$/.test(texto)) throw new Error("KIDMAIS_DESCARTAVEL_PORTA inválida");
  const porta = Number(texto);
  if (porta < 1024 || porta > 65535) throw new Error("KIDMAIS_DESCARTAVEL_PORTA fora do intervalo");
  const esperada = `127.0.0.1:${porta}/kidmais_pacotes_v1_descartavel`;
  if (env.KIDMAIS_DESCARTAVEL_AUTORIZACAO !== esperada) throw new Error(`porta descartável ${porta} exige KIDMAIS_DESCARTAVEL_AUTORIZACAO=${esperada}`);
  return porta;
}
