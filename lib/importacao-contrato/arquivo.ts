import { createHash } from "node:crypto";

/**
 * Validação do arquivo enviado para importação histórica.
 *
 * Extensão, MIME declarado e assinatura (magic bytes) precisam concordar: nunca se confia só na extensão.
 * O nome original é sanitizado (sem caminho, sem controle, sem acento) e só serve para exibição.
 * O limite é configurável (AI_UPLOAD_MAX_BYTES) com teto fixo de 25 MB, o mesmo CHECK da migration 055.
 */
export type TipoAceito = "application/pdf" | "image/jpeg" | "image/png";

export const TETO_BYTES = 25 * 1024 * 1024;
export const LIMITE_PADRAO_BYTES = 15 * 1024 * 1024;

const EXTENSOES: Readonly<Record<string, TipoAceito>> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

export type ArquivoValidado = {
  contentType: TipoAceito;
  nomeSeguro: string;
  tamanhoBytes: number;
  sha256: string;
  bytes: Uint8Array;
};

export type ResultadoValidacao = { ok: true; arquivo: ArquivoValidado } | { ok: false; codigo: string; mensagem: string };

export function limiteConfigurado(valor: string | undefined) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1024 && n <= TETO_BYTES ? n : LIMITE_PADRAO_BYTES;
}

/** Assinatura real do conteúdo. */
export function tipoPelaAssinatura(bytes: Uint8Array): TipoAceito | null {
  const inicio = (assinatura: number[]) => assinatura.every((b, i) => bytes[i] === b);
  if (inicio([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (inicio([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (inicio([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

export function nomeSeguro(original: string, tipo: TipoAceito) {
  const base = (original.split(/[\\/]/).pop() ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, "_")
    .replace(/^[.\s_-]+|[.\s_-]+$/g, "")
    .slice(0, 120) || "documento";
  const extensao = tipo === "application/pdf" ? "pdf" : tipo === "image/png" ? "png" : "jpg";
  return `${base}.${extensao}`;
}

/** Procura marcadores que impedem a leitura (PDF criptografado). Varre só texto ASCII do arquivo. */
function pdfCriptografado(bytes: Uint8Array) {
  const amostra = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 64 * 1024))).toString("latin1") + Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).toString("latin1");
  return /\/Encrypt\s/.test(amostra);
}

export function validarArquivoEnviado(entrada: { nome: string; tipoDeclarado: string; bytes: Uint8Array; limiteBytes: number }): ResultadoValidacao {
  const { nome, tipoDeclarado, bytes, limiteBytes } = entrada;
  if (bytes.length === 0) return { ok: false, codigo: "ARQUIVO_VAZIO", mensagem: "O arquivo está vazio." };
  if (bytes.length > Math.min(limiteBytes, TETO_BYTES)) {
    return { ok: false, codigo: "ARQUIVO_GRANDE", mensagem: `O arquivo passa de ${Math.floor(Math.min(limiteBytes, TETO_BYTES) / (1024 * 1024))} MB. Envie uma versão menor.` };
  }
  const extensao = nome.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
  const pelaExtensao = EXTENSOES[extensao];
  const pelaAssinatura = tipoPelaAssinatura(bytes);
  const declarado = tipoDeclarado.split(";")[0].trim().toLowerCase();
  if (!pelaExtensao || !pelaAssinatura) return { ok: false, codigo: "TIPO_NAO_ACEITO", mensagem: "Envie o contrato em PDF, JPG ou PNG." };
  if (pelaExtensao !== pelaAssinatura || (declarado && declarado !== pelaAssinatura && !(declarado === "image/jpg" && pelaAssinatura === "image/jpeg"))) {
    return { ok: false, codigo: "TIPO_DIVERGENTE", mensagem: "O conteúdo do arquivo não corresponde ao tipo informado." };
  }
  if (pelaAssinatura === "application/pdf" && pdfCriptografado(bytes)) {
    return { ok: false, codigo: "PDF_PROTEGIDO", mensagem: "PDF protegido por senha não pode ser lido. Envie uma cópia sem proteção." };
  }
  return {
    ok: true,
    arquivo: {
      contentType: pelaAssinatura,
      nomeSeguro: nomeSeguro(nome, pelaAssinatura),
      tamanhoBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    },
  };
}
