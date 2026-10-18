import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { buscarPacoteVigenteDaEmpresaPorCodigo } from "../../comercial/repositories/comercial.repository.ts";
import { lerPrecosCorrentes } from "../../comercial/pacote-precos.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "../../comercial/pacotes-v1.ts";
import { nomePublicoDaEmpresa } from "../../perfil/nome-publico.ts";
import { perfilDoTenantOuNulo } from "../../perfil/tenant.ts";
import { MarketingError, conflito, naoEncontrado } from "../erros.ts";
import { exigirUnidadeDaEmpresa } from "../campanhas.ts";
import {
  SLUG_SITE, conteudoVazio, esquemaConteudoSite, formaParaImpressao, imagensReferenciadas, pendenciasParaPublicar, sugerirSlug,
  type ConteudoPublicado, type ConteudoSite, type PacotePublicado,
} from "./conteudo.ts";
import { exigirImagensDoSite, listarImagens } from "./imagens.ts";

export type EstadoSite = "RASCUNHO" | "PUBLICADO" | "DESPUBLICADO";
export type SiteAdmin = {
  id: string; slug: string; unidadeId: string | null; estado: EstadoSite; rascunho: ConteudoSite; rascunhoVersao: number;
  versaoPublicada: { id: string; numero: number; publicadoEm: string } | null; publicadoEm: string | null; despublicadoEm: string | null;
  atualizadoEm: string; pendencias: string[]; alteracoesNaoPublicadas: boolean;
};

type LinhaSite = {
  id: string; slug: string; estabelecimento_id: string | null; estado: EstadoSite; rascunho: unknown; rascunho_versao: number;
  versao_publicada_id: string | null; publicado_em: string | null; despublicado_em: string | null; atualizado_em: string;
  versao_numero: number | null; versao_publicada_em: string | null; versao_conteudo: unknown;
};

const SELECT_SITE = `SELECT s.id::text, s.slug, s.estabelecimento_id::text, s.estado, s.rascunho, s.rascunho_versao, s.versao_publicada_id::text,
    s.publicado_em::text, s.despublicado_em::text, s.atualizado_em::text, v.numero AS versao_numero, v.publicado_em::text AS versao_publicada_em,
    v.conteudo AS versao_conteudo
  FROM marketing_sites s LEFT JOIN marketing_site_versoes v ON v.id = s.versao_publicada_id AND v.site_id = s.id`;

/** Rascunho salvo que não passa mais no esquema (versão antiga) é recomposto com os padrões, sem perder o nome. */
function rascunhoSeguro(valor: unknown): ConteudoSite {
  const r = esquemaConteudoSite.safeParse(valor);
  if (r.success) return r.data;
  const nome = (valor as { identidade?: { nome?: unknown } } | null)?.identidade?.nome;
  return conteudoVazio(typeof nome === "string" ? nome : "Nosso buffet");
}

/** Impressão do rascunho: a versão publicada guarda a do rascunho que a originou (alterações pendentes = diferentes). */
export function impressaoRascunho(c: ConteudoSite) {
  return createHash("sha256").update(JSON.stringify(formaParaImpressao(c))).digest("hex");
}

function mapear(l: LinhaSite): SiteAdmin {
  const rascunho = rascunhoSeguro(l.rascunho);
  const publicadoDe = (l.versao_conteudo as { rascunhoHash?: unknown } | null)?.rascunhoHash ?? null;
  return {
    id: l.id, slug: l.slug, unidadeId: l.estabelecimento_id, estado: l.estado, rascunho, rascunhoVersao: l.rascunho_versao,
    versaoPublicada: l.versao_publicada_id && l.versao_numero !== null && l.versao_publicada_em
      ? { id: l.versao_publicada_id, numero: l.versao_numero, publicadoEm: l.versao_publicada_em } : null,
    publicadoEm: l.publicado_em, despublicadoEm: l.despublicado_em, atualizadoEm: l.atualizado_em, pendencias: pendenciasParaPublicar(rascunho),
    alteracoesNaoPublicadas: publicadoDe !== impressaoRascunho(rascunho),
  };
}

export async function siteDaUnidade(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  const r = await tx.query<LinhaSite>(
    `${SELECT_SITE} WHERE s.empresa_id = $1::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM $2::uuid`, [empresaId, unidadeId]);
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export async function siteDaEmpresa(tx: DbExecutor, empresaId: string, siteId: string, travar = false) {
  const r = await tx.query<LinhaSite>(`${SELECT_SITE} WHERE s.id = $1::uuid AND s.empresa_id = $2::uuid${travar ? " FOR UPDATE OF s" : ""}`, [siteId, empresaId]);
  if (!r.rows[0]) naoEncontrado("Site não encontrado nesta empresa.");
  return mapear(r.rows[0]);
}

export async function listarSites(tx: DbExecutor, empresaId: string) {
  const r = await tx.query<{ id: string; slug: string; estabelecimento_id: string | null; estado: EstadoSite }>(
    `SELECT id::text, slug, estabelecimento_id::text, estado FROM marketing_sites WHERE empresa_id = $1::uuid ORDER BY slug`, [empresaId]);
  return r.rows.map((l) => ({ id: l.id, slug: l.slug, unidadeId: l.estabelecimento_id, estado: l.estado }));
}

export async function versoesDoSite(tx: DbExecutor, empresaId: string, siteId: string) {
  const r = await tx.query<{ id: string; numero: number; publicado_em: string; nome: string | null }>(
    `SELECT v.id::text, v.numero, v.publicado_em::text, u.nome FROM marketing_site_versoes v LEFT JOIN usuarios_administrativos u ON u.id = v.publicado_por
      WHERE v.site_id = $1::uuid AND v.empresa_id = $2::uuid ORDER BY v.numero DESC LIMIT 20`, [siteId, empresaId]);
  return r.rows.map((l) => ({ id: l.id, numero: l.numero, publicadoEm: l.publicado_em, publicadoPor: l.nome }));
}

/** Pacotes vigentes que a empresa pode escolher divulgar (nome do catálogo; preço só na publicação). */
/** Pacotes vigentes para o editor (inclui os dados que a prévia imediata mostra antes de salvar). */
export async function pacotesDisponiveis(tx: DbExecutor, empresaId: string) {
  const lista: Array<{ codigo: string; nome: string; descricao: string | null; convidadosMinimos: number | null; convidadosMaximos: number | null; duracaoMinutos: number | null }> = [];
  for (const { codigo } of PACOTES_CONTRATAVEIS_V1) {
    const p = await buscarPacoteVigenteDaEmpresaPorCodigo(empresaId, codigo, tx).catch(() => null);
    if (p) lista.push({ codigo: p.codigo, nome: p.nome, descricao: p.descricao ?? null, convidadosMinimos: p.convidadosMinimos ?? null,
      convidadosMaximos: p.convidadosMaximos ?? null, duracaoMinutos: p.duracaoMinutos ?? null });
  }
  return lista;
}

/** Rascunho inicial a partir do cadastro APLICADO (nome comercial, endereço e contatos da unidade). Nada é publicado. */
export async function rascunhoInicial(tx: DbExecutor, empresaId: string): Promise<ConteudoSite> {
  const nome = (await nomePublicoDaEmpresa(tx, empresaId)) ?? "Nosso buffet";
  const base = conteudoVazio(nome);
  try {
    const perfil = await perfilDoTenantOuNulo(tx, empresaId);
    if (perfil) {
      const u = (await tx.query<{ logradouro: string | null; numero: string | null; bairro: string | null; cidade: string | null; uf: string | null; cep: string | null;
        referencia_chegada: string | null; telefone: string | null; whatsapp: string | null; email_comercial: string | null; instagram: string | null }>(
        `SELECT logradouro, numero, bairro, cidade, uf, cep, referencia_chegada, telefone, whatsapp, email_comercial, instagram
           FROM perfil_unidades WHERE empresa_id = $1::uuid ORDER BY id LIMIT 2`, [perfil])).rows;
      if (u.length === 1) {
        const l = u[0];
        const candidato = {
          ...base,
          localizacao: { ...base.localizacao, endereco: [l.logradouro, l.numero].filter(Boolean).join(", "), bairro: l.bairro ?? "", cidade: l.cidade ?? "",
            uf: l.uf ?? "", cep: l.cep ? `${l.cep.slice(0, 5)}-${l.cep.slice(5)}` : "", referencia: l.referencia_chegada ?? "" },
          contato: { ...base.contato, telefone: l.telefone ?? "", whatsapp: l.whatsapp ?? "", email: l.email_comercial ?? "", instagram: l.instagram ?? "" },
        };
        const ok = esquemaConteudoSite.safeParse(candidato);
        if (ok.success) return ok.data;
      }
    }
  } catch {
    // Perfil ausente/ambíguo: rascunho só com o nome. Nada de outra empresa.
  }
  return base;
}

export const esquemaAcaoSite = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("criar"), unidadeId: z.string().uuid().nullable().optional(), slug: z.string().trim().toLowerCase().regex(SLUG_SITE).optional() }).strict(),
  z.object({ acao: z.literal("salvar"), siteId: z.string().uuid(), rascunhoVersao: z.number().int().min(1), conteudo: z.unknown() }).strict(),
  z.object({ acao: z.literal("endereco"), siteId: z.string().uuid(), rascunhoVersao: z.number().int().min(1), slug: z.string().trim().toLowerCase().regex(SLUG_SITE) }).strict(),
  z.object({ acao: z.literal("publicar"), siteId: z.string().uuid(), rascunhoVersao: z.number().int().min(1) }).strict(),
  z.object({ acao: z.literal("despublicar"), siteId: z.string().uuid() }).strict(),
]);
export type AcaoSite = z.infer<typeof esquemaAcaoSite>;
export const ACOES_DE_PUBLICACAO = new Set(["publicar", "despublicar"]);

function slugEmUso(error: unknown) {
  return (error as { constraint?: string }).constraint === "marketing_sites_slug_uk";
}

export async function criarSite(tx: DbExecutor, empresaId: string, usuarioId: string, unidadeId: string | null, slugPedido?: string) {
  const unidade = await exigirUnidadeDaEmpresa(tx, empresaId, unidadeId);
  if (await siteDaUnidade(tx, empresaId, unidade)) throw new MarketingError("MARKETING_SITE_EXISTENTE", "Esta unidade já tem um site.", 409);
  const rascunho = await rascunhoInicial(tx, empresaId);
  const base = slugPedido ?? sugerirSlug(rascunho.identidade.nome);
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const slug = tentativa === 0 ? base : `${base.slice(0, 56)}-${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      await tx.query("SAVEPOINT marketing_site_slug");
      const r = await tx.query<{ id: string }>(
        `INSERT INTO marketing_sites (empresa_id, estabelecimento_id, slug, rascunho, criado_por, atualizado_por)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid, $5::uuid) RETURNING id::text`,
        [empresaId, unidade, slug, JSON.stringify(rascunho), usuarioId],
      );
      await tx.query("RELEASE SAVEPOINT marketing_site_slug");
      return siteDaEmpresa(tx, empresaId, r.rows[0].id);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT marketing_site_slug");
      if (!slugEmUso(error)) throw error;
      if (slugPedido) throw new MarketingError("MARKETING_ENDERECO_EM_USO", "Este endereço já está em uso. Escolha outro.", 409);
    }
  }
  throw new MarketingError("MARKETING_ENDERECO_EM_USO", "Não foi possível reservar um endereço. Escolha um manualmente.", 409);
}

export async function salvarRascunho(tx: DbExecutor, empresaId: string, usuarioId: string, siteId: string, rascunhoVersao: number, conteudo: unknown) {
  // Site de outra empresa: 404 antes de qualquer validação do conteúdo (nada é revelado sobre o site alheio).
  await siteDaEmpresa(tx, empresaId, siteId, true);
  const parsed = esquemaConteudoSite.safeParse(conteudo);
  if (!parsed.success) {
    const primeiro = parsed.error.issues[0];
    throw new MarketingError("MARKETING_CONTEUDO_INVALIDO", primeiro?.message && !/^Invalid|^Expected|^Unrecognized/.test(primeiro.message) ? primeiro.message : "Revise os campos do site.",
      400, { campo: primeiro?.path.join(".") ?? null });
  }
  const pacotes = parsed.data.pacotes.map((p) => p.codigo);
  if (new Set(pacotes).size !== pacotes.length) throw new MarketingError("MARKETING_CONTEUDO_INVALIDO", "Pacote repetido na lista.", 400);
  await exigirImagensDoSite(tx, empresaId, siteId, imagensReferenciadas(parsed.data));
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_sites SET rascunho = $3::jsonb, rascunho_versao = rascunho_versao + 1, atualizado_por = $4::uuid, atualizado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND rascunho_versao = $5 RETURNING id::text`,
    [siteId, empresaId, JSON.stringify(parsed.data), usuarioId, rascunhoVersao],
  );
  if (r.rows.length !== 1) { await siteDaEmpresa(tx, empresaId, siteId); conflito(); }
  return siteDaEmpresa(tx, empresaId, siteId);
}

/** Troca de endereço só antes da primeira publicação (links já divulgados não quebram). */
export async function alterarEndereco(tx: DbExecutor, empresaId: string, usuarioId: string, siteId: string, rascunhoVersao: number, slug: string) {
  const site = await siteDaEmpresa(tx, empresaId, siteId, true);
  if (site.versaoPublicada) throw new MarketingError("MARKETING_ENDERECO_FIXO", "O endereço não muda depois da primeira publicação (links divulgados quebrariam).", 409);
  if (site.rascunhoVersao !== rascunhoVersao) conflito();
  try {
    await tx.query("SAVEPOINT marketing_site_endereco");
    await tx.query(`UPDATE marketing_sites SET slug = $3, rascunho_versao = rascunho_versao + 1, atualizado_por = $4::uuid, atualizado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid`, [siteId, empresaId, slug, usuarioId]);
    await tx.query("RELEASE SAVEPOINT marketing_site_endereco");
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT marketing_site_endereco");
    if (slugEmUso(error)) throw new MarketingError("MARKETING_ENDERECO_EM_USO", "Este endereço já está em uso. Escolha outro.", 409);
    throw error;
  }
  return siteDaEmpresa(tx, empresaId, siteId);
}

function precoMinimoCentavos(linhas: Array<{ porConvidado: boolean; min: number; valor: number }>) {
  if (!linhas.length) return null;
  return Math.round(Math.min(...linhas.map((l) => (l.porConvidado ? l.valor * l.min : l.valor))) * 100);
}

/** Dados comerciais congelados na publicação: só pacotes vigentes da empresa; preço só se pedido e legível na tabela de hoje. */
export async function resolverPacotesPublicados(tx: DbExecutor, empresaId: string, rascunho: ConteudoSite) {
  const avisos: string[] = [];
  const precos = rascunho.pacotes.some((p) => p.mostrarPreco)
    ? await lerPrecosCorrentes(tx, empresaId).catch(() => ({ pacotes: [] as Array<{ pacoteId: string; porConvidado: boolean; min: number; valor: number }> }))
    : { pacotes: [] as Array<{ pacoteId: string; porConvidado: boolean; min: number; valor: number }> };
  const pacotes: PacotePublicado[] = [];
  for (const escolhido of rascunho.pacotes) {
    const p = await buscarPacoteVigenteDaEmpresaPorCodigo(empresaId, escolhido.codigo, tx).catch(() => null);
    if (!p) { avisos.push(`Pacote ${escolhido.codigo} não está vigente e ficou fora da publicação.`); continue; }
    const preco = escolhido.mostrarPreco ? precoMinimoCentavos(precos.pacotes.filter((l) => l.pacoteId === p.id)) : null;
    if (escolhido.mostrarPreco && preco === null) avisos.push(`Pacote ${p.nome} publicado sem preço: não há valor legível na tabela de hoje.`);
    pacotes.push({
      codigo: p.codigo, nome: p.nome, descricao: p.descricao ?? null, destaque: escolhido.destaque,
      convidadosMinimos: p.convidadosMinimos ?? null, convidadosMaximos: p.convidadosMaximos ?? null, duracaoMinutos: p.duracaoMinutos ?? null,
      precoAPartirCentavos: preco, imagemId: escolhido.imagemId ?? null,
    });
  }
  return { pacotes, avisos };
}

export async function publicarSite(tx: DbExecutor, empresaId: string, usuarioId: string, siteId: string, rascunhoVersao: number) {
  const site = await siteDaEmpresa(tx, empresaId, siteId, true);
  if (site.rascunhoVersao !== rascunhoVersao) conflito("O rascunho mudou desde que você abriu a tela. Revise a prévia antes de publicar.");
  if (site.pendencias.length > 0) throw new MarketingError("MARKETING_SITE_INCOMPLETO", site.pendencias.join(" "), 409, { pendencias: site.pendencias });
  await exigirImagensDoSite(tx, empresaId, siteId, imagensReferenciadas(site.rascunho));
  const { pacotes, avisos } = await resolverPacotesPublicados(tx, empresaId, site.rascunho);
  const numero = (site.versaoPublicada?.numero ?? 0) + 1;
  const ultima = await tx.query<{ n: number | null }>(`SELECT max(numero) AS n FROM marketing_site_versoes WHERE site_id = $1::uuid`, [siteId]);
  const proximo = Math.max(numero, (ultima.rows[0]?.n ?? 0) + 1);
  const conteudo: Omit<ConteudoPublicado, "publicadoEm"> = { ...site.rascunho, pacotes, versao: proximo, rascunhoHash: impressaoRascunho(site.rascunho) };
  const v = await tx.query<{ id: string; publicado_em: string }>(
    `INSERT INTO marketing_site_versoes (empresa_id, site_id, numero, conteudo, publicado_por)
     VALUES ($1::uuid, $2::uuid, $3, jsonb_set($4::jsonb, '{publicadoEm}', to_jsonb(clock_timestamp()::text)), $5::uuid) RETURNING id::text, publicado_em::text`,
    [empresaId, siteId, proximo, JSON.stringify(conteudo), usuarioId],
  );
  await tx.query(
    `UPDATE marketing_sites SET estado = 'PUBLICADO', versao_publicada_id = $3::uuid, publicado_em = clock_timestamp(), atualizado_por = $4::uuid, atualizado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid`, [siteId, empresaId, v.rows[0].id, usuarioId]);
  return { site: await siteDaEmpresa(tx, empresaId, siteId), avisos, versao: proximo };
}

export async function despublicarSite(tx: DbExecutor, empresaId: string, usuarioId: string, siteId: string) {
  const site = await siteDaEmpresa(tx, empresaId, siteId, true);
  if (site.estado !== "PUBLICADO") throw new MarketingError("MARKETING_SITE_NAO_PUBLICADO", "O site não está publicado.", 409);
  await tx.query(
    `UPDATE marketing_sites SET estado = 'DESPUBLICADO', despublicado_em = clock_timestamp(), atualizado_por = $3::uuid, atualizado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid`, [siteId, empresaId, usuarioId]);
  return siteDaEmpresa(tx, empresaId, siteId);
}

export { listarImagens };
