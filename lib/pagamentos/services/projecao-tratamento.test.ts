import test from 'node:test';
import assert from 'node:assert/strict';
import { projetarTratamento, serializarEscolhaCredito } from './projecao-tratamento.ts';

test('Etapa 2: V1 quitada 929000 e V3 836100 projetam crédito 92900, serializável sem alterar a posição atual', () => {
  const atual = Object.freeze({ obrigacao: '929000', liquido: '929000', credito: '0' });
  const p = projetarTratamento(atual.obrigacao, atual.liquido, '836100');
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { delta: '-92900', saldo: '0', credito: '92900', disponivel: '92900', opcoes: ['MANTER', 'SOLICITAR_DEVOLUCAO'] });
  assert.equal(atual.credito, '0');
  assert.throws(() => serializarEscolhaCredito('', p));
  assert.throws(() => serializarEscolhaCredito('NAO_SE_APLICA', p));
  assert.throws(() => serializarEscolhaCredito('APROVEITAR', p));
  assert.equal(serializarEscolhaCredito('MANTER', p), 'MANTER');
  assert.equal(serializarEscolhaCredito('SOLICITAR_DEVOLUCAO', p), 'MANTER');
});
test('Sem crédito projetado permite apenas não se aplica', () => {
  const p = projetarTratamento('929000', '500000', '836100');
  assert.equal(p.saldo, '336100'); assert.deepEqual(p.opcoes, ['NAO_SE_APLICA']);
  assert.throws(() => serializarEscolhaCredito('SOLICITAR_DEVOLUCAO', p));
});
test('Crédito reservado não oferece nova devolução e aumento sem crédito não exige autorização', () => {
  assert.deepEqual(projetarTratamento('929000', '929000', '836100', '92900').opcoes, ['MANTER']);
  const p = projetarTratamento('836100', '929000', '950000');
  assert.deepEqual(p.opcoes, ['NAO_SE_APLICA']); assert.equal(p.saldo, '21000');
  assert.equal(serializarEscolhaCredito('NAO_SE_APLICA', p), 'NAO_SE_APLICA');
});
test('V3 836100, líquido 879000 e V4 929000: absorção natural, saldo 50000 e crédito zero', () => {
  const p = projetarTratamento('836100', '879000', '929000');
  assert.deepEqual(p, { delta: '92900', saldo: '50000', credito: '0', disponivel: '0', opcoes: ['NAO_SE_APLICA'] });
  assert.equal(serializarEscolhaCredito('NAO_SE_APLICA', p), 'NAO_SE_APLICA');
});
