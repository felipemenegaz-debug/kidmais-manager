import assert from "node:assert/strict";
import test from "node:test";
import {
  statusPagamentoPorLiquido,
  statusParcelaPorLiquido,
  validarPlanoPagamento,
  dinheiroParaCentavos,
  saldoMonetario,
} from "./financeiro-core.ts";
import { calcularCondicaoComercial } from '../../comercial/condicao-pagamento.ts';
import { distribuirCentavos } from './alteracao-financeira-core.ts';

test("plano exige soma exata e parcela inicial de reserva", () => {
  const plano = validarPlanoPagamento(1000, {
    meioPagamento: "PIX",
    modalidade: "PARCELADO",
    parcelas: [
      { valor: 250, vencimento: "2026-09-10", confirmaReserva: true },
      { valor: 750, vencimento: "2026-10-10" },
    ],
  }, '2026-10-10');
  assert.equal(plano.quantidadeParcelas, 2);
  assert.equal(plano.parcelas[0].confirmaReserva, true);
});

for (const valor of [0, -1, NaN, Infinity, 0.001, 1.999, 1e-12, 1.0000000001, 0.0100000001, 10000000000, Number.MAX_VALUE]) {
  test(`rejeita valor monetário fora do domínio: ${valor}`, () => {
    assert.throws(() => dinheiroParaCentavos(valor), { code: 'PLANO_PAGAMENTO_INVALIDO' });
  });
}

test('centavos e saldo não expõem resíduos de ponto flutuante', () => {
  assert.equal(dinheiroParaCentavos(0.29),29);
  assert.equal(saldoMonetario(0.3,0.1),0.2);
  assert.equal(dinheiroParaCentavos(9999999999.99),999999999999);
});

for (const vencimento of ['2026-02-29','2026-04-31','0000-01-01','2026-13-01','2026-00-10','2026-01-00','10/09/2026']) {
  test(`rejeita vencimento inválido: ${vencimento}`, () => {
    assert.throws(() => validarPlanoPagamento(10, { meioPagamento:'PIX', modalidade:'AVISTA', parcelas:[{valor:10,vencimento,confirmaReserva:true}] }, '2028-02-29'), {code:'PLANO_PAGAMENTO_INVALIDO'});
  });
}

test('plano exige uma única parcela qualificadora na primeira posição', () => {
  for (const flags of [[false,false],[true,true],[false,true]]) {
    assert.throws(() => validarPlanoPagamento(20,{meioPagamento:'PIX',modalidade:'PARCELADO',parcelas:flags.map(confirmaReserva=>({valor:10,vencimento:'2028-02-29',confirmaReserva}))}, '2028-02-29'), {code:'PLANO_PAGAMENTO_INVALIDO'});
  }
});

test('limites de quantidade e modalidade são respeitados', () => {
  for (const [modalidade,quantidade] of [['AVISTA',0],['AVISTA',2],['PARCELADO',1],['PARCELADO',61]] as const) {
    assert.throws(() => validarPlanoPagamento(Math.max(1,quantidade),{meioPagamento:'PIX',modalidade,parcelas:Array.from({length:quantidade},(_,i)=>({valor:1,vencimento:'2028-02-29',confirmaReserva:i===0}))}, '2028-02-29'),{code:'PLANO_PAGAMENTO_INVALIDO'});
  }
});

test("plano rejeita soma diferente do contrato", () => {
  assert.throws(() => validarPlanoPagamento(1000, {
    meioPagamento: "PIX",
    modalidade: "PARCELADO",
    parcelas: [
      { valor: 250, vencimento: "2026-09-10", confirmaReserva: true },
      { valor: 700, vencimento: "2026-10-10" },
    ],
  }, '2026-10-10'));
});

for (const meioPagamento of ['PIX', 'CARTAO'] as const) {
  for (const vencimento of ['2027-06-14', '2027-06-15', '2027-06-16']) {
    test(`${meioPagamento}: limite inclusivo da Festa para ${vencimento}`, () => {
      const validar = () => validarPlanoPagamento(9700, { meioPagamento, modalidade: 'PARCELADO', parcelas: [
        { valor: 2000, vencimento: '2027-01-05', confirmaReserva: true },
        { valor: 7700, vencimento },
      ] }, '2027-06-15');
      if (vencimento <= '2027-06-15') assert.doesNotThrow(validar);
      else assert.throws(validar, { code: meioPagamento === 'PIX' ? 'PIX_APOS_DATA_FESTA' : 'PARCELA_APOS_DATA_FESTA', status: 422 });
    });
  }
}

test('PIX 3%, entrada e parcelas geradas reconciliam centavos; última após Festa recusa todo o plano', () => {
  const valores = calcularCondicaoComercial(10000, 'PIX_PARCELADO');
  assert.equal(valores.valorDescontoFormaPagamento, 300);
  assert.equal(valores.valorFinalContrato, 9700);
  const saldo = dinheiroParaCentavos(valores.valorFinalContrato) - dinheiroParaCentavos(2000);
  assert.equal(saldo, 770000);
  const distribuidas = distribuirCentavos(BigInt(saldo), 3);
  assert.deepEqual(distribuidas, [256667n, 256667n, 256666n]);
  const plano = { meioPagamento: 'PIX' as const, modalidade: 'PARCELADO' as const, parcelas: [
    { valor: 2000, vencimento: '2026-10-05', confirmaReserva: true },
    ...distribuidas.map((valor, i) => ({ valor: Number(valor) / 100, vencimento: ['2026-11-05', '2026-12-05', '2027-06-15'][i] })),
  ] };
  const validado = validarPlanoPagamento(valores.valorFinalContrato, plano, '2027-06-15');
  assert.equal(validado.parcelas.reduce((s, p) => s + dinheiroParaCentavos(p.valor), 0), 970000);
  plano.parcelas[3].vencimento = '2027-06-16';
  assert.throws(() => validarPlanoPagamento(9700, plano, '2027-06-15'), { code: 'PIX_APOS_DATA_FESTA' });
});

for (const dataFesta of ['', '2027-02-30', undefined]) test(`data contratual ausente/inválida não libera plano: ${dataFesta}`, () => {
  assert.throws(() => validarPlanoPagamento(10, { meioPagamento: 'PIX', modalidade: 'AVISTA', parcelas: [
    { valor: 10, vencimento: '2027-06-15', confirmaReserva: true },
  ] }, dataFesta as string), { code: 'DADOS_INVALIDOS' });
});

test("status financeiro considera estornos sem apagar o histórico", () => {
  assert.equal(statusPagamentoPorLiquido({
    valorTotalContratado: 1000,
    recebidoConfirmado: 250,
    estornadoConfirmado: 0,
  }), "PARCIALMENTE_PAGO");

  assert.equal(statusPagamentoPorLiquido({
    valorTotalContratado: 1000,
    recebidoConfirmado: 1000,
    estornadoConfirmado: 0,
  }), "QUITADO");

  assert.equal(statusPagamentoPorLiquido({
    valorTotalContratado: 1000,
    recebidoConfirmado: 250,
    estornadoConfirmado: 250,
  }), "ESTORNADO");
});

test("parcela parcialmente estornada volta a parcialmente paga", () => {
  assert.equal(statusParcelaPorLiquido({
    valorPrevisto: 500,
    recebidoConfirmado: 500,
    estornadoConfirmado: 100,
  }), "PARCIALMENTE_PAGA");
});
