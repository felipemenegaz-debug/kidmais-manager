import test from 'node:test';
import assert from 'node:assert/strict';
import { localizarEspaco, posicaoLivre } from './fundo-posicoes.ts';

test('elemento sai da área do painel sem colidir com conteúdo ou outro desenho', () => {
    const areas = [{ left: 300, top: 80, right: 700, bottom: 500 }];
    const usadas = [{ x: 120, y: 130, raio: 40 }];
    const p = localizarEspaco({ x: 450, y: 150, raio: 45 }, 1000, 800, areas, usadas);
    assert.ok(p);
    assert.ok(posicaoLivre(p, 1000, 800, areas, usadas));
    assert.ok(Math.hypot(p.x - usadas[0].x, p.y - usadas[0].y) >= 200);
});

test('conteúdo preenchendo a tela não força um símbolo por cima do texto', () => {
    assert.equal(localizarEspaco({ x: 100, y: 100, raio: 40 }, 390, 700,
        [{ left: 0, top: 0, right: 390, bottom: 700 }], []), null);
});

test('área vazia à direita do título permanece disponível; margem de flutuação é respeitada', () => {
    const titulo = [{ left: 20, top: 100, right: 330, bottom: 190 }];
    assert.equal(posicaoLivre({ x: 350, y: 150, raio: 40 }, 1000, 600, titulo, []), false);
    const preferida = { x: 700, y: 150, raio: 40 };
    assert.deepEqual(localizarEspaco(preferida, 1000, 600, titulo, []), preferida);
});
