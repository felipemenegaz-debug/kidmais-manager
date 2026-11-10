import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarModoArteLocal, selecionarArte, semArte } from './arte-local.ts';
import type { Conteudo } from '@/lib/convites/domain';

const conteudo: Conteudo = { tema: 'arco', nome: 'Mariana', idade: '10 anos', data: '2026-10-10', horario: '17:00', local: 'KidMais', endereco: 'Asa Norte', mensagem: 'Venha!', arteId: '00000000-0000-4000-8000-000000000001', confirmarPresenca: true };

test('arte completa da galeria corrige composição antiga e mantém os dados ao carregar/salvar', () => {
  const corrigido = aplicarModoArteLocal(conteudo, { completo: true }, true);
  assert.equal(corrigido.visual?.modo, 'completa');
  assert.equal(corrigido.visual?.ajuste, 'conter');
  assert.equal(corrigido.nome, conteudo.nome);
  assert.deepEqual(aplicarModoArteLocal(JSON.parse(JSON.stringify(corrigido)), { completo: true }, true), corrigido);
  assert.equal(conteudo.visual, undefined);
});

test('trocar para ilustração restaura composição; arte completa ignora controle anterior de modelo', () => {
  const completa = aplicarModoArteLocal(conteudo, { completo: true }, true);
  assert.equal(aplicarModoArteLocal(completa, { completo: false }, true).visual?.modo, 'modelo');
  assert.equal(aplicarModoArteLocal({ ...completa, arteId: null }, undefined, true).visual?.modo, 'modelo');
  assert.equal(aplicarModoArteLocal({ ...completa, visual: { ...completa.visual!, modo: 'modelo' } }, { completo: true }, true).visual?.modo, 'completa');
});

test('imagens sem metadata preservam comportamento existente no laboratório', () => {
  assert.equal(aplicarModoArteLocal(conteudo, {}, true), conteudo);
  assert.equal(aplicarModoArteLocal(conteudo, undefined, true), conteudo);
});

test('produto: convite completo abre em "completa"; "Arte completa" antiga nunca é rebaixada ao carregar', () => {
  assert.equal(aplicarModoArteLocal(conteudo, { completo: true }, false).visual?.modo, 'completa');
  assert.equal(aplicarModoArteLocal(conteudo, { completo: true }, false).visual?.posicao, undefined);
  const legado: Conteudo = { ...conteudo, visual: { modo: 'completa', ajuste: 'preencher', x: 30, y: 70 } };
  for (const arte of [{ completo: false }, {}, undefined]) assert.equal(aplicarModoArteLocal(legado, arte, false), legado);
  assert.equal(aplicarModoArteLocal(conteudo, { completo: false }, false), conteudo);
});

test('produto: escolher uma arte define o modo pela arte escolhida', () => {
  const legado: Conteudo = { ...conteudo, visual: { modo: 'completa', ajuste: 'preencher', x: 30, y: 70 } };
  const comum = selecionarArte(legado, '00000000-0000-4000-8000-000000000002', false);
  assert.equal(comum.arteId, '00000000-0000-4000-8000-000000000002'); assert.equal(comum.visual?.modo, 'modelo');
  const completo = selecionarArte(conteudo, '00000000-0000-4000-8000-000000000003', true);
  assert.equal(completo.visual?.modo, 'completa'); assert.equal(completo.visual?.ajuste, 'conter');
  assert.equal(selecionarArte(conteudo, conteudo.arteId!, false).visual, undefined);
});

test('convite pronto: reclicar a mesma imagem comum preserva todo o visual; trocar de imagem segue a regra da arte', () => {
  const pronto: Conteudo = { ...conteudo, visual: { modo: 'completa', ajuste: 'conter', x: 20, y: 80, cores: { fundo: '#101020', tinta: '#ffffff', destaque: '#aa00bb' } } };
  assert.equal(selecionarArte(pronto, conteudo.arteId!, false), pronto);
  const topo: Conteudo = { ...conteudo, visual: { modo: 'modelo', ajuste: 'preencher', x: 10, y: 90, posicao: 'topo' } };
  assert.equal(selecionarArte(topo, conteudo.arteId!, false), topo);
  const outra = selecionarArte(pronto, '00000000-0000-4000-8000-000000000002', false);
  assert.equal(outra.visual?.modo, 'modelo'); assert.equal(outra.visual?.x, 20);
  const ia = selecionarArte(topo, '00000000-0000-4000-8000-000000000003', true);
  assert.equal(ia.visual?.modo, 'completa'); assert.equal(ia.visual?.posicao, undefined);
  // Reclicar a arte completa da IA continua em "completa".
  assert.equal(selecionarArte(ia, '00000000-0000-4000-8000-000000000003', true).visual?.modo, 'completa');
});

test('convite pronto: sem imagem volta à composição (remover, excluir, rascunho antigo), preservando o resto', () => {
  const pronto: Conteudo = { ...conteudo, visual: { modo: 'completa', ajuste: 'preencher', x: 30, y: 70 } };
  const removido = semArte(pronto);
  assert.equal(removido.arteId, null); assert.deepEqual(removido.visual, { ...pronto.visual, modo: 'modelo' }); assert.equal(removido.nome, conteudo.nome);
  assert.equal(semArte(conteudo).visual, undefined);
  const topo: Conteudo = { ...conteudo, visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, posicao: 'topo' } };
  assert.deepEqual(semArte(topo).visual, topo.visual);
  // Production ao carregar: rascunho antigo "completa" sem arte é normalizado; com arte, nunca rebaixado.
  for (const arte of [{ completo: false }, {}, undefined]) {
    assert.equal(aplicarModoArteLocal({ ...pronto, arteId: null }, arte, false).visual?.modo, 'modelo');
    assert.equal(aplicarModoArteLocal(pronto, arte, false), pronto);
  }
  assert.equal(aplicarModoArteLocal({ ...conteudo, arteId: null }, undefined, false).visual, undefined);
});

test('laboratório: escolha "completa" de imagem comum continua sendo rebaixada (fora do Convite pronto)', () => {
  const pronto: Conteudo = { ...conteudo, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 } };
  assert.equal(aplicarModoArteLocal(pronto, { completo: false }, true).visual?.modo, 'modelo');
});
