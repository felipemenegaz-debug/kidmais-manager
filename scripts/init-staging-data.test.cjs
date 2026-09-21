/* eslint-disable @typescript-eslint/no-require-imports -- Teste Node CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { caminhoDisponibilidade, inicializarDadosStaging } = require('./init-staging-data.cjs');

async function comTemporario(work) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kidmais-staging-data-'));
  try { await work(cwd); } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

const envStaging = { KIDMAIS_DEPLOY_ENV: 'staging' };

test('cria diretório e arquivo inicial quando ambos não existem', async () => {
  await comTemporario(async (cwd) => {
    const resultado = await inicializarDadosStaging({ env: envStaging, cwd });
    assert.equal(resultado.criado, true);
    assert.deepEqual(JSON.parse(await fs.readFile(caminhoDisponibilidade(cwd), 'utf8')), { pacoteOverrides: [], descontos: [] });
  });
});

test('cria atomicamente o arquivo quando o diretório já existe', async () => {
  await comTemporario(async (cwd) => {
    await fs.mkdir(path.join(cwd, 'data'));
    assert.equal((await inicializarDadosStaging({ env: envStaging, cwd })).criado, true);
    assert.deepEqual(await fs.readdir(path.join(cwd, 'data')), ['disponibilidade.json']);
  });
});

test('preserva byte a byte um arquivo existente válido', async () => {
  await comTemporario(async (cwd) => {
    const arquivo = caminhoDisponibilidade(cwd);
    await fs.mkdir(path.dirname(arquivo));
    const original = '{\n  "pacoteOverrides": [{"teste": true}],\n  "descontos": []\n}\n';
    await fs.writeFile(arquivo, original, 'utf8');
    assert.equal((await inicializarDadosStaging({ env: envStaging, cwd })).criado, false);
    assert.equal(await fs.readFile(arquivo, 'utf8'), original);
  });
});

test('recusa JSON existente inválido sem sobrescrever', async () => {
  await comTemporario(async (cwd) => {
    const arquivo = caminhoDisponibilidade(cwd);
    await fs.mkdir(path.dirname(arquivo));
    const original = '{invalido';
    await fs.writeFile(arquivo, original, 'utf8');
    await assert.rejects(inicializarDadosStaging({ env: envStaging, cwd }), /JSON inválido/);
    assert.equal(await fs.readFile(arquivo, 'utf8'), original);
  });
});

test('fora de staging recusa antes de criar diretório ou arquivo', async () => {
  await comTemporario(async (cwd) => {
    await assert.rejects(inicializarDadosStaging({ env: {}, cwd }), /deve ser staging/);
    await assert.rejects(fs.stat(path.join(cwd, 'data')), (error) => error?.code === 'ENOENT');
  });
});
