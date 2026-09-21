import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { concluirOnboardingSchema, exigirRepresentanteRecente, stateCorresponde } from './onboarding-core.ts';

type SessaoTeste = { id: string; usuario_id: string; nome: string; cargo: null; papel: string; autenticado_em: string; expira_em: string; csrf_hash: string };
function sessao(overrides: Partial<SessaoTeste> = {}): SessaoTeste {
  return { id: randomUUID(), usuario_id: randomUUID(), nome: 'Usuário Sintético', cargo: null,
    papel: 'REPRESENTANTE_AUTORIZADO', autenticado_em: new Date(1_000_000).toISOString(),
    expira_em: new Date(2_000_000).toISOString(), csrf_hash: 'hash', ...overrides };
}

test('somente representante com reautenticação recente é aceito', () => {
  assert.doesNotThrow(() => exigirRepresentanteRecente(sessao(), 1_000_000 + 299_999));
  assert.throws(() => exigirRepresentanteRecente(sessao({ papel: 'ADMINISTRATIVO' }), 1_000_000), /Somente representante/);
  assert.throws(() => exigirRepresentanteRecente(sessao(), 1_000_000 + 300_001), /Confirme sua senha/);
});

test('state é comparado pelo hash e payload rejeita campos inesperados', () => {
  const state = Buffer.alloc(32, 3).toString('base64url');
  assert.equal(stateCorresponde(state, createHash('sha256').update(state).digest()), true);
  assert.equal(stateCorresponde(Buffer.alloc(32, 4).toString('base64url'), createHash('sha256').update(state).digest()), false);
  assert.equal(concluirOnboardingSchema.safeParse({ tentativaId: randomUUID(), state, authorizationCode: 'codigo-123',
    businessId: '1', wabaId: '2', phoneNumberId: '3', accessToken: 'proibido' }).success, false);
});
