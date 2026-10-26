import type { DbExecutor } from "../../db/contracts.ts";
import { ImagemInvalidaError, normalizarWebp, WEBP_MAX_ENTRADA, WEBP_TIPOS_ENTRADA } from "../../imagens/normalizar-webp.ts";
import { MarketingError, naoEncontrado } from "../erros.ts";

/**
 * Imagens do site (galeria e logo). Entrada PNG/JPEG/WebP até 8 MB; saída SEMPRE WebP reprocessado (sem EXIF/GPS, sem
 * animação, sem SVG), até 1600 px no maior lado e 1,5 MB. O conteúdo enviado nunca é servido como veio.
 * Publicidade: a rota pública só entrega imagem citada na VERSÃO PUBLICADA do site; rascunho e upload avulso continuam
 * privados (prévia só com sessão administrativa).
 */
export const IMAGEM_MAX_UPLOAD = WEBP_MAX_ENTRADA;
export const IMAGEM_TIPOS = WEBP_TIPOS_ENTRADA;
export const IMAGENS_POR_SITE = 40;

/** Normalização compartilhada (lib/imagens/normalizar-webp.ts), com as mensagens do site. */
export async function normalizarImagemSite(bytes: Buffer) {
  try {
    return await normalizarWebp(bytes);
  } catch (error) {
    if (error instanceof ImagemInvalidaError && error.motivo === "TAMANHO") throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Envie uma imagem de até 8 MB.", 413);
    throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Não foi possível usar esta imagem. Envie um PNG, JPEG ou WebP válido.", 400);
  }
}

export async function salvarImagem(
  tx: DbExecutor, empresaId: string, siteId: string, usuarioId: string,
  imagem: Awaited<ReturnType<typeof normalizarImagemSite>>, descricao: string | null,
) {
  const total = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM marketing_site_imagens WHERE site_id = $1::uuid AND empresa_id = $2::uuid AND removida_em IS NULL`, [siteId, empresaId]);
  if (Number(total.rows[0]?.n ?? 0) >= IMAGENS_POR_SITE) {
    throw new MarketingError("MARKETING_IMAGENS_LIMITE", `Limite de ${IMAGENS_POR_SITE} imagens por site. Remova alguma antes de enviar outra.`, 409);
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO marketing_site_imagens (empresa_id, site_id, conteudo, mime, bytes, largura, altura, sha256, descricao, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, $5, $6, $7, $8, $9::uuid) RETURNING id::text`,
    [empresaId, siteId, imagem.conteudo, imagem.conteudo.length, imagem.largura, imagem.altura, imagem.sha256, descricao, usuarioId],
  );
  return { id: r.rows[0].id, largura: imagem.largura, altura: imagem.altura, bytes: imagem.conteudo.length };
}

export async function listarImagens(tx: DbExecutor, empresaId: string, siteId: string) {
  const r = await tx.query<{ id: string; largura: number; altura: number; bytes: number; descricao: string | null; criado_em: string }>(
    `SELECT id::text, largura, altura, bytes, descricao, criado_em::text FROM marketing_site_imagens
      WHERE site_id = $1::uuid AND empresa_id = $2::uuid AND removida_em IS NULL ORDER BY criado_em DESC`, [siteId, empresaId]);
  return r.rows.map((l) => ({ id: l.id, largura: l.largura, altura: l.altura, bytes: l.bytes, descricao: l.descricao, criadoEm: l.criado_em }));
}

/**
 * Remoção vale na hora NO SERVIDOR, inclusive para a página publicada (a imagem deixa de ser servida; o espaço some da
 * galeria). Cópias já guardadas por navegador/CDN podem ser reaproveitadas até o fim do cache público (max-age=300,
 * ver rotas-publicas.ts). Privacidade antes de estética: quem removeu uma foto publicada por engano não espera a
 * próxima publicação.
 */
export async function removerImagem(tx: DbExecutor, empresaId: string, siteId: string, imagemId: string) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_site_imagens SET removida_em = clock_timestamp()
      WHERE id = $1::uuid AND site_id = $2::uuid AND empresa_id = $3::uuid AND removida_em IS NULL RETURNING id::text`,
    [imagemId, siteId, empresaId],
  );
  if (r.rows.length !== 1) naoEncontrado("Imagem não encontrada neste site.");
}

/** Conteúdo para a PRÉVIA administrativa (empresa comprovada): qualquer imagem não removida do site da empresa. */
export async function imagemDaEmpresa(tx: DbExecutor, empresaId: string, imagemId: string) {
  const r = await tx.query<{ conteudo: Buffer; sha256: string }>(
    `SELECT conteudo, sha256 FROM marketing_site_imagens WHERE id = $1::uuid AND empresa_id = $2::uuid AND removida_em IS NULL`, [imagemId, empresaId]);
  return r.rows[0] ?? null;
}

/** Exige que as imagens citadas pelo conteúdo sejam deste site e não removidas (antes de salvar/publicar). */
export async function exigirImagensDoSite(tx: DbExecutor, empresaId: string, siteId: string, ids: string[]) {
  if (ids.length === 0) return;
  const r = await tx.query<{ id: string }>(
    `SELECT id::text FROM marketing_site_imagens WHERE id = ANY($1::uuid[]) AND site_id = $2::uuid AND empresa_id = $3::uuid AND removida_em IS NULL`,
    [ids, siteId, empresaId],
  );
  if (r.rows.length !== ids.length) {
    throw new MarketingError("MARKETING_IMAGEM_INVALIDA", "Alguma imagem escolhida não pertence a este site ou foi removida. Escolha de novo.", 400);
  }
}
