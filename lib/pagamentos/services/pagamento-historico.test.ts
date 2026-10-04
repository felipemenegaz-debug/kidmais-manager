import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fluxoInicialDoPagamento } from './pagamento-historico.ts';

/** Caminho oficial da obrigação financeira para contrato nativo e histórico (061). */
const codigo = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as { code?: string }).code; } };

test('contrato nativo: regra de sempre (só com contrato assinado no fechamento)', () => {
  assert.equal(fluxoInicialDoPagamento({ fechamentoStatus: 'CONTRATO_ASSINADO', origemFechamento: 'CLIENTE', versaoId: 'v2', versaoConferidaId: null }), 'NATIVO');
  assert.equal(codigo(() => fluxoInicialDoPagamento({ fechamentoStatus: 'CONFIRMADO', origemFechamento: 'ATENDIMENTO_KIDMAIS', versaoId: 'v2', versaoConferidaId: null })), 'STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO');
});

test('contrato histórico: na versão conferida o caminho é "Conferir pagamentos"; depois de revisão, o plano nativo na versão vigente', () => {
  assert.equal(codigo(() => fluxoInicialDoPagamento({ fechamentoStatus: 'CONFIRMADO', origemFechamento: 'IMPORTACAO_HISTORICA', versaoId: 'v1', versaoConferidaId: 'v1' })), 'CONFERENCIA_HISTORICA_PENDENTE');
  assert.equal(codigo(() => fluxoInicialDoPagamento({ fechamentoStatus: 'CONFIRMADO', origemFechamento: 'IMPORTACAO_HISTORICA', versaoId: 'v2', versaoConferidaId: null })), 'CONFERENCIA_HISTORICA_PENDENTE', 'sem vínculo não presume nada');
  assert.equal(fluxoInicialDoPagamento({ fechamentoStatus: 'CONFIRMADO', origemFechamento: 'IMPORTACAO_HISTORICA', versaoId: 'v2', versaoConferidaId: 'v1' }), 'HISTORICO_REVISADO');
  assert.equal(codigo(() => fluxoInicialDoPagamento({ fechamentoStatus: 'CANCELADO', origemFechamento: 'IMPORTACAO_HISTORICA', versaoId: 'v2', versaoConferidaId: 'v1' })), 'STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO');
});

test('serviço nativo usa a decisão: histórico revisado mantém o fechamento CONFIRMADO e a reserva confirmada; plano nativo validado', () => {
  const svc = readFileSync('lib/pagamentos/services/pagamento.service.ts', 'utf8');
  const corpo = svc.slice(svc.indexOf('export async function criarPagamentoDoFechamento('), svc.indexOf('/** `tx`: transação do tenant'));
  assert.match(corpo, /const fluxo = fluxoInicialDoPagamento\(/);
  assert.ok(corpo.indexOf('fluxoInicialDoPagamento(') < corpo.indexOf('const pagamento = await criarPagamento('), 'decide antes de gravar');
  assert.ok(corpo.indexOf('fluxoInicialDoPagamento(') < corpo.indexOf('validarCondicaoContratual('), 'histórico: orientação antes da validação do plano');
  assert.ok(corpo.indexOf('validarPlanoPagamento(valorTotal, plano, versao.snapshot.evento.data)') > 0, 'regra nativa do plano intacta (sem exceção de vencimento)');
  assert.match(corpo, /if \(fluxo === "HISTORICO_REVISADO"\) await marcarReservaPagamento\(pagamento\.id, "CONFIRMADA", tx\);/);
  assert.match(corpo, /fluxo === "HISTORICO_REVISADO" \? fechamento : await marcarFechamentoAguardandoPagamento\(fechamento\.id, tx\)/);
  assert.doesNotMatch(corpo, /fechamento\.status !== "CONTRATO_ASSINADO"/, 'a regra do status passou para a decisão única');
  // Tela: com revisão vigente o Financeiro mostra o plano nativo; com revisão aberta, aguarda; na v1, a conferência.
  const tela = readFileSync('components/admin/ContratoAdmin.tsx', 'utf8');
  assert.match(tela, /caminhoFinanceiro==='AGUARDAR_REVISAO'\?<p role="status">/);
  assert.match(tela, /caminhoFinanceiro==='CONFERIR_HISTORICO'\?<IntegracaoContrato/);
  // Regra única do caminho, usada pela tela do contrato e pela tela da importação.
  assert.ok(readFileSync('lib/contratos/importados.ts', 'utf8').includes('caminhoFinanceiro({ conferido: l.fin_situacao !== null, comPagamento: l.com_pagamento, revisaoAberta: l.revisao_aberta, vigenteConferida: l.vigente_conferida })'));
  const regra = readFileSync('lib/contratos/integracao-importados/repositorio.ts', 'utf8');
  assert.ok(regra.includes("if (e.conferido || e.comPagamento) return 'CONCLUIDO';") && regra.includes("return e.vigenteConferida ? 'CONFERIR_HISTORICO' : 'PLANO_NA_VERSAO_VIGENTE';"));
});
