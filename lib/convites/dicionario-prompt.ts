const normalizar = (palavra: string) => palavra.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '');
export function criarDicionario(conteudo: string) {
  const palavras = new Set<string>();
  const acentos = new Map<string, string[]>();
  const comprimentos = new Map<number, string[]>();
  for (const linha of conteudo.split(/\r?\n/).slice(1)) {
    const palavra = linha.split('/')[0].trim().toLocaleLowerCase('pt-BR');
    if (!/^[\p{L}\p{M}]+(?:[-'][\p{L}\p{M}]+)*$/u.test(palavra) || palavras.has(palavra)) continue;
    palavras.add(palavra);
    const chave = normalizar(palavra);
    const grupo = acentos.get(chave) ?? []; grupo.push(palavra); acentos.set(chave, grupo);
    const tamanho = comprimentos.get(chave.length) ?? []; tamanho.push(palavra); comprimentos.set(chave.length, tamanho);
  }
  return (entrada: string) => {
    const palavra = entrada.toLocaleLowerCase('pt-BR');
    const chave = normalizar(palavra);
    const exatas = acentos.get(chave);
    if (palavras.has(palavra)) return { correta: true, sugestoes: (exatas ?? []).filter(item => item !== palavra).slice(0, 5) };
    if (exatas) return { correta: false, sugestoes: exatas.slice(0, 5) };
    const candidatas: { palavra: string; distancia: number }[] = [];
    for (let tamanho = chave.length - 2; tamanho <= chave.length + 2; tamanho++) {
      for (const candidata of comprimentos.get(tamanho) ?? []) {
        const distancia = distanciaLimitada(chave, normalizar(candidata), 2);
        if (distancia <= 2) candidatas.push({ palavra: candidata, distancia });
      }
    }
    candidatas.sort((a, b) => a.distancia - b.distancia || a.palavra.localeCompare(b.palavra, 'pt-BR'));
    return { correta: false, sugestoes: candidatas.slice(0, 5).map(item => item.palavra) };
  };
}

function distanciaLimitada(a: string, b: string, limite: number) {
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  let anteanterior = anterior;
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(atual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) atual[j] = Math.min(atual[j], anteanterior[j - 2] + 1);
    }
    if (Math.min(...atual) > limite) return limite + 1;
    anteanterior = anterior; anterior = atual;
  }
  return anterior[b.length];
}
