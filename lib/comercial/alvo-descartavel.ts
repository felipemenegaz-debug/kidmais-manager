/**
 * Alvo do cluster PostgreSQL descartável das suítes `*.postgres.test.ts` (mesmo padrão de `alvo-054.ts`).
 * Módulo puro (sem driver): testado sem banco.
 *
 * Sem padrão implícito: a suíte só conecta com opt-in explícito (`KIDMAIS_POSTGRES_DESCARTAVEL`), porta explícita
 * (`KIDMAIS_DESCARTAVEL_PORTA`) e a autorização literal `127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel` — o que o
 * runner (`check:v1:postgres`) repassa a cada suíte. Execução local comum (`node --test` direto) falha ANTES de
 * qualquer conexão. DATABASE_URL e PG* genéricas nunca escolhem o destino; o host é sempre 127.0.0.1 e o conector
 * confere a identidade do servidor antes de qualquer outro SQL.
 */
/** Porta do cluster sintético autorizado (documentação e orquestrador); NUNCA usada como padrão pelo conector. */
export const PORTA_PADRAO = 55498;
export const BANCO_DESCARTAVEL = "kidmais_pacotes_v1_descartavel";
export const PAPEL_DESCARTAVEL = "kidmais_descartavel";

/** Opt-in explícito do harness PostgreSQL; sem ele nenhuma suíte conecta. */
export function exigirOptInDescartavel(env: Record<string, string | undefined> = process.env) {
  if (env.KIDMAIS_POSTGRES_DESCARTAVEL !== BANCO_DESCARTAVEL) {
    throw new Error("suíte PostgreSQL sem opt-in explícito (KIDMAIS_POSTGRES_DESCARTAVEL): nenhuma conexão tentada. Rode pelo check:v1:postgres no cluster sintético autorizado.");
  }
}

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
  exigirOptInDescartavel(env);
  const texto = env.KIDMAIS_DESCARTAVEL_PORTA;
  if (texto === undefined || texto === "") throw new Error("KIDMAIS_DESCARTAVEL_PORTA ausente: o conector não usa porta padrão");
  if (!/^[0-9]{4,5}$/.test(texto)) throw new Error("KIDMAIS_DESCARTAVEL_PORTA inválida");
  const porta = Number(texto);
  if (porta < 1024 || porta > 65535) throw new Error("KIDMAIS_DESCARTAVEL_PORTA fora do intervalo");
  const esperada = `127.0.0.1:${porta}/kidmais_pacotes_v1_descartavel`;
  if (env.KIDMAIS_DESCARTAVEL_AUTORIZACAO !== esperada) throw new Error(`porta descartável ${porta} exige KIDMAIS_DESCARTAVEL_AUTORIZACAO=${esperada}`);
  return porta;
}
