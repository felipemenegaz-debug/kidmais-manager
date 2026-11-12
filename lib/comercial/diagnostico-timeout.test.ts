import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { instrumentarTimeout, type ClienteDiagnostico } from "./diagnostico-timeout.ts";

/**
 * B-14 (revisão do HB-3 r4, P3): o diagnóstico do 57014 tem prazo na coleta e no encerramento e sempre relança o erro
 * original — mesmo com uma segunda conexão que nunca responde.
 */
const PRAZO = 60;
const ENCERRAR = 40;
const nunca = () => new Promise<never>(() => undefined);
const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

/** Cliente falso com os eventos de um EventEmitter, como o pg.Client: `emit("error")` sem ouvinte lança. */
type Falso = Partial<Omit<ClienteDiagnostico, "on">>;
function montar(falha: Error, cliente: Falso | ((emissor: EventEmitter) => Falso)) {
  const registros: string[] = [];
  let aberturas = 0;
  let destruicoes = 0;
  const principal = { query: async () => Promise.reject(falha) };
  instrumentarTimeout(
    principal,
    () => {
      aberturas += 1;
      const emissor = new EventEmitter();
      const completo: ClienteDiagnostico = Object.assign(emissor, {
        connect: async () => undefined,
        query: async () => ({ rows: [] }),
        end: async () => undefined,
        ...(typeof cliente === "function" ? cliente(emissor) : cliente),
      });
      return { cliente: completo, destruir: () => void (destruicoes += 1) };
    },
    { prazoMs: PRAZO, encerrarMs: ENCERRAR, registrar: (rotulo, detalhe) => void registros.push(rotulo + " " + detalhe) },
  );
  return { principal, registros, aberturas: () => aberturas, destruicoes: () => destruicoes };
}

async function relanca(principal: { query: (sql: string) => Promise<unknown> }, original: Error) {
  const inicio = Date.now();
  await assert.rejects(principal.query("SELECT 1"), (erro) => erro === original);
  return Date.now() - inicio;
}

test("coleta completa: registra a fotografia e relança o MESMO erro", async () => {
  const original = timeout();
  const m = montar(original, { query: async (sql) => ({ rows: sql.includes("pg_locks") ? [{ pid: 7 }] : [{ pid: 1 }] }) });
  await relanca(m.principal, original);
  assert.equal(m.registros.length, 1);
  assert.match(m.registros[0], /^DIAGNOSTICO_PG_TIMEOUT \{"sql":"SELECT 1","sessoes":\[\{"pid":1\}\],"travas":\[\{"pid":7\}\]\}/);
  assert.equal(m.destruicoes(), 0);
});

test("connect que nunca responde: prazo esgota, encerra e relança dentro do limite", async () => {
  const original = timeout();
  const m = montar(original, { connect: nunca });
  const ms = await relanca(m.principal, original);
  assert.ok(ms < PRAZO + ENCERRAR + 500, `levou ${ms} ms`);
  assert.match(m.registros[0], /^DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA prazo de 60 ms esgotado/);
});

test("consulta de diagnóstico que nunca responde: mesmo prazo", async () => {
  const original = timeout();
  const m = montar(original, { query: nunca });
  const ms = await relanca(m.principal, original);
  assert.ok(ms < PRAZO + ENCERRAR + 500, `levou ${ms} ms`);
  assert.match(m.registros[0], /SEM_FOTOGRAFIA prazo/);
});

test("tudo trava, inclusive o encerramento: a conexão é destruída e o erro original sai", async () => {
  const original = timeout();
  const m = montar(original, { connect: nunca, end: nunca });
  const ms = await relanca(m.principal, original);
  assert.ok(ms < PRAZO + ENCERRAR + 500, `levou ${ms} ms`);
  assert.equal(m.destruicoes(), 1);
  assert.deepEqual(
    m.registros.map((r) => r.split(" ")[0]),
    ["DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA", "DIAGNOSTICO_PG_ENCERRAMENTO_ESGOTADO"],
  );
});

test("falhas síncronas da coleta (abrir, end) não substituem o erro original", async () => {
  const original = timeout();
  const m = montar(original, {
    connect: async () => Promise.reject(new Error("recusada")),
    end: () => {
      throw new Error("end síncrono");
    },
  });
  await relanca(m.principal, original);
  assert.match(m.registros[0], /SEM_FOTOGRAFIA recusada/);

  const principal = { query: async () => Promise.reject(original) };
  instrumentarTimeout(principal, () => {
    throw new Error("abrir falhou");
  }, { registrar: () => undefined });
  await relanca(principal, original);
});

/** Exceções que escapam do fluxo de promessas (como o `error` emitido pelo socket do pg, fora da cadeia). */
async function semExcecaoSolta(acao: () => Promise<void>) {
  const escapadas: unknown[] = [];
  const pegar = (erro: unknown) => void escapadas.push(erro);
  process.on("uncaughtException", pegar);
  try {
    await acao();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    process.off("uncaughtException", pegar);
  }
  assert.deepEqual(escapadas.map((e) => String((e as Error)?.message ?? e)), []);
}
const emitirDepois = (emissor: EventEmitter, mensagem: string) => setImmediate(() => emissor.emit("error", new Error(mensagem)));

test("queda do socket depois de conectar, durante a coleta: evento tratado e erro original relançado", async () => {
  await semExcecaoSolta(async () => {
    const original = timeout();
    const m = montar(original, (emissor) => ({
      query: () => {
        emitirDepois(emissor, "Connection terminated unexpectedly");
        return new Promise((_, rejeitar) => setImmediate(() => rejeitar(new Error("Connection terminated unexpectedly"))));
      },
    }));
    await relanca(m.principal, original);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(m.registros.some((r) => r.startsWith("DIAGNOSTICO_PG_CONEXAO_ERRO Connection terminated")), m.registros.join(" | "));
    assert.ok(m.registros.some((r) => r.startsWith("DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA")));
  });
});

test("erro emitido no encerramento e depois do relançamento: nada escapa", async () => {
  await semExcecaoSolta(async () => {
    const original = timeout();
    const m = montar(original, (emissor) => ({
      end: async () => {
        emitirDepois(emissor, "erro no encerramento");
        setTimeout(() => emissor.emit("error", new Error("erro tardio")), 15);
      },
    }));
    await relanca(m.principal, original);
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(m.registros.filter((r) => r.startsWith("DIAGNOSTICO_PG_CONEXAO_ERRO")).length, 2);
  });
});

test("fora do 57014 nada é aberto e o resultado normal passa intacto", async () => {
  const outro = Object.assign(new Error("duplicada"), { code: "23505" });
  const m = montar(outro, {});
  await relanca(m.principal, outro);
  assert.equal(m.aberturas(), 0);
  assert.equal(m.registros.length, 0);

  const ok = { query: async (sql: string) => ({ rows: [sql] }) };
  instrumentarTimeout(ok, () => {
    throw new Error("não deveria abrir");
  });
  assert.deepEqual(await ok.query("SELECT 2"), { rows: ["SELECT 2"] });
});
