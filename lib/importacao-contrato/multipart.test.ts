import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { boundaryDe, criarSemaforo, lerMultipartLimitado, limitesUpload, type LimitesMultipart } from "./multipart.ts";

const BOUNDARY = "----kidmais123";
const TIPO = `multipart/form-data; boundary=${BOUNDARY}`;
const LIMITES: LimitesMultipart = { totalBytes: 2048, arquivoBytes: 1024, partes: 3, cabecalhoBytes: 256, campoBytes: 64 };

function parte(cabecalho: string, corpo: Uint8Array | string) {
  return Buffer.concat([Buffer.from(`--${BOUNDARY}\r\n${cabecalho}\r\n\r\n`), Buffer.from(corpo), Buffer.from("\r\n")]);
}
const arquivo = (bytes: Uint8Array | string, nome = "contrato.pdf") => parte(`Content-Disposition: form-data; name="arquivo"; filename="${nome}"\r\nContent-Type: application/pdf`, bytes);
const campo = (nome: string, valor: string) => parte(`Content-Disposition: form-data; name="${nome}"`, valor);
const corpo = (...partes: Buffer[]) => Buffer.concat([...partes, Buffer.from(`--${BOUNDARY}--\r\n`)]);

/** Stream em pedaços que conta quanto foi puxado e se foi cancelado. */
function stream(bytes: Uint8Array, pedaco = 128) {
  const estado = { puxados: 0, cancelado: false };
  let pos = 0;
  const s = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return; }
      const fatia = bytes.slice(pos, pos + pedaco);
      pos += fatia.length;
      estado.puxados += fatia.length;
      controller.enqueue(fatia);
    },
    cancel() { estado.cancelado = true; },
  });
  return { s, estado };
}

/** Stream infinito: nunca termina sozinho. Só um leitor limitado sai daqui. */
function streamInfinito() {
  const estado = { puxados: 0, cancelado: false };
  const s = new ReadableStream<Uint8Array>({
    pull(controller) { estado.puxados += 512; controller.enqueue(new Uint8Array(512)); },
    cancel() { estado.cancelado = true; },
  });
  return { s, estado };
}

test("arquivo dentro do limite: um arquivo, nome e tipo preservados, bytes exatos", async () => {
  const bytes = new Uint8Array(1024).fill(7);
  const { s } = stream(corpo(arquivo(bytes)));
  const r = await lerMultipartLimitado(s, TIPO, LIMITES);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.arquivo.nome, "contrato.pdf");
    assert.equal(r.arquivo.tipo, "application/pdf");
    assert.deepEqual(r.arquivo.bytes, bytes);
  }
});

test("arquivo acima do limite (corpo ainda dentro do teto total): 413 ARQUIVO_GRANDE", async () => {
  const { s } = stream(corpo(arquivo(new Uint8Array(1025))));
  assert.deepEqual(await lerMultipartLimitado(s, TIPO, LIMITES), { ok: false, codigo: "ARQUIVO_GRANDE", status: 413 });
});

test("sem Content-Length e corpo sem fim: leitura para no teto e o stream é cancelado", async () => {
  const { s, estado } = streamInfinito();
  const r = await lerMultipartLimitado(s, TIPO, LIMITES);
  assert.deepEqual(r, { ok: false, codigo: "CORPO_GRANDE", status: 413 });
  assert.equal(estado.cancelado, true);
  // Teto + o pedaço que estourou + no máximo um pedaço de pré-leitura da própria fila do stream (descartado).
  assert.ok(estado.puxados <= LIMITES.totalBytes + 2 * 512, `puxou ${estado.puxados} bytes`);
});

test("Content-Length falso não importa: o leitor conta os bytes reais", async () => {
  // A rota nunca lê Content-Length; o leitor só recebe o stream e o Content-Type.
  const rota = readFileSync("app/api/admin/inteligencia/documentos/route.ts", "utf8");
  assert.doesNotMatch(rota, /content-length/i);
  assert.doesNotMatch(rota, /formData\(\)/, "request.formData() lê o corpo inteiro sem teto");
  const { s, estado } = stream(new Uint8Array(10_000));
  assert.equal((await lerMultipartLimitado(s, TIPO, LIMITES)).ok, false);
  assert.equal(estado.cancelado, true);
  assert.ok(estado.puxados < 10_000);
});

test("parte extra enorme (não arquivo) é recusada: campo simples tem teto próprio", async () => {
  const { s } = stream(corpo(campo("extra", "x".repeat(65)), arquivo("%PDF-1.4")));
  assert.deepEqual(await lerMultipartLimitado(s, TIPO, LIMITES), { ok: false, codigo: "CAMPO_GRANDE", status: 413 });
});

test("partes demais, dois arquivos, arquivo com outro nome ou sem arquivo: recusados", async () => {
  const muitas = stream(corpo(campo("a", "1"), campo("b", "2"), campo("c", "3"), arquivo("%PDF")));
  assert.deepEqual(await lerMultipartLimitado(muitas.s, TIPO, LIMITES), { ok: false, codigo: "PARTES_DEMAIS", status: 413 });
  const dois = stream(corpo(arquivo("%PDF"), arquivo("%PDF")));
  assert.equal((await lerMultipartLimitado(dois.s, TIPO, LIMITES)).ok, false);
  const outroNome = stream(corpo(parte(`Content-Disposition: form-data; name="outro"; filename="x.pdf"`, "%PDF")));
  assert.equal((await lerMultipartLimitado(outroNome.s, TIPO, LIMITES)).ok, false);
  const semArquivo = stream(corpo(campo("a", "1")));
  assert.deepEqual(await lerMultipartLimitado(semArquivo.s, TIPO, LIMITES), { ok: false, codigo: "ARQUIVO_AUSENTE", status: 400 });
});

test("cabeçalho de parte gigante e boundary inválido são recusados", async () => {
  const cabecalho = stream(corpo(parte(`Content-Disposition: form-data; name="arquivo"; filename="a.pdf"\r\nX-Lixo: ${"y".repeat(300)}`, "%PDF")));
  assert.deepEqual(await lerMultipartLimitado(cabecalho.s, TIPO, LIMITES), { ok: false, codigo: "CABECALHO_GRANDE", status: 413 });
  assert.equal(boundaryDe("application/json"), null);
  assert.equal(boundaryDe("multipart/form-data"), null);
  assert.equal(boundaryDe(`multipart/form-data; boundary=${"a".repeat(71)}`), null);
  assert.equal(boundaryDe('multipart/form-data; boundary="abc"'), "abc");
  const { s } = stream(corpo(arquivo("%PDF")));
  assert.deepEqual(await lerMultipartLimitado(s, "multipart/form-data", LIMITES), { ok: false, codigo: "MULTIPART_INVALIDO", status: 400 });
});

test("limites de produção: teto total = arquivo + envelope; semáforo limita envios simultâneos", () => {
  const l = limitesUpload(15 * 1024 * 1024);
  assert.equal(l.totalBytes - l.arquivoBytes, 64 * 1024);
  const semaforo = criarSemaforo(2);
  const a = semaforo.tentar();
  const b = semaforo.tentar();
  assert.ok(a && b);
  assert.equal(semaforo.tentar(), null, "terceiro envio simultâneo recusado");
  a!();
  a!();
  assert.equal(semaforo.ocupados, 1, "liberar duas vezes não abre vaga extra");
  assert.ok(semaforo.tentar());
});

// ---------------------------------------------------------------- B1 (H7): conexão lenta

/** Stream que nunca manda nada (conexão parada). */
function streamParado() {
  const estado = { cancelado: false };
  return { s: new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { estado.cancelado = true; } }), estado };
}

/** Stream que pinga 1 byte a cada `ms` (nunca ocioso, mas nunca termina). */
function streamGotejando(ms: number) {
  const estado = { cancelado: false };
  return {
    s: new ReadableStream<Uint8Array>({
      pull(controller) { return new Promise((ok) => setTimeout(() => { if (!estado.cancelado) controller.enqueue(new Uint8Array([45])); ok(); }, ms)); },
      cancel() { estado.cancelado = true; },
    }),
    estado,
  };
}

test("B1: conexão parada estoura o tempo ocioso; o stream é cancelado (408)", async () => {
  const { s, estado } = streamParado();
  const inicio = performance.now();
  const r = await lerMultipartLimitado(s, TIPO, LIMITES, { prazoMs: 5_000, ociosoMs: 50 });
  assert.deepEqual(r, { ok: false, codigo: "LEITURA_LENTA", status: 408 });
  assert.ok(performance.now() - inicio < 2_000);
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(estado.cancelado, true);
});

test("B1: conta-gotas que nunca fica ocioso ainda estoura o prazo total", async () => {
  const { s, estado } = streamGotejando(5);
  const r = await lerMultipartLimitado(s, TIPO, { ...LIMITES, totalBytes: 10_000_000 }, { prazoMs: 150, ociosoMs: 1_000 });
  assert.deepEqual(r, { ok: false, codigo: "LEITURA_LENTA", status: 408 });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(estado.cancelado, true);
});

test("B1: cliente desconectou (AbortSignal do pedido) ⇒ leitura cancelada na hora", async () => {
  const { s, estado } = streamParado();
  const controle = new AbortController();
  setTimeout(() => controle.abort(), 20);
  const r = await lerMultipartLimitado(s, TIPO, LIMITES, { prazoMs: 5_000, ociosoMs: 5_000, sinal: controle.signal });
  assert.deepEqual(r, { ok: false, codigo: "ENVIO_CANCELADO", status: 400 });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(estado.cancelado, true);
});

test("B1: duas conexões lentas não ocupam os 2 slots indefinidamente", async () => {
  const semaforo = criarSemaforo(2);
  const envio = async () => {
    const liberar = semaforo.tentar();
    assert.ok(liberar);
    try { return await lerMultipartLimitado(streamParado().s, TIPO, LIMITES, { prazoMs: 5_000, ociosoMs: 60 }); } finally { liberar(); }
  };
  const lentos = [envio(), envio()];
  assert.equal(semaforo.tentar(), null, "enquanto as duas leem, um terceiro espera");
  const resultados = await Promise.all(lentos);
  assert.deepEqual(resultados.map((r) => !r.ok && r.codigo), ["LEITURA_LENTA", "LEITURA_LENTA"]);
  assert.equal(semaforo.ocupados, 0, "slots liberados ao estourar o tempo");
  assert.ok(semaforo.tentar(), "novo envio consegue vaga");
});

test("B1: a rota passa o AbortSignal do pedido e o prazo padrão para a leitura", () => {
  const rota = readFileSync("app/api/admin/inteligencia/documentos/route.ts", "utf8");
  assert.match(rota, /\{ \.\.\.TEMPO_PADRAO, sinal: request\.signal \}/);
  assert.match(rota, /finally \{\s+liberar\(\);/);
});
