import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts.ts';
import { podeResolverBloqueioLegado, resolverEDesativarBloqueioLegado } from './bloqueios-legados.ts';
import { AvailabilityServiceError } from './services/errors.ts';

const sessao = { usuario_id: 'operador', autenticado_em: '2026-10-05T15:00:00Z', consultado_em: '2026-10-05T15:02:00Z' };
const escopo = { empresaId: 'empresa-A', estabelecimentoId: 'unidade-A' };
function banco(op: { instalada?: boolean; autoridade?: boolean; unidade?: boolean; bloqueio?: boolean; resolucao?: boolean; alterado?: boolean } = {}) {
  const sql: Array<{ text: string; values: readonly unknown[] }> = [];
  const db: DbExecutor = { async query<Row extends object>(text: string, values: readonly unknown[] = []) {
    sql.push({ text, values });
    let rows: object[] = [];
    if (text.includes('to_regclass')) rows = [{ instalada: op.instalada ?? true }];
    else if (text.includes('FROM plataforma_desenvolvedores')) rows = op.autoridade === false ? [] : [{ id: 'concessao' }];
    else if (text.includes('AS valida')) rows = [{ valida: op.unidade ?? true }];
    else if (text.startsWith('SELECT data')) rows = op.bloqueio === false ? [] : [{ data: '2026-10-18' }];
    else if (text.startsWith('INSERT')) rows = op.resolucao === false ? [] : [{ bloqueio_id: 'bloqueio' }];
    else if (text.startsWith('UPDATE')) rows = op.alterado === false ? [] : [{ id: 'bloqueio' }];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  return { db, sql };
}
const recusa = (codigo: string) => (e: unknown) => e instanceof AvailabilityServiceError && e.code === codigo;
test('schema anterior à 063 não quebra a consulta nem concede autoridade', async () => {
  const b = banco({ instalada: false });
  assert.equal(await podeResolverBloqueioLegado(b.db, sessao.usuario_id), false);
  assert.equal(b.sql.length, 1);
});
test('papel da empresa não dá autoridade para resolver bloqueios globais', async () => {
  const b = banco({ autoridade: false });
  await assert.rejects(resolverEDesativarBloqueioLegado(b.db, escopo, sessao, 'g', 'Importação histórica'), recusa('SEM_AUTORIDADE'));
  assert.ok(b.sql.every(q => !/^(INSERT|UPDATE)/.test(q.text)));
});
test('sessão antiga, unidade inválida e ausência de unidade recusam antes de escrever', async () => {
  for (const [op, alvo, s, codigo] of [
    [{}, escopo, { ...sessao, autenticado_em: '2026-10-05T14:00:00Z' }, 'REAUTENTICACAO'],
    [{ unidade: false }, escopo, sessao, 'UNIDADE_INVALIDA'],
    [{}, { empresaId: 'empresa-A', estabelecimentoId: null }, sessao, 'RESOLUCAO_INVALIDA'],
  ] as const) {
    const b = banco(op);
    await assert.rejects(resolverEDesativarBloqueioLegado(b.db, alvo, s, 'g', 'Importação histórica'), recusa(codigo));
    assert.ok(b.sql.every(q => !/^(INSERT|UPDATE)/.test(q.text)));
  }
});
test('bloqueio resolvido ou de outra empresa não é alterado', async () => {
  const b = banco({ bloqueio: false });
  await assert.rejects(resolverEDesativarBloqueioLegado(b.db, escopo, sessao, 'g', 'Importação histórica'), recusa('BLOQUEIO_NAO_ENCONTRADO'));
  assert.match(b.sql.at(-1)!.text, /empresa_id IS NULL AND ativo/);
  assert.ok(b.sql.every(q => !/^(INSERT|UPDATE)/.test(q.text)));
});
test('resolução registra identidade, motivo e escopo e preserva bloqueio inativo', async () => {
  const b = banco();
  await resolverEDesativarBloqueioLegado(b.db, escopo, sessao, 'g', ' Importação histórica ');
  const registro = b.sql.find(q => q.text.startsWith('INSERT'))!;
  assert.deepEqual(registro.values, ['g', 'empresa-A', 'unidade-A', 'operador', 'Importação histórica']);
  assert.match(b.sql.at(-1)!.text, /ativo=false/);
  assert.match(b.sql.at(-1)!.text, /empresa_id IS NULL AND ativo/);
  assert.ok(b.sql.findIndex(q => q.text.includes('travar_habilitacao')) < b.sql.findIndex(q => q.text.includes('pg_advisory')));
  assert.match(b.sql.find(q => q.text.includes('pg_advisory'))!.text, /kidmais:agenda:/);
});
test('disputa de resolução falha para a transação reverter, sem alterar resolução existente', async () => {
  const b = banco({ resolucao: false });
  await assert.rejects(resolverEDesativarBloqueioLegado(b.db, escopo, sessao, 'g', 'Importação histórica'), recusa('RESOLUCAO_EXISTENTE'));
  assert.ok(!b.sql.some(q => q.text.startsWith('UPDATE')));
  const corrida = banco({ alterado: false });
  await assert.rejects(resolverEDesativarBloqueioLegado(corrida.db, escopo, sessao, 'g', 'Importação histórica'), recusa('BLOQUEIO_ALTERADO'));
});
