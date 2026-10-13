import type { Conteudo } from '@/lib/convites/domain';

// O modo pertence à arte gerada, não ao último controle de composição usado.
export function aplicarModoArteLocal(conteudo: Conteudo, arte: { completo?: boolean } | undefined, local: boolean): Conteudo {
  if (local && !conteudo.arteId && conteudo.visual?.modo === 'completa') return { ...conteudo, visual: { ...conteudo.visual, modo: 'modelo' } };
  if (!local || typeof arte?.completo !== 'boolean') return conteudo;
  if (arte.completo) return { ...conteudo, visual: { x: 50, y: 50, ...conteudo.visual, modo: 'completa', ajuste: 'conter', posicao: 'topo' } };
  if (conteudo.visual?.modo === 'completa') return { ...conteudo, visual: { ...conteudo.visual, modo: 'modelo' } };
  return conteudo;
}
