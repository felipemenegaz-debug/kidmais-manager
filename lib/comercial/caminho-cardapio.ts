import { enderecoPublicoAbsoluto, paginaInicialPublica } from '../fechamentos/rota-publica.ts';

/** Formato público em minúsculas do código aceito por criarCategoriaBuffet. */
export const CODIGO_CATEGORIA_PUBLICA = /^[a-z][a-z0-9_]{1,79}$/;

export function caminhoCardapioPublico(empresa: string, categoria?: string): string {
  return paginaInicialPublica(empresa) + sufixoCardapio(categoria);
}

function sufixoCardapio(categoria?: string) {
  return categoria ? '/cardapio/' + encodeURIComponent(categoria.toLowerCase()) : '/cardapio';
}

/** O endereço por empresa usa a origem do produto configurada no servidor. */
export function linkCardapioPublico(empresa: string, categoria?: string, origem = process.env.SITE_URL || process.env.ADMIN_AUTH_ORIGIN): string | null {
  const buffet = enderecoPublicoAbsoluto(origem, empresa);
  return buffet ? buffet + sufixoCardapio(categoria) : null;
}
