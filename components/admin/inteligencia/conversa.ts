import type { Interpretacao } from './perguntas.ts';
import {
  CODIGO_CANCELADA, pareceAtencaoHoje, type AtencaoHoje, type ComplementoCopiloto, type RascunhoPublico, type RespostaLeitura, type ResultadoAtencao,
  type ResultadoConversa, type SecaoAgente, type SugestaoAgente,
} from './cliente-inteligencia.ts';

/**
 * Histórico visual curto do drawer. Só em memória: some ao recarregar a página.
 * O estado que importa (rascunho sob Human Gate) fica no servidor; aqui só a última forma exibida.
 */
export const LIMITE_HISTORICO = 6;

export type Mensagem = { id: number; pergunta: string } & (
  | { fase: 'carregando' }
  | { fase: 'resposta'; dados: AtencaoHoje; complemento?: ComplementoCopiloto | null }
  | { fase: 'leitura'; dados: RespostaLeitura; complemento?: ComplementoCopiloto | null }
  | { fase: 'agente'; agente: { id: string; nome: string }; resumo: string; secoes: SecaoAgente[]; sugestao: SugestaoAgente | null }
  | { fase: 'rascunho'; rascunho: RascunhoPublico; perguntaKidmais: string; decidindo?: boolean; erro?: string | null }
  | { fase: 'preview'; rascunho: RascunhoPublico; decidindo: boolean; erro: string | null }
  | { fase: 'resultado'; rascunho: RascunhoPublico; mensagem: string; destino?: string }
  | { fase: 'nao_suportado'; mensagem: string; sugestoes: string[] }
  | { fase: 'precisa_contexto'; mensagem: string }
  | { fase: 'indisponivel' }
  /** `reenviavel`: perguntar de novo é seguro (leitura ou pergunta nova; nunca resposta a rascunho nem confirmação). */
  | { fase: 'erro'; mensagem: string; reenviavel: boolean }
  | { fase: 'cancelada' }
);

/**
 * Categoria que a UI mostra em cada resposta, sempre com texto (não só cor):
 * INFORMAÇÃO (dado do sistema), SUGESTÃO (rascunho de texto, orientação, próxima ação — nada é enviado),
 * CONFIRMAÇÃO (ação que só acontece com o clique humano) e ERRO.
 */
export type Categoria = 'informacao' | 'sugestao' | 'confirmacao' | 'erro';

export function categoriaDa(m: Mensagem): Categoria | null {
  switch (m.fase) {
    case 'resposta':
    case 'leitura':
    case 'nao_suportado':
    case 'precisa_contexto':
    case 'indisponivel':
    case 'resultado':
      return 'informacao';
    case 'agente': return m.sugestao ? 'sugestao' : 'informacao';
    case 'rascunho':
    case 'preview':
      return 'confirmacao';
    case 'erro': return 'erro';
    default: return null;
  }
}

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
      : { id, pergunta: mensagem.pergunta, fase: 'erro', mensagem: resultado.mensagem, reenviavel: true };
  });
}

/** Converte a resposta do servidor na mensagem exibida. `reenviavel` diz se um erro pode ser repetido com segurança. */
export function mensagemDaConversa(id: number, pergunta: string, resultado: ResultadoConversa, reenviavel = true): Mensagem {
  if (resultado.tipo === 'desativada') return { id, pergunta, fase: 'indisponivel' };
  if (resultado.tipo === 'erro') {
    return resultado.codigo === CODIGO_CANCELADA ? { id, pergunta, fase: 'cancelada' } : { id, pergunta, fase: 'erro', mensagem: resultado.mensagem, reenviavel };
  }
  const r = resultado.resposta;
  switch (r.tipo) {
    case 'resposta': return pareceAtencaoHoje(r.dados)
      ? { id, pergunta, fase: 'resposta', dados: r.dados, complemento: r.complemento ?? null }
      : { id, pergunta, fase: 'leitura', dados: r.dados, complemento: r.complemento ?? null };
    case 'agente': return { id, pergunta, fase: 'agente', agente: r.agente, resumo: r.resumo, secoes: r.secoes, sugestao: r.sugestao };
    case 'rascunho': return { id, pergunta, fase: 'rascunho', rascunho: r.rascunho, perguntaKidmais: r.pergunta };
    case 'preview': return { id, pergunta, fase: 'preview', rascunho: r.rascunho, decidindo: false, erro: null };
    case 'resultado_acao': return { id, pergunta, fase: 'resultado', rascunho: r.rascunho, mensagem: r.mensagem, ...(r.destino ? { destino: r.destino } : {}) };
    case 'nao_suportado': return { id, pergunta, fase: 'nao_suportado', mensagem: r.mensagem, sugestoes: r.sugestoes };
    case 'precisa_contexto': return { id, pergunta, fase: 'precisa_contexto', mensagem: r.mensagem };
  }
}

export function registrarConversa(historico: readonly Mensagem[], id: number, resultado: ResultadoConversa, reenviavel = true): Mensagem[] {
  return historico.map((m) => (m.id === id && m.fase === 'carregando' ? mensagemDaConversa(id, m.pergunta, resultado, reenviavel) : m));
}

/** Cancelamento local da espera: a mensagem em curso vira "cancelada" (o servidor não altera nada numa leitura). */
export function cancelarEspera(historico: readonly Mensagem[], id: number): Mensagem[] {
  return historico.map((m): Mensagem => (m.id === id && m.fase === 'carregando' ? { id, pergunta: m.pergunta, fase: 'cancelada' } : m));
}

/** Pergunta que pode ser repetida com segurança a partir de um erro (ou null). */
export function perguntaReenviavel(historico: readonly Mensagem[], id: number): string | null {
  const m = historico.find((x) => x.id === id);
  return m && m.fase === 'erro' && m.reenviavel ? m.pergunta : null;
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
 * enviada a ele. Erro ⇒ o rascunho continua aberto, com a mensagem de erro (o botão do preview é a
 * repetição segura: o servidor é idempotente por versão + hash).
 */
export function registrarDecisao(historico: readonly Mensagem[], operacaoId: string, resultado: ResultadoConversa): Mensagem[] {
  const alvo = ultimaDoRascunho(historico, operacaoId);
  return historico.map((m, i) => {
    if (i !== alvo || (m.fase !== 'preview' && m.fase !== 'rascunho')) return m;
    if (resultado.tipo !== 'ok') return { ...m, decidindo: false, erro: resultado.mensagem };
    return mensagemDaConversa(m.id, m.pergunta, resultado, false);
  });
}

export function aguardandoResposta(historico: readonly Mensagem[]) {
  return historico.some((mensagem) => mensagem.fase === 'carregando' || ((mensagem.fase === 'preview' || mensagem.fase === 'rascunho') && mensagem.decidindo === true));
}

/** Id da pergunta em curso (a única que pode ser cancelada). */
export function perguntaEmCurso(historico: readonly Mensagem[]): number | null {
  return historico.find((m) => m.fase === 'carregando')?.id ?? null;
}
