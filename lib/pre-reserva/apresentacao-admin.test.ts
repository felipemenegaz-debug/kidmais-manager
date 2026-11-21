import assert from 'node:assert/strict';
import test from 'node:test';
import { corpoBaixa, corpoConfiguracao, corpoSinal, formatarInstanteSP, instanteComOffsetSP, rotuloDestino, rotuloMotivo } from './apresentacao-admin.ts';

const referencia = 'E12345678202611201234Ab123456789';

test('exibe e envia o horário de São Paulo mesmo na virada de data UTC', () => {
  assert.equal(formatarInstanteSP('2026-11-22T02:42:00Z'), '21/11/2026, 23:42');
  assert.equal(instanteComOffsetSP('2026-11-21', '23:42'), '2026-11-21T23:42:00-03:00');
  assert.equal(instanteComOffsetSP('2018-11-04', '01:30:02'), '2018-11-04T01:30:02-02:00');
  assert.throws(() => instanteComOffsetSP('2018-11-04', '00:30'), /São Paulo/);
  for (const [data, hora] of [['2026-11-21', ''], ['2026-02-29', '12:00'], ['2026-11-21', '24:00']]) {
    assert.throws(() => instanteComOffsetSP(data, hora), /data e (a )?hora/);
  }
});

test('rótulos da devolução incluem o motivo do servidor e o destino do dinheiro', () => {
  assert.equal(rotuloMotivo('VALOR_DIVERGENTE'), 'Valor recebido diferente do sinal');
  assert.equal(rotuloMotivo('ADITIVO_ABAIXO_DO_CREDITO'), 'Valor do aditivo abaixo do crédito do sinal');
  assert.equal(rotuloMotivo('EXPIRADA'), 'Garantia vencida');
  assert.equal(rotuloMotivo('toString'), 'Motivo não informado');
  assert.equal(rotuloDestino('DEVOLVIDO'), 'Devolvido');
});

test('corpos usam centavos exatos, versão e sequência, sem misturar senha ou dados locais', () => {
  assert.deepEqual(corpoConfiguracao(false, '100,00', 7), { habilitada: false, sinalCentavos: 10000, versao: 7 });
  assert.throws(() => corpoConfiguracao(true, '9,99', 7), /R\$ 10 e R\$ 500/);
  assert.deepEqual(corpoSinal(2, ` ${referencia} `, '99.10', 'CONFIRMAR'), {
    aceiteSequencia: 2, referencia, valorCentavos: 9910, acao: 'CONFIRMAR',
  });
  assert.throws(() => corpoSinal(2, referencia, '9.999', 'CONFIRMAR'), /duas casas/);
  const baixa = (valor: string, conferido: boolean) =>
    corpoBaixa(referencia, ' Saída ', valor, '9910', '2026-11-21', '16:42:15', conferido);
  assert.deepEqual(baixa('99,10', true), {
    original: referencia, referencia: 'Saída', valorCentavos: 9910, devolvidoEm: '2026-11-21T16:42:15-03:00', extratoConferido: true,
  });
  assert.throws(() => baixa('99,09', true), /valor integral/);
  assert.throws(() => baixa('99,10', false), /conferência/);
});
