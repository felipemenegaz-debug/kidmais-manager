import assert from 'node:assert/strict';
import test from 'node:test';
import { montarResumoContrato } from './resumir-contrato.ts';
import type { ContextoFerramenta } from '../ferramentas.ts';

/** Contrato histórico assinado em papel (061): a leitura não aponta assinatura eletrônica faltando. */
test('leitura da IA: contrato em papel não aparece como "Falta assinatura"', () => {
  const contexto = { hoje: '2026-10-03', geradoEm: '2026-10-03T12:00:00Z', portas: {} } as unknown as ContextoFerramenta;
  const base = { contratoId: 'k', status: 'ASSINADO', versaoVigente: 1, versaoEmPreparacao: false, dataEvento: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00',
    pacote: 'Pacote', convidados: 50, valorFinalContrato: 5000, formaPagamento: null, buffetStatus: null, assinaturas: [], canceladoEm: null };
  const papel = JSON.stringify(montarResumoContrato({ ...base, assinadoEmPapel: true }, contexto));
  assert.doesNotMatch(papel, /Falta assinatura/);
  assert.match(papel, /assinado em papel/);
  assert.match(JSON.stringify(montarResumoContrato(base, contexto)), /Falta assinatura: Kidmais e cliente/, 'contrato nativo continua apontando a falta');
});
