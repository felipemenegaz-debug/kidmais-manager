import assert from 'node:assert/strict';
import test from 'node:test';
import { baseDaValidade } from './pagamento.ts';
import { vencimentoEmDias } from './dominio.ts';

/** B-14 (D-B14-15): validade dos créditos recriados contada da data do pagamento no Asaas. Sem banco. */
const AGORA = Date.parse('2026-11-05T18:30:00Z');
const lido = (extra: Record<string, string | null> = {}) => ({ paymentDate: '2026-10-21', confirmedDate: null, clientPaymentDate: null, ...extra });

test('sem baseValidade (web, webhook, cron): a validade conta de agora, como antes', () => {
    assert.equal(baseDaValidade(AGORA, lido(), undefined), AGORA);
});

test('baseValidade PAGAMENTO: conta da data do pagamento (a mais antiga informada), ao meio-dia de Brasília', () => {
    const base = baseDaValidade(AGORA, lido({ clientPaymentDate: '2026-10-20', confirmedDate: '2026-10-22' }), 'PAGAMENTO')!;
    assert.equal(base, Date.parse('2026-10-20T15:00:00Z'));
    assert.equal(vencimentoEmDias(base, 90), vencimentoEmDias(Date.parse('2026-10-20T12:00:00-03:00'), 90));
    assert.ok(vencimentoEmDias(base, 90) < vencimentoEmDias(AGORA, 90), 'o cliente não ganha os dias entre o pagamento e a recuperação');
});

test('baseValidade PAGAMENTO sem data informada → null (o pedido vai para REVISAO, nunca credita com a data de agora)', () => {
    assert.equal(baseDaValidade(AGORA, lido({ paymentDate: null }), 'PAGAMENTO'), null);
    assert.equal(baseDaValidade(AGORA, lido({ paymentDate: '21/10/2026' }), 'PAGAMENTO'), null);
});
