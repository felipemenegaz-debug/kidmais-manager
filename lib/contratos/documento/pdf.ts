import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContratoDocumentoLinha, ContratoDocumentoRenderizado } from "./models.ts";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 44;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;
const CONTENT_TOP = 718;
const CONTENT_BOTTOM = 76;

const LOGO_PATH = join(
  process.cwd(),
  "public",
  "assets",
  "contratos",
  "kidmais-logo-template-v1.jpg",
);
const LOGO_PIXEL_WIDTH = 1400;
const LOGO_PIXEL_HEIGHT = 578;

const COLORS = {
  navy: "0.055 0.090 0.180",
  text: "0.110 0.145 0.220",
  muted: "0.390 0.430 0.500",
  line: "0.870 0.890 0.925",
  soft: "0.965 0.973 0.985",
  blue: "0.000 0.525 0.780",
  purple: "0.455 0.255 0.635",
  orange: "0.980 0.455 0.055",
  warmBg: "1.000 0.972 0.930",
  warmText: "0.560 0.245 0.045",
  blueBg: "0.940 0.975 0.992",
  purpleBg: "0.970 0.955 0.985",
  white: "1 1 1",
};

type PdfFont = "F1" | "F2" | "F3";
type Secao = { titulo: string; itens: ContratoDocumentoLinha[] };
type Campo = { label: string; value: string };

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

function comandoTexto(
  texto: string,
  x: number,
  y: number,
  size: number,
  font: PdfFont = "F1",
  color = COLORS.text,
) {
  return `BT /${font} ${size.toFixed(2)} Tf ${color} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escaparLiteralPdf(texto)}) Tj ET\n`;
}

function retangulo(
  x: number,
  top: number,
  width: number,
  height: number,
  options: { fill?: string; stroke?: string; lineWidth?: number } = {},
) {
  const y = top - height;
  const commands = ["q"];
  if (options.fill) commands.push(`${options.fill} rg`);
  if (options.stroke) commands.push(`${options.stroke} RG`);
  commands.push(`${(options.lineWidth ?? 0.7).toFixed(2)} w`);
  commands.push(`${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re`);
  commands.push(options.fill && options.stroke ? "B" : options.fill ? "f" : "S");
  commands.push("Q\n");
  return commands.join(" ");
}

function linhaHorizontal(x1: number, x2: number, y: number, color = COLORS.line, width = 0.7) {
  return `q ${color} RG ${width.toFixed(2)} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S Q\n`;
}

function capacidadeCaracteres(width: number, size: number, fator = 0.53) {
  return Math.max(18, Math.floor(width / (size * fator)));
}

function quebrarTexto(texto: string, maxChars: number) {
  const clean = normalizarTextoPdf(texto).trim();
  if (!clean) return [""];
  const words = clean.split(/\s+/);
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
    for (let i = 0; i < word.length; i += maxChars) {
      const piece = word.slice(i, i + maxChars);
      if (piece.length === maxChars) lines.push(piece);
      else current = piece;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function textoQuebrado(
  texto: string,
  x: number,
  y: number,
  width: number,
  options: { size?: number; font?: PdfFont; color?: string; leading?: number } = {},
) {
  const size = options.size ?? 9.4;
  const leading = options.leading ?? size * 1.34;
  const lines = quebrarTexto(texto, capacidadeCaracteres(width, size));
  let command = "";
  let cursor = y;
  for (const line of lines) {
    command += comandoTexto(line, x, cursor, size, options.font ?? "F1", options.color ?? COLORS.text);
    cursor -= leading;
  }
  return { command, lines, height: lines.length * leading, yAfter: cursor };
}

function imagemLogo(x: number, y: number, width: number, height: number) {
  return `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Logo Do Q\n`;
}

function extrairVersao(documento: ContratoDocumentoRenderizado) {
  const rodape = documento.linhas.find((item) => item.estilo === "rodape")?.texto ?? "";
  const match = rodape.match(/Versão (?:documental|do resumo):\s*(\d+)/i);
  return match?.[1] ?? "1";
}

function extrairSnapshotHash(documento: ContratoDocumentoRenderizado) {
  const texto = documento.linhas.map((item) => item.texto).join("\n");
  return texto.match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() ?? null;
}

function separarDocumento(documento: ContratoDocumentoRenderizado) {
  const titulo = documento.linhas.find((item) => item.estilo === "titulo")?.texto ?? documento.titulo;
  const aviso = documento.linhas.find((item) => item.estilo === "aviso")?.texto ?? "";
  const secoes: Secao[] = [];
  let atual: Secao | null = null;

  for (const item of documento.linhas) {
    if (item.estilo === "secao") {
      atual = { titulo: item.texto, itens: [] };
      secoes.push(atual);
      continue;
    }
    if (atual && item.estilo !== "rodape") atual.itens.push(item);
  }

  return { titulo, aviso, secoes };
}

function campoPorLabel(itens: ContratoDocumentoLinha[], label: string) {
  const prefix = `${label}:`;
  const item = itens.find((linha) => linha.texto.startsWith(prefix));
  return item ? item.texto.slice(prefix.length).trim() : "Não informado";
}

function cabecalho(pageNumber: number, totalPages: number, documento: ContratoDocumentoRenderizado, temLogo: boolean) {
  let command = "";
  if (temLogo) {
    const logoWidth = 151;
    const logoHeight = logoWidth * (LOGO_PIXEL_HEIGHT / LOGO_PIXEL_WIDTH);
    command += imagemLogo(MARGIN_X, 762, logoWidth, logoHeight);
  } else {
    command += comandoTexto("KIDMAIS FESTAS", MARGIN_X, 793, 15, "F2", COLORS.navy);
  }

  command += comandoTexto(documento.cabecalhoRotulo ?? "RESUMO DA CONTRATAÇÃO", 385, 799, 8.2, "F2", COLORS.muted);
  command += comandoTexto(`Versão ${extrairVersao(documento)}`, 464, 781, 10.5, "F2", COLORS.purple);

  command += `q ${COLORS.orange} rg ${MARGIN_X} 747 145 2.4 re f Q\n`;
  command += `q ${COLORS.purple} rg ${MARGIN_X + 145} 747 173 2.4 re f Q\n`;
  command += `q ${COLORS.blue} rg ${MARGIN_X + 318} 747 ${(CONTENT_WIDTH - 318).toFixed(2)} 2.4 re f Q\n`;
  return command;
}

function rodape(pageNumber: number, totalPages: number, documento: ContratoDocumentoRenderizado) {
  const hash = extrairSnapshotHash(documento);
  let command = linhaHorizontal(MARGIN_X, A4_WIDTH - MARGIN_X, 56, COLORS.line, 0.65);
  command += comandoTexto("Kidmais Festas  |  Documento gerado pelo Kidmais Manager", MARGIN_X, 40, 7.2, "F1", COLORS.muted);
  command += comandoTexto(`Página ${pageNumber} de ${totalPages}`, 489, 40, 7.2, "F1", COLORS.muted);
  if (hash) {
    command += comandoTexto(`Integridade: ${hash.slice(0, 16)}...${hash.slice(-8)}`, MARGIN_X, 27, 6.8, "F3", COLORS.muted);
  }
  return command;
}

function renderizarTitulo(command: string, y: number, titulo: string) {
  const exact = "CONTRATO DE PRESTAÇÃO DE SERVIÇOS PARA FESTA INFANTIL";
  if (normalizarTextoPdf(titulo).toUpperCase() === exact) {
    command += comandoTexto("CONTRATO DE PRESTAÇÃO DE SERVIÇOS", MARGIN_X, y, 17.8, "F2", COLORS.navy);
    command += comandoTexto("PARA FESTA INFANTIL", MARGIN_X, y - 24, 17.8, "F2", COLORS.navy);
    return { command, y: y - 44 };
  }

  const wrapped = textoQuebrado(titulo, MARGIN_X, y, CONTENT_WIDTH, {
    size: 17.8,
    font: "F2",
    color: COLORS.navy,
    leading: 22,
  });
  return { command: command + wrapped.command, y: wrapped.yAfter - 10 };
}

function renderizarAviso(command: string, y: number, aviso: string) {
  const height = 42;
  command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.warmBg, stroke: "0.965 0.780 0.560", lineWidth: 0.7 });
  command += `q ${COLORS.orange} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
  command += comandoTexto("DOCUMENTO INFORMATIVO", MARGIN_X + 14, y - 15, 8.5, "F2", COLORS.warmText);
  const texto = aviso.replace(/^DOCUMENTO INFORMATIVO\s*-\s*/i, "");
  command += textoQuebrado(texto, MARGIN_X + 14, y - 29, CONTENT_WIDTH - 28, {
    size: 7.8,
    color: COLORS.warmText,
    leading: 10,
  }).command;
  return { command, y: y - height - 13 };
}

function secaoCabecalho(command: string, y: number, titulo: string) {
  const height = 22;
  command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.soft });
  command += `q ${COLORS.blue} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
  command += comandoTexto(titulo, MARGIN_X + 13, y - 14.5, 10.2, "F2", COLORS.navy);
  return { command, y: y - 29 };
}

function renderizarLinhaCampo(
  command: string,
  y: number,
  campos: Campo[],
  options: { gap?: number; labelWidth?: number } = {},
) {
  const gap = options.gap ?? 18;
  const colWidth = (CONTENT_WIDTH - gap * (campos.length - 1)) / campos.length;
  const labelWidth = options.labelWidth ?? 72;
  const layouts = campos.map((campo) => {
    const valueWidth = colWidth - labelWidth;
    const lines = quebrarTexto(campo.value, capacidadeCaracteres(valueWidth, 9.25));
    return { campo, lines, valueWidth };
  });
  const height = Math.max(18, ...layouts.map((layout) => layout.lines.length * 11.2 + 5));

  layouts.forEach((layout, index) => {
    const x = MARGIN_X + index * (colWidth + gap);
    command += comandoTexto(layout.campo.label.toUpperCase(), x, y - 3, 7.7, "F2", COLORS.muted);
    let valueY = y - 3;
    const valueX = x + labelWidth;
    for (const line of layout.lines) {
      command += comandoTexto(line, valueX, valueY, 9.25, "F1", COLORS.text);
      valueY -= 11.2;
    }
  });

  command += linhaHorizontal(MARGIN_X, A4_WIDTH - MARGIN_X, y - height + 1, COLORS.line, 0.45);
  return { command, y: y - height };
}

function renderizarParagrafo(command: string, y: number, texto: string, options: { color?: string; size?: number; indent?: number } = {}) {
  const indent = options.indent ?? 0;
  const wrapped = textoQuebrado(texto, MARGIN_X + indent, y, CONTENT_WIDTH - indent, {
    size: options.size ?? 9.2,
    color: options.color ?? COLORS.text,
    leading: 12.3,
  });
  return { command: command + wrapped.command, y: wrapped.yAfter - 4 };
}

function renderizarSecao1(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  ({ command, y } = renderizarLinhaCampo(command, y, [{ label: "Nome", value: campoPorLabel(itens, "Nome") }], { labelWidth: 54 }));
  ({ command, y } = renderizarLinhaCampo(command, y, [
    { label: "CPF", value: campoPorLabel(itens, "CPF") },
    { label: "RG", value: campoPorLabel(itens, "RG") },
  ], { labelWidth: 34 }));
  ({ command, y } = renderizarLinhaCampo(command, y, [{ label: "E-mail", value: campoPorLabel(itens, "E-mail") }], { labelWidth: 54 }));
  ({ command, y } = renderizarLinhaCampo(command, y, [{ label: "Endereço", value: campoPorLabel(itens, "Endereço") }], { labelWidth: 62 }));
  return { command, y: y - 3 };
}

function renderizarSecao2(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  ({ command, y } = renderizarLinhaCampo(command, y, [
    { label: "Aniversariante", value: campoPorLabel(itens, "Aniversariante") },
    { label: "Tema", value: campoPorLabel(itens, "Tema") },
  ], { labelWidth: 76 }));
  ({ command, y } = renderizarLinhaCampo(command, y, [
    { label: "Data", value: campoPorLabel(itens, "Data") },
    { label: "Horário", value: campoPorLabel(itens, "Horário") },
  ], { labelWidth: 48 }));

  const convidadosRaw = campoPorLabel(itens, "Convidados informados");
  const match = convidadosRaw.match(/^(.*?)\s*\|\s*Convidados faturados:\s*(.*)$/i);
  ({ command, y } = renderizarLinhaCampo(command, y, [
    { label: "Pacote", value: campoPorLabel(itens, "Pacote") },
    { label: "Convidados", value: match ? `${match[1]} informados | ${match[2]} faturados` : convidadosRaw },
  ], { labelWidth: 61 }));
  return { command, y: y - 3 };
}

function renderizarSecao3(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  for (const item of itens) {
    if (!item.texto.trim()) continue;
    if (item.texto.startsWith("Alterações específicas do pacote:")) {
      ({ command, y } = renderizarLinhaCampo(command, y, [{
        label: "Alterações",
        value: item.texto.slice("Alterações específicas do pacote:".length).trim(),
      }], { labelWidth: 66 }));
      continue;
    }
    if (/^\d+\.\s/.test(item.texto) || item.texto.startsWith("Nenhum adicional")) {
      const bullet = "-";
      const wrapped = textoQuebrado(`${bullet} ${item.texto.replace(/^\d+\.\s*/, "")}`, MARGIN_X + 10, y, CONTENT_WIDTH - 10, {
        size: 9.1,
        color: COLORS.text,
        leading: 12,
      });
      command += wrapped.command;
      y = wrapped.yAfter - 3;
      continue;
    }
    ({ command, y } = renderizarParagrafo(command, y, item.texto));
  }
  return { command, y: y - 2 };
}

function renderizarSecao4(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  const texto = itens.map((item) => item.texto).filter(Boolean).join(" ");
  const wrapped = textoQuebrado(texto, MARGIN_X + 16, y - 29, CONTENT_WIDTH - 32, {
    size: 8.9,
    color: COLORS.text,
    leading: 11.8,
  });
  const height = Math.max(58, wrapped.height + 38);
  command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.blueBg, stroke: "0.760 0.880 0.950", lineWidth: 0.7 });
  command += `q ${COLORS.blue} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
  command += comandoTexto("STATUS DO BUFFET", MARGIN_X + 16, y - 13, 7.6, "F2", COLORS.blue);
  command += wrapped.command;
  return { command, y: y - height - 5 };
}

function renderizarSecao5(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  ({ command, y } = renderizarLinhaCampo(command, y, [
    { label: "Pacote", value: campoPorLabel(itens, "Valor do pacote aplicado") },
    { label: "Adicionais", value: campoPorLabel(itens, "Valor dos adicionais") },
  ], { labelWidth: 58 }));

  const total = campoPorLabel(itens, "Valor final desta contratação");
  const totalHeight = 39;
  command += retangulo(MARGIN_X, y, CONTENT_WIDTH, totalHeight, { fill: COLORS.warmBg, stroke: "0.950 0.760 0.520", lineWidth: 0.7 });
  command += comandoTexto("VALOR FINAL DA CONTRATAÇÃO", MARGIN_X + 14, y - 14, 8.0, "F2", COLORS.warmText);
  command += comandoTexto(total, A4_WIDTH - MARGIN_X - 132, y - 27, 14.2, "F2", COLORS.navy);
  y -= totalHeight + 6;

  ({ command, y } = renderizarLinhaCampo(command, y, [{
    label: "Pagamento",
    value: campoPorLabel(itens, "Forma de pagamento pretendida"),
  }], { labelWidth: 72 }));

  const disclaimer = itens.find((item) => item.texto.startsWith("A forma de pagamento acima"))?.texto;
  if (disclaimer) ({ command, y } = renderizarParagrafo(command, y, disclaimer, { size: 8.3, color: COLORS.muted }));
  return { command, y: y - 2 };
}

function renderizarSecao6(command: string, y: number, itens: ContratoDocumentoLinha[]) {
  const texto = itens.map((item) => item.texto).filter(Boolean).join(" ") || "Não informado";
  const wrapped = textoQuebrado(texto, MARGIN_X + 13, y - 17, CONTENT_WIDTH - 26, {
    size: 8.9,
    color: texto === "Não informado" ? COLORS.muted : COLORS.text,
    leading: 11.8,
  });
  const height = Math.max(40, wrapped.height + 22);
  command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.soft, stroke: COLORS.line, lineWidth: 0.6 });
  command += wrapped.command;
  return { command, y: y - height - 5 };
}

function renderizarSecao7(command: string, y: number, itens: ContratoDocumentoLinha[], documento: ContratoDocumentoRenderizado) {
  const hash = extrairSnapshotHash(documento);
  const textoSemHash = itens
    .filter((item) => item.estilo !== "rodape")
    .map((item) => item.texto)
    .filter(Boolean);

  if (textoSemHash[0]) ({ command, y } = renderizarParagrafo(command, y, textoSemHash[0], { size: 9.0 }));

  if (hash) {
    const height = 49;
    command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.soft, stroke: COLORS.line, lineWidth: 0.7 });
    command += comandoTexto("SHA-256 DO SNAPSHOT CONTRATUAL", MARGIN_X + 13, y - 14, 7.5, "F2", COLORS.muted);
    command += comandoTexto(hash, MARGIN_X + 13, y - 32, 7.2, "F3", COLORS.navy);
    y -= height + 9;
  }

  if (textoSemHash[1]) ({ command, y } = renderizarParagrafo(command, y, textoSemHash[1], { size: 9.0 }));

  if (textoSemHash[2]) {
    const wrapped = textoQuebrado(textoSemHash[2], MARGIN_X + 16, y - 25, CONTENT_WIDTH - 32, {
      size: 9.1,
      font: "F2",
      color: COLORS.navy,
      leading: 12.2,
    });
    const height = Math.max(68, wrapped.height + 43);
    command += retangulo(MARGIN_X, y, CONTENT_WIDTH, height, { fill: COLORS.purpleBg, stroke: "0.830 0.770 0.900", lineWidth: 0.8 });
    command += `q ${COLORS.purple} rg ${MARGIN_X} ${(y - height).toFixed(2)} 4 ${height.toFixed(2)} re f Q\n`;
    command += comandoTexto("VÍNCULO DOCUMENTAL", MARGIN_X + 16, y - 14, 8.0, "F2", COLORS.purple);
    command += wrapped.command;
    y -= height + 8;
  }

  command += comandoTexto(
    documento.cabecalhoRotulo
      ? `Resumo V${documento.templateVersao}  |  Documento informativo  |  Versão ${extrairVersao(documento)}`
      : `Modelo do resumo - revisão ${documento.templateVersao}  |  Documento informativo  |  Versão contratual ${extrairVersao(documento)}`,
    MARGIN_X,
    y - 2,
    7.5,
    "F1",
    COLORS.muted,
  );
  return { command, y: y - 18 };
}

function estimativaSecao(titulo: string, itens: ContratoDocumentoLinha[]) {
  if (titulo.startsWith("1.")) return 112;
  if (titulo.startsWith("2.")) return 86;
  if (titulo.startsWith("3.")) return Math.min(130, 58 + itens.length * 17);
  if (titulo.startsWith("4.")) return 82;
  if (titulo.startsWith("5.")) return 126;
  if (titulo.startsWith("6.")) return 78;
  if (titulo.startsWith("7.")) return 245;
  return 80;
}

function montarCorpos(documento: ContratoDocumentoRenderizado) {
  const { titulo, aviso, secoes } = separarDocumento(documento);
  const pages: string[] = [];
  let command = "";
  let y = CONTENT_TOP;

  const novaPagina = () => {
    pages.push(command);
    command = "";
    y = CONTENT_TOP;
  };

  const garantir = (height: number) => {
    if (y - height < CONTENT_BOTTOM && command.trim()) novaPagina();
  };

  ({ command, y } = renderizarTitulo(command, y, titulo));
  if (aviso) ({ command, y } = renderizarAviso(command, y, aviso));

  for (const secao of secoes) {
    const estimated = estimativaSecao(secao.titulo, secao.itens);
    if (secao.titulo.startsWith("7.") && y < 380 && command.trim()) novaPagina();
    else garantir(estimated);

    ({ command, y } = secaoCabecalho(command, y, secao.titulo));

    if (secao.titulo.startsWith("1.")) ({ command, y } = renderizarSecao1(command, y, secao.itens));
    else if (secao.titulo.startsWith("2.")) ({ command, y } = renderizarSecao2(command, y, secao.itens));
    else if (secao.titulo.startsWith("3.")) ({ command, y } = renderizarSecao3(command, y, secao.itens));
    else if (secao.titulo.startsWith("4.")) ({ command, y } = renderizarSecao4(command, y, secao.itens));
    else if (secao.titulo.startsWith("5.")) ({ command, y } = renderizarSecao5(command, y, secao.itens));
    else if (secao.titulo.startsWith("6.")) ({ command, y } = renderizarSecao6(command, y, secao.itens));
    else if (secao.titulo.startsWith("7.")) ({ command, y } = renderizarSecao7(command, y, secao.itens, documento));
    else {
      for (const item of secao.itens) {
        if (item.texto.trim()) ({ command, y } = renderizarParagrafo(command, y, item.texto));
      }
    }

    y -= 7;
  }

  pages.push(command);
  return pages;
}

function latin1Buffer(value: string) {
  return Buffer.from(value, "latin1");
}

function carregarLogo() {
  try {
    return readFileSync(LOGO_PATH);
  } catch {
    return null;
  }
}

export function gerarPdfDocumentoContrato(documento: ContratoDocumentoRenderizado): Buffer {
  const bodyStreams = montarCorpos(documento);
  const logo = carregarLogo();
  const fontRegularId = 3;
  const fontBoldId = 4;
  const fontMonoId = 5;
  const logoObjectId = logo ? 6 : null;
  const firstPageObject = logo ? 7 : 6;

  const pageStreams = bodyStreams.map((body, index) => {
    const pageNumber = index + 1;
    return `${cabecalho(pageNumber, bodyStreams.length, documento, Boolean(logo))}${body}${rodape(pageNumber, bodyStreams.length, documento)}`;
  });
  const pageRefs = pageStreams.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(" ");

  const objects: Array<{ id: number; bytes: Buffer }> = [];
  const addObject = (id: number, body: string | Buffer) => {
    const bodyBuffer = Buffer.isBuffer(body) ? body : latin1Buffer(body);
    objects.push({
      id,
      bytes: Buffer.concat([
        latin1Buffer(`${id} 0 obj\n`),
        bodyBuffer,
        latin1Buffer("\nendobj\n"),
      ]),
    });
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, `<< /Type /Pages /Kids [${pageRefs}] /Count ${pageStreams.length} >>`);
  addObject(fontRegularId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  addObject(fontBoldId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  addObject(fontMonoId, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

  if (logo && logoObjectId) {
    addObject(
      logoObjectId,
      Buffer.concat([
        latin1Buffer(
          `<< /Type /XObject /Subtype /Image /Width ${LOGO_PIXEL_WIDTH} /Height ${LOGO_PIXEL_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.length} >>\nstream\n`,
        ),
        logo,
        latin1Buffer("\nendstream"),
      ]),
    );
  }

  pageStreams.forEach((stream, index) => {
    const pageId = firstPageObject + index * 2;
    const contentId = pageId + 1;
    const streamBytes = latin1Buffer(stream);
    const xObject = logoObjectId ? ` /XObject << /Logo ${logoObjectId} 0 R >>` : "";

    addObject(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontMonoId} 0 R >>${xObject} >> /Contents ${contentId} 0 R >>`,
    );
    addObject(
      contentId,
      Buffer.concat([
        latin1Buffer(`<< /Length ${streamBytes.length} >>\nstream\n`),
        streamBytes,
        latin1Buffer("endstream"),
      ]),
    );
  });

  objects.sort((a, b) => a.id - b.id);
  const headerBytes = latin1Buffer("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const chunks: Buffer[] = [headerBytes];
  const offsets = new Map<number, number>();
  let offset = headerBytes.length;

  for (const object of objects) {
    offsets.set(object.id, offset);
    chunks.push(object.bytes);
    offset += object.bytes.length;
  }

  const xrefOffset = offset;
  const maxId = Math.max(...objects.map((object) => object.id));
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const itemOffset = offsets.get(id);
    xref += itemOffset == null
      ? "0000000000 00000 f \n"
      : `${itemOffset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(latin1Buffer(xref + trailer));

  return Buffer.concat(chunks);
}

export function hashPdfContrato(pdf: Uint8Array) {
  return createHash("sha256").update(pdf).digest("hex");
}
