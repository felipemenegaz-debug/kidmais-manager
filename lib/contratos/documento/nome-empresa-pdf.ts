/**
 * Nome do buffet nos PDFs: o nome vem do cadastro, sem limite de largura e com qualquer caractere. As fontes são as padrão
 * (WinAnsi), e o gerador só escreve Latin-1: o que está fora vira equivalente ou sai do nome, em vez de "?". O corte é pela
 * largura real, não por caracteres.
 */
// Larguras AFM da Helvetica-Bold (32 a 126), em milésimos do corpo. Vale para as duas: a regular só é mais larga no "@", que
// usa aqui o valor dela (1015; 975 na negrito).
const LARGURAS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 1015, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const LARGURA_MAIOR = 1000;
const EQUIVALENTES: Record<string, string> = { "Œ": "OE", "œ": "oe", "Š": "S", "š": "s", "Ž": "Z", "ž": "z", "Ÿ": "Y", "€": "EUR", "™": "TM" };

export function limparNomePdf(nome: string) {
  return nome
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .replace(/[ŒœŠšŽžŸ€™]/g, (c) => EQUIVALENTES[c])
    .normalize("NFC")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function larguraDoCaractere(caractere: string) {
  const base = caractere.normalize("NFD").charCodeAt(0);
  return LARGURAS[base - 32] ?? LARGURA_MAIOR;
}

export function larguraTextoPdf(texto: string, tamanho: number) {
  return Array.from(texto).reduce((total, c) => total + larguraDoCaractere(c), 0) * tamanho / 1000;
}

/** Nome limpo que cabe em `largura` pontos, com "..." quando corta; null quando nada resta para mostrar. */
export function nomeNoEspacoPdf(nome: string, tamanho: number, largura: number) {
  const limpo = limparNomePdf(nome);
  if (!limpo) return null;
  if (larguraTextoPdf(limpo, tamanho) <= largura) return limpo;
  const letras = Array.from(limpo);
  while (letras.length && larguraTextoPdf(letras.join("") + "...", tamanho) > largura) letras.pop();
  const corte = letras.join("").trimEnd();
  return corte ? corte + "..." : null;
}
