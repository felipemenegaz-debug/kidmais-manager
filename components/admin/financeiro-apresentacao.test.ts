import test from 'node:test';
import assert from 'node:assert/strict';
import { propostaDeParcelas, origemApresentacao, contratoApresentacao, textoHistorico } from './financeiro-apresentacao.ts';
test('PIX à vista compõe uma cobrança única pelo saldo, sem complemento separado', () => {
  const futuro = [{ parcelaId: 'antiga', valorCentavos: '50000', vencimento: '2026-10-01' }];
  assert.deepEqual(propostaDeParcelas('142900', futuro, '2026-12-01', true), { modo: 'REPROGRAMAR', parcelas: [{ valorCentavos: '142900', vencimento: '2026-10-01' }] });
  assert.deepEqual(propostaDeParcelas('50000', futuro, '2026-12-01', true).parcelas, futuro);
  assert.equal(propostaDeParcelas('142900', futuro, '2026-12-01', false).parcelas.length, 2);
  assert.deepEqual(propostaDeParcelas('0', futuro, '2026-12-01', true), { modo: 'SEM_SALDO', parcelas: [] });
});
test('Origem descreve valor, data e meio; contrato coloca referência após contexto', () => {
  assert.match(origemApresentacao({ valor_bruto: '4645.00', recebido_em: '2026-09-10 10:00:00', meio_pagamento: 'PIX' }), /Recebimento de R\$\s4\.645,00 — 10\/09\/2026 — PIX/);
  assert.equal(contratoApresentacao({ id: '123456789', nome: 'Cliente', data_evento: '2026-10-10', pacote: 'Premium', convidados: 120, status: 'ASSINADO' }), 'Cliente — 10/10/2026 — Premium — 120 convidados — ASSINADO — ref. 12345678');
});
test('Texto histórico corrompido é corrigido somente na apresentação', () => {
  const fonte = Object.freeze({ texto: 'Mudança de condi��o e obrigaÃ§Ã£o' });
  assert.equal(textoHistorico(fonte.texto), 'Mudança de condição e obrigação');
  assert.equal(fonte.texto, 'Mudança de condi��o e obrigaÃ§Ã£o');
  assert.equal(textoHistorico('Condição correta — PIX'), 'Condição correta — PIX');
});

test('contrato integrado de importação histórica é identificado na lista sem perder o status do Core nos demais', () => {
  const base = { id: 'abcdef12-0000-4000-8000-000000000000', nome: 'Ana', data_evento: '2026-11-14', pacote: 'Festa', convidados: 80 };
  assert.match(contratoApresentacao({ ...base, status: 'ASSINADO', origem_fechamento: 'IMPORTACAO_HISTORICA' }), /HISTÓRICO INTEGRADO \(papel\)/);
  assert.match(contratoApresentacao({ ...base, status: 'ASSINADO', origem_fechamento: 'ATENDIMENTO_KIDMAIS' }), /— ASSINADO —/);
  assert.match(contratoApresentacao({ ...base, status: 'CANCELADO', origem_fechamento: 'IMPORTACAO_HISTORICA' }), /— CANCELADO —/);
});
