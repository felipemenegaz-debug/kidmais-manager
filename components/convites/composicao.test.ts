import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarComposicao, composicaoAtual, opcoesComposicao } from './composicao.ts';
import type { Conteudo } from '@/lib/convites/domain';

const base: Conteudo = { tema: 'celebrar', nome: 'Felipe', idade: '41 anos', data: '2027-03-03', horario: '17:00', local: 'Kidmais', endereco: 'Asa Norte', mensagem: '', arteId: '00000000-0000-4000-8000-000000000001', confirmarPresenca: true };

test('seletor aparece pela arte escolhida, não pelo modo; laboratório não oferece Convite pronto', () => {
  const comum = { temArte: true, comFoto: false, arteCompletaIA: false, laboratorio: false };
  assert.deepEqual(opcoesComposicao(comum), ['fundo', 'topo', 'pronto']);
  assert.deepEqual(opcoesComposicao({ ...comum, laboratorio: true }), ['fundo', 'topo']);
  assert.deepEqual(opcoesComposicao({ ...comum, arteCompletaIA: true }), []);
  assert.deepEqual(opcoesComposicao({ ...comum, temArte: false }), []);
  assert.deepEqual(opcoesComposicao({ ...comum, comFoto: true }), []);
});

test('estado marcado: fundo (padrão), topo e pronto são mutuamente exclusivos', () => {
  assert.equal(composicaoAtual(base), 'fundo');
  assert.equal(composicaoAtual({ ...base, visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, posicao: 'fundo' } }), 'fundo');
  assert.equal(composicaoAtual({ ...base, visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, posicao: 'topo' } }), 'topo');
  assert.equal(composicaoAtual({ ...base, visual: { modo: 'completa', ajuste: 'conter', x: 50, y: 50 } }), 'pronto');
});

test('ida e volta: pronto remove posição; voltar a fundo/topo grava modelo e preserva cores e enquadramento', () => {
  const cores = { fundo: '#101020', tinta: '#ffffff', destaque: '#aa00bb' };
  const topo: Conteudo = { ...base, visual: { modo: 'modelo', ajuste: 'conter', x: 20, y: 80, posicao: 'topo', cores } };
  const pronto = aplicarComposicao(topo, 'pronto');
  assert.deepEqual(pronto.visual, { modo: 'completa', ajuste: 'conter', x: 20, y: 80, cores });
  assert.equal(composicaoAtual(pronto), 'pronto');
  const fundo = aplicarComposicao(pronto, 'fundo');
  assert.deepEqual(fundo.visual, { modo: 'modelo', ajuste: 'conter', x: 20, y: 80, cores, posicao: 'fundo' });
  assert.equal(composicaoAtual(aplicarComposicao(pronto, 'topo')), 'topo');
  assert.equal(aplicarComposicao(base, 'fundo').visual?.modo, 'modelo');
  assert.equal(pronto.nome, base.nome); assert.equal(pronto.arteId, base.arteId);
});
