/**
 * Configurações › Salões: aviso sobre a página pública "Conheça os salões" (S-D). Antes era um texto fixo dizendo que a
 * página não estava ligada; agora segue a flag SALOES_PUBLICOS do servidor. Não promete exibição: o painel lista os
 * salões da empresa inteira, mas o portão público exige agenda por salão e pelo menos 2 salões prontos NA MESMA unidade
 * (revisão do Astra, 28/10/2026) — o aviso só diz a regra.
 */
export const MINIMO_SALOES_PRONTOS = 2;

export function avisoPaginaPublica(paginaPublica: boolean) {
  if (!paginaPublica) return 'A página pública dos salões está desligada neste ambiente.';
  return `A página pública dos salões está ligada neste ambiente. Para aparecer ao cliente, é necessário ter agenda por salão e pelo menos ${MINIMO_SALOES_PRONTOS} salões prontos na mesma unidade.`;
}
