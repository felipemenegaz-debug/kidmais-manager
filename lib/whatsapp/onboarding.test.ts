import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { concluirOnboardingSchema, desconectarSchema, exigirEsquemaPorEmpresa, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, stateCorresponde } from './onboarding-core.ts';

type SessaoTeste = { id: string; usuario_id: string; nome: string; cargo: null; papel: string; autenticado_em: string; expira_em: string; csrf_hash: string };
function sessao(overrides: Partial<SessaoTeste> = {}): SessaoTeste {
  return { id: randomUUID(), usuario_id: randomUUID(), nome: 'Usuário Sintético', cargo: null,
    papel: 'REPRESENTANTE_AUTORIZADO', autenticado_em: new Date(1_000_000).toISOString(),
    expira_em: new Date(2_000_000).toISOString(), csrf_hash: 'hash', ...overrides };
}

test('Gestão DA EMPRESA com reautenticação recente é aceita; Equipe e senha vencida são recusadas', () => {
  assert.doesNotThrow(() => exigirReautenticacaoRecente(sessao(), 1_000_000 + 299_999));
  assert.throws(() => exigirReautenticacaoRecente(sessao(), 1_000_000 + 300_001), /Confirme sua senha/);
  assert.doesNotThrow(() => exigirGestaoDaEmpresa('REPRESENTANTE_AUTORIZADO', 'conectar'));
  assert.throws(() => exigirGestaoDaEmpresa('ADMINISTRATIVO', 'conectar'), /Somente a Gestão da empresa pode conectar o WhatsApp/);
});

test('desconectar exige conexão, motivo de 3 a 500 caracteres e nada além disso', () => {
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: 'Troca de número' }).success, true);
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: '  a ' }).success, false);
  assert.equal(desconectarSchema.safeParse({ conexaoId: 'x', motivo: 'Troca de número' }).success, false);
  assert.equal(desconectarSchema.safeParse({ conexaoId: randomUUID(), motivo: 'Troca', empresaId: randomUUID() }).success, false, 'a empresa vem da sessão, nunca do corpo');
});

test('state é comparado pelo hash e payload rejeita campos inesperados', () => {
  const state = Buffer.alloc(32, 3).toString('base64url');
  assert.equal(stateCorresponde(state, createHash('sha256').update(state).digest()), true);
  assert.equal(stateCorresponde(Buffer.alloc(32, 4).toString('base64url'), createHash('sha256').update(state).digest()), false);
  assert.equal(concluirOnboardingSchema.safeParse({ tentativaId: randomUUID(), state, authorizationCode: 'codigo-123',
    businessId: '1', wabaId: '2', phoneNumberId: '3', accessToken: 'proibido' }).success, false);
});

test('antes da 083 aplicada, o WhatsApp por empresa responde 503 com mensagem clara (nunca erro de SQL)', async () => {
  const tx = (ok: boolean) => ({ query: async () => ({ rows: [{ ok }] }) }) as never;
  await assert.rejects(exigirEsquemaPorEmpresa(tx(false)), (e: { code?: string; httpStatus?: number }) => e.code === 'WHATSAPP_ATUALIZACAO_PENDENTE' && e.httpStatus === 503);
  await assert.doesNotReject(exigirEsquemaPorEmpresa(tx(true)));
});
