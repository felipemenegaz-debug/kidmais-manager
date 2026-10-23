import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import ts from 'typescript';
import { achar, carregarComponente, cssFalso, elementos, tique } from './teste-componente.ts';
import * as errosPreco from '../../lib/comercial/services/errors.ts';
import { preservarPrecoHistorico } from '../../lib/fechamentos/revisao-preco.ts';
import { duracaoAceita, duracaoDoIntervalo } from '../../lib/disponibilidade/services/horario.utils.ts';
import { gerarCandidatosLivres } from '../../lib/disponibilidade/services/availability.service.ts';

/**
 * Parecer do Astra (P2, 22/10/2026): na tela de edição, o horário livre oferecia só candidatos de 4 horas. Cenário:
 * festa de 3 horas (10h–13h) remarcada para 15h–18h, com bloqueio das 18h às 19h. Fluxo API → seletor → gravação com
 * o gerador real do horário livre (bloqueio simulado). P3: duracaoDoIntervalo nunca lança.
 */
const id = '00000000-0000-4000-8000-000000000001';
const fonte = {
  fechamento: { id, origemFechamento: 'ATENDIMENTO_KIDMAIS', pacoteId: id, configuracaoAgendaId: id,
    dataEvento: '2026-11-20', convidados: 50, horarioInicio: '10:00:00', horarioFim: '13:00:00', valorTabela: 5000,
    valorNegociado: null, buffetStatus: 'PENDENTE', clienteId: id, aniversarianteId: null },
  cliente: null, aniversariante: null, adicionais: [], fonteHash: 'hash',
};
const minutos = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
// Bloqueio 18h–19h; sem duração, 4 horas (como o motor).
function disponibilidade(opcoes?: { duracaoMinutos?: number | null }) {
  const horarios = gerarCandidatosLivres(60, opcoes?.duracaoMinutos ?? 240).map((c) => ({
    inicio: c.inicio, fim: c.fim, status: c.inicioMinutos < minutos('19:00') && c.fimMinutos > minutos('18:00') ? 'INDISPONIVEL' : 'DISPONIVEL',
  }));
  return { data: fonte.fechamento.dataEvento, periodos: [{ configuracaoId: id, nome: 'Horário livre', horarios }] };
}

function rota(f: typeof fonte = fonte) {
  const opcoes: unknown[] = [];
  const tx = { query: async () => ({ rows: [] }) };
  const r = carregarComponente('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', {
    zod: { z },
    '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({}) },
    '@/lib/http/api-response': { jsonNoStore: (b: unknown) => Response.json(b), apiErrorResponse: () => Response.json({ ok: false, erro: 'inválido' }, { status: 400 }) },
    '@/lib/saas/provar-tenant': { withTenantTransaction: async (_s: unknown, _e: unknown, fn: (t: typeof tx, tenant: object) => unknown) => fn(tx, { empresaComprovada: id }) },
    '@/lib/contratos/services/administrativo.service': { versaoDoTenant: async () => ({ versao: { id }, empresaId: id }) },
    '@/lib/contratos/services/revisao-inicial': {},
    '@/lib/fechamentos/services/revisao-operacional.service': { fontesPreparacao: async () => f },
    '@/lib/disponibilidade/services': {
      duracaoAceita, duracaoDoIntervalo,
      consultarDisponibilidadeData: async (...args: unknown[]) => { opcoes.push(args[4]); return disponibilidade(args[4] as { duracaoMinutos?: number }); },
    },
    '@/lib/comercial/composicao': { listarCodigosInclusos: async () => [] },
    '@/lib/comercial/services/errors': errosPreco,
    '@/lib/comercial/regras-pagamento': { lerRegrasPagamento: async () => null },
    '@/lib/comercial/services': {
      listarPacotesComerciais: async () => [],
      listarCatalogoAdicionais: async () => ({ itens: [] }),
      calcularResumoComercial: async () => ({ valorTotalTabela: 5000 }),
    },
  });
  const get = (url: string) => (r.modulo.GET as (req: object, ctx: object) => Promise<Response>)(
    { nextUrl: new URL(url, 'https://exemplo.invalid') }, { params: Promise.resolve({ versaoId: id }) });
  return { get, opcoes };
}

const horario = (dados: ReturnType<typeof disponibilidade>, inicio: string) => dados.periodos[0].horarios.find((h) => h.inicio === inicio);

test('P3: duração do intervalo devolve null para horário inválido, sem lançar', () => {
  assert.equal(duracaoDoIntervalo('25:00', '26:00'), null);
  assert.equal(duracaoDoIntervalo('15:60', '18:00'), null);
  assert.equal(duracaoDoIntervalo('', '18:00'), null);
  assert.equal(duracaoDoIntervalo('15:00', 'abc'), null);
  assert.equal(duracaoDoIntervalo('18:00', '15:00'), null);
  assert.equal(duracaoDoIntervalo('15:00:00', '18:00:00'), 180);
});

test('API da edição: carga inicial usa a duração da festa; ?duracao= do formulário prevalece; inválida é recusada', async () => {
  const { get, opcoes } = rota();
  const inicial = await (await get('/edicao')).json();
  assert.deepEqual(opcoes[0], { duracaoMinutos: 180 });
  assert.deepEqual(horario(inicial.data.disponibilidade, '15:00'), { inicio: '15:00', fim: '18:00', status: 'DISPONIVEL' });
  // Controle: sem duração, o mesmo início vira 15h–19h e cruza o bloqueio.
  assert.deepEqual(horario(disponibilidade(), '15:00'), { inicio: '15:00', fim: '19:00', status: 'INDISPONIVEL' });
  await get('/edicao?duracao=300');
  assert.deepEqual(opcoes[1], { duracaoMinutos: 300 });
  for (const ruim of ['abc', '0', '1440', '90.5']) assert.equal((await get(`/edicao?duracao=${ruim}`)).status, 400, ruim);
  assert.equal(opcoes.length, 2, 'duração inválida não chega à consulta');
});

test('tela de edição: envia a duração atual, oferece 15h–18h livre e grava o intervalo de 3 horas', async () => {
  const { get } = rota();
  const urls: string[] = [];
  const salvos: Record<string, unknown>[] = [];
  const tela = carregarComponente('components/admin/EdicaoFesta.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async (url: string) => { urls.push(url); return get(url); } },
    '@/lib/fechamentos/convidados': { atalhosConvidados: () => [] },
    '@/lib/disponibilidade/services/horario.utils': { duracaoDoIntervalo },
    '@/lib/comercial/condicao-pagamento': { calcularCondicaoComercial: () => ({ valorFinalContrato: 5000 }) },
    '@/lib/comercial/regras-pagamento': { percentualDaForma: () => 0 },
    '@/lib/contratos/documento/formatters': { formatarMoeda: String },
    '@/lib/fechamentos/revisao-preco': { preservarPrecoHistorico }, './admin.module.css': cssFalso,
  });
  const props = { versaoId: id, revisao: 1, serverError: '', onClose: () => {}, onSave: async (b: Record<string, unknown>) => { salvos.push(b); return true; } };
  const render = () => tela.render('default', props);
  render(); tela.efeitos(); await tique(); await tique();
  render(); tela.efeitos();
  await new Promise((r) => setTimeout(r, 350)); await tique(); await tique();
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1], 'https://exemplo.invalid').searchParams.get('duracao'), '180');
  const seletor = achar(render(), 'select', 'Horário');
  const opcoes = elementos(seletor).filter((e) => e.type === 'option');
  assert.equal(opcoes.find((o) => o.props.value === '15:00|18:00')?.props.disabled, false);
  assert.equal(opcoes.find((o) => o.props.value === '17:00|20:00')?.props.disabled, true, 'cruza o bloqueio');
  assert.ok(opcoes.every((o) => !String(o.props.value).startsWith('15:00|19')), 'nenhuma opção de 4 horas');
  (seletor.props.onChange as (e: unknown) => void)({ target: { value: '15:00|18:00' } });
  (achar(achar(render(), 'label', /^Motivo/), 'input').props.onChange as (e: unknown) => void)({ target: { value: 'Remarcação' } });
  render(); tela.efeitos();
  await (achar(render(), 'form').props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  assert.equal(salvos[0].horarioInicio, '15:00');
  assert.equal(salvos[0].horarioFim, '18:00');
  assert.equal(urls.length, 2, 'escolher um horário da mesma duração não refaz a consulta');
});

// Gravação: calcularEdicaoFechamento revalida o intervalo enviado pela tela com a duração dele.
function servicoEdicao() {
  const consultas: unknown[] = [];
  const mocks: Record<string, unknown> = {
    '../../comercial/services': { calcularResumoComercial: async () => ({ pacote: { pacote: { id, convidadosMinimos: 1 } }, adicionais: { itens: [] } }) },
    '../../comercial/condicao-pagamento': {}, '../../comercial/regras-pagamento': {},
    '../../disponibilidade/services': {
      duracaoDoIntervalo,
      consultarDisponibilidadeData: async (...args: unknown[]) => { consultas.push(args[4]); return disponibilidade(args[4] as { duracaoMinutos?: number }); },
    },
    '../../disponibilidade/repositories': { adquirirLockConfirmacaoAgenda: async () => {} },
    '../repositories': { empresaDoFechamentoComTrava: async () => id },
    './edicao-administrativa-schema': { edicaoFestaSchema: { parse: (x: unknown) => x } },
    '../../comercial/composicao': { listarCodigosInclusos: async () => [] },
    './errors': { FechamentoServiceError: class extends Error { constructor(_c: string, m: string) { super(m); } } },
  };
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync('lib/fechamentos/services/edicao-administrativa.service.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', code)((n: string) => mocks[n] ?? {}, exports);
  const calcular = exports.calcularEdicaoFechamento as (f: unknown, raw: unknown, tx: unknown) => Promise<unknown>;
  const pedido = (inicio: string, fim: string) => ({ ...fonte.fechamento, horarioInicio: inicio, horarioFim: fim, adicionais: [] });
  return { calcular: (inicio: string, fim: string) => calcular(fonte.fechamento, pedido(inicio, fim), {}), consultas };
}

test('gravação: 15h–18h passa pela agenda com 180 min; 15h–19h (cruza o bloqueio) é recusado', async () => {
  const { calcular, consultas } = servicoEdicao();
  // Depois da agenda o cálculo segue com dependências não simuladas; basta não ser a recusa de horário.
  await calcular('15:00', '18:00').catch((e: Error) => assert.doesNotMatch(e.message, /indisponível/));
  assert.deepEqual(consultas[0], { duracaoMinutos: 180 });
  await assert.rejects(calcular('15:00', '19:00'), /indisponível/);
  assert.deepEqual(consultas[1], { duracaoMinutos: 240 });
});

// Navegador de 22/10 (P2-N2): festa marcada num horário fixo que o modo livre não oferece mais — o horário atual aparece
// como opção (estado coerente) e trocar para "Horário livre" traz os candidatos e grava o novo horário.
test('edição: festa em horário antigo fora da lista — período atual visível, troca para o horário livre e grava', async () => {
  const ANTIGO = '00000000-0000-4000-8000-0000000000a1';
  const { get } = rota({ ...fonte, fechamento: { ...fonte.fechamento, configuracaoAgendaId: ANTIGO } });
  const urls: string[] = [];
  const salvos: Record<string, unknown>[] = [];
  const tela = carregarComponente('components/admin/EdicaoFesta.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async (url: string) => { urls.push(url); return get(url); } },
    '@/lib/fechamentos/convidados': { atalhosConvidados: () => [] },
    '@/lib/disponibilidade/services/horario.utils': { duracaoDoIntervalo },
    '@/lib/comercial/condicao-pagamento': { calcularCondicaoComercial: () => ({ valorFinalContrato: 5000 }) },
    '@/lib/comercial/regras-pagamento': { percentualDaForma: () => 0 },
    '@/lib/contratos/documento/formatters': { formatarMoeda: String },
    '@/lib/fechamentos/revisao-preco': { preservarPrecoHistorico }, './admin.module.css': cssFalso,
  });
  const props = { versaoId: id, revisao: 1, serverError: '', onClose: () => {}, onSave: async (b: Record<string, unknown>) => { salvos.push(b); return true; } };
  const render = () => tela.render('default', props);
  const esperar = async () => { render(); tela.efeitos(); await new Promise((r) => setTimeout(r, 350)); await tique(); await tique(); };
  render(); tela.efeitos(); await tique(); await tique();
  await esperar();
  const periodo = achar(render(), 'select', 'Período');
  const opcoesPeriodo = elementos(periodo).filter((e) => e.type === 'option');
  assert.equal(periodo.props.value, ANTIGO);
  assert.deepEqual(opcoesPeriodo.map((o) => o.props.value), [ANTIGO, id], 'o horário atual aparece antes dos oferecidos');
  assert.match(String(elementos(opcoesPeriodo[0]).map((e) => e.props.children).flat().join('')), /Horário atual da festa/);
  // Ainda no horário antigo: só o horário atual (o período não está na lista).
  assert.equal(elementos(achar(render(), 'select', 'Horário')).filter((e) => e.type === 'option').length, 1);
  (periodo.props.onChange as (e: unknown) => void)({ target: { value: id } });
  await esperar();
  const horario = achar(render(), 'select', 'Horário');
  const candidatos = elementos(horario).filter((e) => e.type === 'option');
  assert.equal(candidatos.find((o) => o.props.value === '15:00|18:00')?.props.disabled, false, 'candidatos do horário livre com a duração atual');
  (horario.props.onChange as (e: unknown) => void)({ target: { value: '15:00|18:00' } });
  (achar(achar(render(), 'label', /^Motivo/), 'input').props.onChange as (e: unknown) => void)({ target: { value: 'Remarcação para o horário livre' } });
  render(); tela.efeitos();
  await (achar(render(), 'form').props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  assert.deepEqual([salvos[0].configuracaoAgendaId, salvos[0].horarioInicio, salvos[0].horarioFim], [id, '15:00', '18:00']);
});
