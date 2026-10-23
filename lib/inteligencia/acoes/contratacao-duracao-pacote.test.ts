import test from 'node:test';
import assert from 'node:assert/strict';
import * as politica from '../politica.ts';
import { EMPRESA, ESCOPO, servico, transpilar } from '../../disponibilidade/services/duracao-pacote-livre.test-apoio.ts';

/** Parecer do Astra (P2): na preparação da IA, duração cadastrada inválida é erro do pacote, não falta de data/turno. */
test('IA: duração cadastrada inválida chega como erro do pacote (não como data/turno indisponível)', async () => {
  const { m, tx } = servico('LIVRE', 1440);
  const composicao = transpilar('app/api/admin/inteligencia/operacoes/composicao.ts', {
    '@/lib/disponibilidade/services': { ...m, periodoDoTurno: (periodos: unknown[]) => periodos[0] },
    '@/lib/disponibilidade/escopo': { escopoDaEmpresa: async () => ESCOPO },
    '@/lib/inteligencia/politica': politica,
  }, false) as { portaContratacao: { horarios: (tx: unknown, e: string, d: string, t: string, p?: string) => Promise<unknown> } };
  await assert.rejects(composicao.portaContratacao.horarios(tx, EMPRESA, '2026-11-20', 'noite', 'COMPACTA'),
    (e: { code?: string; message: string }) => e instanceof politica.InteligenciaError && e.code === 'PACOTE_DURACAO_INVALIDA' && /Configurações › Pacotes/.test(e.message));
  // Outras falhas de agenda continuam null (comportamento anterior).
  const falha = transpilar('app/api/admin/inteligencia/operacoes/composicao.ts', {
    '@/lib/disponibilidade/services': { ...m, consultarDisponibilidadeData: async () => { throw new Error('agenda fora'); }, duracaoDoPacoteDaEmpresa: async () => null, periodoDoTurno: () => null },
    '@/lib/disponibilidade/escopo': { escopoDaEmpresa: async () => ESCOPO },
    '@/lib/inteligencia/politica': politica,
  }, false) as typeof composicao;
  assert.equal(await falha.portaContratacao.horarios(tx, EMPRESA, '2026-11-20', 'noite', 'COMPACTA'), null);
});

