/**
 * Alvo do ciclo PostgreSQL descartável da migration 054: só o que a autorização humana nomeou.
 *
 * Sem fallback: host, porta, banco e usuário vêm de variáveis próprias da 054, e a autorização
 * repete `host:porta/banco` literalmente. DATABASE_URL e as variáveis PG* genéricas recusam o
 * ciclo (nunca escolhem o destino). O banco real `kidmais_manager` é proibido em qualquer grafia.
 * Módulo puro (sem driver): testado sem banco.
 */
export type Alvo054 = { host: string; port: number; database: string; user: string };
export type Identidade054 = { database: string | null; addr: string | null; port: number | null };

export const VARIAVEIS_054 = {
  host: "KIDMAIS_054_PG_HOST",
  port: "KIDMAIS_054_PG_PORT",
  database: "KIDMAIS_054_PG_DATABASE",
  user: "KIDMAIS_054_PG_USER",
  autorizacao: "KIDMAIS_054_AUTORIZACAO",
} as const;

/** Variáveis que o driver `pg` usaria como fallback de destino: presença recusa o ciclo. */
export const GENERICAS_RECUSADAS = ["DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGSERVICEFILE"] as const;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function falhar(motivo: string): never {
  throw new Error(`Ciclo PostgreSQL da 054 recusado: ${motivo}`);
}

export function bancoProibido(nome: string | null | undefined) {
  return typeof nome === "string" && nome.trim().toLowerCase().replace(/^"|"$/g, "") === "kidmais_manager";
}

function exigir(env: Record<string, string | undefined>, nome: string) {
  const valor = env[nome];
  if (valor === undefined || valor === "") falhar(`${nome} ausente (não há valor padrão).`);
  if (valor !== valor.trim() || valor.includes("://") || /[\s@?#]/.test(valor)) falhar(`${nome} com formato inválido.`);
  return valor;
}

/** Lê e valida o alvo autorizado. Qualquer divergência recusa antes de abrir conexão. */
export function alvoAutorizado054(env: Record<string, string | undefined>): Alvo054 {
  for (const nome of GENERICAS_RECUSADAS) if (env[nome] !== undefined) falhar(`${nome} definida; o ciclo não usa destino genérico.`);
  const host = exigir(env, VARIAVEIS_054.host);
  const portaTexto = exigir(env, VARIAVEIS_054.port);
  const database = exigir(env, VARIAVEIS_054.database);
  const user = exigir(env, VARIAVEIS_054.user);
  const autorizacao = exigir(env, VARIAVEIS_054.autorizacao);
  if (!/^[0-9]{4,5}$/.test(portaTexto)) falhar("porta inválida.");
  const port = Number(portaTexto);
  if (port < 1024 || port > 65535) falhar("porta fora do intervalo.");
  if (!/^[a-z0-9_]+$/.test(database)) falhar("nome de banco inválido.");
  if (bancoProibido(database)) falhar("o banco real kidmais_manager é proibido.");
  if (!/^[a-z0-9_]+$/.test(user)) falhar("usuário inválido.");
  if (!LOOPBACK.has(host)) falhar("o ciclo só roda em host local (loopback).");
  if (autorizacao !== `${host}:${port}/${database}`) falhar(`${VARIAVEIS_054.autorizacao} não repete exatamente host:porta/banco.`);
  return { host, port, database, user };
}

/** Confere a identidade informada pelo próprio servidor, antes de qualquer outro SQL. */
export function conferirIdentidade054(alvo: Alvo054, ident: Identidade054) {
  if (bancoProibido(ident.database)) falhar("o servidor respondeu kidmais_manager.");
  if (ident.database !== alvo.database) falhar(`current_database() = ${String(ident.database)}, esperado ${alvo.database}.`);
  if (ident.port !== alvo.port) falhar(`inet_server_port() = ${String(ident.port)}, esperado ${alvo.port}.`);
  if (ident.addr === null) falhar("conexão sem endereço TCP (inet_server_addr nulo).");
  const aceitos = alvo.host === "localhost" ? ["127.0.0.1", "::1"] : [alvo.host];
  if (!aceitos.includes(ident.addr)) falhar(`inet_server_addr() = ${ident.addr}, esperado ${aceitos.join(" ou ")}.`);
}
