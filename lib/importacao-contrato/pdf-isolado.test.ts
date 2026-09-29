import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { extrairTextoPdfIsolado, rodarEmWorker } from "./pdf-isolado.ts";

/** A1: isolamento real em Worker — prazo e cancelamento encerram o Worker; o event loop segue livre. */
function pdfPesado() {
  const conteudo = deflateSync(Buffer.from("BT /F1 10 Tf (A) Tj ET\n".repeat(300_000), "latin1"));
  return new Uint8Array(Buffer.concat([
    Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n", "latin1"),
    Buffer.from(`4 0 obj\n<< /Length ${conteudo.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), conteudo, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]));
}

test("Worker: PDF válido volta com o texto lido fora do processo principal", async () => {
  const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 25 >>\nstream\nBT /F1 10 Tf (Oi) Tj ET\nendstream\nendobj\n%%EOF", "latin1"));
  const r = await extrairTextoPdfIsolado(pdf, { prazoMs: 3_000 });
  assert.deepEqual(r.paginas, ["Oi"]);
  assert.equal(r.interrompido, null);
});

test("Worker: cancelamento do pedido real encerra a extração e libera quem chama na hora", async () => {
  const controle = new AbortController();
  const inicio = performance.now();
  const pendente = extrairTextoPdfIsolado(pdfPesado(), { sinal: controle.signal, prazoMs: 10_000, limiteTrabalho: 10_000_000_000 });
  setTimeout(() => controle.abort(), 20);
  let batidas = 0;
  const pulso = setInterval(() => { batidas += 1; }, 5);
  const r = await pendente;
  clearInterval(pulso);
  assert.equal(r.interrompido, "CANCELADO");
  assert.ok(performance.now() - inicio < 3_000);
  assert.ok(batidas > 0, "o event loop continuou rodando durante a extração");
});

test("Worker: prazo curto interrompe a extração real", async () => {
  const r = await extrairTextoPdfIsolado(pdfPesado(), { prazoMs: 1, limiteTrabalho: 10_000_000_000 });
  assert.equal(r.interrompido, "PRAZO");
});

test("Worker: prazo vale mesmo que o código do Worker nunca confira o relógio (terminate)", async () => {
  const inicio = performance.now();
  // Worker que trava de propósito: só o terminate do chamador encerra.
  const r = await rodarEmWorker((o) => new Worker("while (true) {}", { ...o, eval: true }), new Uint8Array([1]), { prazoMs: 50 });
  assert.equal(r.interrompido, "PRAZO");
  assert.ok(r.avisos.includes("WORKER_ENCERRADO"));
  assert.ok(performance.now() - inicio < 5_000);
});

test("Worker: sinal já cancelado nem cria Worker", async () => {
  const controle = new AbortController();
  controle.abort();
  const r = await extrairTextoPdfIsolado(new Uint8Array([1]), { sinal: controle.signal });
  assert.equal(r.interrompido, "CANCELADO");
});
