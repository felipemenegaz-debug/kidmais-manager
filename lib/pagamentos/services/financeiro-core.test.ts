import assert from "node:assert/strict";
import test from "node:test";
import {
  statusPagamentoPorLiquido,
  statusParcelaPorLiquido,
  validarPlanoPagamento,
  dinheiroParaCentavos,
  saldoMonetario,
} from "./financeiro-core.ts";

test("plano exige soma exata e parcela inicial de reserva", () => {
  const plano = validarPlanoPagamento(1000, {
    meioPagamento: "PIX",
    modalidade: "PARCELADO",
    parcelas: [
      { valor: 250, vencimento: "2026-09-10", confirmaReserva: true },
      { valor: 750, vencimento: "2026-10-10" },
    ],
  });
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
    assert.throws(() => validarPlanoPagamento(10, { meioPagamento:'PIX', modalidade:'AVISTA', parcelas:[{valor:10,vencimento,confirmaReserva:true}] }), {code:'PLANO_PAGAMENTO_INVALIDO'});
  });
}

test('plano exige uma única parcela qualificadora na primeira posição', () => {
  for (const flags of [[false,false],[true,true],[false,true]]) {
    assert.throws(() => validarPlanoPagamento(20,{meioPagamento:'PIX',modalidade:'PARCELADO',parcelas:flags.map(confirmaReserva=>({valor:10,vencimento:'2028-02-29',confirmaReserva}))}), {code:'PLANO_PAGAMENTO_INVALIDO'});
  }
});

test('limites de quantidade e modalidade são respeitados', () => {
  for (const [modalidade,quantidade] of [['AVISTA',0],['AVISTA',2],['PARCELADO',1],['PARCELADO',61]] as const) {
    assert.throws(() => validarPlanoPagamento(Math.max(1,quantidade),{meioPagamento:'PIX',modalidade,parcelas:Array.from({length:quantidade},(_,i)=>({valor:1,vencimento:'2028-02-29',confirmaReserva:i===0}))}),{code:'PLANO_PAGAMENTO_INVALIDO'});
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
  }));
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
