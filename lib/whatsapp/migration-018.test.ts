import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync('database/migrations/20260912_018_whatsapp_onboarding.sql', 'utf8');
const rollback = readFileSync('database/rollback/20260912_018_whatsapp_onboarding_down.sql', 'utf8');
const routes = [
  'app/api/admin/configuracoes/whatsapp/onboarding/iniciar/route.ts',
  'app/api/admin/configuracoes/whatsapp/onboarding/concluir/route.ts',
].map((path) => readFileSync(path, 'utf8')).join('\n');

test('migration cria somente as duas tabelas e não persiste código ou token em texto', () => {
  assert.deepEqual([...migration.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g)].map((m) => m[1]),
    ['whatsapp_conexoes', 'whatsapp_onboarding_tentativas']);
  assert.doesNotMatch(migration, /authorization_code|access_token/i);
  assert.match(migration, /state_hash bytea NOT NULL/);
  assert.match(migration, /credencial_cifrada bytea NOT NULL/);
});

test('rollback é protegido por dados e rotas administrativas preservam guarda comum', () => {
  assert.match(rollback, /Rollback 018 recusado: existem dados/);
  assert.equal((routes.match(/exigirApiAdminCrmDisponivel\(request\)/g) ?? []).length, 2);
  assert.equal((routes.match(/export async function POST/g) ?? []).length, 2);
});
