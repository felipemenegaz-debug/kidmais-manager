import type { Conteudo } from '@/lib/convites/domain';

// O modo pertence à arte gerada, não ao último controle de composição usado.
// Produto: ao carregar, só promove convites completos (textos na arte) e nunca rebaixa um modo salvo;
// convites antigos com "Arte completa" (botão anterior) continuam como foram publicados.
export function aplicarModoArteLocal(conteudo: Conteudo, arte: { completo?: boolean } | undefined, local: boolean): Conteudo {
  // Convite pronto sem imagem (removida/excluída, inclusive rascunhos antigos) volta à composição: nada a exibir sozinho.
  if (!local) return arte?.completo === true ? comoCompleta(conteudo) : semArteSemCompleta(conteudo);
  if (!conteudo.arteId && conteudo.visual?.modo === 'completa') return { ...conteudo, visual: { ...conteudo.visual, modo: 'modelo' } };
  if (typeof arte?.completo !== 'boolean') return conteudo;
  if (arte.completo) return comoCompleta(conteudo);
  if (conteudo.visual?.modo === 'completa') return { ...conteudo, visual: { ...conteudo.visual, modo: 'modelo' } };
  return conteudo;
}

// Escolha explícita de uma arte (galeria, envio ou geração): o modo segue a arte escolhida.
export function selecionarArte(conteudo: Conteudo, arteId: string, completo: boolean): Conteudo {
  // Reclicar a imagem já escolhida não desfaz a composição escolhida (ex.: "Convite pronto" de imagem enviada).
  if (!completo && conteudo.arteId === arteId) return conteudo;
  const escolhido = { ...conteudo, arteId };
  if (completo) return comoCompleta(escolhido);
  return escolhido.visual?.modo === 'completa' ? { ...escolhido, visual: { ...escolhido.visual, modo: 'modelo' } } : escolhido;
}

/** Sem imagem não há "Convite pronto": remover/excluir a arte devolve a composição com os dados da festa. */
export function semArte(conteudo: Conteudo): Conteudo {
  return semArteSemCompleta({ ...conteudo, arteId: null });
}

function semArteSemCompleta(conteudo: Conteudo): Conteudo {
  return !conteudo.arteId && conteudo.visual?.modo === 'completa' ? { ...conteudo, visual: { ...conteudo.visual, modo: 'modelo' } } : conteudo;
}

/** "Convite pronto": a imagem é exibida como está, sem os textos do editor por cima. */
export function comoCompleta(conteudo: Conteudo): Conteudo {
  // Sem "posicao": irrelevante para a arte completa e mantém o rascunho legível por versões anteriores.
  const { posicao: _posicao, ...visual } = { x: 50, y: 50, ...conteudo.visual };
  void _posicao;
  return { ...conteudo, visual: { ...visual, modo: 'completa', ajuste: 'conter' } };
}
