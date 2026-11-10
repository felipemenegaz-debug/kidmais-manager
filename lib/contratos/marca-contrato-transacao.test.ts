import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { MARCA_CONTRATO_NEUTRA, marcaDaEmpresa, marcaDoContratoNaTransacao, marcaDoContratoPublico } from './marca-contrato.ts';

const CONTRATO = '11111111-1111-4111-8111-111111111111';
const EMPRESA = '22222222-2222-4222-8222-222222222222';

/** Transação como no PostgreSQL: depois da primeira falha de SQL, toda consulta recebe 25P02. */
function transacaoQueFalhaNoPerfil(erro: Error & { code?: string }): DbExecutor & { abortada: () => boolean } {
  let abortada = false;
  return {
    abortada: () => abortada,
    async query<Row extends object>(sql: string) {
      if (abortada) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes('FROM public.contratos')) return r([{ e: EMPRESA }]);
      if (sql.includes('SELECT codigo')) return r([{ codigo: 'estrela' }]);
      if (sql.includes('SELECT nome FROM public.empresas')) return r([{ nome: 'Buffet Estrela' }]);
      if (sql.includes('to_regclass') || sql.includes('information_schema')) { abortada = true; throw erro; }
      throw new Error('consulta inesperada: ' + sql.slice(0, 60));
    },
  };
}
const cancelada = () => Object.assign(new Error('canceling statement'), { code: '57014' });

test('na transação, falha de SQL no perfil sobe com a causa original, não com 25P02 nem neutro', async () => {
  const tx = transacaoQueFalhaNoPerfil(cancelada());
  await assert.rejects(marcaDoContratoNaTransacao(tx, CONTRATO), (e: { code?: string }) => e.code === '57014');
  assert.equal(tx.abortada(), true);
});

test('marcaDaEmpresa, usada nos comprovantes do painel, também não engole a falha', async () => {
  await assert.rejects(marcaDaEmpresa(transacaoQueFalhaNoPerfil(cancelada()), EMPRESA), (e: { code?: string }) => e.code === '57014');
});

test('leitura fora de transação segue neutra com a mesma falha', async () => {
  assert.deepEqual(await marcaDoContratoPublico(transacaoQueFalhaNoPerfil(cancelada()), CONTRATO), MARCA_CONTRATO_NEUTRA);
});

test('perfil ambíguo não é falha de SQL: segue para o nome da empresa', async () => {
  const ambiguo = new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'ambíguo', 409);
  const executor: DbExecutor = {
    async query<Row extends object>(sql: string) {
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes('FROM public.contratos')) return r([{ e: EMPRESA }]);
      if (sql.includes('SELECT codigo')) return r([{ codigo: 'estrela' }]);
      if (sql.includes('SELECT nome FROM public.empresas')) return r([{ nome: 'Buffet Estrela' }]);
      if (sql.includes('to_regclass') || sql.includes('information_schema')) throw ambiguo;
      throw new Error('consulta inesperada: ' + sql.slice(0, 60));
    },
  };
  assert.deepEqual(await marcaDoContratoNaTransacao(executor, CONTRATO), { kidmais: false, nome: 'Buffet Estrela' });
});

test('contrato sem empresa ou id inválido na transação: neutro, sem erro', async () => {
  const vazio: DbExecutor = { async query<Row extends object>() { return { rows: [] as Row[], rowCount: 0 }; } };
  assert.deepEqual(await marcaDoContratoNaTransacao(vazio, CONTRATO), MARCA_CONTRATO_NEUTRA);
  assert.deepEqual(await marcaDoContratoNaTransacao(vazio, 'nao-e-uuid'), MARCA_CONTRATO_NEUTRA);
});
