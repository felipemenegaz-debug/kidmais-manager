export function palavraNoPrompt(texto: string, inicio: number, fim = inicio) {
  if (fim > inicio) {
    const palavra = texto.slice(inicio, fim);
    return /^[\p{L}\p{M}]+(?:[-'][\p{L}\p{M}]+)*$/u.test(palavra) ? { palavra, inicio, fim } : null;
  }
  for (const trecho of texto.matchAll(/[\p{L}\p{M}]+(?:[-'][\p{L}\p{M}]+)*/gu)) {
    const posicao = trecho.index;
    if (inicio >= posicao && inicio <= posicao + trecho[0].length) return { palavra: trecho[0], inicio: posicao, fim: posicao + trecho[0].length };
  }
  return null;
}

export function substituirPalavra(texto: string, trecho: { palavra: string; inicio: number; fim: number }, sugestao: string) {
  // Não aplicar uma resposta atrasada a um texto que já foi editado.
  if (texto.slice(trecho.inicio, trecho.fim) !== trecho.palavra) return texto;
  const nova = trecho.palavra === trecho.palavra.toLocaleUpperCase('pt-BR') ? sugestao.toLocaleUpperCase('pt-BR')
    : /^\p{Lu}/u.test(trecho.palavra) ? sugestao[0].toLocaleUpperCase('pt-BR') + sugestao.slice(1) : sugestao;
  return texto.slice(0, trecho.inicio) + nova + texto.slice(trecho.fim);
}
