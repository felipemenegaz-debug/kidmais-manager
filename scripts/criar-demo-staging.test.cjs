/* eslint-disable @typescript-eslint/no-require-imports -- Teste Node CommonJS do script operacional. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CONSULTA_DERIVADOS_SQL,
  CPF_DEMO,
  EMAIL_DEMO,
  MARCADOR_DEMO,
  criarInputFechamento,
  validarConfiguracao,
} = require('./criar-demo-staging.cjs');

function ambiente(overrides = {}) {
  return {
    KIDMAIS_DEPLOY_ENV: 'staging',
    KIDMAIS_CRIAR_DEMO_STAGING: 'SIM',
    RENDER: 'true',
    DATABASE_URL: 'postgresql://demo:segredo-sintetico@dpg-staging.internal:5432/kidmais_staging',
    KIDMAIS_STAGING_DATABASE_NAME: 'kidmais_staging',
    KIDMAIS_DEMO_ADMIN_EMAIL: 'operador.staging@example.invalid',
    ...overrides,
  };
}

test('aceita somente a configuração explícita do staging Render', () => {
  const config = validarConfiguracao(ambiente());
  assert.equal(config.databaseName, 'kidmais_staging');
  assert.equal(config.adminEmail, 'operador.staging@example.invalid');
});

test('recusa ambiente, confirmação ou Render ausentes', () => {
  assert.throws(() => validarConfiguracao(ambiente({ KIDMAIS_DEPLOY_ENV: 'production' })), /deve ser staging/);
  assert.throws(() => validarConfiguracao(ambiente({ KIDMAIS_CRIAR_DEMO_STAGING: undefined })), /deve ser SIM/);
  assert.throws(() => validarConfiguracao(ambiente({ RENDER: undefined })), /staging do Render/);
});

test('recusa ausência de DATABASE_URL e nunca usa outra variável como fallback', () => {
  assert.throws(() => validarConfiguracao(ambiente({ DATABASE_URL: undefined, KIDMAIS_STAGING_DATABASE_URL: 'postgresql://x:y@outro/db' })), /DATABASE_URL é obrigatória/);
});

test('recusa banco real, nomes de produção, divergência e loopback', () => {
  assert.throws(() => validarConfiguracao(ambiente({ DATABASE_URL: 'postgresql://x:y@dpg.internal/kidmais_manager', KIDMAIS_STAGING_DATABASE_NAME: 'kidmais_manager' })), /produção/);
  assert.throws(() => validarConfiguracao(ambiente({ DATABASE_URL: 'postgresql://x:y@dpg.internal/kidmais_production', KIDMAIS_STAGING_DATABASE_NAME: 'kidmais_production' })), /produção/);
  assert.throws(() => validarConfiguracao(ambiente({ KIDMAIS_STAGING_DATABASE_NAME: 'outro_staging' })), /nome exato/);
  assert.throws(() => validarConfiguracao(ambiente({ DATABASE_URL: 'postgresql://x:y@127.0.0.1/kidmais_staging' })), /loopback/);
});

test('recusa destino igual ao banco configurado como produção', () => {
  assert.throws(() => validarConfiguracao(ambiente({
    KIDMAIS_PRODUCTION_DATABASE_URL: 'postgresql://outro:outro@dpg-staging.internal:5432/kidmais_staging',
  })), /destino configurado como produção/);
});

test('fixture é integralmente sintética e deixa explícito que não houve aceite', () => {
  const input = criarInputFechamento({
    data: '2098-10-11',
    periodo: { configuracaoId: 'agenda-demo' },
    horario: { inicio: '11:00', fim: '15:00' },
    pacoteId: 'pacote-completa',
    valorTabela: 9290,
  });
  assert.equal(input.cliente.nomeCompleto, 'Cliente Demonstração Kidmais');
  assert.equal(input.cliente.cpf, CPF_DEMO);
  assert.equal(input.cliente.email, EMAIL_DEMO);
  assert.match(input.cliente.email, /example\.invalid$/);
  assert.equal(input.aniversariante.nome, 'Maria Demo');
  assert.equal(input.formaPagamentoPretendida, 'CARTAO_CIELO');
  assert.equal(input.valorProposto, 9290);
  assert.match(input.observacoesEquipe, new RegExp(MARCADOR_DEMO));
  assert.match(input.observacoesEquipe, /Não representa contratação, aceite ou pagamento real/);
  assert.equal(Object.hasOwn(input, 'provaToken'), false);
});

test('script não carrega .env.local nem chama assinatura, OTP, Pagamentos ou Festa', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'criar-demo-staging.cjs'), 'utf8');
  assert.doesNotMatch(fonte, /dotenv|env-file|\.env\.local/);
  assert.doesNotMatch(fonte, /assinarContrato|iniciarDesafio|criarPagamento|criarFesta/);
});

test('verificação final segue os vínculos reais de Pagamentos e Festa', () => {
  const migrationPagamentos = fs.readFileSync(
    path.join(__dirname, '../database/migrations/20260908_011_pagamentos_base.sql'),
    'utf8',
  );
  const migrationFesta = fs.readFileSync(
    path.join(__dirname, '../database/migrations/20260911_016_festa.sql'),
    'utf8',
  );

  assert.match(migrationPagamentos, /CREATE TABLE pagamentos[\s\S]*?contrato_versao_id uuid NOT NULL/);
  assert.match(migrationFesta, /CREATE TABLE festas[\s\S]*?contrato_id uuid NOT NULL REFERENCES contratos\(id\)/);
  assert.doesNotMatch(CONSULTA_DERIVADOS_SQL, /FROM (?:pagamentos|festas) WHERE fechamento_id/);
  assert.match(CONSULTA_DERIVADOS_SQL, /FROM pagamentos WHERE contrato_versao_id=\$1/);
  assert.match(CONSULTA_DERIVADOS_SQL, /FROM festas WHERE contrato_id=\$2/);
});
