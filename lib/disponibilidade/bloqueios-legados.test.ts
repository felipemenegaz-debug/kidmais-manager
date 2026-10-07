import test from 'node:test';
import assert from 'node:assert/strict';
import type { DbExecutor } from '../db/contracts.ts';
import { bloqueioLegadoSemDono, liberarBloqueioLegadoPelaEmpresa, MOTIVO_LIBERACAO_PADRAO, podeResolverBloqueioLegado, resolverEDesativarBloqueioLegado } from './bloqueios-legados.ts';
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

// Liberação pela própria empresa (sem autoridade da plataforma).
function bancoEmpresa(op: { unidade?: boolean; bloqueio?: boolean; autor?: string | null; autorDaEmpresa?: boolean; unica?: boolean; resolucaoDe?: string | null; alterado?: boolean } = {}) {
  const sql: Array<{ text: string; values: readonly unknown[] }> = [];
  let resolucaoDe: string | null | undefined = op.resolucaoDe;
  const db: DbExecutor = { async query<Row extends object>(text: string, values: readonly unknown[] = []) {
    sql.push({ text, values });
    let rows: object[] = [];
    if (text.includes('AS valida')) rows = [{ valida: op.unidade ?? true }];
    else if (text.startsWith('SELECT data')) rows = op.bloqueio === false ? [] : [{ data: '2026-12-05', criado_por_usuario_id: op.autor === undefined ? 'autor' : op.autor }];
    else if (text.includes('AS autor_da_empresa')) rows = [{ autor_da_empresa: op.autorDaEmpresa ?? true, unica_empresa: op.unica ?? false }];
    else if (text.startsWith('INSERT')) { if (resolucaoDe === undefined) resolucaoDe = String(values[1]); }
    else if (text.startsWith('SELECT empresa_id')) rows = resolucaoDe ? [{ empresa_id: resolucaoDe }] : [];
    else if (text.startsWith('UPDATE')) rows = op.alterado === false ? [] : [{ id: 'bloqueio' }];
    else if (text.startsWith('SELECT id FROM bloqueios_agenda')) rows = op.bloqueio === false ? [] : [{ id: 'bloqueio' }];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  return { db, sql };
}
const semEscrita = (sql: Array<{ text: string }>) => sql.every(q => !/^(INSERT|UPDATE)/.test(q.text));
test('bloqueioLegadoSemDono só reconhece bloqueio ativo e sem empresa', async () => {
  const b = bancoEmpresa();
  assert.equal(await bloqueioLegadoSemDono(b.db, 'g'), true);
  assert.match(b.sql[0].text, /empresa_id IS NULL AND ativo/);
  assert.equal(await bloqueioLegadoSemDono(bancoEmpresa({ bloqueio: false }).db, 'g'), false);
});
test('empresa libera bloqueio antigo criado por quem tem vínculo com ela: resolução gravada, registro inativo e atribuído', async () => {
  const b = bancoEmpresa({ autorDaEmpresa: true, unica: false });
  await liberarBloqueioLegadoPelaEmpresa(b.db, escopo, 'operador', 'g');
  const registro = b.sql.find(q => q.text.startsWith('INSERT'))!;
  assert.deepEqual(registro.values, ['g', 'empresa-A', 'unidade-A', 'operador', MOTIVO_LIBERACAO_PADRAO]);
  assert.match(registro.text, /ON CONFLICT \(bloqueio_id\) DO NOTHING/);
  const alteracao = b.sql.at(-1)!;
  assert.match(alteracao.text, /ativo=false/);
  assert.match(alteracao.text, /empresa_id IS NULL AND ativo/);
  assert.deepEqual(alteracao.values, ['g', 'empresa-A', 'unidade-A']);
  assert.ok(b.sql.findIndex(q => q.text.includes('travar_habilitacao')) < b.sql.findIndex(q => q.text.includes('pg_advisory')));
  assert.ok(b.sql.findIndex(q => q.text.includes('pg_advisory')) < b.sql.findIndex(q => q.text.includes('AS autor_da_empresa')), 'propriedade conferida com a data travada');
  assert.ok(!b.sql.some(q => q.text.includes('plataforma_desenvolvedores')), 'não exige autoridade da plataforma');
});
test('sem autor conhecido, a única empresa com agenda libera; motivo informado é preservado', async () => {
  const b = bancoEmpresa({ autor: null, autorDaEmpresa: false, unica: true });
  await liberarBloqueioLegadoPelaEmpresa(b.db, { empresaId: 'empresa-A', estabelecimentoId: null }, 'operador', 'g', '  Festa fechada antes do sistema, já cadastrada como contrato  ');
  const registro = b.sql.find(q => q.text.startsWith('INSERT'))!;
  assert.deepEqual(registro.values, ['g', 'empresa-A', null, 'operador', 'Festa fechada antes do sistema, já cadastrada como contrato']);
  assert.ok(!b.sql.some(q => q.text.includes('travar_habilitacao')), 'sem unidade não há habilitação a travar');
  assert.match(b.sql.at(-1)!.text, /ativo=false/);
});
test('bloqueio que pode ser de outra empresa continua com a plataforma: nada é escrito', async () => {
  const b = bancoEmpresa({ autorDaEmpresa: false, unica: false });
  await assert.rejects(liberarBloqueioLegadoPelaEmpresa(b.db, escopo, 'operador', 'g'), recusa('BLOQUEIO_SEM_DONO'));
  assert.ok(semEscrita(b.sql));
});
test('motivo curto, empresa ausente, unidade inválida e bloqueio inexistente recusam antes de escrever', async () => {
  for (const [op, alvo, motivo, codigo] of [
    [{}, escopo, 'abc', 'RESOLUCAO_INVALIDA'],
    [{}, { empresaId: null, estabelecimentoId: null }, undefined, 'RESOLUCAO_INVALIDA'],
    [{ unidade: false }, escopo, undefined, 'UNIDADE_INVALIDA'],
    [{ bloqueio: false }, escopo, undefined, 'BLOQUEIO_NAO_ENCONTRADO'],
  ] as const) {
    const b = bancoEmpresa(op);
    await assert.rejects(liberarBloqueioLegadoPelaEmpresa(b.db, alvo, 'operador', 'g', motivo), recusa(codigo));
    assert.ok(semEscrita(b.sql), codigo);
  }
});
test('resolução já registrada para outra empresa é recusada; para a própria empresa, a liberação segue', async () => {
  const outra = bancoEmpresa({ resolucaoDe: 'empresa-B' });
  await assert.rejects(liberarBloqueioLegadoPelaEmpresa(outra.db, escopo, 'operador', 'g'), recusa('RESOLUCAO_EXISTENTE'));
  assert.ok(!outra.sql.some(q => q.text.startsWith('UPDATE')));
  const propria = bancoEmpresa({ resolucaoDe: 'empresa-A' });
  await liberarBloqueioLegadoPelaEmpresa(propria.db, escopo, 'operador', 'g');
  assert.match(propria.sql.at(-1)!.text, /ativo=false/);
  const corrida = bancoEmpresa({ alterado: false });
  await assert.rejects(liberarBloqueioLegadoPelaEmpresa(corrida.db, escopo, 'operador', 'g'), recusa('BLOQUEIO_ALTERADO'));
});
