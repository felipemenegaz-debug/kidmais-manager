import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

/**
 * Revisão de contrato histórico no horário original fora dos turnos atuais (decisão de 04/10/2026): o mesmo destino
 * (data, início, fim e turno) dispensa só a exigência de candidato do turno; conflito continua conferido e qualquer
 * mudança de destino — inclusive de duração — segue as validações oficiais. Sem banco: dependências simuladas.
 */
const nativeRequire = createRequire(import.meta.url);
type Chamadas = { intervalo: unknown[][]; auditorias: Array<{ acao: string; dadosDepois: { resultado: Record<string, unknown> } }>; holds: number };

function carregar(f: Record<string, unknown>, candidatos: Array<{ inicio: string; fim: string; status: string }>, intervaloLivre: boolean) {
  const chamadas: Chamadas = { intervalo: [], auditorias: [], holds: 0 };
  const mocks: Record<string, unknown> = {
    '../repositories': { buscarFechamentoPorIdParaAtualizacao: async () => f, buscarFechamentoPorId: async () => f },
    '../../disponibilidade/services': {
      consultarDisponibilidadeData: async () => ({ periodos: [{ configuracaoId: 'turno', horarios: candidatos }] }),
      intervaloSemConflito: async (...args: unknown[]) => { chamadas.intervalo.push(args); return intervaloLivre; },
    },
    '../../clientes/repositories': { registrarAuditoria: async (registro: Chamadas['auditorias'][number]) => { chamadas.auditorias.push(registro); } },
    './errors': { FechamentoServiceError: class extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } } },
  };
  const exports: Record<string, (...args: never[]) => unknown> = {};
  const code = ts.transpileModule(readFileSync('lib/fechamentos/services/revisao-operacional.service.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', code)((name: string) => (name in mocks ? mocks[name] : name === 'node:crypto' ? nativeRequire(name) : {}), exports);
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('kidmais019_ocupa')) return { rows: [{ ocupa: true }] };
      if (sql.startsWith('UPDATE fechamento_revisoes SET hold_destino_adquirido_em')) chamadas.holds++;
      return { rows: [] };
    },
  };
  return { m: exports as unknown as Modulo, tx, chamadas };
}
type Modulo = {
  horarioHistoricoPreservado: (v: Record<string, unknown>, d: Record<string, unknown>) => boolean;
  revalidarAgendaRevisao: (tx: unknown, r: unknown, c: unknown, o?: { naoFalharPorConflito?: boolean; mudouDestino?: boolean }) => Promise<boolean>;
};

const HISTORICO = { id: 'f', origemFechamento: 'IMPORTACAO_HISTORICA', dataEvento: '2026-11-20', horarioInicio: '14:00:00', horarioFim: '18:00:00', configuracaoAgendaId: 'turno', status: 'CONFIRMADO' };
const TURNO = [{ inicio: '09:30', fim: '21:30', status: 'DISPONIVEL' }, { inicio: '10:00', fim: '22:00', status: 'DISPONIVEL' }, { inicio: '10:30', fim: '22:30', status: 'DISPONIVEL' }];
const revisao = (operacao: Record<string, unknown>) => ({ id: 'r', fechamento_id: 'f', hold_destino_adquirido_em: null, operacao: { clienteId: 'cli', ...operacao } });
const ctx = { usuarioId: 'u', requestId: 'req' };
const destino = (mudanca: Record<string, unknown> = {}) => ({ dataEvento: '2026-11-20', horarioInicio: '14:00', horarioFim: '18:00', configuracaoAgendaId: 'turno', ...mudanca });

test('horário histórico preservado: só contrato histórico, mesmo destino exato (data, início, fim/duração e turno)', () => {
  const { m } = carregar(HISTORICO, TURNO, true);
  assert.equal(m.horarioHistoricoPreservado(HISTORICO, destino()), true, 'mesmo destino (formato HH:MM:SS × HH:MM)');
  assert.equal(m.horarioHistoricoPreservado({ ...HISTORICO, origemFechamento: 'ATENDIMENTO_KIDMAIS' }, destino()), false, 'contrato nativo segue a regra nativa');
  for (const [rotulo, mudanca] of [['duração (fim)', { horarioFim: '19:00' }], ['início', { horarioInicio: '14:30' }], ['data', { dataEvento: '2026-11-21' }], ['turno', { configuracaoAgendaId: 'outro' }]] as const) {
    assert.equal(m.horarioHistoricoPreservado(HISTORICO, destino(mudanca)), false, rotulo);
  }
});

test('revisão sem mudança de destino: horário fora dos candidatos aceito quando o intervalo exato está livre; hold auditado como histórico preservado', async () => {
  const { m, tx, chamadas } = carregar(HISTORICO, TURNO, true);
  assert.equal(await m.revalidarAgendaRevisao(tx, revisao(destino()), ctx), true);
  assert.deepEqual(chamadas.intervalo, [['2026-11-20', '14:00', '18:00', tx, 'f']], 'confere o intervalo exato, excluída a própria reserva');
  assert.equal(chamadas.holds, 1);
  const hold = chamadas.auditorias.find((a) => a.acao === 'RESERVA_REVISAO_ADQUIRIDA')!;
  assert.equal(hold.dadosDepois.resultado.horarioHistoricoPreservado, true);
});

test('mesmo destino histórico com conflito (outra reserva ou bloqueio no intervalo): recusado', async () => {
  const { m, tx, chamadas } = carregar(HISTORICO, TURNO, false);
  await assert.rejects(m.revalidarAgendaRevisao(tx, revisao(destino()), ctx), /Destino da revisão indisponível/);
  assert.equal(chamadas.holds, 0);
  // Pagamento com revisão aberta (naoFalharPorConflito): registra o conflito e não falha.
  const outro = carregar(HISTORICO, TURNO, false);
  assert.equal(await outro.m.revalidarAgendaRevisao(outro.tx, revisao(destino()), ctx, { naoFalharPorConflito: true }), false);
  assert.ok(outro.chamadas.auditorias.some((a) => a.acao === 'REVISAO_DESTINO_EM_CONFLITO'));
});

test('mudança de destino a partir do horário histórico segue as validações oficiais: duração, início ou data fora dos candidatos são recusados sem a exceção', async () => {
  for (const mudanca of [{ horarioFim: '19:00' }, { horarioInicio: '13:00', horarioFim: '17:00' }, { dataEvento: '2026-11-27' }]) {
    const { m, tx, chamadas } = carregar(HISTORICO, TURNO, true);
    await assert.rejects(m.revalidarAgendaRevisao(tx, revisao(destino(mudanca)), ctx, { mudouDestino: true }), /Destino da revisão indisponível/, JSON.stringify(mudanca));
    assert.equal(chamadas.intervalo.length, 0, 'a exceção nem é consultada');
  }
  // Remarcação para um candidato oficial disponível: aceita pela regra nativa (sem a exceção).
  const { m, tx, chamadas } = carregar(HISTORICO, TURNO, true);
  assert.equal(await m.revalidarAgendaRevisao(tx, revisao(destino({ dataEvento: '2026-11-27', horarioInicio: '10:00', horarioFim: '22:00' })), ctx, { mudouDestino: true }), true);
  assert.equal(chamadas.intervalo.length, 0);
  assert.equal(chamadas.auditorias.find((a) => a.acao === 'RESERVA_REVISAO_MOVIDA')!.dadosDepois.resultado.horarioHistoricoPreservado, false);
  // Candidato oficial ocupado: recusado.
  const ocupado = carregar(HISTORICO, TURNO.map((h) => ({ ...h, status: 'INDISPONIVEL' })), true);
  await assert.rejects(ocupado.m.revalidarAgendaRevisao(ocupado.tx, revisao(destino({ dataEvento: '2026-11-27', horarioInicio: '10:00', horarioFim: '22:00' })), ctx, { mudouDestino: true }), /Destino da revisão indisponível/);
});

test('contrato nativo fora dos candidatos continua recusado (regra nativa intacta)', async () => {
  const { m, tx, chamadas } = carregar({ ...HISTORICO, origemFechamento: 'ATENDIMENTO_KIDMAIS' }, TURNO, true);
  await assert.rejects(m.revalidarAgendaRevisao(tx, revisao(destino()), ctx), /Destino da revisão indisponível/);
  assert.equal(chamadas.intervalo.length, 0);
});

test('intervalo exato: mesmas fontes da disponibilidade (reservas e bloqueios do escopo), excluída a própria contratação', () => {
  const fonte = readFileSync('lib/disponibilidade/services/availability.service.ts', 'utf8');
  const corpo = fonte.slice(fonte.indexOf('export async function intervaloSemConflito'), fonte.indexOf('export type RevalidarHorarioSelecionadoInput'));
  for (const trecho of ['resolverEscopo(customDb, undefined, fechamentoId)', 'listarBloqueiosAtivosPorPeriodo(data, data, customDb, escopo)',
    'listarFechamentosConfirmadosPorPeriodo(data, data, customDb, escopo)', 'bloqueioConflitaComCandidato(b, intervalo)', 'o.fechamentoId !== fechamentoId']) {
    assert.ok(corpo.includes(trecho), trecho);
  }
});

test('alteração comercial continua validando preço, elegibilidade e convidados antes da agenda; correção cadastral preserva o histórico', () => {
  const fonte = readFileSync('lib/fechamentos/services/revisao-operacional.service.ts', 'utf8');
  const editar = fonte.slice(fonte.indexOf('export async function editarPreparacao('), fonte.indexOf('export async function congelarPreparacao('));
  const iPreco = editar.indexOf('await calcularResumoComercial(');
  assert.ok(iPreco > 0 && iPreco < editar.indexOf('await revalidarAgendaRevisao(tx, novo, c, { mudouDestino })'), 'preço/elegibilidade/capacidade do pacote antes da agenda');
  assert.ok(editar.includes("recusar('Quantidade abaixo do mínimo do pacote.')"));
  assert.equal(fonte.split('horarioHistoricoPreservado(f, op)').length, 2, 'um único ponto de uso, na revalidação da agenda');
  assert.ok(editar.includes('const resumo = preservarHistorico ? null : await calcularResumoComercial'));
});
