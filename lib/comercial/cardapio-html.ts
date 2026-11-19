import type { ContatoPublico } from "../fechamentos/marca-publica.ts";
import type { CategoriaCardapio } from "./cardapio-publico.ts";

const descricao = "Estas são as opções do buffet. Quais e quantas entram na sua festa dependem do pacote escolhido.";
const entidades: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapar = (texto: string) => texto.replace(/[&<>"']/g, c => entidades[c]);

function documento(titulo: string, conteudo: string, status = 200, espera?: string | null) {
  const cabecalho = new Headers({
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  if (espera) cabecalho.set("Retry-After", espera);
  const seguro = escapar(titulo);
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${seguro}</title><meta property="og:title" content="${seguro}"><meta property="og:type" content="website"><link rel="icon" href="/icone-orcamento.svg"><link rel="stylesheet" href="/estilos/cardapio.css"></head><body><main>${conteudo}</main></body></html>`, { status, headers: cabecalho });
}
export function cardapioIndisponivel() {
  return documento("Cardápio indisponível", "<h1>Cardápio indisponível</h1>", 404);
}
export function cardapioLimitado(espera: string | null) {
  return documento("Tente novamente em instantes", "<h1>Tente novamente em instantes</h1>", 429, espera);
}

function contatosPublicos(contato: ContatoPublico | null) {
  if (!contato) return "";
  // Os destinos são montados/validados por contatoPublicoDe; valores publicados ainda precisam de escape de atributo.
  const links: string[] = [];
  function link(rotulo: string, campo: { texto: string; url: string } | null) {
    if (campo) links.push(`<li>${rotulo} <a href="${escapar(campo.url)}">${escapar(campo.texto)}</a></li>`);
  }
  link("WhatsApp", contato.whatsapp); link("Telefone", contato.telefone);
  if (contato.email) link("E-mail", { texto: contato.email, url: "mailto:" + contato.email });
  link("Instagram", contato.instagram); link("Site", contato.site);
  return links.length ? `<footer class="cartao-cardapio"><h2>Fale com o buffet</h2><ul>${links.join("")}</ul></footer>` : "";
}

export function renderizarCardapio(nome: string, contato: ContatoPublico | null, categorias: CategoriaCardapio[], codigo?: string) {
  const primeira = categorias.find(c => c.codigo === codigo);
  const ordenadas = primeira ? [primeira, ...categorias.filter(c => c !== primeira)] : categorias;
  const aviso = codigo && !primeira ? '<p role="status">Esta categoria está indisponível. Veja o cardápio completo abaixo.</p>' : "";
  const secoes = ordenadas.map(c => `<section class="cartao-cardapio"><h2>${escapar(c.nome)}</h2><ul>${c.itens.map(i => "<li>" + escapar(i) + "</li>").join("")}</ul></section>`);
  return documento(`${primeira?.nome ?? "Cardápio"} · ${nome}`,
    `<header><p>${escapar(nome)}</p><h1>Cardápio do buffet</h1><p>${descricao}</p></header>${aviso}` +
    (secoes.join("") || '<section class="cartao-cardapio"><h2>Cardápio em preparação</h2></section>') + contatosPublicos(contato));
}
