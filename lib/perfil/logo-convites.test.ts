import assert from 'node:assert/strict';
import test from 'node:test';
import { cadastroVazio, normalizarCadastro } from './cadastro.ts';
import { agruparComparacao, linhasAntesDepois } from './tela-cadastro.ts';

test('logo nos convites: ligado por padrão; só false desliga', () => {
  assert.equal(cadastroVazio().logoNosConvites, true);
  assert.equal(normalizarCadastro({}).logoNosConvites, true);
  assert.equal(normalizarCadastro({ logoNosConvites: false }).logoNosConvites, false);
});

test('a revisão mostra a mudança no grupo Marca e some quando não muda', () => {
  const ligado = cadastroVazio(), desligado = { ...cadastroVazio(), logoNosConvites: false };
  assert.deepEqual(linhasAntesDepois(ligado, desligado), [{ rotulo: 'Logo nos convites novos', antes: 'sim', depois: 'não' }]);
  assert.deepEqual(linhasAntesDepois(ligado, { ...cadastroVazio(), logoNosConvites: undefined }), []);
  assert.deepEqual(agruparComparacao(linhasAntesDepois(ligado, desligado)).map(g => g.titulo), ['Marca']);
});
