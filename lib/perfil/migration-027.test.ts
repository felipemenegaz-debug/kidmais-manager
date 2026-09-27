import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { autorizado, recusarBancoReal } from '../../scripts/perfil-empresa-provisionar.cjs';

const migration = readFileSync('database/migrations/20260925_027_perfil_empresa_cadastro.sql', 'utf8');
const postcheck = readFileSync('database/checks/20260925_027_postcheck.sql', 'utf8');
const script = readFileSync('scripts/perfil-empresa-provisionar.cjs', 'utf8');

test('027 acrescenta cadastro e revisão sem singleton, seed ou documento', () => {
    assert.match(migration, /CREATE TABLE perfil_empresa_revisoes/);
    assert.match(migration, /mesmo_endereco_sede/);
    assert.match(migration, /sede_sem_numero/);
    const sql = migration.replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /INSERT INTO|CREATE TRIGGER|bytea|contrato_documentos|documentos_publicos/i);
    assert.match(postcheck, /zero revisões vale só na instalação inicial/);
    assert.match(postcheck, /índice único global inesperado/);
    assert.match(script, /kidmais:perfil-empresa:provisionamento-inicial/);
    assert.doesNotMatch(script, /example\.com|00000000000191/);
});

test('o procedimento não abre conexão sem a autorização explícita', () => {
    assert.equal(autorizado(['node', 'script'], {} as NodeJS.ProcessEnv), false);
    assert.equal(autorizado(['node', 'script', '--autorizado-por-felipe'], { KIDMAIS_PERFIL_PROVISIONAR: 'CONFIRMAR' } as unknown as NodeJS.ProcessEnv), true);
    assert.throws(() => recusarBancoReal('postgres://local/kidmais_manager'), /kidmais_manager/);
    const main = script.slice(script.indexOf('async function main'));
    assert.match(main, /if \(!autorizado\(\)\)/);
    const guarda = main.indexOf('if (!autorizado())');
    const cliente = main.indexOf('new Client');
    assert.equal(guarda >= 0 && guarda < cliente, true);
});
