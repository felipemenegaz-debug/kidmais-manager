import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { limiteConfigurado, nomeSeguro, tipoPelaAssinatura, validarArquivoEnviado } from "./arquivo.ts";
import { extrairPorRegras } from "./extracao.ts";
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

/** PDF sem compressão com uma página: /F1 é o objeto 3 e /F2 o 6 (os dois opcionais); `extras` completa ou substitui. */
function pdfObjetos(conteudo: string, extras: Record<number, string>) {
  const objetos: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R /F2 6 0 R >> >> >>",
    4: "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    5: `<< /Length ${Buffer.byteLength(conteudo, "latin1")} >>\nstream\n${conteudo}\nendstream`,
    ...extras,
  };
  const corpo = Object.entries(objetos).map(([n, o]) => `${n} 0 obj\n${o}\nendobj\n`).join("");
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${corpo}%%EOF\n`, "latin1"));
}

/**
 * Fonte composta como a do Chrome/Skia: Identity-H, um glifo por código (1, 2, …), /W com as larguras e
 * /ToUnicode. Espaço é um glifo de verdade. `w` = largura em milésimos do tamanho.
 */
function fonteChrome(alfabeto: string[], w: (ch: string) => number, extrasCid = "") {
  const codigo = (ch: string) => (alfabeto.indexOf(ch) + 1).toString(16).padStart(4, "0");
  const cmap = `begincmap\n${alfabeto.length} beginbfchar\n${alfabeto.map((ch) => `<${codigo(ch)}> <${[...ch].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`).join("\n")}\nendbfchar\nendcmap`;
  return {
    codigo,
    objetos: {
      3: "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Georgia /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>",
      7: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Georgia /DW 1000 /W [1 [${alfabeto.map(w).join(" ")}]]${extrasCid} >>`,
      8: `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`,
    } as Record<number, string>,
  };
}

const larguraTeste = (ch: string) => (ch === " " ? 250 : "il.,:;|".includes(ch) ? 280 : ch === "M" ? 830 : 560);

/**
 * Um glifo por Td, como o Chrome imprime. `|` marca fim de palavra SEM glifo de espaço (lacuna de 0,3 em),
 * `~` aplica um ajuste fino de kerning (−0,04 em) e `^` um espaçamento folgado de letras (+0,06 em) antes do próximo glifo. Devolve os operadores e a posição final.
 */
function glifoAGlifo(texto: string, codigo: (ch: string) => string, tamanho: number, x: number, y: number, escala = 1) {
  const ops = [`BT /F1 ${tamanho} Tf ${escala} 0 0 ${-escala} ${x} ${y} Tm`];
  let anterior = 0;
  let ajuste = 0;
  let posicao = 0;
  for (const ch of texto) {
    if (ch === "|") { ajuste += 0.3 * tamanho; continue; }
    if (ch === "~") { ajuste -= 0.04 * tamanho; continue; }
    if (ch === "^") { ajuste += 0.06 * tamanho; continue; }
    if (ops.length > 1) { ops.push(`${(anterior + ajuste).toFixed(5)} 0 Td`); posicao += anterior + ajuste; }
    ops.push(`<${codigo(ch)}> Tj`);
    anterior = larguraTeste(ch) / 1000 * tamanho;
    ajuste = 0;
  }
  ops.push("ET");
  return { ops: ops.join("\n"), fim: x + (posicao + anterior) * escala };
}

test("PDF do Chrome (um glifo por Td): letras juntas, espaço só onde há glifo de espaço ou lacuna real", () => {
  const linha1 = "CONTRATANTE: Juliana Quintana, CPF 463.641.191-90";
  const linha2 = "Pacote: Festa|Premium|Kids";
  const linha3 = "Ke~r~n~ing não separa: Mo~d~elo F^o^l^g^a";
  const alfabeto = [...new Set([...linha1, ...linha2, ...linha3].filter((c) => !"|~^".includes(c)))];
  const fonte = fonteChrome(alfabeto, larguraTeste);
  const conteudo = [glifoAGlifo(linha1, fonte.codigo, 14.66, 75.5, 145), glifoAGlifo(linha2, fonte.codigo, 14.66, 75.5, 166), glifoAGlifo(linha3, fonte.codigo, 14.66, 75.5, 188)].map((g) => g.ops).join("\n");
  const texto = extrairTextoPdf(pdfObjetos(conteudo, fonte.objetos));
  assert.deepEqual(texto.paginas[0].split("\n"), ["CONTRATANTE: Juliana Quintana, CPF 463.641.191-90", "Pacote: Festa Premium Kids", "Kerning não separa: Modelo Folga"]);
  assert.deepEqual(texto.avisos, []);

  // Mesmas larguras declaradas por faixa (/W c1 c2 w, como no Calibri do Chrome) e o resto pelo /DW.
  const faixas = alfabeto.map((ch, i) => [i + 1, larguraTeste(ch)] as const).filter(([, w]) => w !== 560).map(([c, w]) => `${c} ${c} ${w}`).join(" ");
  const porFaixa = { ...fonte.objetos, 7: `<< /Type /Font /Subtype /CIDFontType2 /DW 560 /W [${faixas}] >>` };
  assert.equal(extrairTextoPdf(pdfObjetos(conteudo, porFaixa)).paginas[0], texto.paginas[0]);
});

test("troca de fonte no meio da linha (ET + novo BT na mesma altura) continua a frase; outra altura quebra", () => {
  const alfabeto = [...new Set("Castelo Mágico Ltda., inscrita no CNPJ")];
  const fonte = fonteChrome(alfabeto, larguraTeste);
  const negrito = glifoAGlifo("Castelo Mágico Ltda.", fonte.codigo, 14.66, 75.5, 145);
  // Mesmo y, começando exatamente onde o negrito terminou (sem espaço) e depois com um glifo de espaço.
  const resto = glifoAGlifo(", inscrita no", fonte.codigo, 14.66, negrito.fim, 145);
  const outra = glifoAGlifo("CNPJ", fonte.codigo, 14.66, 75.5, 166);
  const texto = extrairTextoPdf(pdfObjetos([negrito.ops, resto.ops, outra.ops].join("\n"), fonte.objetos));
  assert.deepEqual(texto.paginas[0].split("\n"), ["Castelo Mágico Ltda., inscrita no", "CNPJ"]);
  // Mesma altura com lacuna de coluna (40 ≈ 2,7 em): continua sendo outra linha, como antes — as regras
  // determinísticas leem o valor até o fim da linha e não podem receber a coluna vizinha junto.
  const coluna = glifoAGlifo("CNPJ", fonte.codigo, 14.66, negrito.fim + 40, 145);
  assert.deepEqual(extrairTextoPdf(pdfObjetos([negrito.ops, coluna.ops].join("\n"), fonte.objetos)).paginas[0].split("\n"), ["Castelo Mágico Ltda.", "CNPJ"]);
  // Bloco na mesma altura que volta para a esquerda (coluna desenhada depois): também quebra.
  const recuado = glifoAGlifo("CNPJ", fonte.codigo, 14.66, 75.5, 145);
  assert.deepEqual(extrairTextoPdf(pdfObjetos([negrito.ops, recuado.ops].join("\n"), fonte.objetos)).paginas[0].split("\n"), ["Castelo Mágico Ltda.", "CNPJ"]);
  // Lacuna de meia linha (≈ 0,5 em) já pode separar campos independentes: quebra também.
  const perto = glifoAGlifo("CNPJ", fonte.codigo, 14.66, negrito.fim + 7, 145);
  assert.deepEqual(extrairTextoPdf(pdfObjetos([negrito.ops, perto.ops].join("\n"), fonte.objetos)).paginas[0].split("\n"), ["Castelo Mágico Ltda.", "CNPJ"]);
  // Matriz de texto com escala 2 (tamanho 7,33 desenhado como 14,66): a continuação colada segue colada.
  const escalado = glifoAGlifo("Castelo Mágico Ltda.", fonte.codigo, 7.33, 75.5, 145, 2);
  const continua = glifoAGlifo(", inscrita no", fonte.codigo, 7.33, escalado.fim, 145, 2);
  assert.equal(extrairTextoPdf(pdfObjetos([escalado.ops, continua.ops].join("\n"), fonte.objetos)).paginas[0], "Castelo Mágico Ltda., inscrita no");
  // Lacuna de 1,76 na página = 0,88 em unidades de texto (escala 2) = 0,12 em: ainda colado, sem espaço.
  // Comparar na unidade da página (1,76 > 0,15 × 7,33) quebraria (outro bloco) ou poria espaço (mesmo bloco).
  const folga = glifoAGlifo(", inscrita no", fonte.codigo, 7.33, escalado.fim + 1.76, 145, 2);
  assert.equal(extrairTextoPdf(pdfObjetos([escalado.ops, folga.ops].join("\n"), fonte.objetos)).paginas[0], "Castelo Mágico Ltda., inscrita no");
  const mesmoBloco = `${escalado.ops.replace(/ET$/, "")}2 0 0 -2 ${escalado.fim + 1.76} 145 Tm <${fonte.codigo(",")}> Tj ET`;
  assert.equal(extrairTextoPdf(pdfObjetos(mesmoBloco, fonte.objetos)).paginas[0], "Castelo Mágico Ltda.,");
});

test("fonte simples com /Widths (Word e afins): palavra por Td com a lacuna do espaço, Tc e Tz considerados", () => {
  const larguras = Array.from({ length: 95 }, (_, i) => (i === 0 ? 278 : 556)).join(" ");
  const fonte = `<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 32 /LastChar 126 /Widths [${larguras}] /Encoding /WinAnsiEncoding >>`;
  // "Contrato" = 8 × 5,56 = 44,48; espaço de 2,78 ⇒ próxima palavra em 47,26 (relativo ao início da linha).
  // Com Tc 1, "CPF" avança 3 × (5,56 + 1) = 19,68; o número começa colado (19,68): sem espaço.
  // Com Tz 50, "Valor" avança 5 × 5,56 × 0,5 = 13,9: o ":" colado em 13,9 não ganha espaço e termina em 16,68.
  // Sem Tz o fim seria 19,46 e o valor em 19,9 ficaria colado; com Tz a lacuna é 3,22, acima de 0,15 em (1,5) ⇒ espaço.
  const conteudo = [
    "BT /F2 10 Tf 1 0 0 1 50 700 Tm (Contrato) Tj 47.26 0 Td (de) Tj 13.9 0 Td (buffet) Tj ET",
    "BT /F2 10 Tf 1 Tc 1 0 0 1 50 680 Tm (CPF) Tj 19.68 0 Td (529.982.247-25) Tj ET",
    "BT /F2 10 Tf 0 Tc 50 Tz 1 0 0 1 50 660 Tm (Valor) Tj 13.9 0 Td (:) Tj 6 0 Td (R$ 10,00) Tj ET",
    // Número no TJ recua a caneta: "Sinal" termina em 27,8 − 3 = 24,8; "pago" em 26,5 ⇒ lacuna 1,7 ⇒ espaço.
    "BT /F2 10 Tf 100 Tz 1 0 0 1 50 640 Tm [(Sinal) 300] TJ 26.5 0 Td (pago) Tj ET",
  ].join("\n");
  const texto = extrairTextoPdf(pdfObjetos(conteudo, { 6: fonte }));
  assert.deepEqual(texto.paginas[0].split("\n"), ["Contrato de buffet", "CPF529.982.247-25", "Valor: R$ 10,00", "Sinal pago"]);
});

/** Fonte simples Arial-like: espaço 278, demais 556 (milésimos). Em tamanho 10, cada letra avança 5,56. */
const ARIAL = `<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 32 /LastChar 126 /Widths [${Array.from({ length: 95 }, (_, i) => (i === 0 ? 278 : 556)).join(" ")}] /Encoding /WinAnsiEncoding >>`;
const fimArial = (x: number, texto: string) => x + [...texto].reduce((t, c) => t + (c === " " ? 2.78 : 5.56), 0);

test("campos vizinhos em blocos separados mantêm a fronteira de linha (regras determinísticas)", () => {
  // Revisão do Astra: "Pacote: Ouro" termina em x; "Tema: Frozen" começa 5 adiante (0,5 em), noutro bloco.
  const fim = fimArial(50, "Pacote: Ouro");
  const conteudo = `BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf 1 0 0 1 ${fim + 5} 700 Tm (Tema: Frozen) Tj ET`;
  const texto = extrairTextoPdf(pdfObjetos(conteudo, { 6: ARIAL }));
  assert.deepEqual(texto.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen"]);
  const lida = extrairPorRegras(texto.paginas);
  assert.equal(lida.pacote.nome?.valor, "Ouro");
  assert.equal(lida.evento.tema?.valor, "Frozen");
  // Revisão r2: o Tm colado não basta; vale a posição da PRIMEIRA string, depois de Td, outro Tm ou número do TJ.
  const deslocamentos: Array<[string, string]> = [
    ["Td", `1 0 0 1 ${fim} 700 Tm 5 0 Td (Tema: Frozen) Tj`],
    ["outro Tm", `1 0 0 1 ${fim} 700 Tm 1 0 0 1 ${fim + 5} 700 Tm (Tema: Frozen) Tj`],
    ["TJ", `1 0 0 1 ${fim} 700 Tm [-500 (Tema: Frozen)] TJ`],
    ["() vazio antes", `1 0 0 1 ${fim} 700 Tm () Tj 5 0 Td (Tema: Frozen) Tj`],
  ];
  for (const [nome, segundo] of deslocamentos) {
    const lido = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf ${segundo} ET`, { 6: ARIAL }));
    assert.deepEqual(lido.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen"], nome);
    assert.equal(extrairPorRegras(lido.paginas).pacote.nome?.valor, "Ouro", nome);
  }
  // O contrário também vale: Tm longe e Td/TJ que trazem a primeira string de volta para colada continuam a linha.
  const devolvidos: Array<[string, string]> = [
    ["Td", `1 0 0 1 ${fim - 5} 700 Tm 5 0 Td (, com bolo) Tj`],
    ["TJ", `1 0 0 1 ${fim - 5} 700 Tm [-500 (, com bolo)] TJ`],
    ["Td com descida", `1 0 0 1 ${fim} 720 Tm 0 -20 Td (, com bolo) Tj`],
  ];
  for (const [nome, segundo] of devolvidos) {
    const lido = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf ${segundo} ET`, { 6: ARIAL }));
    assert.equal(lido.paginas[0], "Pacote: Ouro, com bolo", nome);
  }
  // Bloco vazio no meio (BT … ET sem texto) não muda a referência do fim do último bloco escrito.
  const comVazio = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf 1 0 0 1 300 500 Tm ET\nBT /F2 10 Tf 1 0 0 1 ${fim} 700 Tm (, com bolo) Tj ET`, { 6: ARIAL }));
  assert.equal(comVazio.paginas[0], "Pacote: Ouro, com bolo");
  // Colado (negrito no meio da frase, sem lacuna): continua a linha, sem espaço inventado.
  const colado = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf 1 0 0 1 ${fim} 700 Tm (, com bolo) Tj ET`, { 6: ARIAL }));
  assert.equal(colado.paginas[0], "Pacote: Ouro, com bolo");
});

test("a referência é o fim da última string: TJ, Td ou Tm depois dela e antes do ET não mudam o ponto de comparação", () => {
  // Revisão r3 do Astra: o ET guardava a caneta, que andava com movimentos sem texto e encostava no bloco seguinte.
  const fim = fimArial(50, "Pacote: Ouro");
  const depoisDoTexto: Array<[string, string]> = [
    ["TJ final", "[(Pacote: Ouro) -500] TJ"],
    ["Td", `(Pacote: Ouro) Tj ${fim + 5 - 50} 0 Td`],
    ["Tm", `(Pacote: Ouro) Tj 1 0 0 1 ${fim + 5} 700 Tm`],
  ];
  for (const [nome, primeiro] of depoisDoTexto) {
    const lido = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm ${primeiro} ET\nBT /F2 10 Tf 1 0 0 1 ${fim + 5} 700 Tm (Tema: Frozen) Tj ET`, { 6: ARIAL }));
    assert.deepEqual(lido.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen"], nome);
    assert.equal(extrairPorRegras(lido.paginas).pacote.nome?.valor, "Ouro", nome);
  }
  // Movimento depois da última string não atrapalha o caso colado: a comparação continua com o fim do texto.
  const coladoComTd = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj 40 0 Td ET\nBT /F2 10 Tf 1 0 0 1 ${fim} 700 Tm (, com bolo) Tj ET`, { 6: ARIAL }));
  assert.equal(coladoComTd.paginas[0], "Pacote: Ouro, com bolo");
  // Bloco anterior em fonte sem larguras: o fim fica desconhecido; Td ou Tm antes do ET não o "recuperam".
  const helvetica = { 3: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", 6: ARIAL };
  const recuperados: Array<[string, string]> = [
    ["Td", "(Pacote: Ouro) Tj 60 0 Td"],
    ["Tm", "(Pacote: Ouro) Tj 1 0 0 1 110 700 Tm"],
  ];
  for (const [nome, primeiro] of recuperados) {
    const lido = extrairTextoPdf(pdfObjetos(`BT /F1 10 Tf 1 0 0 1 50 700 Tm ${primeiro} ET\nBT /F2 10 Tf 1 0 0 1 110 700 Tm (Tema: Frozen) Tj ET`, helvetica));
    assert.deepEqual(lido.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen"], `sem larguras + ${nome}`);
    assert.equal(extrairPorRegras(lido.paginas).pacote.nome?.valor, "Ouro", `sem larguras + ${nome}`);
  }
});

test("com a decisão pendente, bloco vazio não quebra a linha e recuo final do TJ não deixa espaço", () => {
  // Revisão r4 do Astra: "Pacote: Ou" e "ro" em blocos colados; o que fica entre eles não pode separar a palavra.
  const primeiro = "BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ou) Tj ET";
  const segundo = `BT /F2 10 Tf 1 0 0 1 ${fimArial(50, "Pacote: Ou")} 700 Tm (ro) Tj ET`;
  const casos: Array<[string, string]> = [
    ["sem nada no meio", `${primeiro}\n${segundo}`],
    ["bloco vazio com T*", `${primeiro}\nBT 20 TL 1 0 0 1 300 500 Tm T* ET\n${segundo}`],
    ["bloco vazio com () '", `${primeiro}\nBT /F2 10 Tf 20 TL 1 0 0 1 300 500 Tm () ' ET\n${segundo}`],
    ["bloco vazio com 0 0 () \"", `${primeiro}\nBT /F2 10 Tf 20 TL 1 0 0 1 300 500 Tm 0 0 () " ET\n${segundo}`],
    ["-500 final do TJ", `BT /F2 10 Tf 1 0 0 1 50 700 Tm [(Pacote: Ou) -500] TJ ET\n${segundo}`],
  ];
  for (const [nome, conteudo] of casos) {
    const lido = extrairTextoPdf(pdfObjetos(conteudo, { 6: ARIAL }));
    assert.equal(lido.paginas[0], "Pacote: Ouro", nome);
    assert.equal(extrairPorRegras(lido.paginas).pacote.nome?.valor, "Ouro", nome);
  }
  // O recuo seguido de texto no mesmo TJ continua virando espaço; ' com texto depois do ET desce e quebra.
  assert.equal(extrairTextoPdf(pdfObjetos("BT /F2 10 Tf 1 0 0 1 50 700 Tm [(Pacote:) -500 (Ouro)] TJ ET", { 6: ARIAL })).paginas[0], "Pacote: Ouro");
  const desce = extrairTextoPdf(pdfObjetos(`${primeiro}\nBT /F2 10 Tf 20 TL 1 0 0 1 ${fimArial(50, "Pacote: Ou")} 700 Tm (Tema: Frozen) ' ET`, { 6: ARIAL }));
  assert.deepEqual(desce.paginas[0].split("\n"), ["Pacote: Ou", "Tema: Frozen"]);
});

test("a altura da linha acompanha Td, TD, T*, ' e \": bloco novo na altura antiga não junta com a linha de baixo", () => {
  const casos: Array<[string, string]> = [
    ["Td", "0 -20 Td (Tema: Frozen) Tj"],
    ["TD", "0 -20 TD (Tema: Frozen) Tj"],
    ["T*", "20 TL T* (Tema: Frozen) Tj"],
    ["'", "20 TL (Tema: Frozen) '"],
    ["\"", "20 TL 0 0 (Tema: Frozen) \""],
  ];
  for (const [nome, desce] of casos) {
    // Linha 700 "Pacote: Ouro", desce para 680 "Tema: Frozen", ET; o bloco seguinte volta para 700, logo
    // depois do fim de "Tema: Frozen": é outra linha (700), não continuação da 680.
    const fim = fimArial(50, "Tema: Frozen");
    const conteudo = `BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ${desce} ET\nBT /F2 10 Tf 1 0 0 1 ${fim} 700 Tm (Ouro Premium) Tj ET`;
    const texto = extrairTextoPdf(pdfObjetos(conteudo, { 6: ARIAL }));
    assert.deepEqual(texto.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen", "Ouro Premium"], nome);
    assert.equal(extrairPorRegras(texto.paginas).evento.tema?.valor, "Frozen", nome);
    // O mesmo bloco na altura 680, colado: continua a linha de baixo.
    const naLinha = extrairTextoPdf(pdfObjetos(conteudo.replace(`${fim} 700 Tm (Ouro Premium)`, `${fim} 680 Tm (!)`), { 6: ARIAL }));
    assert.deepEqual(naLinha.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen!"], nome);
  }
  // No MESMO bloco: depois de descer com Td, um Tm de volta à altura antiga é outra linha (não a de baixo).
  const mesmoBloco = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (A) Tj 0 -20 Td (B) Tj 1 0 0 1 ${fimArial(50, "B")} 700 Tm (C) Tj ET`, { 6: ARIAL }));
  assert.deepEqual(mesmoBloco.paginas[0].split("\n"), ["A", "B", "C"]);
  // TD define a entrelinha usada pelo T* seguinte: 700 → 680 (TD) → 660 (T*).
  const fimC = fimArial(50, "C");
  const td = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (A) Tj 0 -20 TD (B) Tj T* (C) Tj ET\nBT /F2 10 Tf 1 0 0 1 ${fimC} 660 Tm (!) Tj ET`, { 6: ARIAL }));
  assert.deepEqual(td.paginas[0].split("\n"), ["A", "B", "C!"]);
  // Matriz invertida como a do Chrome (d = −1): Td 0 20 desce para y = 100 − 20 = 80 nas coordenadas da página.
  const invertida = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 -1 50 100 Tm (A) Tj 0 20 Td (B) Tj ET\nBT /F2 10 Tf 1 0 0 -1 ${fimArial(50, "B")} 80 Tm (!) Tj ET`, { 6: ARIAL }));
  assert.deepEqual(invertida.paginas[0].split("\n"), ["A", "B!"]);
  // BT volta a matriz à identidade: o Td de um bloco sem Tm é absoluto, não relativo ao Tm do bloco anterior.
  const fimTema = fimArial(50, "Tema: Frozen");
  const semTm = extrairTextoPdf(pdfObjetos(`BT /F2 10 Tf 1 0 0 1 50 700 Tm (Pacote: Ouro) Tj ET\nBT /F2 10 Tf 50 680 Td (Tema: Frozen) Tj ET\nBT /F2 10 Tf 1 0 0 1 ${fimTema} 680 Tm (!) Tj ET`, { 6: ARIAL }));
  assert.deepEqual(semTm.paginas[0].split("\n"), ["Pacote: Ouro", "Tema: Frozen!"]);
  // O operador " define Tw e Tc antes de escrever: com Tc 1, "CPF" avança 3 × 6,56 = 19,68 e o número vem colado.
  const aspas = extrairTextoPdf(pdfObjetos("BT /F2 10 Tf 0 TL 1 0 0 1 50 700 Tm 0 1 (CPF) \" 19.68 0 Td (529) Tj ET", { 6: ARIAL }));
  assert.equal(aspas.paginas[0], "CPF529");
});

test("comentário dentro de /Widths e /W não vira largura", () => {
  const larguras = "[% 0\n500 500]";
  const simples = (w: string) => `<< /Type /Font /Subtype /TrueType /FirstChar 65 /LastChar 66 /Widths ${w} >>`;
  const conteudo = "BT /F2 10 Tf 1 0 0 1 50 700 Tm (A) Tj 5 0 Td (B) Tj ET";
  assert.equal(extrairTextoPdf(pdfObjetos(conteudo, { 6: simples(larguras) })).paginas[0], "AB");
  assert.equal(extrairTextoPdf(pdfObjetos(conteudo, { 6: simples("[500 500]") })).paginas[0], "AB");
  // /W: o comentário escondendo um "999" não pode mudar a largura do código 1.
  const alfabeto = ["A", "B"];
  const fonte = fonteChrome(alfabeto, () => 500, "");
  const cid = (w: string) => ({ ...fonte.objetos, 7: `<< /Type /Font /Subtype /CIDFontType2 /W ${w} >>` });
  const linha = glifoAGlifo("AB", fonte.codigo, 10, 50, 100).ops;
  assert.equal(extrairTextoPdf(pdfObjetos(linha, cid("[1 [% 999\n500 500]]"))).paginas[0], "AB");
});

test("sem larguras na fonte (Helvetica padrão): mantém a regra anterior — avanço à direita vale espaço", () => {
  const conteudo = [
    "BT /F1 10 Tf 1 0 0 1 50 700 Tm (Valor) Tj 30 0 Td (total) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 50 680 Tm (Contratante:) Tj ET BT /F1 10 Tf 1 0 0 1 140 680 Tm (José) Tj ET",
  ].join("\n");
  const texto = extrairTextoPdf(pdfObjetos(conteudo, { 3: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" }));
  // Blocos separados na mesma altura sem larguras: posição desconhecida ⇒ quebra, como antes.
  assert.deepEqual(texto.paginas[0].split("\n"), ["Valor total", "Contratante:", "José"]);
});

test("ligaduras tipográficas (ﬁ, ﬀ) viram letras comuns", () => {
  const alfabeto = ["d", "e", "\uFB01", "n", "i", "ç", "õ", "s", " ", "B", "u", "\uFB00", "t"];
  const fonte = fonteChrome(alfabeto, larguraTeste);
  const texto = extrairTextoPdf(pdfObjetos(glifoAGlifo("de\uFB01nições Bu\uFB00et", fonte.codigo, 12, 50, 100).ops, fonte.objetos));
  assert.equal(texto.paginas[0], "definições Buffet");
});

test("larguras hostis (/W enorme, aninhado, quebrado ou ausente) não derrubam a leitura nem estouram o orçamento", () => {
  const alfabeto = [...new Set("CPF 529.982.247-25")];
  const base = fonteChrome(alfabeto, larguraTeste);
  const linha = glifoAGlifo("CPF 529.982.247-25", base.codigo, 12, 50, 100).ops;
  const variantes: Array<[string, string]> = [
    ["array gigante", `<< /Type /Font /Subtype /CIDFontType2 /W [0 [${"7 ".repeat(70_000)}] 1 [${alfabeto.map(larguraTeste).join(" ")}]] >>`],
    ["faixas demais", `<< /Type /Font /Subtype /CIDFontType2 /W [${Array.from({ length: 4_200 }, (_, i) => `${2000 + i} ${2000 + i} 5`).join(" ")}] >>`],
    ["faixa enorme", "<< /Type /Font /Subtype /CIDFontType2 /W [0 4294967295 500] >>"],
    ["aninhado e lixo", "<< /Type /Font /Subtype /CIDFontType2 /W [1 [[[ 5 ]]] abc (x) 3 4 /Nome] >>"],
    ["referência ausente", "<< /Type /Font /Subtype /CIDFontType2 /W 99 0 R /DW 500 >>"],
    ["sem fechamento", "<< /Type /Font /Subtype /CIDFontType2 /W [1 [500 500 500 >>"],
  ];
  for (const [nome, cid] of variantes) {
    const texto = extrairTextoPdf(pdfObjetos(linha, { ...base.objetos, 7: cid }));
    assert.equal(texto.interrompido, null, nome);
    assert.equal(texto.paginas[0].replace(/\s/g, ""), "CPF529.982.247-25", nome);
  }
  // Array gigante: o dicionário já é cortado em 64 KB; faixas demais: o teto de faixas avisa.
  assert.ok(extrairTextoPdf(pdfObjetos(linha, { ...base.objetos, 7: variantes[0][1] })).avisos.includes("DICIONARIO_GRANDE"));
  assert.ok(extrairTextoPdf(pdfObjetos(linha, { ...base.objetos, 7: variantes[1][1] })).avisos.includes("LARGURAS_GRANDES"));
  // Orçamento curto: a leitura do /W para de forma controlada, sem lançar.
  const curto = extrairTextoPdf(pdfObjetos(linha, { ...base.objetos, 7: variantes[0][1] }), { limiteTrabalho: 50_000 });
  assert.equal(curto.interrompido, "LIMITE_TRABALHO");
});
