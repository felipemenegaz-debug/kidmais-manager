import type { Interpretacao } from './perguntas.ts';
import { pareceAtencaoHoje, type AtencaoHoje, type RascunhoPublico, type RespostaLeitura, type ResultadoAtencao, type ResultadoConversa } from './cliente-inteligencia.ts';

/**
 * Histórico visual curto do drawer. Só em memória: some ao recarregar a página.
 * O estado que importa (rascunho sob Human Gate) fica no servidor; aqui só a última forma exibida.
 */
export const LIMITE_HISTORICO = 6;

export type Mensagem = { id: number; pergunta: string } & (
  | { fase: 'carregando' }
  | { fase: 'resposta'; dados: AtencaoHoje }
  | { fase: 'leitura'; dados: RespostaLeitura }
  | { fase: 'rascunho'; rascunho: RascunhoPublico; perguntaKidmais: string; decidindo?: boolean; erro?: string | null }
  | { fase: 'preview'; rascunho: RascunhoPublico; decidindo: boolean; erro: string | null }
  | { fase: 'resultado'; rascunho: RascunhoPublico; mensagem: string; destino?: string }
  | { fase: 'nao_suportado'; mensagem: string; sugestoes: string[] }
  | { fase: 'precisa_contexto'; mensagem: string }
  | { fase: 'indisponivel' }
  | { fase: 'erro'; mensagem: string }
);

export function adicionarPergunta(historico: readonly Mensagem[], id: number, pergunta: string, interpretacao: Interpretacao | { tipo: 'servidor' }): Mensagem[] {
  if (interpretacao.tipo === 'vazia') return [...historico];
  const nova: Mensagem = interpretacao.tipo === 'indisponivel'
    ? { id, pergunta, fase: 'indisponivel' }
    : { id, pergunta, fase: 'carregando' };
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

/** Converte a resposta do servidor na mensagem exibida. */
export function mensagemDaConversa(id: number, pergunta: string, resultado: ResultadoConversa): Mensagem {
  if (resultado.tipo === 'desativada') return { id, pergunta, fase: 'indisponivel' };
  if (resultado.tipo === 'erro') return { id, pergunta, fase: 'erro', mensagem: resultado.mensagem };
  const r = resultado.resposta;
  switch (r.tipo) {
    case 'resposta': return pareceAtencaoHoje(r.dados)
      ? { id, pergunta, fase: 'resposta', dados: r.dados }
      : { id, pergunta, fase: 'leitura', dados: r.dados };
    case 'rascunho': return { id, pergunta, fase: 'rascunho', rascunho: r.rascunho, perguntaKidmais: r.pergunta };
    case 'preview': return { id, pergunta, fase: 'preview', rascunho: r.rascunho, decidindo: false, erro: null };
    case 'resultado_acao': return { id, pergunta, fase: 'resultado', rascunho: r.rascunho, mensagem: r.mensagem, ...(r.destino ? { destino: r.destino } : {}) };
    case 'nao_suportado': return { id, pergunta, fase: 'nao_suportado', mensagem: r.mensagem, sugestoes: r.sugestoes };
    case 'precisa_contexto': return { id, pergunta, fase: 'precisa_contexto', mensagem: r.mensagem };
  }
}

export function registrarConversa(historico: readonly Mensagem[], id: number, resultado: ResultadoConversa): Mensagem[] {
  return historico.map((m) => (m.id === id && m.fase === 'carregando' ? mensagemDaConversa(id, m.pergunta, resultado) : m));
}

/** Rascunho ainda aberto (coletando ou aguardando o clique): a próxima frase responde a ele. */
export function rascunhoAberto(historico: readonly Mensagem[]): RascunhoPublico | null {
  const ultima = [...historico].reverse().find((m) => m.fase === 'rascunho' || m.fase === 'preview' || m.fase === 'resultado');
  if (!ultima || ultima.fase === 'resultado') return null;
  return ultima.rascunho;
}

/** Última mensagem (coleta OU preview) do rascunho: é ela que representa o estado atual da operação. */
function ultimaDoRascunho(historico: readonly Mensagem[], operacaoId: string) {
  for (let i = historico.length - 1; i >= 0; i -= 1) {
    const m = historico[i];
    if ((m.fase === 'preview' || m.fase === 'rascunho') && m.rascunho.operacaoId === operacaoId) return i;
  }
  return -1;
}

export function marcarDecisao(historico: readonly Mensagem[], operacaoId: string, decidindo: boolean, erro: string | null = null): Mensagem[] {
  const alvo = ultimaDoRascunho(historico, operacaoId);
  return historico.map((m, i) => (i === alvo && (m.fase === 'preview' || m.fase === 'rascunho') ? { ...m, decidindo, erro } : m));
}

/**
 * O resultado do clique substitui a mensagem ATUAL daquela operação — preview ou rascunho em coleta (C4).
 * Cancelado com sucesso ⇒ vira resultado: o rascunho deixa de estar aberto e a próxima frase não é
 * enviada a ele. Erro ⇒ o rascunho continua aberto, com a mensagem de erro.
 */
export function registrarDecisao(historico: readonly Mensagem[], operacaoId: string, resultado: ResultadoConversa): Mensagem[] {
  const alvo = ultimaDoRascunho(historico, operacaoId);
  return historico.map((m, i) => {
    if (i !== alvo || (m.fase !== 'preview' && m.fase !== 'rascunho')) return m;
    if (resultado.tipo !== 'ok') return { ...m, decidindo: false, erro: resultado.mensagem };
    return mensagemDaConversa(m.id, m.pergunta, resultado);
  });
}

export function aguardandoResposta(historico: readonly Mensagem[]) {
  return historico.some((mensagem) => mensagem.fase === 'carregando' || ((mensagem.fase === 'preview' || mensagem.fase === 'rascunho') && mensagem.decidindo === true));
}
