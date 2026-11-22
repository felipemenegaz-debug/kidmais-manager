import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';

const { limitesMesesSaoPaulo } = carregarComponente('lib/whatsapp/atendimento/resultado.ts', {
  './configuracao.ts': {}, './service.ts': {},
}).modulo as typeof import('./resultado.ts');

test('limites dos meses no horário de São Paulo na virada de dezembro para janeiro', () => {
  const dezembro = { mes: '2026-12', inicio: '2026-12-01T03:00:00.000Z', fim: '2027-01-01T03:00:00.000Z' };
  assert.deepEqual(limitesMesesSaoPaulo(new Date('2027-01-01T02:59:59.999Z')), [
    dezembro,
    { mes: '2026-11', inicio: '2026-11-01T03:00:00.000Z', fim: '2026-12-01T03:00:00.000Z' },
  ]);
  assert.deepEqual(limitesMesesSaoPaulo(new Date('2027-01-01T03:00:00.000Z')), [
    { mes: '2027-01', inicio: '2027-01-01T03:00:00.000Z', fim: '2027-02-01T03:00:00.000Z' },
    dezembro,
  ]);
});

test('cada limite usa o deslocamento de São Paulo da sua própria data', () => {
  assert.deepEqual(limitesMesesSaoPaulo(new Date('2019-02-10T12:00:00Z')), [
    { mes: '2019-02', inicio: '2019-02-01T02:00:00.000Z', fim: '2019-03-01T03:00:00.000Z' },
    { mes: '2019-01', inicio: '2019-01-01T02:00:00.000Z', fim: '2019-02-01T02:00:00.000Z' },
  ]);
});
