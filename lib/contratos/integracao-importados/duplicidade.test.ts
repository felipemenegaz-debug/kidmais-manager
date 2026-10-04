import test from 'node:test';
import assert from 'node:assert/strict';
import { contatoComparavel, dataInvertida, JANELA_DATA_PROXIMA_DIAS, possiveisVinculos, travarDuplicidade } from './repositorio.ts';

/** Busca de possíveis duplicados (mesmo dia + complementar em outras datas) e serialização por empresa. Sem banco. */
const EMPRESA = '11111111-1111-4111-8111-111111111111';

function txFalso(linhas: Array<Record<string, unknown>> = []) {
  const chamadas: Array<{ sql: string; v: readonly unknown[] }> = [];
  return { chamadas, tx: { query: async (sql: string, v: readonly unknown[] = []) => { chamadas.push({ sql, v }); return { rows: linhas, rowCount: linhas.length }; } } };
}
const criterio = (mudanca: Record<string, unknown> = {}) => ({
  clienteId: 'cli', data: '2026-11-04', dataDocumento: '2026-11-14', aniversariante: 'Lia', valorCentavos: 500000, documentoSha256: 'a'.repeat(64),
  cpf: '12345678901', telefones: ['11999990000'], ...mudanca,
});

test('dia e mês trocados: só quando a troca dá outra data válida', () => {
  assert.equal(dataInvertida('2026-11-04'), '2026-04-11');
  assert.equal(dataInvertida('2026-04-11'), '2026-11-04');
  assert.equal(dataInvertida('2026-11-11'), null, 'dia = mês');
  assert.equal(dataInvertida('2026-11-14'), null, 'dia > 12 não vira mês');
  assert.equal(dataInvertida('2026-02-30'), null);
});

test('contato comparável: só dígitos; CPF com 11 dígitos e telefones com 8 ou mais', () => {
  assert.deepEqual(contatoComparavel({ cpf: '123.456.789-01', telefone: '(11) 99999-0000', whatsapp: '11 99999-0000' }), { cpf: '12345678901', telefones: ['11999990000'] });
  assert.deepEqual(contatoComparavel({ cpf: '123', telefone: '1234', whatsapp: null }), { cpf: null, telefones: [] });
});

test('consulta: só a empresa comprovada; mesmo dia com um sinal; outra data só com documento, data lida/trocada + sinal pessoal ou janela + dois sinais', async () => {
  const { tx, chamadas } = txFalso();
  await possiveisVinculos(tx as never, EMPRESA, criterio());
  const { sql, v } = chamadas[0];
  assert.deepEqual(v, [EMPRESA, 'cli', '2026-11-04', 'Lia', 500000, 'a'.repeat(64), '2026-11-14', '2026-04-11', '12345678901', ['11999990000'], JANELA_DATA_PROXIMA_DIAS]);
  assert.equal(JANELA_DATA_PROXIMA_DIAS, 90, 'festa do ano seguinte fora da proximidade');
  assert.match(sql, /WHERE f\.empresa_id = \$1::uuid\n/, 'sempre a empresa comprovada (outra empresa nunca aparece)');
  assert.ok(!/f\.empresa_id IS NULL|OR f\.empresa_id/.test(sql));
  assert.ok(sql.includes("f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO') AND coalesce(c.status, '') <> 'CANCELADO'"));
  assert.ok(sql.includes('(mesmo_dia AND (pessoa OR mesmo_aniversariante OR mesmo_valor OR mesmo_documento))'));
  assert.ok(sql.includes('OR (NOT mesmo_dia AND (mesmo_documento'), 'mesmo documento em qualquer data');
  assert.ok(sql.includes('OR ((data_evento = $7::date OR data_evento = $8::date) AND (pessoa OR mesmo_aniversariante OR mesmo_valor))'), 'data lida ou trocada: um sinal');
  assert.ok(sql.includes('OR (abs(data_evento - $3::date) <= $11::int AND combinados >= 2)'), 'proximidade: dois sinais');
  assert.ok(sql.includes('(mesmo_cliente OR mesmo_contato)::int + mesmo_aniversariante::int + mesmo_valor::int AS combinados'), 'cliente e contato contam como UM sinal');
  // Contato só de OUTRO cadastro (mesmo cliente já é sinal próprio).
  assert.ok(sql.includes('f.cliente_id IS DISTINCT FROM $2::uuid AND cl.id IS NOT NULL'));
  // Nada é escrito: a busca só lê.
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(sql));
});

test('data lida igual à decidida não vira critério extra; alcance e data de cada candidato', async () => {
  const { tx, chamadas } = txFalso([
    { fechamento_id: 'f1', contrato_id: 'k1', status: 'ASSINADO', data_evento: '2026-11-04', horario_inicio: '14:00', horario_fim: '18:00', com_pagamento: false, importado: true, sinais: ['MESMO_VALOR'] },
    { fechamento_id: 'f2', contrato_id: 'k2', status: 'ASSINADO', data_evento: '2026-04-11', horario_inicio: '10:00', horario_fim: '14:00', com_pagamento: true, importado: true, sinais: ['MESMO_CLIENTE', 'DATA_INVERTIDA'] },
  ]);
  const r = await possiveisVinculos(tx as never, EMPRESA, criterio({ dataDocumento: '2026-11-04' }));
  assert.equal(chamadas[0].v[6], null);
  assert.deepEqual(r.map((x) => [x.fechamentoId, x.data, x.alcance, x.horario]), [['f1', '2026-11-04', 'MESMO_DIA', '14:00–18:00'], ['f2', '2026-04-11', 'OUTRA_DATA', '10:00–14:00']]);
});

test('serialização da detecção: uma por empresa (a chave não leva a data)', async () => {
  const { tx, chamadas } = txFalso();
  await travarDuplicidade(tx as never, EMPRESA);
  assert.deepEqual(chamadas.map((c) => [c.sql, c.v]), [["SELECT pg_advisory_xact_lock(hashtextextended('kidmais:importacao-duplicidade:' || $1::text, 0))", [EMPRESA]]]);
});
