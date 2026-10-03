/**
 * Alvo do cluster PostgreSQL descartável das suítes `*.postgres.test.ts` (mesmo padrão de `alvo-054.ts`).
 * Módulo puro (sem driver): testado sem banco.
 *
 * Porta padrão histórica 55498. Outra porta só com variáveis próprias e a autorização literal
 * `127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel`. DATABASE_URL e PG* genéricas nunca escolhem o
 * destino; o host é sempre 127.0.0.1 e o conector confere `inet_server_port()` antes de qualquer SQL.
 */
export const PORTA_PADRAO = 55498;

/**
 * Configuração de conexão herdada que o driver (`pg`/libpq) usaria sem pedir: DATABASE_URL e QUALQUER PG*
 * (PGHOST, PGPORT, PGOPTIONS, PGSERVICE, PGSERVICEFILE, PGPASSFILE, PGPASSWORD, PGSSL*...). Nunca pode existir no
 * processo que conecta ao cluster descartável.
 */
export function variavelDeConexaoHerdada(nome: string) {
  return nome === "DATABASE_URL" || /^PG/i.test(nome);
}

export function exigirAmbienteSemConexaoHerdada(env: Record<string, string | undefined> = process.env) {
  const herdadas = Object.keys(env).filter(variavelDeConexaoHerdada);
  if (herdadas.length) throw new Error(`cluster descartável recusado: configuração de conexão herdada (${herdadas.join(", ")})`);
}

/** O cluster descartável usa trust só em 127.0.0.1: se o servidor pedir senha, o destino diverge e a conexão falha. */
export async function senhaRecusada(): Promise<string> {
  throw new Error("cluster descartável: o servidor pediu senha; nenhuma credencial é carregada");
}

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
