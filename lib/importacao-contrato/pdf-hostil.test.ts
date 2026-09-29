import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { LIMITES, extrairTextoPdf, lerToUnicode, temTextoNativo, type TextoPdf } from "./pdf-texto.ts";

/**
 * PDF hostil (B1). Casos que poderiam travar rodam num Worker com prazo e `terminate()`:
 * se uma regressão reintroduzir laço infinito, o teste falha por timeout em vez de travar a suíte.
 */
function extrairIsolado(bytes: Uint8Array, opcoes: { limiteTrabalho?: number; prazoMs?: number } = {}, timeoutMs = 8_000): Promise<TextoPdf | "TIMEOUT"> {
  const modulo = new URL("./pdf-texto.ts", import.meta.url).href;
  const codigo = `const { parentPort, workerData } = require("node:worker_threads");
import(workerData.modulo)
  .then((m) => parentPort.postMessage({ ok: m.extrairTextoPdf(new Uint8Array(workerData.bytes), workerData.opcoes) }))
  .catch((e) => parentPort.postMessage({ erro: String(e && e.message) }));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(codigo, { eval: true, workerData: { modulo, bytes, opcoes } });
    const timer = setTimeout(() => { void worker.terminate(); resolve("TIMEOUT"); }, timeoutMs);
    worker.once("message", (m: { ok?: TextoPdf; erro?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.erro) reject(new Error(m.erro)); else resolve(m.ok!);
    });
    worker.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** PDF de uma página cuja fonte Type0 usa o CMap informado e cujo conteúdo é informado. */
function pdfCom(cmap: string, conteudo: string) {
  const c = deflateSync(Buffer.from(conteudo, "latin1"));
  const m = deflateSync(Buffer.from(cmap, "latin1"));
  const partes = [
    "%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>\nendobj\n",
  ].map((s) => Buffer.from(s, "latin1"));
  const stream = (n: number, dados: Buffer) => Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${dados.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), dados, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  return new Uint8Array(Buffer.concat([...partes, stream(5, c), stream(6, m), Buffer.from("%%EOF\n", "latin1")]));
}

const range = (a: string, b: string, destino: string) => `beginbfrange <${a}> <${b}> <${destino}> endbfrange`;

test("bfrange hostil: 2^53, descendente, gigantesco e destino Unicode inválido são descartados sem laço nem exceção", () => {
  const avisos: string[] = [];
  // 2^53 = 0x20000000000000: fora do inteiro seguro para iteração ⇒ recusado antes de iterar.
  assert.equal(lerToUnicode(range("20000000000000", "20000000000005", "0041"), avisos).size, 0);
  assert.equal(lerToUnicode(range("0010", "0005", "0041"), avisos).size, 0, "descendente");
  assert.equal(lerToUnicode(range("00000000", "FFFFFFFF", "0041"), avisos).size, 0, "amplitude acima do teto");
  assert.equal(lerToUnicode(range("0000", "0001", "D800"), avisos).size, 0, "surrogate isolado");
  assert.equal(lerToUnicode("beginbfchar <0001> <DC00> <0002> <110000> <0003> <> endbfchar", avisos).size, 0);
  assert.equal(lerToUnicode(range("0000", "0002", "FFFF"), avisos).size, 1, "incremento além de U+FFFF para no primeiro inválido");
  assert.ok(avisos.includes("CMAP_RANGE_INVALIDO") && avisos.includes("CMAP_INVALIDO"));
  assert.equal(lerToUnicode(range("0000", "00FF", "0041"), []).size, LIMITES.amplitudeRange, "range válido no teto continua funcionando");
});

test("CMap com entradas demais é truncado com aviso", () => {
  const entradas = Array.from({ length: LIMITES.entradasCmap + 10 }, (_, i) => `<${i.toString(16).padStart(8, "0")}> <0041>`).join(" ");
  const avisos: string[] = [];
  assert.equal(lerToUnicode(`beginbfchar ${entradas} endbfchar`, avisos).size, LIMITES.entradasCmap);
  assert.ok(avisos.includes("CMAP_GRANDE"));
});

test("PDF com CMap 2^53 dentro do limite de bytes: termina, sem travar, e sem inventar texto", async () => {
  const pdf = pdfCom(range("20000000000000", "20000000000010", "0041"), "BT /F1 10 Tf <0041> Tj ET");
  const r = await extrairIsolado(pdf);
  assert.notEqual(r, "TIMEOUT");
  if (r === "TIMEOUT") return;
  assert.ok(r.avisos.includes("CMAP_RANGE_INVALIDO"));
  assert.deepEqual(r.paginas, [""]);
});

test("explosão de trabalho dentro do limite de bytes: orçamento interrompe, controlado", async () => {
  // ~6 MB de tokens minúsculos comprimem para poucos KB.
  const pdf = pdfCom("", "1 ".repeat(3_000_000));
  assert.ok(pdf.length < 64 * 1024, `arquivo pequeno: ${pdf.length} bytes`);
  const limitado = await extrairIsolado(pdf, { limiteTrabalho: 200_000 });
  assert.notEqual(limitado, "TIMEOUT");
  if (limitado !== "TIMEOUT") {
    assert.equal(limitado.interrompido, "LIMITE_TRABALHO");
    assert.equal(temTextoNativo(limitado), false, "interrompida nunca conta como texto completo");
  }
  // Com o orçamento padrão também termina dentro do prazo.
  const padrao = await extrairIsolado(pdf);
  assert.notEqual(padrao, "TIMEOUT");
});

test("muitos cabeçalhos sem endobj não viram varredura quadrática", async () => {
  const hostil = new Uint8Array(Buffer.from(`%PDF-1.4\n${"1 0 obj\n<< >>\n".repeat(19_000)}endobj\n%%EOF`, "latin1"));
  const inicio = Date.now();
  const r = await extrairIsolado(hostil);
  assert.notEqual(r, "TIMEOUT");
  assert.ok(Date.now() - inicio < 8_000);
});

test("prazo de relógio e cancelamento interrompem a extração", () => {
  const pdf = pdfCom("", "BT /F1 10 Tf <0041> Tj ET\n".repeat(20_000));
  let relogio = 0;
  const porPrazo = extrairTextoPdf(pdf, { prazoMs: 5, agora: () => (relogio += 1) });
  assert.equal(porPrazo.interrompido, "PRAZO");
  const controle = new AbortController();
  controle.abort();
  const cancelado = extrairTextoPdf(pdf, { sinal: controle.signal });
  assert.equal(cancelado.interrompido, "CANCELADO");
});

test("estrutura corrompida nunca lança para quem chama", () => {
  for (const lixo of ["%PDF-1.4\n1 0 obj\n<< /Length 999999 >>\nstream\nÿÿ", "%PDF-1.7\n9999999999 0 obj endobj", "%PDF-"]) {
    assert.doesNotThrow(() => extrairTextoPdf(new Uint8Array(Buffer.from(lixo, "latin1"))));
  }
});

// ---------------------------------------------------------------- rodada 3: CMap sem regex, dicionários limitados

test("A1: PDF de poucos KB com beginbfchar repetido sem fechamento não bloqueia (antes: regex quadrática > 4 s)", async () => {
  const cmap = "beginbfchar <0001> ".repeat(300_000);
  const pdf = pdfCom(cmap, "BT /F1 10 Tf <0001> Tj ET");
  assert.ok(pdf.length < 64 * 1024, `arquivo pequeno: ${pdf.length} bytes`);
  const inicio = performance.now();
  const r = extrairTextoPdf(pdf);
  const ms = performance.now() - inicio;
  assert.ok(ms < 2_000, `terminou em ${Math.round(ms)} ms`);
  assert.ok(r.avisos.includes("CMAP_BLOCO_SEM_FIM") || r.avisos.includes("CMAP_GRANDE") || r.interrompido !== null, JSON.stringify(r.avisos));
});

test("A1: beginbfrange repetido sem fechamento, hex sem '>' e arrays sem ']' são lidos em uma passada", () => {
  for (const cmap of ["beginbfrange <00> <01> ".repeat(200_000), "beginbfchar <" + "0".repeat(2_000_000), "beginbfrange <0000> <0001> [" + "<0041> ".repeat(300_000)]) {
    const avisos: string[] = [];
    const inicio = performance.now();
    lerToUnicode(cmap, avisos);
    assert.ok(performance.now() - inicio < 2_000, cmap.slice(0, 30));
  }
  const avisos: string[] = [];
  assert.equal(lerToUnicode("beginbfchar <0001> <0041> beginbfchar <0002> <0042> endbfchar", avisos).size, 2);
  assert.ok(avisos.includes("CMAP_BLOCO_SEM_FIM"), "begin dentro de bloco aberto é anotado");
  assert.equal(lerToUnicode(`beginbfchar <${"1".repeat(200)}> <0041> endbfchar`, avisos).size, 0, "token hex longo demais é inválido");
});

test("A1: dicionário gigante com /Filter[ e /Kids[ repetidos sem fechamento não vira varredura quadrática", () => {
  const dicionario = "/Filter [ /Kids [ ".repeat(200_000);
  const pdf = new Uint8Array(Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages ${dicionario} >>\nendobj\n%%EOF`, "latin1"));
  const inicio = performance.now();
  const r = extrairTextoPdf(pdf);
  assert.ok(performance.now() - inicio < 2_000);
  assert.ok(r.avisos.includes("DICIONARIO_GRANDE"));
});

test("A1: o parser não tem regex sobre bloco arbitrário do CMap", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("./pdf-texto.ts", import.meta.url), "utf8");
  assert.doesNotMatch(fonte, /\[\s\S\]\*\?/, "sem [\s\S]*? (varredura lazy até o fim)");
  assert.doesNotMatch(fonte, /\[\^\\]\]\*/, "sem [^\]]* sem teto");
});
