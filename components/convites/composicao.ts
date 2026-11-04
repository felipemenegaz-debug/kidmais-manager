import type { Conteudo } from '../../lib/convites/domain.ts';
import { visualPadrao } from '../../lib/convites/visual.ts';
import { comoCompleta } from './arte-local.ts';

// Composição da imagem própria. "pronto" grava visual.modo='completa' (já aceito pelo schema desde 09/10):
// a imagem aparece como está e os dados da festa ficam só na página do convite e no texto acessível.
export type Composicao = 'fundo' | 'topo' | 'pronto';
export const rotulosComposicao: Record<Composicao, string> = { fundo: 'Imagem como fundo', topo: 'Imagem no topo', pronto: 'Convite pronto' };

export function composicaoAtual(c: Conteudo): Composicao {
  if (c.visual?.modo === 'completa') return 'pronto';
  return c.visual?.posicao === 'topo' ? 'topo' : 'fundo';
}

export function aplicarComposicao(c: Conteudo, opcao: Composicao): Conteudo {
  if (opcao === 'pronto') return comoCompleta(c);
  return { ...c, visual: { ...visualPadrao, ...c.visual, modo: 'modelo', posicao: opcao } };
}

/**
 * O seletor depende da arte escolhida, não do modo: continua visível em "Convite pronto" para voltar a fundo/topo.
 * Convite completo gerado pela IA já traz os textos e segue sem seletor. Metadata ausente = imagem comum.
 * Laboratório local fica fora do "Convite pronto": lá o modo pertence à arte gerada.
 */
export function opcoesComposicao(p: { temArte: boolean; comFoto: boolean; arteCompletaIA: boolean; laboratorio: boolean }): Composicao[] {
  if (!p.temArte || p.comFoto || p.arteCompletaIA) return [];
  return p.laboratorio ? ['fundo', 'topo'] : ['fundo', 'topo', 'pronto'];
}
