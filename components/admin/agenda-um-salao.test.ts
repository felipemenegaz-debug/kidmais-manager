import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from './teste-componente.ts';

/**
 * Decisão de Felipe (25/10/2026): nunca duas festas no mesmo horário, a não ser com salões distintos e o nome do salão
 * no contrato, no resumo do cliente e no convite. Até lá:
 * - com um salão, cada horário recebe uma festa por vez (sem campo de capacidade);
 * - a agenda com mais de um salão não pode ser escolhida (só quem já está nela continua);
 * - com salões cadastrados, o pacote diz em qual salão (ou quais) acontece.
 */
const HORARIO = '00000000-0000-4000-8000-000000000071';
const horario = { id: HORARIO, codigo: 'TURNO_1', nome: 'Primeiro horário', inicio: '11:00', fim: '15:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 3,
  desativadoAPartirDe: null, saloes: [], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } };
const agendaDe = (capacidadeTipo: 'POR_HORARIO' | 'POR_SALAO' | null) => ({
  escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: capacidadeTipo !== null },
  config: capacidadeTipo && { modo: 'FIXO', capacidadeTipo, limiteFestasDia: null, intervaloMinimoMinutos: 60, configuradoPor: 'Ana', configuradoEm: '2026-10-22T15:00:00Z' },
  saloes: capacidadeTipo === 'POR_SALAO' ? [{ id: 'S1', nome: 'Salão 1', capacidadeConvidados: null }, { id: 'S2', nome: 'Salão 2', capacidadeConvidados: null }] : [],
  combinados: [], combinadosDisponiveis: false,
  horarios: [{ ...horario, saloes: capacidadeTipo === 'POR_SALAO' ? ['S1', 'S2'] : [] }],
});

function Botao(props: { children?: unknown }) { return props.children; }

function carregar(agenda: ReturnType<typeof agendaDe>, pedidos: Array<Record<string, unknown>> = []) {
  const dados = { instalada: true, gestao: true, escopos: [agenda.escopo], agenda };
  const adminFetch = async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return Response.json({ ok: true, data: dados });
    pedidos.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, data: {} });
  };
  const base = { '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao,
    './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso };
  const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', base);
  const combinados = carregarComponente('components/admin/SaloesCombinados.tsx', base);
  const tela = carregarComponente('components/admin/AgendaConfiguracao.tsx', { ...base, './AssistenteAgenda': assistente.modulo, './SaloesCombinados': combinados.modulo });
  return { tela, assistente };
}

async function telaCarregada(agenda: ReturnType<typeof agendaDe>) {
  const { tela } = carregar(agenda);
  tela.render();
  tela.efeitos();
  await tique();
  await tique();
  return tela.render();
}

const titulos = (arvore: unknown) => elementos(arvore).filter((e) => typeof e.props.titulo === 'string').map((e) => e.props.titulo);

test('corpo salvo: com um salão a capacidade vai sempre 1 (mesmo com valor antigo maior); por salão segue os salões', () => {
  const { assistente } = carregar(agendaDe('POR_HORARIO'));
  const m = assistente.modulo as {
    formDaAgenda: (a: unknown) => { capacidadeTipo: string; horarios: Array<{ capacidade: string }> };
    corpoSalvar: (f: unknown, e: null, o: string) => { horarios: Array<{ capacidade: number }> };
    erroDosHorarios: (f: unknown) => string | null;
  };
  const umSalao = m.formDaAgenda(agendaDe('POR_HORARIO'));
  assert.equal(umSalao.horarios[0].capacidade, '3', 'a linha antiga guardava 3');
  assert.deepEqual(m.corpoSalvar(umSalao, null, 'CONFIGURACOES').horarios.map((h) => h.capacidade), [1]);
  assert.equal(m.erroDosHorarios({ ...umSalao, horarios: [{ ...umSalao.horarios[0], capacidade: 'abc' }] }), null, 'não há mais campo para validar');
  const porSalao = m.formDaAgenda(agendaDe('POR_SALAO'));
  assert.deepEqual(m.corpoSalvar(porSalao, null, 'CONFIGURACOES').horarios.map((h) => h.capacidade), [2]);
});

test('Configurações › Agenda com um salão: sem campo de capacidade, sem escolher "mais de um salão"', async () => {
  const arvore = await telaCarregada(agendaDe('POR_HORARIO'));
  assert.deepEqual(titulos(arvore).filter((t) => /salão/i.test(String(t))), [], 'nenhuma opção de salão');
  assert.match(texto(arvore), /Agenda com um salão: cada horário recebe uma festa por vez\./);
  assert.match(texto(arvore), /1 festa por vez/);
  assert.equal(elementos(arvore).filter((e) => e.type === 'input' && e.props.inputMode === 'numeric' && /festas ao mesmo tempo/i.test(texto(e))).length, 0);
  assert.doesNotMatch(texto(arvore), /Festas ao mesmo tempo/);
});

test('Configurações › Agenda por salão (já configurada assim): continua com as duas opções e os salões', async () => {
  const arvore = await telaCarregada(agendaDe('POR_SALAO'));
  assert.deepEqual(titulos(arvore).filter((t) => /salão/i.test(String(t))), ['Um salão', 'Mais de um salão']);
  // Parecer do Astra (P2): a volta para um salão fica bloqueada por ora — opção desabilitada e aviso.
  assert.equal(elementos(arvore).find((e) => e.props.titulo === 'Um salão')?.props.disabled, true);
  assert.match(texto(arvore), /Voltar da agenda com mais de um salão para um salão ainda não está disponível pela tela./);
  assert.doesNotMatch(texto(arvore), /Agenda com um salão:/);
});

test('assistente: "Sim, mais de um salão" avisa que ainda não está disponível e segue com um salão', async () => {
  const pedidos: Array<Record<string, unknown>> = [];
  const agenda = agendaDe(null);
  const { assistente } = carregar(agenda, pedidos);
  const props = { escopo: agenda.escopo, agenda, onConcluido: () => {}, onDepois: () => {} };
  let arvore = assistente.render('AssistenteAgenda', props);
  (achar(arvore, Botao, 'Começar').props.onClick as () => void)();
  arvore = assistente.render('AssistenteAgenda', props);
  (achar(arvore, 'button', 'Sim, mais de um salão').props.onClick as () => void)();
  arvore = assistente.render('AssistenteAgenda', props);
  assert.match(texto(arvore), /ainda não está disponível/);
  assert.equal(elementos(arvore).some((e) => e.props['aria-label'] === 'Salões do pacote' || /Adicionar salão/.test(texto(e as Elemento))), false, 'sem editor de salões');
  const formDaAgenda = (assistente.modulo as { formDaAgenda: (a: unknown) => { capacidadeTipo: string } }).formDaAgenda;
  assert.equal(formDaAgenda(agenda).capacidadeTipo, 'POR_HORARIO');
  // "Não, um espaço só" tira o aviso.
  (achar(arvore, 'button', 'Não, um espaço só').props.onClick as () => void)();
  assert.doesNotMatch(texto(assistente.render('AssistenteAgenda', props)), /ainda não está disponível/);
  assert.deepEqual(pedidos, []);
});

test('pacote: com salões cadastrados, salvar sem escolher salão é recusado na tela e o rótulo pede a escolha', () => {
  const pacotes = readFileSync('components/admin/PacotesAdmin.tsx', 'utf8');
  assert.match(pacotes, /const salaoFaltando = saloes\.length > 0 && saloesEscolhidos\.length === 0;/);
  assert.match(pacotes, /if \(salaoFaltando\) \{\s*setErro\(AVISO_SALAO_DO_PACOTE\);\s*return;/);
  assert.match(pacotes, /Salões do pacote \*/);
  assert.doesNotMatch(pacotes, /nenhum marcado = todos/);
  assert.equal(liberacao.AVISO_SALAO_DO_PACOTE, 'Escolha o salão ou os salões deste pacote.');
});
