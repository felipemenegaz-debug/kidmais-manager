import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { duracaoDoIntervalo, gerarCandidatosLivres } from '../../disponibilidade/services/availability.service.ts';

/**
 * Parecer do Astra (P2, 22/10/2026): no horário livre os candidatos dependem da duração; revisão, edição administrativa e
 * proposta inicial informam a duração do próprio intervalo. Regressões com 3 e 5 horas. Sem banco: disponibilidade
 * simulada com o gerador real do horário livre.
 */
const nativeRequire = createRequire(import.meta.url);

function carregar() {
  const consultas: unknown[][] = [];
  let holds = 0;
  const mocks: Record<string, unknown> = {
    '../repositories': { buscarFechamentoPorIdParaAtualizacao: async () => FESTA, buscarFechamentoPorId: async () => FESTA },
    '../../disponibilidade/services': {
      duracaoDoIntervalo,
      // Como o motor: sem duração, 4 horas.
      consultarDisponibilidadeData: async (...args: unknown[]) => {
        consultas.push(args);
        const duracao = (args[4] as { duracaoMinutos?: number | null } | undefined)?.duracaoMinutos ?? 240;
        return { periodos: [{ configuracaoId: 'livre', horarios: gerarCandidatosLivres(30, duracao).map((c) => ({ inicio: c.inicio, fim: c.fim, status: 'DISPONIVEL' })) }] };
      },
      intervaloSemConflito: async () => false,
    },
    '../../agenda/salao-festa.ts': { escolherSalaoDestinoRevisao: async () => ({ exigido: true, salao: 'S1' }) },
    '../../clientes/repositories': { registrarAuditoria: async () => {} },
    './errors': { FechamentoServiceError: class extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } } },
  };
  const exports: Record<string, (...args: never[]) => unknown> = {};
  const code = ts.transpileModule(readFileSync('lib/fechamentos/services/revisao-operacional.service.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', code)((name: string) => (name in mocks ? mocks[name] : name === 'node:crypto' ? nativeRequire(name) : {}), exports);
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('kidmais019_ocupa')) return { rows: [{ ocupa: true }] };
      if (sql.startsWith('UPDATE fechamento_revisoes SET hold_destino_adquirido_em')) holds++;
      return { rows: [] };
    },
  };
  return { m: exports as unknown as { revalidarAgendaRevisao: (tx: unknown, r: unknown, c: unknown) => Promise<{ livre: boolean }> }, tx, consultas, holds: () => holds };
}

const FESTA = { id: 'f', origemFechamento: 'ATENDIMENTO_KIDMAIS', dataEvento: '2026-11-20', horarioInicio: '10:00:00', horarioFim: '14:00:00', configuracaoAgendaId: 'livre', status: 'CONFIRMADO' };
const revisao = (inicio: string, fim: string) => ({ id: 'r', fechamento_id: 'f', hold_destino_adquirido_em: null,
  operacao: { clienteId: 'cli', dataEvento: '2026-11-20', horarioInicio: inicio, horarioFim: fim, configuracaoAgendaId: 'livre' } });

test('duração do intervalo: minutos entre início e fim; inválido = null', () => {
  assert.equal(duracaoDoIntervalo('15:00', '18:00'), 180);
  assert.equal(duracaoDoIntervalo('15:00:00', '20:00:00'), 300);
  assert.equal(duracaoDoIntervalo('18:00', '15:00'), null);
});

for (const [rotulo, inicio, fim, duracao] of [['3 horas', '15:00', '18:00', 180], ['5 horas', '15:00', '20:00', 300]] as const) {
  test(`horário livre: remarcação para ${inicio}–${fim} (${rotulo}) consulta com a duração do destino e é aceita`, async () => {
    const { m, tx, consultas, holds } = carregar();
    assert.equal((await m.revalidarAgendaRevisao(tx, revisao(inicio, fim), { usuarioId: 'u', requestId: 'req' })).livre, true);
    assert.deepEqual(consultas[0]?.[4], { duracaoMinutos: duracao });
    assert.equal(holds(), 1);
  });
}

test('edição administrativa e proposta inicial também informam a duração do intervalo', () => {
  const edicao = readFileSync('lib/fechamentos/services/edicao-administrativa.service.ts', 'utf8');
  assert.match(edicao, /consultarDisponibilidadeData\(input\.dataEvento, tx, undefined, \{ fechamentoId: f\.id \},\s*\{ duracaoMinutos: duracaoDoIntervalo\(input\.horarioInicio, input\.horarioFim\) \}\)/);
  const inicial = readFileSync('lib/contratos/services/revisao-inicial.ts', 'utf8');
  assert.match(inicial, /consultarDisponibilidadeData\(f\.dataEvento, tx, undefined, \{ fechamentoId: f\.id \},\s*\{ duracaoMinutos: duracaoDoIntervalo\(f\.horarioInicio, f\.horarioFim\) \}\)/);
});
