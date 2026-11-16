/**
 * Faixa com a logo do buffet na imagem baixada do convite (etapa 2, 15/11/2026).
 *
 * A arte não muda: a faixa clara entra abaixo dela, com ~12% da altura da arte, e a logo fica centrada dentro de
 * uma caixa de 60% da altura da faixa por 40% da largura, sem distorcer. Fundo claro para a logo ficar legível
 * mesmo em arte escura. Sem logo (ou com medidas inválidas) não há faixa e a imagem sai como antes.
 */
export const FUNDO_FAIXA_LOGO = '#FFFFFF';
export const LINHA_FAIXA_LOGO = '#E7E3F0';

export type MedidasFaixaLogo = {
  alturaTotal: number; faixa: number;
  x: number; y: number; largura: number; altura: number;
};

export function medidasFaixaLogo(larguraArte: number, alturaArte: number, larguraLogo: number, alturaLogo: number): MedidasFaixaLogo | null {
  const validos = [larguraArte, alturaArte, larguraLogo, alturaLogo].every(n => Number.isFinite(n) && n > 0);
  if (!validos) return null;
  const faixa = Math.max(96, Math.round(alturaArte * 0.12));
  const caixaAltura = faixa * 0.6, caixaLargura = larguraArte * 0.4;
  const escala = Math.min(caixaAltura / alturaLogo, caixaLargura / larguraLogo);
  const largura = Math.max(1, Math.round(larguraLogo * escala)), altura = Math.max(1, Math.round(alturaLogo * escala));
  return {
    alturaTotal: alturaArte + faixa, faixa,
    x: Math.round((larguraArte - largura) / 2), y: alturaArte + Math.round((faixa - altura) / 2),
    largura, altura,
  };
}
