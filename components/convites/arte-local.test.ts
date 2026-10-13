import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarModoArteLocal } from './arte-local.ts';
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

test('produção e imagens sem metadata preservam comportamento existente', () => {
  assert.equal(aplicarModoArteLocal(conteudo, { completo: true }, false), conteudo);
  assert.equal(aplicarModoArteLocal(conteudo, {}, true), conteudo);
  assert.equal(aplicarModoArteLocal(conteudo, undefined, true), conteudo);
});
