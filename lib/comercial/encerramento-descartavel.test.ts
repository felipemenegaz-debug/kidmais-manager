import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { descreverFalha, encerrarRegistrando, registrarFalhaPadrao, type FalhaLimpeza } from "./encerramento-descartavel.ts";

/** Cliente simulado: registra a ordem das chamadas e rejeita os SQL indicados. */
function cliente(rejeitar: Record<string, unknown> = {}, endRejeita?: unknown) {
  const chamadas: string[] = [];
  return {
    chamadas,
    async query(sql: string) {
      chamadas.push(sql.startsWith("SELECT pg_advisory_unlock") ? "unlock" : sql);
      const chave = sql.startsWith("SELECT pg_advisory_unlock") ? "unlock" : sql;
      if (chave in rejeitar) throw rejeitar[chave];
      return { rows: [] };
    },
    async end() {
      chamadas.push("end");
      if (endRejeita) throw endRejeita;
    },
  };
}
const erroPg = (code: string, message: string) => Object.assign(new Error(message), { code });

test("sem falha: ROLLBACK, unlock e end, nessa ordem, e nada registrado", async () => {
  const c = cliente(); const falhas: FalhaLimpeza[] = [];
  await encerrarRegistrando(c, 7, (f) => falhas.push(f));
  assert.deepEqual(c.chamadas, ["ROLLBACK", "unlock", "end"]);
  assert.deepEqual(falhas, []);
});

test("ROLLBACK cancelado (57014): registra fase e SQLSTATE, não relança, e ainda faz unlock e end", async () => {
  const c = cliente({ ROLLBACK: erroPg("57014", "canceling statement due to statement timeout") }); const falhas: FalhaLimpeza[] = [];
  await encerrarRegistrando(c, 7, (f) => falhas.push(f));
  assert.deepEqual(c.chamadas, ["ROLLBACK", "unlock", "end"]);
  assert.deepEqual(falhas, [{ fase: "rollback", sqlstate: "57014", mensagem: "canceling statement due to statement timeout" }]);
});

test("unlock falha (25P02): registrado, e o end acontece", async () => {
  const c = cliente({ unlock: erroPg("25P02", "current transaction is aborted") }); const falhas: FalhaLimpeza[] = [];
  await encerrarRegistrando(c, 7, (f) => falhas.push(f));
  assert.deepEqual(c.chamadas, ["ROLLBACK", "unlock", "end"]);
  assert.deepEqual(falhas.map((f) => [f.fase, f.sqlstate]), [["unlock", "25P02"]]);
});

test("as duas fases falham: duas falhas registradas, na ordem", async () => {
  const c = cliente({ ROLLBACK: erroPg("57014", "x"), unlock: erroPg("25P02", "y") }); const falhas: FalhaLimpeza[] = [];
  await encerrarRegistrando(c, 7, (f) => falhas.push(f));
  assert.deepEqual(falhas.map((f) => `${f.fase}:${f.sqlstate}`), ["rollback:57014", "unlock:25P02"]);
  assert.equal(c.chamadas.at(-1), "end");
});

test("sem trava (travou=false): não chama unlock", async () => {
  const c = cliente();
  await encerrarRegistrando(c, null, () => assert.fail("nada a registrar"));
  assert.deepEqual(c.chamadas, ["ROLLBACK", "end"]);
});

test("registro que lança não impede unlock nem end", async () => {
  const c = cliente({ ROLLBACK: erroPg("57014", "x"), unlock: erroPg("25P02", "y") });
  await encerrarRegistrando(c, 7, () => { throw new Error("registro quebrado"); });
  assert.deepEqual(c.chamadas, ["ROLLBACK", "unlock", "end"]);
});

test("falha no end continua chegando ao chamador (comportamento anterior preservado)", async () => {
  const c = cliente({}, new Error("socket caiu"));
  await assert.rejects(encerrarRegistrando(c, 7, () => {}), /socket caiu/);
});

test("erro sem código vira SQLSTATE nulo; mensagem limitada a 200 caracteres", () => {
  assert.deepEqual(descreverFalha("rollback", "texto"), { fase: "rollback", sqlstate: null, mensagem: "texto" });
  assert.equal(descreverFalha("unlock", new Error("x".repeat(500))).mensagem.length, 200);
  assert.equal(descreverFalha("unlock", { code: 42 }).sqlstate, null);
});

test("registro padrão: grava JSONL no destino e não lança com destino inválido", () => {
  const pasta = mkdtempSync(path.join(tmpdir(), "kidmais-limpeza-"));
  const original = console.error;
  const linhas: unknown[][] = [];
  console.error = (...a: unknown[]) => { linhas.push(a); };
  try {
    const destino = path.join(pasta, "r.jsonl");
    registrarFalhaPadrao({ fase: "rollback", sqlstate: "57014", mensagem: "m" }, destino);
    registrarFalhaPadrao({ fase: "unlock", sqlstate: null, mensagem: "n" }, destino);
    const gravado = readFileSync(destino, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(gravado.map((g) => [g.fase, g.sqlstate, g.mensagem]), [["rollback", "57014", "m"], ["unlock", null, "n"]]);
    assert.ok(gravado.every((g) => typeof g.iso === "string"));
    assert.doesNotThrow(() => registrarFalhaPadrao({ fase: "rollback", sqlstate: null, mensagem: "z" }, path.join(pasta, "nao-existe", "r.jsonl")));
    assert.equal(linhas.length, 3);
    assert.equal(linhas[0][0], "LIMPEZA_DESCARTAVEL_FALHOU");
  } finally {
    console.error = original;
    rmSync(pasta, { recursive: true, force: true });
  }
});
