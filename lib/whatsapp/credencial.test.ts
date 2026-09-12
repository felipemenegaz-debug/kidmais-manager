import assert from 'node:assert/strict';
import test from 'node:test';
import { cifrarCredencialWhatsapp, decifrarCredencialWhatsapp } from './credencial.ts';

const env = { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), WHATSAPP_CREDENTIAL_KEY_VERSION: '4' };
const identidade = { ambiente: 'STAGING' as const, appId: '1', businessId: '2', wabaId: '3', phoneNumberId: '4' };

test('AES-256-GCM usa IV novo, AAD e não armazena token em texto', () => {
  const token = 'token-sintetico-nao-producao';
  const a = cifrarCredencialWhatsapp(token, identidade, env);
  const b = cifrarCredencialWhatsapp(token, identidade, env);
  assert.equal(a.iv.length, 12); assert.equal(a.tag.length, 16); assert.equal(a.keyVersion, 4);
  assert.notDeepEqual(a.iv, b.iv);
  assert.equal(a.ciphertext.includes(Buffer.from(token)), false);
  assert.equal(decifrarCredencialWhatsapp(a, identidade, env), token);
});

test('adulteração, AAD divergente e chave errada são recusados', () => {
  const cifrada = cifrarCredencialWhatsapp('token-sintetico', identidade, env);
  const adulterada = { ...cifrada, ciphertext: Buffer.from(cifrada.ciphertext) };
  adulterada.ciphertext[0] ^= 1;
  assert.throws(() => decifrarCredencialWhatsapp(adulterada, identidade, env), /integridade/);
  assert.throws(() => decifrarCredencialWhatsapp(cifrada, { ...identidade, wabaId: '99' }, env), /integridade/);
  assert.throws(() => decifrarCredencialWhatsapp(cifrada, identidade, { ...env, WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') }), /integridade/);
});
