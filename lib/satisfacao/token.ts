import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Link da pesquisa (plano rev. 3, N1). Nunca é gravado: o banco guarda só o SHA-256; o despacho recalcula o mesmo link
 * a partir de envio_id, geração e versão da chave.
 *
 *   token = base64url( versão(1) ‖ envio_id(16) ‖ geração(4, big-endian) ‖ chave_versao(1) ‖ HMAC-SHA256(K[chave_versao], 22 bytes anteriores)(32) )
 *         = 54 bytes = 72 caracteres.
 *
 * A verificação é TODA em memória (tamanho, formato, chave no anel, HMAC em tempo constante) e acontece antes de qualquer
 * consulta ao banco: um token inventado nunca chega ao banco nem ao limite de tentativas.
 *
 * Anel de chaves: SATISFACAO_LINK_CHAVES = "1:<base64>,2:<base64>" (segredos de ≥ 32 bytes, versões 1–255, sem repetição)
 * e SATISFACAO_LINK_CHAVE_ATUAL = versão que assina os links novos. Ausente, malformado ou com a atual fora do anel:
 * falha fechada (null), sem fallback. Chave trocada continua no anel por ≥ 31 dias (os links já enviados seguem válidos).
 */
export const VERSAO_FORMATO = 1;
export const TAMANHO_TOKEN = 72;
const TAMANHO_BYTES = 54;
const ASSINADO = 22;

export type AnelChaves = { atual: number; chaves: ReadonlyMap<number, Buffer> };
export type TokenVerificado = { envioId: string; geracao: number; chaveVersao: number; hash: Buffer };

/** Lê o anel do ambiente. Qualquer defeito devolve null (quem chama falha fechado). */
export function lerAnel(env: Record<string, string | undefined> = process.env): AnelChaves | null {
  const lista = env.SATISFACAO_LINK_CHAVES?.trim();
  const atualTexto = env.SATISFACAO_LINK_CHAVE_ATUAL?.trim();
  if (!lista || !atualTexto || !/^[0-9]{1,3}$/.test(atualTexto)) return null;
  const chaves = new Map<number, Buffer>();
  for (const parte of lista.split(",")) {
    const m = /^([0-9]{1,3}):([A-Za-z0-9+/_-]+={0,2})$/.exec(parte.trim());
    if (!m) return null;
    const versao = Number(m[1]);
    const segredo = Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (versao < 1 || versao > 255 || chaves.has(versao) || segredo.length < 32) return null;
    chaves.set(versao, segredo);
  }
  const atual = Number(atualTexto);
  if (!chaves.has(atual)) return null;
  return { atual, chaves };
}

function uuidParaBytes(uuid: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw new Error("envio_id inválido");
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesParaUuid(b: Buffer) {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function assinatura(segredo: Buffer, dados: Buffer) {
  return createHmac("sha256", segredo).update(dados).digest();
}

/** Monta o token de um envio (geração e chave dados). Lança se a chave não está no anel. */
export function assinarToken(anel: AnelChaves, envioId: string, geracao: number, chaveVersao: number): string {
  const segredo = anel.chaves.get(chaveVersao);
  if (!segredo) throw new Error("chave fora do anel");
  if (!Number.isInteger(geracao) || geracao < 1 || geracao > 0x7fffffff) throw new Error("geração inválida");
  const dados = Buffer.alloc(ASSINADO);
  dados.writeUInt8(VERSAO_FORMATO, 0);
  uuidParaBytes(envioId).copy(dados, 1);
  dados.writeUInt32BE(geracao, 17);
  dados.writeUInt8(chaveVersao, 21);
  return Buffer.concat([dados, assinatura(segredo, dados)]).toString("base64url");
}

/** SHA-256 do token (o que o banco guarda e o que identifica o limite sem IP). */
export function hashDoToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Verificação em memória. null = recusado (formato, versão, chave fora do anel ou HMAC divergente). */
export function verificarToken(anel: AnelChaves, token: unknown): TokenVerificado | null {
  if (typeof token !== "string" || token.length !== TAMANHO_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== TAMANHO_BYTES || bytes.toString("base64url") !== token) return null;
  if (bytes.readUInt8(0) !== VERSAO_FORMATO) return null;
  const chaveVersao = bytes.readUInt8(21);
  const segredo = anel.chaves.get(chaveVersao);
  if (!segredo) return null;
  const esperado = assinatura(segredo, bytes.subarray(0, ASSINADO));
  if (!timingSafeEqual(esperado, bytes.subarray(ASSINADO))) return null;
  const geracao = bytes.readUInt32BE(17);
  if (geracao < 1 || geracao > 0x7fffffff) return null;
  return { envioId: bytesParaUuid(bytes.subarray(1, 17)), geracao, chaveVersao, hash: hashDoToken(token) };
}

/** Comparação do hash gravado com o do token, em tempo constante. */
export function mesmoHash(gravado: Buffer | null | undefined, calculado: Buffer) {
  return !!gravado && gravado.length === calculado.length && timingSafeEqual(gravado, calculado);
}
