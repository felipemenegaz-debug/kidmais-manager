/**
 * Apresentação das telas públicas de cotação/fechamento. Sem empresa informada = endereço atual (Kidmais, inalterado).
 * Endereço de outra empresa (/b/<código>): nome da empresa no cabeçalho e redação neutra (“o buffet”), sem logo,
 * contatos, capacidade ou processador de pagamento da Kidmais.
 */
import { REGRAS_LEGADAS, type RegrasPagamento } from "../comercial/regras-pagamento.ts";

/** Contatos do cadastro APLICADO da própria empresa, já conferidos para exibição; campo ausente = não exibido. */
export type ContatoPublico = {
  whatsapp: { texto: string; url: string } | null;
  telefone: { texto: string; url: string } | null;
  email: string | null;
  site: { texto: string; url: string } | null;
  instagram: { texto: string; url: string } | null;
};

export type MarcaPublica = { kidmais: true } | { kidmais: false; nome: string; pagamento: RegrasPagamento; contato?: ContatoPublico | null };

function digitosTelefone(valor: string | null | undefined) {
  const digitos = (valor ?? "").replace(/\D/g, "");
  const nacional = /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
  return /^\d{10,11}$/.test(nacional) ? nacional : null;
}

function telefoneTexto(nacional: string) {
  const meio = nacional.length === 11 ? 7 : 6;
  return `(${nacional.slice(0, 2)}) ${nacional.slice(2, meio)}-${nacional.slice(meio)}`;
}

function linkHttp(valor: string | null | undefined) {
  const texto = (valor ?? "").trim();
  if (!texto || texto.length > 200) return null;
  try {
    const url = new URL(texto);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Converte as colunas do cadastro (perfil_unidades) no que a tela pode exibir. Telefone/WhatsApp só com DDD
 * (10 ou 11 dígitos, com ou sem 55); site e Instagram só http(s) sem credenciais; e-mail com forma mínima.
 * Valor fora disso some — nunca é completado com dado de outra empresa. Nada válido = null.
 */
export function contatoPublicoDe(linha: { telefone?: string | null; whatsapp?: string | null; email?: string | null; site?: string | null; instagram?: string | null }): ContatoPublico | null {
  const whatsapp = digitosTelefone(linha.whatsapp);
  const telefone = digitosTelefone(linha.telefone);
  const email = (linha.email ?? "").trim();
  const site = linkHttp(linha.site);
  const instagram = linkHttp(linha.instagram);
  const perfilInstagram = instagram && /(^|\.)instagram\.com$/i.test(instagram.hostname)
    ? instagram.pathname.split("/").filter(Boolean)[0] ?? null
    : null;
  const contato: ContatoPublico = {
    whatsapp: whatsapp ? { texto: telefoneTexto(whatsapp), url: `https://wa.me/55${whatsapp}` } : null,
    telefone: telefone ? { texto: telefoneTexto(telefone), url: `tel:+55${telefone}` } : null,
    email: email.length <= 200 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : null,
    site: site ? { texto: `${site.hostname.replace(/^www\./i, "")}${site.pathname === "/" ? "" : site.pathname}`, url: site.href } : null,
    instagram: instagram ? { texto: perfilInstagram ? `@${perfilInstagram}` : "Instagram", url: instagram.href } : null,
  };
  return Object.values(contato).some(Boolean) ? contato : null;
}

export type TextosMarca = {
  kidmais: boolean;
  /** Nome exibido no cabeçalho. */
  nome: string;
  /** “a Kidmais” / “o buffet” (sujeito, minúsculo). */
  a: string;
  /** Início de frase: “A Kidmais” / “O buffet”. */
  A: string;
  /** “da Kidmais” / “do buffet”. */
  da: string;
  /** “pela Kidmais” / “pelo buffet”. */
  pela: string;
  /** “equipe Kidmais” / “equipe do buffet”. */
  equipe: string;
  /** Título curto: “Kidmais” / “O buffet”. */
  titulo: string;
  /** Aviso contratual em maiúsculas: “da KIDMAIS” / “do BUFFET”. */
  daMaiusculo: string;
  /** Regras de pagamento exibidas: Kidmais = legadas; outra empresa = as dela (servidor). */
  pagamento: RegrasPagamento;
  /** Contatos da própria empresa (outra empresa); null na Kidmais, cujas telas usam os contatos fixos atuais. */
  contato: ContatoPublico | null;
};

export const MARCA_KIDMAIS: MarcaPublica = { kidmais: true };

export function textosMarca(marca: MarcaPublica): TextosMarca {
  if (marca.kidmais)
    return { kidmais: true, nome: "Kidmais", a: "a Kidmais", A: "A Kidmais", da: "da Kidmais", pela: "pela Kidmais",
      equipe: "equipe Kidmais", titulo: "Kidmais", daMaiusculo: "da KIDMAIS", pagamento: REGRAS_LEGADAS, contato: null };
  const nome = marca.nome.trim() || "Buffet";
  return { kidmais: false, nome, a: "o buffet", A: "O buffet", da: "do buffet", pela: "pelo buffet",
    equipe: "equipe do buffet", titulo: "O buffet", daMaiusculo: "do BUFFET", pagamento: marca.pagamento, contato: marca.contato ?? null };
}

/** Rótulo do cartão PIX: “10% de desconto” ou, sem desconto configurado, “Sem desconto automático”. */
export function rotuloDescontoPix(percentual: number) {
  return percentual > 0 ? `${percentual}% de desconto` : "Sem desconto automático";
}

/** Frase das condições após aprovação. Kidmais: texto atual, idêntico. */
export function textoCondicoesPagamento(marca: TextosMarca) {
  const { pixAvistaPercentual: avista, pixParceladoPercentual: parcelado } = marca.pagamento;
  const descontos = avista > 0 || parcelado > 0
    ? `Após aprovação: PIX à vista tem ${avista}% de desconto. PIX parcelado tem ${parcelado}% de desconto; as condições são confirmadas pela ${marca.equipe}.`
    : `As condições de pagamento são confirmadas pela ${marca.equipe} após a aprovação.`;
  return marca.kidmais ? `${descontos} Cartão é processado pela Cielo.` : descontos;
}