import { z } from "zod";

/**
 * Conteúdo do site público por unidade. Tudo é TEXTO PURO: a página renderiza com React (escapado), nunca como HTML;
 * cores só em #rrggbb; links só http(s) sem credenciais (Instagram e mapa). Imagens só por id de imagem do próprio site.
 * O rascunho guarda exatamente este formato; a publicação congela uma cópia + dados comerciais resolvidos no momento
 * (pacotes, preço "a partir de" aprovado) em marketing_site_versoes.
 */
const texto = (max: number) => z.string().trim().max(max).transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""));
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Cor no formato #RRGGBB.").transform((v) => v.toLowerCase());
const uuid = z.string().uuid();
const linkSeguro = z.string().trim().max(500).refine((v) => {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch { return false; }
}, "Use um endereço começando com https://.");

export const esquemaConteudoSite = z.object({
  identidade: z.object({
    nome: texto(80).pipe(z.string().min(2, "Informe o nome do buffet.")),
    slogan: texto(120).default(""),
    corPrimaria: hex.default("#6d4aff"),
    corSecundaria: hex.default("#14b8a6"),
    logoImagemId: uuid.nullable().default(null),
  }).strict(),
  apresentacao: z.object({ titulo: texto(120).default(""), texto: texto(2000).default("") }).strict(),
  galeria: z.array(z.object({ imagemId: uuid, legenda: texto(140).default("") }).strict()).max(12).default([]),
  estrutura: z.object({ capacidade: texto(80).default(""), itens: z.array(texto(80)).max(20).default([]) }).strict(),
  pacotes: z.array(z.object({ codigo: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/), destaque: texto(140).default(""), mostrarPreco: z.boolean().default(false) }).strict())
    .max(10).default([]),
  localizacao: z.object({
    mostrar: z.boolean().default(false),
    endereco: texto(200).default(""), bairro: texto(80).default(""), cidade: texto(80).default(""),
    uf: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/).default(""), cep: z.string().trim().regex(/^(\d{5}-?\d{3})?$/).default(""),
    referencia: texto(200).default(""), linkMapa: linkSeguro.default(""),
  }).strict(),
  contato: z.object({
    telefone: texto(20).default(""), whatsapp: texto(20).default(""), email: texto(254).default(""), instagram: linkSeguro.default(""),
    botaoWhatsapp: z.boolean().default(true),
  }).strict(),
  formulario: z.object({ ativo: z.boolean().default(true), mostrarDatasLivres: z.boolean().default(false) }).strict(),
  seo: z.object({ titulo: texto(70).default(""), descricao: texto(170).default(""), indexavel: z.boolean().default(true) }).strict(),
}).strict();
export type ConteudoSite = z.infer<typeof esquemaConteudoSite>;

export type PacotePublicado = {
  codigo: string; nome: string; descricao: string | null; destaque: string; convidadosMinimos: number | null; convidadosMaximos: number | null;
  duracaoMinutos: number | null; precoAPartirCentavos: number | null;
};

/** O que fica congelado na versão publicada. */
export type ConteudoPublicado = Omit<ConteudoSite, "pacotes"> & {
  pacotes: PacotePublicado[];
  versao: number;
  publicadoEm: string;
  /** Impressão do rascunho que originou esta versão (detecta alterações ainda não publicadas). */
  rascunhoHash: string;
};

export function conteudoVazio(nome: string): ConteudoSite {
  return esquemaConteudoSite.parse({
    identidade: { nome: nome.trim().length >= 2 ? nome.trim().slice(0, 80) : "Nosso buffet" }, apresentacao: {}, estrutura: {}, localizacao: {}, contato: {}, formulario: {}, seo: {},
  });
}

/** Imagens referenciadas pelo conteúdo (logo + galeria). A rota pública só serve imagem citada na versão publicada. */
export function imagensReferenciadas(conteudo: Pick<ConteudoSite, "identidade" | "galeria">): string[] {
  return [...new Set([conteudo.identidade.logoImagemId, ...conteudo.galeria.map((g) => g.imagemId)].filter((v): v is string => Boolean(v)))];
}

/** Pendências que impedem publicar (mensagens para a tela). */
export function pendenciasParaPublicar(c: ConteudoSite): string[] {
  const p: string[] = [];
  if (c.identidade.nome.trim().length < 2) p.push("Informe o nome do buffet.");
  if (!c.apresentacao.texto.trim()) p.push("Escreva a apresentação.");
  if (!c.seo.titulo.trim()) p.push("Preencha o título para buscadores (SEO).");
  if (!c.seo.descricao.trim()) p.push("Preencha a descrição para buscadores (SEO).");
  if (!c.formulario.ativo && !c.contato.telefone && !c.contato.whatsapp && !c.contato.email) p.push("Ative o formulário ou informe ao menos um contato.");
  return p;
}

export const SLUG_SITE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export function sugerirSlug(nome: string) {
  const base = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const comLetra = /^[a-z]/.test(base) ? base : `buffet-${base}`;
  const slug = comLetra.replace(/-+$/, "");
  return SLUG_SITE.test(slug) ? slug : "meu-buffet";
}
