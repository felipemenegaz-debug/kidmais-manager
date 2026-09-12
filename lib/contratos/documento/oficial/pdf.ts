import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContratoOficialRenderizado } from "./models.ts";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 48;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;
const TOP_Y = 720;
const BOTTOM_Y = 72;
const LOGO_PATH = join(process.cwd(), "public", "assets", "contratos", "kidmais-logo-template-v1.jpg");
const LOGO_PIXEL_WIDTH = 1400;
const LOGO_PIXEL_HEIGHT = 578;

const COLORS = {
  navy: "0.055 0.090 0.180",
  text: "0.115 0.145 0.220",
  muted: "0.410 0.445 0.510",
  line: "0.865 0.885 0.920",
  soft: "0.967 0.974 0.985",
  blue: "0.000 0.525 0.780",
  purple: "0.455 0.255 0.635",
  orange: "0.980 0.455 0.055",
  warmBg: "1.000 0.970 0.925",
  warmText: "0.565 0.245 0.040",
  blueBg: "0.940 0.975 0.992",
  purpleBg: "0.970 0.955 0.985",
  white: "1 1 1",
};

type PdfFont = "F1" | "F2" | "F3";

type PageState = {
  command: string;
  y: number;
};

function normalizarTextoPdf(value: string) {
  return value
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .normalize("NFC")
    .replace(/[^\x00-\xFF]/g, "?");
}

function escaparLiteralPdf(value: string) {
  return normalizarTextoPdf(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n]+/g, " ");
}

// Segmentos consecutivos no mesmo objeto de texto: o PDF usa a largura real
// de Helvetica/Helvetica-Bold, sem estimar posições para alternar o negrito.
function textoComDestaques(value: string, y: number, offset: number, ranges: Array<[number, number]>) {
  let command = `BT ${COLORS.text} rg 1 0 0 1 ${MARGIN_X} ${y.toFixed(2)} Tm `;
  let start = 0;
  const boldAt = (i: number) => ranges.some(([a, b]) => offset + i >= a && offset + i < b);
  for (let i = 1; i <= value.length; i += 1) {
    if (i === value.length || boldAt(i) !== boldAt(start)) {
      command += `/${boldAt(start) ? 'F2' : 'F1'} 9.00 Tf (${escaparLiteralPdf(value.slice(start, i))}) Tj `;
      start = i;
    }
  }
  return command + 'ET\n';
}

function texto(
  value: string,
  x: number,
  y: number,
  size: number,
  font: PdfFont = "F1",
  color = COLORS.text,
) {
  return `BT /${font} ${size.toFixed(2)} Tf ${color} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escaparLiteralPdf(value)}) Tj ET\n`;
}

function rect(
  x: number,
  top: number,
  width: number,
  height: number,
  options: { fill?: string; stroke?: string; lineWidth?: number } = {},
) {
  const y = top - height;
  const chunks = ["q"];
  if (options.fill) chunks.push(`${options.fill} rg`);
  if (options.stroke) chunks.push(`${options.stroke} RG`);
  chunks.push(`${(options.lineWidth ?? 0.7).toFixed(2)} w`);
  chunks.push(`${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re`);
  chunks.push(options.fill && options.stroke ? "B" : options.fill ? "f" : "S");
  chunks.push("Q\n");
  return chunks.join(" ");
}

function line(x1: number, x2: number, y: number, color = COLORS.line, width = 0.7) {
  return `q ${color} RG ${width.toFixed(2)} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S Q\n`;
}

function charsPerLine(width: number, size: number, factor = 0.52) {
  return Math.max(18, Math.floor(width / (size * factor)));
}

function wrap(value: string, maxChars: number) {
  const words = normalizarTextoPdf(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= maxChars) {
      current = word;
      continue;
    }
    let rest = word;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function carregarLogo() {
  try {
    return readFileSync(LOGO_PATH);
  } catch {
    return null;
  }
}

function cabecalho(pageNumber: number, totalPages: number, documento: ContratoOficialRenderizado, hasLogo: boolean) {
  let command = "";
  if (hasLogo) {
    const width = 92;
    const height = width * (LOGO_PIXEL_HEIGHT / LOGO_PIXEL_WIDTH);
    command += `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${MARGIN_X.toFixed(2)} 781 cm /Logo Do Q\n`;
  } else {
    command += texto("KIDMAIS", MARGIN_X, 805, 13, "F2", COLORS.navy);
  }
  command += texto("CONTRATO OFICIAL", 384, 808, 7.4, "F2", COLORS.purple);
  command += texto(documento.subtitulo, 384, 796, 8.8, "F2", COLORS.navy);
  command += texto(`Página ${pageNumber} de ${totalPages}`, 474, 780, 7.2, "F1", COLORS.muted);
  command += line(MARGIN_X, A4_WIDTH - MARGIN_X, 770, COLORS.blue, 1.05);
  return command;
}

function rodape(pageNumber: number, totalPages: number, documento: ContratoOficialRenderizado) {
  const hashLine = documento.integridade.find((item) => item.includes("SHA-256")) ?? "";
  const hash = /([0-9a-f]{64})/i.exec(hashLine)?.[1] ?? "";
  let command = line(MARGIN_X, A4_WIDTH - MARGIN_X, 53, COLORS.line, 0.55);
  command += texto(`Kidmais Manager · ${documento.modeloCodigo} · Template V${documento.templateVersao}`, MARGIN_X, 38, 6.8, "F1", COLORS.muted);
  command += texto(`Integridade ${hash ? hash.slice(0, 16) : "-"}… · ${pageNumber}/${totalPages}`, 377, 38, 6.8, "F3", COLORS.muted);
  return command;
}

function renderTitle(state: PageState, documento: ContratoOficialRenderizado) {
  let { command, y } = state;
  command += texto(documento.titulo, MARGIN_X, y, 18.5, "F2", COLORS.navy);
  y -= 24;
  command += texto(documento.subtitulo, MARGIN_X, y, 11.2, "F2", COLORS.purple);
  y -= 19;
  if (documento.avisoHomologacao) {
    const lines = wrap(documento.avisoHomologacao, charsPerLine(CONTENT_WIDTH - 28, 8.1));
    const height = 25 + lines.length * 10.3;
    command += rect(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.warmBg, stroke: "0.950 0.760 0.520", lineWidth: 0.7 });
    command += `q ${COLORS.orange} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
    command += texto("HOMOLOGAÇÃO JURÍDICA", MARGIN_X + 14, y - 14, 7.5, "F2", COLORS.warmText);
    let yy = y - 28;
    for (const l of lines) {
      command += texto(l, MARGIN_X + 14, yy, 8.1, "F1", COLORS.warmText);
      yy -= 10.3;
    }
    y -= height + 14;
  }
  return { command, y };
}

function sectionTitle(state: PageState, title: string) {
  let { command, y } = state;
  const height = 27;
  command += rect(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.soft });
  command += `q ${COLORS.blue} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
  command += texto(title, MARGIN_X + 13, y - 17, 9.4, "F2", COLORS.navy);
  y -= height + 9;
  return { command, y };
}

function appendWrappedLines(
  state: PageState,
  value: string,
  options: { size?: number; font?: PdfFont; color?: string; indent?: number; leading?: number; after?: number } = {},
) {
  const size = options.size ?? 9.1;
  const leading = options.leading ?? 12.0;
  const indent = options.indent ?? 0;
  const width = CONTENT_WIDTH - indent;
  const lines = wrap(value, charsPerLine(width, size));
  let { command, y } = state;
  for (const l of lines) {
    command += texto(l, MARGIN_X + indent, y, size, options.font ?? "F1", options.color ?? COLORS.text);
    y -= leading;
  }
  y -= options.after ?? 5;
  return { command, y };
}

function buildBodies(documento: ContratoOficialRenderizado) {
  const pages: string[] = [];
  let state: PageState = { command: "", y: TOP_Y };

  const pushPage = () => {
    pages.push(state.command);
    state = { command: "", y: TOP_Y };
  };

  const ensure = (height: number) => {
    if (state.y - height < BOTTOM_Y && state.command.trim()) pushPage();
  };

  const paragraph = (value: string, options: Parameters<typeof appendWrappedLines>[2] = {}) => {
    const size = options.size ?? 9.1;
    const leading = options.leading ?? 12;
    const estimated = wrap(value, charsPerLine(CONTENT_WIDTH - (options.indent ?? 0), size)).length * leading + (options.after ?? 5);
    ensure(Math.min(estimated, 110));
    state = appendWrappedLines(state, value, options);
  };

  state = renderTitle(state, documento);

  ensure(95);
  state = sectionTitle(state, "IDENTIFICAÇÃO DAS PARTES");
  for (const item of documento.contratada) paragraph(item);
  state.y -= 2;
  for (const item of documento.contratante) paragraph(item);
  state.y -= 4;

  for (const item of documento.preambulo) paragraph(item, { font: "F2", size: 9.0, leading: 12.3, after: 10 });

  ensure(45);
  state = sectionTitle(state, "CLÁUSULAS CONTRATUAIS");

  for (const c of documento.clausulas) {
    const label = `Cláusula ${c.numero}ª`;
    const wrapped = wrap(c.texto, charsPerLine(CONTENT_WIDTH, 9.0));
    const estimated = 18 + wrapped.length * 12.1 + 9;
    if (state.y - Math.min(estimated, 145) < BOTTOM_Y && state.command.trim()) pushPage();

    state.command += texto(label, MARGIN_X, state.y, 9.4, "F2", c.numero % 2 === 0 ? COLORS.purple : COLORS.blue);
    state.y -= 15;
    const normalized = normalizarTextoPdf(c.texto).split(/\s+/).filter(Boolean).join(' ');
    const ranges: Array<[number, number]> = (c.destaques ?? []).flatMap(value => {
      const needle = normalizarTextoPdf(value).replace(/\s+/g, ' ');
      const start = normalized.indexOf(needle);
      return start < 0 ? [] : [[start, start + needle.length] as [number, number]];
    });
    let offset = 0;
    for (const l of wrapped) {
      if (state.y < BOTTOM_Y + 12) pushPage();
      // Sem destaques, mantém inclusive os bytes de renderização do template V1.
      state.command += ranges.length ? textoComDestaques(l, state.y, offset, ranges) : texto(l, MARGIN_X, state.y, 9.0, "F1", COLORS.text);
      offset += l.length;
      if (normalized[offset] === ' ') offset += 1;
      state.y -= 12.1;
    }
    state.y -= 10;
  }

  ensure(90);
  state = sectionTitle(state, "OBSERVAÇÕES DA CONTRATAÇÃO");
  for (const item of documento.observacoes) paragraph(item, { size: 8.9, leading: 11.7 });

  ensure(150);
  state = sectionTitle(state, "INTEGRIDADE E ACEITE ELETRÔNICO");
  for (const item of documento.integridade) {
    if (item.includes("SHA-256")) {
      ensure(55);
      const hash = /([0-9a-f]{64})/i.exec(item)?.[1] ?? item;
      state.command += rect(MARGIN_X, state.y, CONTENT_WIDTH, 47, { fill: COLORS.soft, stroke: COLORS.line, lineWidth: 0.7 });
      state.command += texto("SHA-256 DO SNAPSHOT CONTRATUAL", MARGIN_X + 13, state.y - 14, 7.5, "F2", COLORS.muted);
      state.command += texto(hash, MARGIN_X + 13, state.y - 31, 7.2, "F3", COLORS.navy);
      state.y -= 57;
    } else {
      paragraph(item, { size: 8.9, leading: 11.8 });
    }
  }

  ensure(150);
  state = sectionTitle(state, "FORMALIZAÇÃO");
  for (let index = 0; index < documento.assinatura.length; index += 1) {
    const item = documento.assinatura[index];
    if (index === 0) paragraph(item, { font: "F2", size: 9.2, after: 12 });
    else paragraph(item, { size: 8.8, leading: 11.5, after: 8 });
  }

  pages.push(state.command);
  return pages;
}

function latin1(value: string) {
  return Buffer.from(value, "latin1");
}

export function gerarPdfContratoOficial(documento: ContratoOficialRenderizado): Buffer {
  const bodies = buildBodies(documento);
  const logo = carregarLogo();
  const regularId = 3;
  const boldId = 4;
  const monoId = 5;
  const logoId = logo ? 6 : null;
  const firstPageId = logo ? 7 : 6;

  const streams = bodies.map((body, index) =>
    `${cabecalho(index + 1, bodies.length, documento, Boolean(logo))}${body}${rodape(index + 1, bodies.length, documento)}`,
  );
  const refs = streams.map((_, i) => `${firstPageId + i * 2} 0 R`).join(" ");
  const objects: Array<{ id: number; bytes: Buffer }> = [];

  const add = (id: number, body: string | Buffer) => {
    const bytes = Buffer.isBuffer(body) ? body : latin1(body);
    objects.push({ id, bytes: Buffer.concat([latin1(`${id} 0 obj\n`), bytes, latin1("\nendobj\n")]) });
  };

  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, `<< /Type /Pages /Kids [${refs}] /Count ${streams.length} >>`);
  add(regularId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add(boldId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add(monoId, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

  if (logo && logoId) {
    add(
      logoId,
      Buffer.concat([
        latin1(`<< /Type /XObject /Subtype /Image /Width ${LOGO_PIXEL_WIDTH} /Height ${LOGO_PIXEL_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.length} >>\nstream\n`),
        logo,
        latin1("\nendstream"),
      ]),
    );
  }

  streams.forEach((stream, index) => {
    const pageId = firstPageId + index * 2;
    const contentId = pageId + 1;
    const bytes = latin1(stream);
    const xObject = logoId ? ` /XObject << /Logo ${logoId} 0 R >>` : "";
    add(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] /Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R /F3 ${monoId} 0 R >>${xObject} >> /Contents ${contentId} 0 R >>`);
    add(contentId, Buffer.concat([latin1(`<< /Length ${bytes.length} >>\nstream\n`), bytes, latin1("endstream")]));
  });

  objects.sort((a, b) => a.id - b.id);
  const header = latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const chunks: Buffer[] = [header];
  const offsets = new Map<number, number>();
  let offset = header.length;

  for (const obj of objects) {
    offsets.set(obj.id, offset);
    chunks.push(obj.bytes);
    offset += obj.bytes.length;
  }

  const xrefOffset = offset;
  const maxId = Math.max(...objects.map((obj) => obj.id));
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const itemOffset = offsets.get(id);
    xref += itemOffset == null
      ? "0000000000 00000 f \n"
      : `${itemOffset.toString().padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(latin1(`${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export function hashPdfContratoOficial(pdf: Uint8Array) {
  return createHash("sha256").update(pdf).digest("hex");
}
