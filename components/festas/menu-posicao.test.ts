import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MARGEM_MENU, posicaoMenu } from './menu-posicao.ts';

/** Bordas do menu na janela a partir do resultado (`right` é a distância até a borda direita). */
function bordas(r: { top: number; right: number }, menu: { largura: number; altura: number }, janela: { largura: number; altura: number }) {
  const largura = Math.min(menu.largura, janela.largura - 2 * MARGEM_MENU), altura = Math.min(menu.altura, janela.altura - 2 * MARGEM_MENU);
  const direita = janela.largura - r.right;
  return { esquerda: direita - largura, direita, topo: r.top, base: r.top + altura };
}
function dentro(b: ReturnType<typeof bordas>, janela: { largura: number; altura: number }) {
  assert.ok(b.esquerda >= MARGEM_MENU, `esquerda ${b.esquerda}`);
  assert.ok(b.direita <= janela.largura - MARGEM_MENU, `direita ${b.direita}`);
  assert.ok(b.topo >= MARGEM_MENU, `topo ${b.topo}`);
  assert.ok(b.base <= janela.altura - MARGEM_MENU, `base ${b.base}`);
}

test('R1 (reprodução do parecer): janela 320 px, âncora right=80 px, menu 240 px → o menu inteiro fica visível', () => {
  const janela = { largura: 320, altura: 600 }, menu = { largura: 240, altura: 140 };
  const r = posicaoMenu({ top: 200, bottom: 240, right: 80 }, menu, janela);
  const b = bordas(r, menu, janela);
  dentro(b, janela);
  assert.equal(b.esquerda, 8, 'encosta na margem esquerda em vez de sair da tela (antes: −160 px)');
});

test('caso comum: a borda direita do menu fica alinhada à do botão', () => {
  const janela = { largura: 1024, altura: 768 }, menu = { largura: 240, altura: 140 };
  const r = posicaoMenu({ top: 300, bottom: 340, right: 944 }, menu, janela);
  assert.equal(r.right, 80);
  assert.equal(r.top, 344, 'abre logo abaixo do botão');
  dentro(bordas(r, menu, janela), janela);
});

test('âncora colada na borda direita e em qualquer ponto da esquerda: as duas bordas horizontais ficam na janela', () => {
  const janela = { largura: 820, altura: 600 }, menu = { largura: 240, altura: 140 };
  for (const right of [0, 4, 30, 120, 239, 248, 400, 812, 820, 900])
    dentro(bordas(posicaoMenu({ top: 100, bottom: 140, right }, menu, janela), menu, janela), janela);
});

test('janela mais estreita que o menu: largura máxima = janela − margens', () => {
  const janela = { largura: 200, altura: 600 }, menu = { largura: 240, altura: 140 };
  const r = posicaoMenu({ top: 100, bottom: 140, right: 190 }, menu, janela);
  assert.equal(r.maxLargura, 184);
  dentro(bordas(r, menu, janela), janela);
});

test('sem espaço embaixo abre para cima; janela baixa: altura máxima e rolagem interna, sempre dentro da janela', () => {
  const menu = { largura: 240, altura: 145 };
  const alto = posicaoMenu({ top: 698, bottom: 738, right: 960 }, menu, { largura: 1024, altura: 768 });
  assert.equal(alto.top, 698 - 4 - 145, 'acima do botão');
  const baixa = { largura: 1024, altura: 150 };
  const r = posicaoMenu({ top: 60, bottom: 100, right: 960 }, menu, baixa);
  assert.equal(r.maxAltura, 134, 'o CSS rola por dentro (overflow-y: auto) com esta altura máxima');
  dentro(bordas(r, menu, baixa), baixa);
});

test('o componente mede o menu depois de aplicar os limites e usa a geometria testada; o CSS rola por dentro', () => {
  const ui = readFileSync('components/festas/FestaAcessos.tsx', 'utf8').replace(/\r\n/g, '\n');
  const efeito = ui.slice(ui.indexOf(' useLayoutEffect(()=>{'), ui.indexOf(' },[menuId,menuAncora]);'));
  assert.ok(efeito.indexOf("el.style.maxWidth=maxLargura+'px';") < efeito.indexOf('el.offsetWidth'), 'limites antes de medir');
  assert.ok(efeito.includes('posicaoMenu(menuAncora,{largura:el.offsetWidth,altura:el.offsetHeight},janela)'), 'largura e altura reais');
  const css = readFileSync('components/festas/acessos.module.css', 'utf8');
  assert.match(css, /\.menu\{position:fixed;[^}]*overflow-y:auto/);
  assert.match(css, /\.menu\{[^}]*min-width:min\(240px,calc\(100vw - 16px\)\)/, 'a largura mínima não passa da janela');
  // Validação no navegador: com z-index 30 o menu ficava sob a barra lateral do shell (40) ao sobrepô-la.
  assert.match(css, /\.menu\{position:fixed;z-index:44;/, 'acima da barra lateral (40), abaixo da cortina (45) e do menu móvel (50/60)');
});
