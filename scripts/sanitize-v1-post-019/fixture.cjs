'use strict';

const { hash, refuse } = require('./guards.cjs');
const VERSION = 'V1_POST019_SYNTHETIC_INPUT_V1';
const FIXED_TIME = '2030-01-02T12:00:00.000Z';
const SQL_SHA256 = '05996d1e386e10817100d093edbfa8163f3df41687b52624647469a5822426ac';
function syntheticId(label) {
  const h = hash(`${VERSION}:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function fixture() {
  return { version: VERSION, sqlSha256: SQL_SHA256, clock: FIXED_TIME, externalTransport: 'DISABLED',
    cliente: { id: syntheticId('cliente'), nome: 'SINTETICO_SANITIZER_CLIENTE_001',
      email: 'sanitizer-fixture@example.invalid', observacoes: 'SYNTHETIC_PRIVATE_CANARY_019' },
    aniversariante: { id: syntheticId('aniversariante'), nome: 'SINTETICO_ANIVERSARIANTE_001', nascimento: '2020-01-02' },
    usuario: { id: syntheticId('usuario'), nome: 'SINTETICO_USUARIO_001', email: 'admin-fixture@example.invalid' },
    document: { text: 'DOCUMENTO SINTETICO SEM VALIDADE', rendererClock: FIXED_TIME },
    scenarios: ['CRM', 'USUARIO_E_SESSAO', 'FECHAMENTO', 'CONTRATO_ASSINADO',
      'DUAS_ASSINATURAS_E_FESTA_NA_MESMA_TRANSACAO', 'PAGAMENTO', 'PDF_SINTETICO',
      'AUDITORIA_JSON', 'OTP_CONSUMIDO', 'WHATSAPP_CIPHERTEXT_ARTIFICIAL', 'MALHA_FINANCEIRA_015'],
    certifiedOutputMustBeEmpty: true };
}
function loadFixture() { refuse('FIXTURE_REFUSED'); }
module.exports = { VERSION, FIXED_TIME, SQL_SHA256, syntheticId, fixture, loadFixture };
