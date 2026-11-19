import assert from 'node:assert/strict';
import test from 'node:test';
import { avisoDeSaida, normalizarEmail, normalizarTelefone, saidasDosContatos } from './saidas-contato.ts';
import { normalizarDestino } from '../marketing/automacoes/preferencias.ts';

/** Guarda fase 1a (127, 19/11/2026): normalização igual à do banco e aviso em português. */

test('normalizarTelefone é a mesma regra de normalizarDestino (cópia deliberada, sem import circular)', () => {
  for (const v of ['11988887777', '(11) 98888-7777', '1133334444', '5511988887777', '+55 11 98888-7777', '123', '', null, undefined, '1234567890123456', '351912345678']) {
    assert.equal(normalizarTelefone(v as string), normalizarDestino(v as string), `valor ${String(v)}`);
  }
});

test('normalizarEmail: minúsculas e sem espaços nas pontas; inválido vira null (mesma regra de kidmais127_email)', () => {
  assert.equal(normalizarEmail('  Ana.Exemplo@Buffet.COM '), 'ana.exemplo@buffet.com');
  assert.equal(normalizarEmail('sem-arroba'), null);
  assert.equal(normalizarEmail('a@b@c'), null);
  assert.equal(normalizarEmail(''), null);
  assert.equal(normalizarEmail(null), null);
  assert.equal(normalizarEmail('a'.repeat(315) + '@b.com'), null);
});

test('avisoDeSaida: data no fuso de São Paulo (saída às 01:00Z ainda é o dia anterior)', () => {
  assert.equal(avisoDeSaida({ tipo: 'TELEFONE', valor: '5511988887777', saiuEm: '2026-11-02 01:00:00+00', origem: 'EQUIPE' }), 'Este telefone pediu para sair das campanhas em 01/11/2026.');
  assert.equal(avisoDeSaida({ tipo: 'EMAIL', valor: 'a@b.com', saiuEm: '2026-11-02T15:00:00.000Z', origem: 'RESPOSTA_PARAR' }), 'Este e-mail pediu para sair das campanhas em 02/11/2026.');
});

test('saidasDosContatos: normaliza antes de consultar, filtra pela empresa e não consulta sem contato válido', async () => {
  const chamadas: unknown[][] = [];
  const tx = { async query(sql: string, params: unknown[] = []) {
    chamadas.push(params);
    if (sql.includes("to_regclass('public.marketing_saidas_contato')")) return { rows: [{ ok: true }], rowCount: 1 };
    assert.match(sql, /empresa_id = \$1::uuid/);
    return { rows: [], rowCount: 0 };
  } };
  assert.deepEqual(await saidasDosContatos(tx as never, 'e1', { telefones: ['abc', null], emails: ['x'] }), []);
  await saidasDosContatos(tx as never, 'e1', { telefones: ['(11) 98888-7777'], emails: [' A@B.com '] });
  const ultima = chamadas.at(-1) as unknown[];
  assert.deepEqual(ultima, ['e1', ['5511988887777'], ['a@b.com']]);
});
