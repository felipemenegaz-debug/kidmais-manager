import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { limiteConfigurado, nomeSeguro, tipoPelaAssinatura, validarArquivoEnviado } from "./arquivo.ts";
import { extrairTextoPdf, lerToUnicode, temTextoNativo } from "./pdf-texto.ts";

const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF"));
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

test("upload: extensão, MIME e assinatura precisam concordar; nome sanitizado; limite configurável", () => {
  const ok = validarArquivoEnviado({ nome: "../../Contrato Março (final).PDF", tipoDeclarado: "application/pdf", bytes: PDF, limiteBytes: 1024 * 1024 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.arquivo.contentType, "application/pdf");
    assert.equal(ok.arquivo.nomeSeguro, "Contrato Marco _final.pdf");
    assert.match(ok.arquivo.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(validarArquivoEnviado({ nome: "foto.jpg", tipoDeclarado: "image/jpeg", bytes: JPG, limiteBytes: 1024 }).ok, true);
  assert.equal(validarArquivoEnviado({ nome: "foto.png", tipoDeclarado: "", bytes: PNG, limiteBytes: 1024 }).ok, true);

  const casos: Array<[string, string, Uint8Array, string]> = [
    ["contrato.pdf", "application/pdf", JPG, "TIPO_DIVERGENTE"],          // extensão mente
    ["contrato.jpg", "image/jpeg", PDF, "TIPO_DIVERGENTE"],
    ["contrato.pdf", "image/png", PDF, "TIPO_DIVERGENTE"],               // MIME declarado mente
    ["contrato.exe", "application/pdf", PDF, "TIPO_NAO_ACEITO"],
    ["contrato.pdf", "application/pdf", new Uint8Array(Buffer.from("<html><script>")), "TIPO_NAO_ACEITO"],
    ["contrato.pdf", "application/pdf", new Uint8Array(), "ARQUIVO_VAZIO"],
    ["contrato.pdf", "application/pdf", new Uint8Array(Buffer.from("%PDF-1.7\ntrailer << /Encrypt 5 0 R >>")), "PDF_PROTEGIDO"],
  ];
  for (const [nome, tipo, bytes, codigo] of casos) {
    const r = validarArquivoEnviado({ nome, tipoDeclarado: tipo, bytes, limiteBytes: 1024 * 1024 });
    assert.equal(r.ok ? "ok" : r.codigo, codigo, `${nome} ${tipo}`);
  }
  const grande = validarArquivoEnviado({ nome: "a.pdf", tipoDeclarado: "application/pdf", bytes: new Uint8Array(2048).fill(0x25).map((b, i) => (i < 5 ? PDF[i] : b)), limiteBytes: 1024 });
  assert.equal(grande.ok ? "" : grande.codigo, "ARQUIVO_GRANDE");
  assert.equal(limiteConfigurado("99999999999"), 15 * 1024 * 1024);
  assert.equal(limiteConfigurado("5242880"), 5242880);
  assert.equal(tipoPelaAssinatura(new Uint8Array([0x47, 0x49, 0x46])), null);
  assert.equal(nomeSeguro("\u0000\u0007.pdf", "application/pdf"), "documento.pdf");
});

/** PDF nativo sem compressão, Helvetica/WinAnsi (como o Resumo gerado pelo Kidmais): bytes latin1, parênteses escapados. */
function pdfSimples(linhas: string[]) {
  const escapar = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const conteudo = linhas.map((l, i) => `BT /F1 10 Tf 1 0 0 1 50 ${750 - i * 16} Tm (${escapar(l)}) Tj ET`).join("\n");
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(conteudo, "latin1")} >>\nstream\n${conteudo}\nendstream`,
  ];
  const corpo = objetos.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("");
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${corpo}%%EOF\n`, "latin1"));
}

test("PDF nativo sem compressão (formato do Resumo do Kidmais): texto por página, acentos e parênteses preservados", () => {
  const pdf = pdfSimples(["Resumo da Contratação", "Contratante: Conceição (Teste)", "CPF 529.982.247-25", "Documento operacional e comercial. Não substitui o contrato jurídico."]);
  const texto = extrairTextoPdf(pdf);
  assert.equal(texto.paginas.length, 1);
  assert.match(texto.paginas[0], /Resumo da Contratação/);
  assert.match(texto.paginas[0], /Conceição \(Teste\)/);
  assert.match(texto.paginas[0], /529\.982\.247-25/);
  assert.equal(temTextoNativo(texto), true);
});

/** PDF mínimo com FlateDecode, fonte Type0 com /ToUnicode e página/fonte dentro de /ObjStm. */
function pdfComprimido(paginas: string[][]) {
  const partes: string[] = ["%PDF-1.5\n"];
  const objetos: Array<{ num: number; corpo: Buffer | string }> = [];
  // Códigos de 2 bytes: 0x0001.. mapeados pelo ToUnicode.
  const caracteres = [...new Set(paginas.flat().join(""))];
  const codigo = (ch: string) => (caracteres.indexOf(ch) + 1).toString(16).padStart(4, "0");
  const cmap = `/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${caracteres.length} beginbfchar\n${caracteres.map((ch) => `<${codigo(ch)}> <${ch.codePointAt(0)!.toString(16).padStart(4, "0")}>`).join("\n")}\nendbfchar\nendcmap\nend`;
  const stream = (num: number, conteudo: Buffer, extra = "") => objetos.push({ num, corpo: Buffer.concat([Buffer.from(`<< /Length ${conteudo.length} /Filter /FlateDecode${extra} >>\nstream\n`, "latin1"), conteudo, Buffer.from("\nendstream", "latin1")]) });
  stream(5, deflateSync(Buffer.from(cmap, "latin1")));
  const kids: number[] = [];
  const noStream: Array<{ num: number; texto: string }> = [
    { num: 4, texto: "<< /Type /Font /Subtype /Type0 /BaseFont /Fake /Encoding /Identity-H /ToUnicode 5 0 R >>" },
  ];
  paginas.forEach((linhas, i) => {
    const pagina = 10 + i * 2;
    const conteudo = 11 + i * 2;
    kids.push(pagina);
    noStream.push({ num: pagina, texto: `<< /Type /Page /Parent 2 0 R /Contents ${conteudo} 0 R >>` });
    const ops = linhas.map((l, k) => `BT /F1 10 Tf 1 0 0 1 50 ${700 - k * 20} Tm [<${[...l].map(codigo).join("")}>] TJ ET`).join("\n");
    stream(conteudo, deflateSync(Buffer.from(ops, "latin1")));
  });
  noStream.push({ num: 2, texto: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} /Resources << /Font << /F1 4 0 R >> >> >>` });
  // Página, fonte e árvore dentro de um object stream (PDF 1.5+).
  let offset = 0;
  const cabecalho: string[] = [];
  const corpo: string[] = [];
  for (const o of noStream) { cabecalho.push(`${o.num} ${offset}`); corpo.push(o.texto); offset += o.texto.length + 1; }
  const header = `${cabecalho.join(" ")} `;
  stream(20, deflateSync(Buffer.from(header + corpo.join("\n"), "latin1")), ` /Type /ObjStm /N ${noStream.length} /First ${header.length}`);
  objetos.push({ num: 1, corpo: "<< /Type /Catalog /Pages 2 0 R >>" });
  for (const o of objetos) partes.push(`${o.num} 0 obj\n`, typeof o.corpo === "string" ? o.corpo : o.corpo.toString("latin1"), "\nendobj\n");
  partes.push("%%EOF\n");
  return new Uint8Array(Buffer.from(partes.join(""), "latin1"));
}

test("PDF comprimido com Type0 + ToUnicode dentro de object stream: páginas na ordem da árvore", () => {
  const pdf = pdfComprimido([["CONTRATANTE: José Ávila", "CPF 529.982.247-25"], ["Valor total: R$ 8.900,00"]]);
  const texto = extrairTextoPdf(pdf);
  assert.equal(texto.paginas.length, 2);
  assert.equal(texto.paginas[0], "CONTRATANTE: José Ávila\nCPF 529.982.247-25");
  assert.equal(texto.paginas[1], "Valor total: R$ 8.900,00");
});

test("ToUnicode: bfchar e bfrange (forma inicial e array)", () => {
  const mapa = lerToUnicode("beginbfchar <0003> <0020> endbfchar beginbfrange <0010> <0012> <0041> <0020> <0021> [<00E9> <00E7>] endbfrange");
  assert.deepEqual([mapa.get(3), mapa.get(0x10), mapa.get(0x12), mapa.get(0x20), mapa.get(0x21)], [" ", "A", "C", "é", "ç"]);
});

test("arquivo hostil: bomba de descompressão e PDF só com imagem não derrubam nem inventam texto", () => {
  const bomba = deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x41));
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ", "latin1"),
    Buffer.from(`${bomba.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), bomba, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
  const texto = extrairTextoPdf(new Uint8Array(pdf));
  assert.deepEqual(texto.paginas, [""]);
  assert.ok(texto.avisos.includes("STREAM_INVALIDO"));
  assert.equal(temTextoNativo(texto), false);

  const escaneado = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 30 >>\nstream\nq 500 0 0 700 0 0 cm /Im1 Do Q\nendstream\nendobj\n%%EOF", "latin1");
  const semTexto = extrairTextoPdf(new Uint8Array(escaneado));
  assert.equal(temTextoNativo(semTexto), false);
});
