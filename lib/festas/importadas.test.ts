import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts.ts';
import { listarFestasImportadas } from './importadas.ts';
import { estadoDerivado, pertenceVisao } from './domain.ts';
import { nomeComIdade } from './buffet.ts';

const linha = { id: 'i1', empresa: 'a', status: 'IMPORTADA', cliente_id: 'c1', cliente: 'Cliente exemplo', evento: { data: '2026-10-18', horario: { inicio: '10:00', fim: '14:00' }, aniversariante: 'Luca exemplo', idade: 4, convidados: 50, tema: 'Carros' }, pacote: { nome: 'Original 2025', itens: 'Itens originais' }, buffet: { itens: 'Salgados' }, observacoes: null };
function banco() {
  const consultas: string[] = [];
  const rows = [linha, { ...linha, id: 'i2', empresa: 'b' }, { ...linha, id: 'i3', status: 'EM_REVISAO' }, { ...linha, id: 'i4', status: 'DESCARTADA' }];
  const tx = { async query(sql: string, values: unknown[]) {
    consultas.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ok: true }] };
    assert.match(sql, /i.empresa_id = \$1::uuid AND i.status = 'IMPORTADA'/);
    assert.match(sql, /c.empresa_id = i.empresa_id/);
    assert.doesNotMatch(sql, /i\.dados|SELECT \*|AS resultado|valores|pagamentos/);
    return { rows: rows.filter(l => l.empresa === values[0] && l.status === 'IMPORTADA' && (!values[1] || l.cliente_id === values[1]) && (!values[2] || l.id === values[2])) };
  } } as unknown as DbExecutor;
  return { tx, consultas };
}
test('importação já confirmada aparece uma vez, sem reimportação; rascunhos e outra empresa não aparecem', async () => {
  const { tx, consultas } = banco();
  const festas = await listarFestasImportadas(tx, 'a');
  assert.equal(festas.length, 1);
  const festa = festas[0];
  assert.equal(festa.snapshot.evento.pacote.nome, 'Original 2025');
  assert.equal(festa.snapshot.evento.horarioFim, '14:00');
  assert.equal(nomeComIdade(festa.snapshot), 'Luca exemplo — 4 anos');
  for (const [agora, visao] of [['2026-10-02T15:00:00Z', 'Próximas'], ['2026-10-18T14:00:00Z', 'Hoje'], ['2026-10-19T15:00:00Z', 'Histórico']]) {
    assert(pertenceVisao(estadoDerivado(festa.snapshot, false, false, new Date(agora)), visao, false));
  }
  assert.deepEqual(await listarFestasImportadas(tx, 'a', 'outro'), []);
  assert.deepEqual(await listarFestasImportadas(tx, 'a', undefined, 'i2'), []);
  assert.deepEqual(await listarFestasImportadas(tx, 'a', undefined, 'inexistente'), []);
  assert(consultas.every(q => q.startsWith('SELECT')));
});
test('ambiente sem importações preserva a consulta de festas nativas', async () => {
  let chamadas = 0;
  const tx = { query: async () => { chamadas++; return { rows: [{ ok: false }] }; } } as unknown as DbExecutor;
  assert.deepEqual(await listarFestasImportadas(tx, 'a'), []);
  assert.equal(chamadas, 1);
});
