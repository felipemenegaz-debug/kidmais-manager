/**
 * Posição do menu fixo de ações (FestaAcessos, os três pontinhos). O menu é `position: fixed` para não ser recortado
 * pelo overflow da tabela; aqui ele fica DENTRO da janela nas quatro bordas, a partir do tamanho REAL medido:
 *   - horizontal: alinha a borda direita à do botão e limita esquerda e direita pela largura do menu;
 *   - vertical: abaixo do botão; sem espaço, acima; sem espaço nos dois, encosta na borda com rolagem interna;
 *   - largura e altura máximas = janela menos as margens (o menu nunca é maior que a janela).
 * Função pura: testada sem navegador (menu-posicao.test.ts).
 */
export const MARGEM_MENU = 8;
const DISTANCIA_BOTAO = 4;

export type AncoraMenu = { top: number; bottom: number; right: number };
export type Tamanho = { largura: number; altura: number };

export function limitesMenu(janela: Tamanho, margem = MARGEM_MENU) {
  return { maxLargura: Math.max(0, janela.largura - 2 * margem), maxAltura: Math.max(0, janela.altura - 2 * margem) };
}

export function posicaoMenu(ancora: AncoraMenu, menu: Tamanho, janela: Tamanho, margem = MARGEM_MENU) {
  const { maxLargura, maxAltura } = limitesMenu(janela, margem);
  const largura = Math.min(menu.largura, maxLargura), altura = Math.min(menu.altura, maxAltura);
  // `right` (distância até a borda direita da janela): alinhado ao botão, entre a margem e o limite que mantém a
  // borda esquerda do menu dentro da janela.
  const right = Math.min(Math.max(margem, janela.largura - ancora.right), janela.largura - margem - largura);
  const abaixo = ancora.bottom + DISTANCIA_BOTAO, acima = ancora.top - DISTANCIA_BOTAO - altura;
  const top = abaixo + altura <= janela.altura - margem ? abaixo
    : acima >= margem ? acima
      : Math.max(margem, Math.min(abaixo, janela.altura - margem - altura));
  return { top, right, maxLargura, maxAltura };
}
