// Guarda do alvo do ciclo PostgreSQL da 054, sem banco: nenhuma conexão é aberta aqui.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alvoAutorizado054, bancoProibido, conferirIdentidade054, GENERICAS_RECUSADAS } from "./alvo-054.ts";

const valido = {
  KIDMAIS_054_PG_HOST: "127.0.0.1",
  KIDMAIS_054_PG_PORT: "54054",
  KIDMAIS_054_PG_DATABASE: "kidmais_054_descartavel",
  KIDMAIS_054_PG_USER: "kidmais_descartavel",
  KIDMAIS_054_AUTORIZACAO: "127.0.0.1:54054/kidmais_054_descartavel",
};

test("alvo 054: só a combinação autorizada, repetida literalmente, é aceita", () => {
  assert.deepEqual(alvoAutorizado054(valido), { host: "127.0.0.1", port: 54054, database: "kidmais_054_descartavel", user: "kidmais_descartavel" });
  for (const chave of Object.keys(valido)) {
    const env: Record<string, string | undefined> = { ...valido, [chave]: undefined };
    assert.throws(() => alvoAutorizado054(env), /ausente/, chave);
  }
  assert.throws(() => alvoAutorizado054({ ...valido, KIDMAIS_054_AUTORIZACAO: "127.0.0.1:54054/outro_banco" }), /não repete/);
  assert.throws(() => alvoAutorizado054({ ...valido, KIDMAIS_054_AUTORIZACAO: "sim" }), /não repete/);
  assert.throws(() => alvoAutorizado054({ ...valido, KIDMAIS_054_PG_HOST: "db.example.com", KIDMAIS_054_AUTORIZACAO: "db.example.com:54054/kidmais_054_descartavel" }), /loopback/);
  assert.throws(() => alvoAutorizado054({ ...valido, KIDMAIS_054_PG_PORT: "80" }), /porta/);
  assert.throws(() => alvoAutorizado054({ ...valido, KIDMAIS_054_PG_DATABASE: "postgresql://x@127.0.0.1/db" }), /formato/);
});

test("alvo 054: kidmais_manager é proibido em qualquer grafia, na configuração e na resposta do servidor", () => {
  for (const nome of ["kidmais_manager", "KIDMAIS_MANAGER", " kidmais_manager", '"kidmais_manager"']) assert.equal(bancoProibido(nome), true, nome);
  assert.equal(bancoProibido("kidmais_manager_descartavel"), false);
  const proibido = { ...valido, KIDMAIS_054_PG_DATABASE: "kidmais_manager", KIDMAIS_054_AUTORIZACAO: "127.0.0.1:54054/kidmais_manager" };
  assert.throws(() => alvoAutorizado054(proibido), /kidmais_manager é proibido/);
  const alvo = alvoAutorizado054(valido);
  assert.throws(() => conferirIdentidade054(alvo, { database: "kidmais_manager", addr: "127.0.0.1", port: 54054 }), /kidmais_manager/);
});

test("alvo 054: DATABASE_URL e variáveis PG* genéricas recusam o ciclo (sem fallback)", () => {
  for (const nome of GENERICAS_RECUSADAS) {
    assert.throws(() => alvoAutorizado054({ ...valido, [nome]: "qualquer" }), /destino genérico/, nome);
  }
});

test("alvo 054: identidade do servidor precisa bater exatamente (banco, porta e endereço TCP)", () => {
  const alvo = alvoAutorizado054(valido);
  conferirIdentidade054(alvo, { database: "kidmais_054_descartavel", addr: "127.0.0.1", port: 54054 });
  assert.throws(() => conferirIdentidade054(alvo, { database: "outro", addr: "127.0.0.1", port: 54054 }), /current_database/);
  assert.throws(() => conferirIdentidade054(alvo, { database: "kidmais_054_descartavel", addr: "127.0.0.1", port: 5432 }), /inet_server_port/);
  assert.throws(() => conferirIdentidade054(alvo, { database: "kidmais_054_descartavel", addr: "10.0.0.5", port: 54054 }), /inet_server_addr/);
  assert.throws(() => conferirIdentidade054(alvo, { database: "kidmais_054_descartavel", addr: null, port: 54054 }), /sem endereço TCP/);
  const local = alvoAutorizado054({ ...valido, KIDMAIS_054_PG_HOST: "localhost", KIDMAIS_054_AUTORIZACAO: "localhost:54054/kidmais_054_descartavel" });
  conferirIdentidade054(local, { database: "kidmais_054_descartavel", addr: "::1", port: 54054 });
});

test("harness 054: conecta só pelo alvo autorizado e confere a identidade antes de qualquer outro SQL", () => {
  const conector = readFileSync("lib/fechamentos/" + ["postgres", "descartavel", "054.ts"].join("-"), "utf8");
  const i = conector.indexOf("export async function conectar054");
  const corpo = conector.slice(i, conector.indexOf("export async function encerrar054"));
  assert(corpo.indexOf("alvoAutorizado054(process.env)") < corpo.indexOf("client.connect()"));
  assert(corpo.indexOf("current_database()") < corpo.indexOf("pg_advisory_lock"));
  assert(corpo.indexOf("conferirIdentidade054(") < corpo.indexOf("SET statement_timeout"));
  assert.doesNotMatch(conector, /DATABASE_URL\b(?!\s+nem)|connectionString|\.env\.local/);
  const harness = readFileSync("lib/fechamentos/migration-054.postgres.test.ts", "utf8");
  // O harness não abre conexão própria nem fixa banco: só conectar054 (alvo autorizado).
  assert.doesNotMatch(harness, /connectionString|new pg\.Client|pg\.Pool|database:\s*["'`]/);
  assert.match(harness, /conectar054\(/);
  assert.match(harness, /assert\.notEqual\(ident\.db\.toLowerCase\(\), "kidmais_manager"\)/);
});
