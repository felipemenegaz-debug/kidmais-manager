import { criarDicionario } from '@/lib/convites/dicionario-prompt';

let carregamento: Promise<ReturnType<typeof criarDicionario>> | undefined;
function carregar() {
  carregamento ??= (async () => {
    const resposta = await fetch('/dicionarios/pt-BR/index.dic');
    if (!resposta.ok) throw new Error('Dicionário indisponível');
    return criarDicionario(await resposta.text());
  })().catch(erro => { carregamento = undefined; throw erro; });
  return carregamento;
}

self.onmessage = async (evento: MessageEvent<{ id: number; palavra: string }>) => {
  const { id, palavra } = evento.data;
  try {
    const corretor = await carregar();
    self.postMessage({ id, ...corretor(palavra) });
  } catch {
    self.postMessage({ id, erro: 'Não foi possível carregar o corretor. Tente novamente.' });
  }
};
