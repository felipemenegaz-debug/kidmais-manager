import test from 'node:test';
import assert from 'node:assert/strict';
import { criarAcaoContaPagar, extrairContaPagar } from './conta-pagar.ts';
import { pedeContaPagar } from '../operacional/objetivo.ts';
import { ErroCampo } from './human-gate.ts';
const acao = criarAcaoContaPagar({ categorias: async () => [], criar: async () => { throw new Error('não executar na revisão'); } });
const completo = { descricao: 'ChatGPT Pro', valorCentavos: 55000, vencimento: '2026-10-10', diaMensal: 10, recorrente: true, categoria: 'Outros' };

test('frase original preserva valor, dia e mensalidade sem inventar o primeiro mês', () => {
  const frase = 'adicione conta a pagar todos mes dia 10 do Chat-gpt pro 550 rais.';
  assert(pedeContaPagar(frase));
  assert.deepEqual(extrairContaPagar(frase, null), { descricao: 'Chat-gpt pro', valorCentavos: 55000, diaMensal: 10, recorrente: true });
  assert.deepEqual(acao.faltando(extrairContaPagar(frase, null)), ['vencimento', 'categoria']);
  assert.equal(extrairContaPagar('todos os meses', 'vencimento').recorrente, true);
  assert.deepEqual(extrairContaPagar('sim', 'vencimento'), {});
  assert(!pedeContaPagar('não adicione conta a pagar'));
});

test('validação rejeita dia impossível, dia mensal divergente e valor negativo', () => {
  assert.throws(() => acao.validar({ ...completo, vencimento: '2026-02-30' }), ErroCampo);
  assert.throws(() => acao.validar({ ...completo, vencimento: '2026-10-11' }), ErroCampo);
  const negativo = extrairContaPagar('valor -550 reais', 'valorCentavos');
  assert.equal(negativo.valorCentavos, -55000);
  assert.throws(() => acao.validar({ ...completo, ...negativo }), ErroCampo);
  assert.equal(acao.validar(completo).valorCentavos, 55000);
});
