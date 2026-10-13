import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { modelosAcervo, sugestaoAcervo } from './acervo.ts';
import { svgModelo } from './modelos.ts';
import { conteudoSchema, inicioConteudo } from './domain.ts';

test('sugestão local aceita acentos e mantém fallback previsível', () => {
  assert.equal(sugestaoAcervo('Jardim de flores'), 'acervo_folhas');
  assert.equal(sugestaoAcervo('Espaço e galáxias'), 'acervo_estrelas');
  assert.equal(sugestaoAcervo('De volta para o futuro'), 'acervo_estrelas');
  assert.equal(sugestaoAcervo('Festa colorida'), 'acervo_baloes');
});
test('coleção monta moldura, ilustração e dados sem dependências externas', () => {
  for (const tema of modelosAcervo) {
    const c = conteudoSchema.parse({ ...inicioConteudo({}), tema, nome: 'Mariana', idade: '10 anos', data: '2026-10-10', horario: '15:00', local: 'Buffet de teste', endereco: 'Rua de teste', visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, posicao: 'topo' } });
    const svg = svgModelo(c, { arte: 'data:image/png;base64,AA==' });
    for (const dado of [c.nome, c.idade, c.local, c.endereco, c.horario]) assert(svg.includes(dado));
    assert(svg.includes('stroke-linejoin="round"'));
    assert(svg.includes('data:image/png'));
    assert(!/<(?:script|foreignObject)\b/.test(svg));
    assert(!/href="https?:/.test(svg));
    assert.equal((svg.match(/<image /g) ?? []).length, 1);
  }
});
test('arquivos importados correspondem aos checksums e possuem licença registrada', () => {
  const fontes = JSON.parse(readFileSync(new URL('./acervo/fontes.json', import.meta.url), 'utf8'));
  assert.equal(fontes.elementos.length, 3);
  for (const e of fontes.elementos) {
    const bytes = readFileSync(new URL(`./acervo/${e.id}.svg`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), e.sha256);
    assert.equal(e.licenca, 'MIT');
    assert(e.fonte.startsWith('https://github.com/tabler/tabler-icons/'));
  }
  assert(readFileSync(new URL('./acervo/LICENSE-Tabler.txt', import.meta.url), 'utf8').includes('MIT License'));
});
