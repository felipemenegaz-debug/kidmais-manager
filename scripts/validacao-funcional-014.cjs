/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const report = JSON.parse(fs.readFileSync('.tmp/admin-contrato-resultados.json'));
assert.match(report.banco, /^kidmais_funcional_\d+$/);
const connection = new URL(process.env.DATABASE_URL);
connection.pathname = '/' + report.banco;
const env = { ...process.env, DATABASE_URL: connection.toString() };
const commands = [
    ['Comercial unitário', ['--experimental-strip-types', '--test', 'lib/comercial/condicao-pagamento.test.ts']],
    ['Disponibilidade unitário', ['--experimental-strip-types', '--test', 'lib/disponibilidade/services/horario.utils.test.ts']],
    ['Contrato unitário', ['--experimental-strip-types', '--test', 'lib/contratos/services/snapshot-core.test.ts', 'lib/contratos/documento/documento-core.test.ts', 'lib/contratos/services/acesso-token.test.ts']],
    ['Pagamentos unitário', ['--experimental-strip-types', '--test', 'lib/pagamentos/services/financeiro-core.test.ts', 'lib/pagamentos/services/idempotencia.test.ts']],
    ...['condicao-pagamento', 'pagamentos-engenharia', 'pagamentos-http', 'pagamentos-concorrencia'].map(name => [name, ['scripts/' + name + '.integration.cjs']]),
    ...['pricing-service', 'identidade-repository', 'identidade-service', 'identidade-fechamento'].map(name => [name, ['-r', './scripts/pagamentos-test-support.cjs', '-e', `require('./scripts/${name}.integration.ts')`]]),
    ['TypeScript', ['node_modules/typescript/bin/tsc', '--noEmit']],
];
const results = [];
for (const [name, args] of commands) {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120000 });
    const filename = '.tmp/regressao-014-' + results.length + '.log';
    fs.writeFileSync(filename, (result.stdout || '') + (result.stderr || ''));
    results.push({ name, args, status: result.status, log: filename, error: result.error?.message });
    console.log(name, result.status === 0 ? 'PASSOU' : 'FALHOU', filename);
    if (result.status !== 0)
        console.log((result.stdout || '') + (result.stderr || ''));
}
fs.writeFileSync('.tmp/regressoes-014.json', JSON.stringify({ banco: report.banco, results }, null, 2));
if (results.some(r => r.status !== 0))
    process.exitCode = 1;
