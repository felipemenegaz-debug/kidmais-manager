import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContratoSnapshot } from '../repositories/models.ts';
import { analisarRevisao } from './alteracoes.ts';

/**
 * Plano "importados com adicionais" (R2-4): a reclassificação do contrato histórico (adicionais sem itens passam a compor o
 * pacote) é EXPLICADA, sem esconder diferenças nem dispensar assinaturas; outra mudança financeira mantém o aviso.
 */
const comercial = (o: Record<string, number>) => ({ valorPacoteBase: 8000, descontoPercentual: 0, valorDescontoPacote: 0, valorPacoteAplicado: 8000, valorAdicionais: 500, valorTabela: 8500, valorFinalContrato: 8500, ...o });
const snap = (origem: string, c: Record<string, number>, convidados = 80) => ({
  schemaVersao: 1, fechamento: { id: 'f', status: 'CONFIRMADO', origem }, evento: { data: '2027-02-17', horarioInicio: '14:00', horarioFim: '18:00', convidados },
  comercial: comercial(c),
}) as unknown as ContratoSnapshot;

test('só a reclassificação: explica o valor, lista as diferenças, exige assinatura e não acusa impacto financeiro', () => {
  const r = analisarRevisao(snap('IMPORTACAO_HISTORICA', {}), snap('IMPORTACAO_HISTORICA', { valorPacoteBase: 8500, valorPacoteAplicado: 8500, valorAdicionais: 0 }));
  assert.deepEqual(r.reclassificacaoHistorica, { valor: 500 });
  assert.equal(r.impactoFinanceiro, false);
  assert.equal(r.exigeNovaAssinatura, true);
  assert.deepEqual(r.campos.map((c) => c.campo).sort(), ['comercial.valorAdicionais', 'comercial.valorPacoteAplicado', 'comercial.valorPacoteBase']);
});

test('reclassificação + outra mudança financeira ou de convidados: os dois avisos', () => {
  const comValor = analisarRevisao(snap('IMPORTACAO_HISTORICA', {}), snap('IMPORTACAO_HISTORICA', { valorPacoteBase: 8500, valorPacoteAplicado: 8500, valorAdicionais: 0, valorFinalContrato: 9000, valorTabela: 9000 }));
  assert.equal(comValor.reclassificacaoHistorica, null, 'total mudou: não é só reclassificação');
  assert.equal(comValor.impactoFinanceiro, true);
  const comDesconto = analisarRevisao(snap('IMPORTACAO_HISTORICA', {}), snap('IMPORTACAO_HISTORICA', { valorPacoteBase: 8500, valorPacoteAplicado: 8500, valorAdicionais: 0, descontoPercentual: 5 }));
  assert.deepEqual(comDesconto.reclassificacaoHistorica, { valor: 500 });
  assert.equal(comDesconto.impactoFinanceiro, true, 'outra diferença comercial mantém o aviso');
  const comConvidados = analisarRevisao(snap('IMPORTACAO_HISTORICA', {}), snap('IMPORTACAO_HISTORICA', { valorPacoteBase: 8500, valorPacoteAplicado: 8500, valorAdicionais: 0 }, 90));
  assert.deepEqual(comConvidados.reclassificacaoHistorica, { valor: 500 });
  assert.equal(comConvidados.natureza, 'MATERIAL');
});

test('contrato nativo ou adicionais que não viram pacote: sem reclassificação', () => {
  const nativo = analisarRevisao(snap('ATENDIMENTO_KIDMAIS', {}), snap('ATENDIMENTO_KIDMAIS', { valorPacoteBase: 8500, valorPacoteAplicado: 8500, valorAdicionais: 0 }));
  assert.equal(nativo.reclassificacaoHistorica, null);
  assert.equal(nativo.impactoFinanceiro, true);
  const parcial = analisarRevisao(snap('IMPORTACAO_HISTORICA', {}), snap('IMPORTACAO_HISTORICA', { valorPacoteBase: 8300, valorPacoteAplicado: 8300, valorAdicionais: 200 }));
  assert.deepEqual(parcial.reclassificacaoHistorica, { valor: 300 });
});

test('tela do contrato: explica a reclassificação junto das diferenças, sem esconder o aviso de nova assinatura', async () => {
  const { readFileSync } = await import('node:fs');
  const tela = readFileSync('components/admin/ContratoAdmin.tsx', 'utf8');
  assert.match(tela, /analise\.reclassificacaoHistorica&&<p data-reclassificacao>Reclassificação do contrato histórico: R\$ \{/);
  assert.match(tela, /de adicionais sem itens passam a compor o pacote\. O valor do contrato não muda\./);
  assert.match(tela, /Esta revisão exige nova assinatura da Kidmais e do cliente/);
  assert.match(tela, /analise\.impactoFinanceiro&&<p>Há impacto financeiro\./);
});
