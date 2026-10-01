import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import type { DbExecutor } from '../../db/contracts.ts';

/** C3: o beneficiário da devolução precisa ser cliente da MESMA empresa do contrato (a já provada no tenant). */
function carregar(path: string, deps: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', js)((id: string) => { assert(id in deps, `Dependência não simulada: ${id}`); return deps[id]; }, exports);
  return exports;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CONTRATO_A = 'c0000000-0000-4000-8000-00000000000a';
const CLIENTE_A = 'd0000000-0000-4000-8000-00000000000a';
const CLIENTE_B = 'd0000000-0000-4000-8000-00000000000b';
const CLIENTE_LEGADO = 'd0000000-0000-4000-8000-00000000000c';
const INEXISTENTE = 'd0000000-0000-4000-8000-00000000000d';
const EMPRESA_DO_CLIENTE: Record<string, string | null> = { [CLIENTE_A]: A, [CLIENTE_B]: B, [CLIENTE_LEGADO]: null };
const EMPRESA_DO_CONTRATO: Record<string, string> = { [CONTRATO_A]: A };

class ErroFinanceiro extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

function servico() {
  const sqls: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      sqls.push(sql);
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes('FROM clientes cl')) {
        // Mesma empresa do FECHAMENTO do contrato, na própria consulta; FK global não basta.
        assert.match(sql, /JOIN fechamentos fech ON fech\.empresa_id=cl\.empresa_id JOIN contratos c ON c\.fechamento_id=fech\.id WHERE c\.id=\$1 AND cl\.id=\$2/);
        const empresaCliente = EMPRESA_DO_CLIENTE[String(values[1])];
        return r(empresaCliente && empresaCliente === EMPRESA_DO_CONTRATO[String(values[0])] ? [{ id: values[1] }] : []);
      }
      if (sql.includes('pagamento_recebimento_alocacoes')) return r([{ disponivel: '100000' }]);
      if (sql.startsWith('INSERT')) return r([]);
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  const mod = carregar('lib/pagamentos/services/devolucao.service.ts', {
    'node:crypto': crypto,
    '../repositories/alteracao-financeira.repository': { lerPosicaoFinanceira: async () => ({ pagamento: { id: 'pag' }, posicao: { disponivel: 100000n, reservado: 0n, devolvido: 0n }, devolucoes: [] }) },
    './alteracao-financeira.service': { bloquearFinanceiro: async () => ({ usuario_id: 'u', papel: 'ADMINISTRATIVO' }), conferirPosicao: () => {}, registrarEventoFinanceiro: async () => 'evento', repetirEvento: async () => null },
    './alteracao-financeira-core': { centavosInteiros: (v: string) => BigInt(v), recusarFinanceiro: (code: string, msg: string, status = 409) => { throw new ErroFinanceiro(code, msg, status); } },
    './transacao': { naTransacao: (executor: DbExecutor | undefined, trabalho: (tx: DbExecutor) => unknown) => { assert.equal(executor, tx, 'roda no tx do tenant'); return trabalho(executor!); } },
  });
  const solicitar = (beneficiarioClienteId?: string, contratoId = CONTRATO_A) => (mod.solicitarDevolucao as (...a: unknown[]) => Promise<unknown>)(contratoId, {
    posicaoHash: 'a'.repeat(64), valorCentavos: '100', ...(beneficiarioClienteId ? { beneficiarioClienteId } : {}),
    beneficiario: { nome: 'Fulano' }, motivo: 'devolução', origens: [{ alocacaoId: 'aloc', valorCentavos: '100' }],
  }, 'chave', { token: 't', requestId: 'r', ip: null, userAgent: null, executor: tx });
  const gravou = () => sqls.some((s) => s.includes('INSERT INTO pagamento_devolucoes'));
  return { solicitar, gravou, sqls };
}

const recusa = (e: unknown) => e instanceof ErroFinanceiro && e.code === 'BENEFICIARIO_INVALIDO' && e.status === 404 && e.message === 'Beneficiário não encontrado.';

test('C3.1: beneficiário da mesma empresa do contrato ⇒ devolução criada', async () => {
  const s = servico();
  await s.solicitar(CLIENTE_A);
  assert.equal(s.gravou(), true);
});

test('C3.2/3.3/3.5: beneficiário de outra empresa, legado sem empresa ou inexistente ⇒ mesma recusa 404, nada gravado (contrato válido)', async () => {
  for (const cliente of [CLIENTE_B, CLIENTE_LEGADO, INEXISTENTE]) {
    const s = servico();
    await assert.rejects(s.solicitar(cliente), recusa, cliente);
    assert.equal(s.gravou(), false, cliente);
    assert.equal(s.sqls.some((q) => q.startsWith('INSERT')), false, `${cliente}: nenhuma escrita`);
  }
});

test('C3.4: tenant incorreto — contrato que não é da empresa do cliente também recusa (e a rota já recusa o contrato fora do tenant)', async () => {
  const s = servico();
  await assert.rejects(s.solicitar(CLIENTE_A, 'c0000000-0000-4000-8000-0000000000ff'), recusa);
  assert.equal(s.gravou(), false);
  // A rota prova a posse do contrato no tenant antes (tenant.test.ts); aqui, a checagem vem antes de qualquer INSERT.
  const fonte = readFileSync('lib/pagamentos/services/devolucao.service.ts', 'utf8');
  const solicitar = fonte.slice(fonte.indexOf('export async function solicitarDevolucao'), fonte.indexOf('export type ExecucaoDevolucao'));
  assert.ok(solicitar.indexOf('BENEFICIARIO_INVALIDO') < solicitar.indexOf('INSERT'));
});

test('sem beneficiário vinculado (só nome), a devolução segue como antes', async () => {
  const s = servico();
  await s.solicitar();
  assert.equal(s.gravou(), true);
  assert.equal(s.sqls.some((q) => q.includes('FROM clientes cl')), false);
});
