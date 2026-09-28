import type { Interpretacao } from './perguntas.ts';
import type { AtencaoHoje, ResultadoAtencao } from './cliente-inteligencia.ts';

/** Histórico visual curto do drawer. Só em memória: some ao recarregar a página e nunca é enviado ao servidor. */
export const LIMITE_HISTORICO = 6;

export type Mensagem = { id: number; pergunta: string } & (
  | { fase: 'carregando' }
  | { fase: 'resposta'; dados: AtencaoHoje }
  | { fase: 'indisponivel' }
  | { fase: 'erro'; mensagem: string }
);

export function adicionarPergunta(historico: readonly Mensagem[], id: number, pergunta: string, interpretacao: Interpretacao): Mensagem[] {
  if (interpretacao.tipo === 'vazia') return [...historico];
  const nova: Mensagem = interpretacao.tipo === 'capacidade'
    ? { id, pergunta, fase: 'carregando' }
    : { id, pergunta, fase: 'indisponivel' };
  return [...historico, nova].slice(-LIMITE_HISTORICO);
}

export function registrarResultado(historico: readonly Mensagem[], id: number, resultado: ResultadoAtencao): Mensagem[] {
  return historico.map((mensagem): Mensagem => {
    if (mensagem.id !== id || mensagem.fase !== 'carregando') return mensagem;
    return resultado.tipo === 'resposta'
      ? { id, pergunta: mensagem.pergunta, fase: 'resposta', dados: resultado.dados }
      : { id, pergunta: mensagem.pergunta, fase: 'erro', mensagem: resultado.mensagem };
  });
}

export function aguardandoResposta(historico: readonly Mensagem[]) {
  return historico.some((mensagem) => mensagem.fase === 'carregando');
}
