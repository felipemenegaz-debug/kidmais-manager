import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Normalização compartilhada de imagens enviadas ao painel (site da 085 e fotos de salão da 102). Contrato da 085,
 * sem mudança: entrada PNG/JPEG/WebP real até 8 MB e 40 milhões de pixels, sem animação; saída SEMPRE WebP reprocessado
 * (sem EXIF/GPS), rotação aplicada, até 1600 px no maior lado e 1.500.000 bytes. O conteúdo enviado nunca é guardado
 * nem servido como veio. Cada domínio traduz a falha para a sua mensagem.
 */
export const WEBP_MAX_ENTRADA = 8 * 1024 * 1024;
export const WEBP_MAX_SAIDA = 1_500_000;
export const WEBP_MAX_LADO = 1600;
export const WEBP_TIPOS_ENTRADA = ["image/png", "image/jpeg", "image/webp"];

export type WebpNormalizado = { conteudo: Buffer; largura: number; altura: number; sha256: string };

export class ImagemInvalidaError extends Error {
  readonly motivo: "TAMANHO" | "FORMATO";
  constructor(motivo: "TAMANHO" | "FORMATO") {
    super(motivo === "TAMANHO" ? "imagem acima do tamanho de entrada" : "imagem inválida");
    this.name = "ImagemInvalidaError";
    this.motivo = motivo;
  }
}

export async function normalizarWebp(bytes: Buffer): Promise<WebpNormalizado> {
  if (bytes.length === 0 || bytes.length > WEBP_MAX_ENTRADA) throw new ImagemInvalidaError("TAMANHO");
  try {
    const imagem = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: "warning" });
    const meta = await imagem.metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) !== 1) throw new Error("formato");
    for (const qualidade of [82, 74, 66]) {
      const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
        .rotate().resize({ width: WEBP_MAX_LADO, height: WEBP_MAX_LADO, fit: "inside", withoutEnlargement: true }).webp({ quality: qualidade }).toBuffer({ resolveWithObject: true });
      if (data.length <= WEBP_MAX_SAIDA) {
        return { conteudo: data, largura: info.width, altura: info.height, sha256: createHash("sha256").update(data).digest("hex") };
      }
    }
  } catch {
    // qualquer falha do decodificador vira FORMATO abaixo
  }
  throw new ImagemInvalidaError("FORMATO");
}
