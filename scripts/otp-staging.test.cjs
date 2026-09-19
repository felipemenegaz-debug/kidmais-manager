/* eslint-disable @typescript-eslint/no-require-imports -- Teste CommonJS do factory TypeScript real. */
const assert = require('node:assert/strict');
const test = require('node:test');
require('./pagamentos-test-support.cjs');

const { criarIdentityServiceComAmbiente } = require('../lib/identidade/services/identity.service.ts');
const { IdentityServiceError } = require('../lib/identidade/services/errors.ts');

test('factory recusa staging sem WhatsApp antes de criar ou gerar OTP', () => {
  const chaves = ['NODE_ENV','KIDMAIS_DEPLOY_ENV','KIDMAIS_STAGING_OTP_DISABLED','IDENTIDADE_OTP_PROVIDER','IDENTIDADE_OTP_PEPPER'];
  const anteriores = Object.fromEntries(chaves.map((chave) => [chave, process.env[chave]]));
  let geracoes = 0;
  try {
    process.env.NODE_ENV = 'production';
    process.env.KIDMAIS_DEPLOY_ENV = 'staging';
    process.env.KIDMAIS_STAGING_OTP_DISABLED = 'SIM';
    process.env.IDENTIDADE_OTP_PROVIDER = 'disabled';
    delete process.env.IDENTIDADE_OTP_PEPPER;
    assert.throws(
      () => criarIdentityServiceComAmbiente(async () => undefined, { gerarOtp: () => { geracoes += 1; return '123456'; } }),
      (error) => error instanceof IdentityServiceError && error.code === 'OTP_INDISPONIVEL' && error.httpStatus === 503,
    );
    assert.equal(geracoes, 0);
  } finally {
    for (const chave of chaves) {
      const valor = anteriores[chave];
      if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor;
    }
  }
});

test('produção nunca aceita provider disabled', () => {
  const chaves = ['NODE_ENV','KIDMAIS_DEPLOY_ENV','KIDMAIS_STAGING_OTP_DISABLED','IDENTIDADE_OTP_PROVIDER'];
  const anteriores = Object.fromEntries(chaves.map((chave) => [chave, process.env[chave]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.KIDMAIS_DEPLOY_ENV = 'production';
    process.env.KIDMAIS_STAGING_OTP_DISABLED = 'SIM';
    process.env.IDENTIDADE_OTP_PROVIDER = 'disabled';
    assert.throws(
      () => criarIdentityServiceComAmbiente(async () => undefined),
      (error) => error instanceof IdentityServiceError && error.code === 'CONFIGURACAO_IDENTIDADE_INVALIDA' && error.httpStatus === 500,
    );
  } finally {
    for (const chave of chaves) {
      const valor = anteriores[chave];
      if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor;
    }
  }
});

test('factory bloqueia Gupshup antes de gerar código, persistir ou enviar', () => {
  const chaves = ['NODE_ENV', 'KIDMAIS_DEPLOY_ENV', 'KIDMAIS_STAGING_OTP_DISABLED', 'IDENTIDADE_OTP_PROVIDER', 'IDENTIDADE_OTP_PEPPER', 'GUPSHUP_OTP_ENABLED'];
  const anteriores = Object.fromEntries(chaves.map(chave => [chave, process.env[chave]]));
  let geracoes = 0;
  let envios = 0;
  try {
    process.env.NODE_ENV = 'production';
    process.env.KIDMAIS_DEPLOY_ENV = 'staging';
    process.env.IDENTIDADE_OTP_PROVIDER = 'gupshup';
    delete process.env.IDENTIDADE_OTP_PEPPER;
    delete process.env.KIDMAIS_STAGING_OTP_DISABLED;
    for (const enabled of [undefined, 'false', 'true']) {
      if (enabled === undefined) delete process.env.GUPSHUP_OTP_ENABLED;
      else process.env.GUPSHUP_OTP_ENABLED = enabled;
      if (enabled === 'true') process.env.KIDMAIS_STAGING_OTP_DISABLED = 'SIM';
      assert.throws(
        () => criarIdentityServiceComAmbiente(async () => { envios += 1; }, { gerarOtp: () => { geracoes += 1; return '123456'; } }),
        error => error instanceof IdentityServiceError && error.code === 'OTP_INDISPONIVEL' && error.httpStatus === 503,
      );
    }
    assert.equal(geracoes, 0);
    assert.equal(envios, 0);
  } finally {
    for (const [chave, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor;
    }
  }
});
