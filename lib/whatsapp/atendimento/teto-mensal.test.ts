import assert from 'node:assert/strict';
import test from 'node:test';
import { FRANQUIA_META, TETO_MENSAL_PADRAO, contaNoTeto, reservarConsumo, situacaoTeto, tetoMensal } from './teto-mensal.ts';

test('teto mensal (3b): padrão 1.000; ambiente só aceita inteiro de 1 a 100.000 e nunca desliga o teto', () => {
  assert.equal(TETO_MENSAL_PADRAO, 1000);
  assert.equal(tetoMensal({}), 1000);
  assert.equal(tetoMensal({ WHATSAPP_TETO_MENSAL_RESPOSTAS: '2500' }), 2500);
  assert.equal(tetoMensal({ WHATSAPP_TETO_MENSAL_RESPOSTAS: ' 1 ' }), 1);
  assert.equal(tetoMensal({ WHATSAPP_TETO_MENSAL_RESPOSTAS: '100000' }), 100000);
  for (const invalido of ['', '0', '-5', '1.5', '1e3', 'abc', '100001', 'Infinity']) {
    assert.equal(tetoMensal({ WHATSAPP_TETO_MENSAL_RESPOSTAS: invalido }), 1000, `inválido: ${JSON.stringify(invalido)}`);
  }
});

test('teto mensal (3b r2): aviso em 80% com ceil, franquia da Meta fixa e separada do limite do Wall-e', () => {
  assert.deepEqual(situacaoTeto(0, 1000, '2026-11'), { mes: '2026-11', usadas: 0, franquiaMeta: 1000, limite: 1000, aviso: 800, estado: 'NORMAL', acimaDaFranquia: false });
  assert.equal(situacaoTeto(799, 1000, '2026-11').estado, 'NORMAL');
  assert.equal(situacaoTeto(800, 1000, '2026-11').estado, 'AVISO');
  assert.equal(situacaoTeto(999, 1000, '2026-11').estado, 'AVISO');
  assert.equal(situacaoTeto(1000, 1000, '2026-11').estado, 'ATINGIDO');
  assert.equal(situacaoTeto(1500, 1000, '2026-11').estado, 'ATINGIDO');
  // ceil (Astra r1, P3): 7 ⇒ 6 (floor daria 5); 1 ⇒ 1.
  assert.deepEqual([situacaoTeto(0, 7, 'x').aviso, situacaoTeto(0, 1, 'x').aviso, situacaoTeto(1, 1, 'x').estado], [6, 1, 'ATINGIDO']);
  assert.equal(FRANQUIA_META, 1000);
  assert.equal(situacaoTeto(1000, 5000, 'x').acimaDaFranquia, false);
  assert.equal(situacaoTeto(1001, 5000, 'x').acimaDaFranquia, true);
  assert.equal(situacaoTeto(10, 300, 'x').franquiaMeta, 1000, 'limite do Wall-e não muda a franquia');
});

test('teto mensal (3b r3): a piloto fica fora em qualquer canal; as outras empresas contam', () => {
  assert.equal(contaNoTeto('A', 'a'), false, 'piloto (sem diferenciar maiúsculas) fora');
  assert.equal(contaNoTeto('a', 'a'), false, 'piloto fora, qualquer que seja o canal (não é parâmetro)');
  assert.equal(contaNoTeto('b', 'a'), true, 'outra empresa conta');
  assert.equal(contaNoTeto('b', null), true, 'sem piloto: conta');
});

test('teto mensal (3b r2): reserva sem a 135 não grava nada; k=0 não consulta', async () => {
  const sqls: string[] = [];
  const tx = { query: async (sql: string) => { sqls.push(sql); return { rows: sql.includes('to_regclass') ? [{ e: false }] : [] }; } };
  assert.equal(await reservarConsumo(tx as never, 'e', 'staging', 2, 10), true);
  assert.equal(sqls.some(s => s.includes('INSERT')), false);
  sqls.length = 0;
  assert.equal(await reservarConsumo(tx as never, 'e', 'staging', 0, 10), true);
  assert.equal(sqls.length, 0);
});
