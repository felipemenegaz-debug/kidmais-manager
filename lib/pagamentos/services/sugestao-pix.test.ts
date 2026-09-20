import test from 'node:test';
import assert from 'node:assert/strict';
import { sugerirParcelamentoPix as sugerir } from './sugestao-pix.ts';
import { calcularCondicaoComercial } from '../../comercial/condicao-pagamento.ts';
import { validarPlanoPagamento } from './financeiro-core.ts';

const datas = (s: ReturnType<typeof sugerir>) => s.plano.parcelas.map(p => p.vencimento);
const valores = (s: ReturnType<typeof sugerir>) => s.plano.parcelas.map(p => p.valor);
function reconciliar(s: ReturnType<typeof sugerir>) {
  assert.equal(s.plano.parcelas.reduce((sum, p) => sum + Math.round(p.valor * 100), 0), Math.round(s.valorFinal * 100));
  assert(s.plano.parcelas.every(p => p.valor > 0 && p.vencimento <= s.dataFesta));
  validarPlanoPagamento(s.valorFinal, s.plano, s.dataFesta);
}
test('3% aplicado no comercial; entrada é considerada uma única vez no total já descontado', () => {
  const comercial = calcularCondicaoComercial(10000, 'PIX_PARCELADO');
  const s = sugerir(comercial.valorFinalContrato, '2027-01-20', '2026-09-20', { entrada: 2000, valorParcela: 3000 });
  assert.equal(comercial.valorDescontoFormaPagamento, 300);
  assert.equal(s.valorFinal, 9700); assert.equal(s.saldoParcelado, 7700);
  assert.deepEqual(valores(s), [2000, 3000, 3000, 1700]);
  assert.deepEqual(datas(s), ['2026-09-20', '2026-10-20', '2026-11-20', '2026-12-20']);
  assert.equal(s.contraproposta, false); reconciliar(s);
});
test('sem entrada, primeira parcela um mês depois; última absorve diferença', () => {
  const s = sugerir(9700, '2027-01-20', '2026-09-20', { valorParcela: 3000 });
  assert.deepEqual(valores(s), [3000, 3000, 3000, 700]);
  assert.equal(datas(s)[0], '2026-10-20'); assert.equal(datas(s).at(-1), '2027-01-20'); reconciliar(s);
});
test('sem valor/quantidade usa máximo mensal; quantidade informada refere somente ao saldo', () => {
  const s = sugerir(9700, '2027-01-20', '2026-09-20', { entrada: 2000 });
  assert.equal(s.quantidadeParcelas, 4); assert.deepEqual(valores(s), [2000, 1925, 1925, 1925, 1925]); reconciliar(s);
  const q = sugerir(9700, '2027-01-20', '2026-09-20', { entrada: 2000, quantidadeParcelas: 3 });
  assert.deepEqual(valores(q), [2000, 2566.67, 2566.67, 2566.66]); reconciliar(q);
});
for (const pedido of [{ valorParcela: 100 }, { quantidadeParcelas: 99 }, { quantidadeParcelas: 3, valorParcela: 2000 }]) {
  test(`pretensão inviável devolve contraproposta, sem alterar silenciosamente o pedido: ${JSON.stringify(pedido)}`, () => {
    const s = sugerir(9700, '2026-12-20', '2026-09-20', { entrada: 2000, ...pedido });
    assert.equal(s.contraproposta, true); assert(s.motivo);
    assert.equal(s.quantidadeMaxima, 3); assert.equal(s.valorMinimoPorParcela, 2566.67);
    assert.equal(s.pedido?.parcelaCentavos, pedido.valorParcela === undefined ? null : pedido.valorParcela * 100);
    assert.deepEqual(valores(s), [2000, 2566.67, 2566.67, 2566.66]); reconciliar(s);
  });
}
test('valor e quantidade coerentes preservam valor pretendido e resto final', () => {
  const s = sugerir(9700, '2027-01-20', '2026-09-20', { entrada: 2000, valorParcela: 3000, quantidadeParcelas: 3 });
  assert.equal(s.contraproposta, false); assert.deepEqual(valores(s), [2000, 3000, 3000, 1700]);
});
for (const [referencia, festa, esperado] of [
  ['2027-01-31', '2027-04-30', ['2027-02-28', '2027-03-31', '2027-04-30']],
  ['2028-01-31', '2028-04-30', ['2028-02-29', '2028-03-31', '2028-04-30']],
  ['2027-01-30', '2027-04-30', ['2027-02-28', '2027-03-30', '2027-04-30']],
  ['2028-02-29', '2028-04-30', ['2028-03-29', '2028-04-29']],
  ['2026-12-31', '2027-02-28', ['2027-01-31', '2027-02-28']],
] as const) test(`dia de referência preservado em meses curtos: ${referencia}`, () => {
  const s = sugerir(100, festa, referencia); assert.deepEqual(datas(s), [...esperado]); reconciliar(s);
});
test('sábado/domingo/feriado não deslocam PIX', () => {
  assert.deepEqual(datas(sugerir(100, '2027-01-01', '2026-11-01')), ['2026-12-01', '2027-01-01']);
  assert.equal(datas(sugerir(100, '2027-02-28', '2027-01-31'))[0], '2027-02-28');
});
for (const festa of ['2027-02-27', '2027-02-28', '2027-03-01']) test(`limite inclusivo e Festa próxima: ${festa}`, () => {
  const s = sugerir(100, festa, '2027-01-31');
  assert.equal(datas(s)[0], festa === '2027-02-27' ? festa : '2027-02-28'); reconciliar(s);
});
test('Festa próxima permite apenas uma parcela de saldo na Festa, com ou sem entrada', () => {
  for (const entrada of [0, 20]) {
    const s = sugerir(100, '2027-01-20', '2027-01-10', { entrada, quantidadeParcelas: 2 });
    assert.equal(s.quantidadeMaxima, 1); assert.equal(s.contraproposta, true);
    assert.equal(datas(s).at(-1), '2027-01-20'); reconciliar(s);
  }
  reconciliar(sugerir(100, '2027-01-10', '2027-01-10'));
});
test('não adiciona parcela extra na Festa quando já há data mensal disponível', () => {
  const s = sugerir(100, '2027-03-15', '2027-01-10', { quantidadeParcelas: 3 });
  assert.equal(s.contraproposta, true); assert.deepEqual(datas(s), ['2027-02-10', '2027-03-10']);
});
test('limite existente de 60 lançamentos inclui entrada; saldo mínimo nunca gera zero', () => {
  const s = sugerir(100, '2099-01-01', '2027-01-10', { entrada: 10 });
  assert.equal(s.plano.parcelas.length, 60); assert.equal(s.quantidadeMaxima, 59); reconciliar(s);
  const pequeno = sugerir(0.02, '2099-01-01', '2027-01-10');
  assert.deepEqual(valores(pequeno), [0.01, 0.01]); reconciliar(pequeno);
});
test('entrada integral gera somente lançamento previsto, sem recebimento', () => {
  const s = sugerir(100, '2027-02-01', '2027-01-01', { entrada: 100 });
  assert.deepEqual(valores(s), [100]); assert.equal(s.saldoParcelado, 0); reconciliar(s);
});
test('rejeita Festa passada, entrada excessiva, valores inválidos e datas inválidas', () => {
  assert.throws(() => sugerir(100, '2026-01-01', '2027-01-01'), { code: 'SUGESTAO_PIX_INVALIDA' });
  for (const entrada of [101, -1, 0.001]) assert.throws(() => sugerir(100, '2027-02-01', '2027-01-01', { entrada }));
  assert.throws(() => sugerir(100, '2027-02-30', '2027-01-01'));
  assert.throws(() => sugerir(100, '2027-02-01', '2027-01-01', { valorParcela: 0 }));
});
test('validador final preserva PIX_APOS_DATA_FESTA mesmo se sugestão for adulterada', () => {
  const s = sugerir(100, '2027-02-01', '2027-01-01');
  s.plano.parcelas[0].vencimento = '2027-02-02';
  assert.throws(() => validarPlanoPagamento(100, s.plano, s.dataFesta), { code: 'PIX_APOS_DATA_FESTA' });
});
