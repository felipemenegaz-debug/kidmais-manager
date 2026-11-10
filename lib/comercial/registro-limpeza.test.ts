import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { lerLimpeza, resumoLimpeza } = require("./registro-limpeza.cjs") as {
  lerLimpeza: (arquivo: string) => { fase: string; sqlstate: string | null; mensagem: string }[];
  resumoLimpeza: (falhas: { fase: string; sqlstate: string | null }[]) => string;
};

function comPasta(fn: (pasta: string) => void) {
  const pasta = mkdtempSync(path.join(tmpdir(), "kidmais registro limpeza "));
  try { fn(pasta); } finally { rmSync(pasta, { recursive: true, force: true }); }
}

test("arquivo ausente: lista vazia", () => comPasta((p) => assert.deepEqual(lerLimpeza(path.join(p, "nao-existe.jsonl")), [])));

test("JSONL válido, com CRLF e linha em branco, num caminho com espaços", () => comPasta((p) => {
  const f = path.join(p, "r.jsonl");
  writeFileSync(f, '{"iso":"x","fase":"rollback","sqlstate":"57014","mensagem":"cancelado"}\r\n\r\n{"fase":"unlock","sqlstate":null,"mensagem":"m"}\r\n');
  assert.deepEqual(lerLimpeza(f), [{ fase: "rollback", sqlstate: "57014", mensagem: "cancelado" }, { fase: "unlock", sqlstate: null, mensagem: "m" }]);
}));

test("null, número, array, objeto sem fase e JSON quebrado viram 'ilegível' sem lançar", () => comPasta((p) => {
  const f = path.join(p, "r.jsonl");
  writeFileSync(f, ["null", "42", "[1]", '{"sqlstate":"1"}', "{quebrado", '"texto"'].join("\n"));
  const r = lerLimpeza(f);
  assert.equal(r.length, 6);
  assert.ok(r.every((x) => x.fase === "ilegível" && x.sqlstate === null));
  assert.equal(r[0].mensagem, "null");
}));

test("arquivo que não pode ser lido (é uma pasta): uma entrada 'registro', sem lançar", () => comPasta((p) => {
  const f = path.join(p, "pasta.jsonl");
  mkdirSync(f);
  const r = lerLimpeza(f);
  assert.equal(r.length, 1);
  assert.equal(r[0].fase, "registro");
  assert.match(r[0].mensagem, /registro de limpeza não pôde ser lido/);
}));

test("caminho inválido não lança", () => assert.doesNotThrow(() => lerLimpeza("\0inválido")));

test("mensagem e fase saem numa linha só, com no máximo 200 caracteres; sqlstate não textual vira nulo", () => comPasta((p) => {
  const f = path.join(p, "r.jsonl");
  writeFileSync(f, `${JSON.stringify({ fase: "rollback\nx", sqlstate: 57014, mensagem: `a\nb\r\nc${"z".repeat(500)}` })}\n`);
  const [r] = lerLimpeza(f);
  assert.equal(r.fase, "rollback x");
  assert.equal(r.sqlstate, null);
  assert.ok(!/[\r\n]/.test(r.mensagem) && r.mensagem.startsWith("a b c") && r.mensagem.length === 200);
}));

test("resumo por fase e SQLSTATE", () => {
  assert.equal(resumoLimpeza([{ fase: "rollback", sqlstate: "57014" }, { fase: "unlock", sqlstate: null }]), "rollback 57014, unlock sem SQLSTATE");
  assert.equal(resumoLimpeza([]), "");
});
