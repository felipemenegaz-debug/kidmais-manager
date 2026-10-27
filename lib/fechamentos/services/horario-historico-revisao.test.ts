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

function carregar(f: Record<string, unknown>, candidatos: Array<{ inicio: string; fim: string; status: string }>, intervaloLivre: boolean, periodo = 'turno') {
  const chamadas: Chamadas = { intervalo: [], auditorias: [], holds: 0 };
  const mocks: Record<string, unknown> = {
    '../repositories': { buscarFechamentoPorIdParaAtualizacao: async () => f, buscarFechamentoPorId: async () => f },
    '../../disponibilidade/services': {
      duracaoDoIntervalo: () => 240,
      consultarDisponibilidadeData: async () => ({ periodos: [{ configuracaoId: periodo, horarios: candidatos }] }),
      intervaloSemConflito: async (...args: unknown[]) => { chamadas.intervalo.push(args); return intervaloLivre; },
    },
    '../../clientes/repositories': { registrarAuditoria: async (registro: Chamadas['auditorias'][number]) => { chamadas.auditorias.push(registro); } },
    // 094: sem capacidade por salão neste cenário, o destino não exige salão.
    '../../agenda/salao-festa.ts': { escolherSalaoDestinoRevisao: async () => ({ exigido: false, salao: null }) },
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
  horarioHistoricoPreservado: (v: Record<string, unknown>, d: Record<string, unknown>, oferecido?: boolean) => boolean;
  revalidarAgendaRevisao: (tx: unknown, r: unknown, c: unknown, o?: { naoFalharPorConflito?: boolean; mudouDestino?: boolean }) => Promise<{ livre: boolean }>;
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
  assert.equal((await m.revalidarAgendaRevisao(tx, revisao(destino()), ctx)).livre, true);
  // Navegador de 22/10 (P2-N1): também o horário configurado da festa, para a regra da 094 (salão/capacidade).
  assert.deepEqual(chamadas.intervalo, [['2026-11-20', '14:00', '18:00', tx, 'f', 'turno']], 'confere o intervalo exato, excluída a própria reserva');
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
  assert.equal((await outro.m.revalidarAgendaRevisao(outro.tx, revisao(destino()), ctx, { naoFalharPorConflito: true })).livre, false);
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
  assert.equal((await m.revalidarAgendaRevisao(tx, revisao(destino({ dataEvento: '2026-11-27', horarioInicio: '10:00', horarioFim: '22:00' })), ctx, { mudouDestino: true })).livre, true);
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
  assert.ok(iPreco > 0 && iPreco < editar.indexOf('await revalidarAgendaRevisao(tx, salvo, c, { mudouDestino })'), 'preço/elegibilidade/capacidade do pacote antes da agenda');
  assert.ok(editar.includes("recusar('Quantidade abaixo do mínimo do pacote.')"));
  assert.equal(fonte.split('horarioHistoricoPreservado(f, op, horarioOferecido)').length, 2, 'um único ponto de uso, na revalidação da agenda');
  assert.ok(editar.includes('const resumo = preservarHistorico ? null : await calcularResumoComercial'));
});

// Parecer do Astra (23/10, P2): reserva NATIVA mantida no horário configurado que a agenda deixou de oferecer (modo livre).
test('reserva nativa no horário que deixou de ser oferecido: manutenção exata aceita (com ocupação conferida); destino antigo diferente recusado; candidato livre aceito', async () => {
  const NATIVA = { ...HISTORICO, origemFechamento: 'ATENDIMENTO_KIDMAIS' };
  const LIVRE = [{ inicio: '15:00', fim: '19:00', status: 'DISPONIVEL' }];
  const { m } = carregar(NATIVA, LIVRE, true, 'livre');
  assert.equal(m.horarioHistoricoPreservado(NATIVA, destino(), false), true, 'horário não oferecido: exato aceito');
  assert.equal(m.horarioHistoricoPreservado(NATIVA, destino(), true), false, 'horário ainda oferecido: regra nativa');
  assert.equal(m.horarioHistoricoPreservado(NATIVA, destino({ horarioFim: '19:00' }), false), false, 'não exato');
  // 1. Manutenção exata (abrir a preparação depois da mudança para o modo livre): aceita e a ocupação é conferida.
  const exata = carregar(NATIVA, LIVRE, true, 'livre');
  assert.equal((await exata.m.revalidarAgendaRevisao(exata.tx, revisao(destino()), ctx)).livre, true);
  assert.deepEqual(exata.chamadas.intervalo, [['2026-11-20', '14:00', '18:00', exata.tx, 'f', 'turno']]);
  assert.equal(exata.chamadas.auditorias.find((a) => a.acao === 'RESERVA_REVISAO_ADQUIRIDA')!.dadosDepois.resultado.horarioHistoricoPreservado, true);
  // Com conflito na ocupação: recusada.
  const ocupada = carregar(NATIVA, LIVRE, false, 'livre');
  await assert.rejects(ocupada.m.revalidarAgendaRevisao(ocupada.tx, revisao(destino()), ctx), /Destino da revisão indisponível/);
  // 2. Mudança para outra data ou intervalo no horário antigo (não oferecido): recusada, sem a exceção.
  for (const mudanca of [{ dataEvento: '2026-11-27' }, { horarioInicio: '13:00', horarioFim: '17:00' }]) {
    const antigo = carregar(NATIVA, LIVRE, true, 'livre');
    await assert.rejects(antigo.m.revalidarAgendaRevisao(antigo.tx, revisao(destino(mudanca)), ctx, { mudouDestino: true }), /Destino da revisão indisponível/, JSON.stringify(mudanca));
    assert.equal(antigo.chamadas.intervalo.length, 0);
  }
  // 3. Remarcação para um candidato livre do horário livre: aceita pela regra nativa.
  const remarcada = carregar(NATIVA, LIVRE, true, 'livre');
  assert.equal((await remarcada.m.revalidarAgendaRevisao(remarcada.tx, revisao(destino({ configuracaoAgendaId: 'livre', horarioInicio: '15:00', horarioFim: '19:00' })), ctx, { mudouDestino: true })).livre, true);
  assert.equal(remarcada.chamadas.intervalo.length, 0);
});
