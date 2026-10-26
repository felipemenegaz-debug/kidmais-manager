import test from 'node:test';
import assert from 'node:assert/strict';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from './teste-componente.ts';

/**
 * 098 (salões combinados), telas, revisão do Astra de 23/10:
 * - P2-2: com alterações da agenda não salvas, criar ou desativar um combinado NÃO grava nem recarrega (o recarregamento
 *   substituiria o formulário e descartaria a edição): a tela pede salvar ou descartar; depois de descartar, a criação
 *   segue normalmente;
 * - P3-3: na agenda do dia, combinado ativo com membro desativado aparece como indisponível, nunca como livre.
 */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const AB = '00000000-0000-4000-8000-0000000000ab';
const HORARIO = '00000000-0000-4000-8000-000000000071';

const agenda = {
  escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: true },
  config: { modo: 'FIXO', capacidadeTipo: 'POR_SALAO', limiteFestasDia: null, intervaloMinimoMinutos: 60, configuradoPor: 'Ana', configuradoEm: '2026-10-22T15:00:00Z' },
  saloes: [{ id: A, nome: 'Salão A', capacidadeConvidados: null }, { id: B, nome: 'Salão B', capacidadeConvidados: null }],
  combinados: [{ id: AB, nome: 'Salão inteiro', capacidadeConvidados: 150, elegivel: true,
    membros: [{ id: A, nome: 'Salão A', ativo: true }, { id: B, nome: 'Salão B', ativo: true }] }],
  combinadosDisponiveis: true,
  horarios: [{ id: HORARIO, codigo: 'TURNO_1', nome: 'Tarde', inicio: '15:00', fim: '19:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 2,
    desativadoAPartirDe: null, saloes: [A, B], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } }],
};
const dados = { instalada: true, gestao: true, escopos: [agenda.escopo], agenda };

function Botao(props: { children?: unknown }) { return props.children; }

function telas(pedidos: Array<Record<string, unknown>>, gets: { n: number }, esperarPost?: Promise<void>, resposta: unknown = dados) {
  const adminFetch = async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') { gets.n++; return Response.json({ ok: true, data: resposta }); }
    pedidos.push(JSON.parse(String(init.body)));
    if (esperarPost) await esperarPost;
    return Response.json({ ok: true, data: { id: AB } });
  };
  const base = { 'next/link': { default: (p: { children?: unknown }) => p.children }, '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao,
    './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso };
  const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', base);
  const combinados = carregarComponente('components/admin/SaloesCombinados.tsx', base);
  const tela = carregarComponente('components/admin/AgendaConfiguracao.tsx', {
    ...base, './AssistenteAgenda': assistente.modulo, './SaloesCombinados': combinados.modulo,
  });
  return { tela, assistente, SaloesCombinados: combinados.modulo.SaloesCombinados };
}

async function carregada(t: ReturnType<typeof telas>) {
  t.tela.render();
  t.tela.efeitos();
  await tique();
  await tique();
  return () => t.tela.render();
}
const props = (arvore: unknown, tipo: unknown) => (elementos(arvore).find((e) => e.type === tipo) as Elemento).props as {
  pendenteSalvar: boolean; onCriar: (d: { nome: string; capacidadeConvidados: number | null; membros: string[] }) => Promise<boolean>;
  onDesativar: (s: { id: string; nome: string }) => Promise<void>;
};

test('formAlterado: formulário recém-carregado não tem pendência; mudar intervalo, horário ou salão tem', () => {
  const t = telas([], { n: 0 });
  const { formDaAgenda, formAlterado } = t.assistente.modulo as {
    formDaAgenda: (a: unknown) => { intervalo: string; horarios: Array<{ fim: string }>; saloes: Array<{ nome: string }> };
    formAlterado: (f: unknown, a: unknown) => boolean;
  };
  const f = formDaAgenda(agenda);
  assert.equal(formAlterado(f, agenda), false);
  assert.equal(formAlterado({ ...f, intervalo: '90' }, agenda), true);
  assert.equal(formAlterado({ ...f, horarios: [{ ...f.horarios[0], fim: '20:00' }] }, agenda), true);
  assert.equal(formAlterado({ ...f, saloes: [...f.saloes, { chave: 'novo', nome: 'Salão C', capacidade: '' }] }, agenda), true);
});

test('P2-2: com o intervalo alterado e não salvo, criar e desativar combinado não gravam nem recarregam; descartar libera', async () => {
  const pedidos: Array<Record<string, unknown>> = [];
  const gets = { n: 0 };
  const t = telas(pedidos, gets);
  let render = await carregada(t);
  assert.equal(gets.n, 1);
  assert.equal(props(render(), t.SaloesCombinados).pendenteSalvar, false);
  // Edição pendente: o intervalo mínimo (select da capacidade).
  const intervalo = elementos(render()).find((e) => e.type === 'select' && e.props.value === '60')!;
  (intervalo.props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  render = () => t.tela.render();
  const p = props(render(), t.SaloesCombinados);
  assert.equal(p.pendenteSalvar, true, 'pendência detectada');
  assert.equal(await p.onCriar({ nome: 'Outro', capacidadeConvidados: null, membros: [A, B] }), false);
  await p.onDesativar({ id: AB, nome: 'Salão inteiro' });
  assert.deepEqual(pedidos, [], 'nada gravado');
  assert.equal(gets.n, 1, 'nada recarregado');
  assert.match(texto(render()), /alterações da agenda ainda não salvas/);
  assert.ok(elementos(render()).some((e) => e.type === 'select' && e.props.value === '90'), 'a edição pendente continua na tela');
  // Descartar (Cancelar) recarrega a agenda salva; sem pendência, a criação grava e recarrega.
  (achar(render(), 'button', 'Cancelar').props.onClick as () => void)();
  await tique();
  await tique();
  const q = props(render(), t.SaloesCombinados);
  assert.equal(q.pendenteSalvar, false);
  assert.equal(await q.onCriar({ nome: 'Outro', capacidadeConvidados: null, membros: [A, B] }), true);
  assert.equal(pedidos.length, 1);
  assert.equal((pedidos[0] as Record<string, unknown>).acao, 'criar_combinado');
});

test('P2-2: o painel do combinado bloqueia os botões e mostra o aviso enquanto houver pendência', () => {
  const painel = (pendenteSalvar: boolean) => carregarComponente('components/admin/SaloesCombinados.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({}) }, './AdminPrimaryButton': { AdminPrimaryButton: Botao },
    './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso,
  }).render('SaloesCombinados', { agenda, leitura: false, ocupado: false, pendenteSalvar, onCriar: async () => true, onDesativar: async () => {} });
  const com = painel(true);
  assert.equal(achar(com, 'button', 'Desativar').props.disabled, true);
  assert.equal((elementos(com).find((e) => e.type === Botao)!.props as { disabled: boolean }).disabled, true);
  assert.match(texto(com), /Salve ou descarte/);
  const sem = painel(false);
  assert.equal(achar(sem, 'button', 'Desativar').props.disabled, false);
  assert.doesNotMatch(texto(sem), /Salve ou descarte/);
});

test('P3-3: agenda do dia — combinado inelegível aparece como indisponível, não como livre', async () => {
  const lista = [
    { id: A, nome: 'Salão A', combinado: false, membros: [], ocupacoes: [], elegivel: true, membrosInativos: [] },
    { id: AB, nome: 'Salão inteiro', combinado: true, membros: ['Salão A', 'Salão B'], ocupacoes: [], elegivel: false, membrosInativos: ['Salão B'] },
  ];
  const tela = carregarComponente('components/admin/SaloesDoDia.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: true, data: { saloes: lista } }) },
  });
  const classes = { painel: 'p', lista: 'l', livre: 'livre', ocupado: 'ocupado' };
  tela.render('SaloesDoDia', { data: '2026-11-21', unidadeId: '', classes });
  tela.efeitos();
  await tique();
  await tique();
  const arvore = tela.render('SaloesDoDia', { data: '2026-11-21', unidadeId: '', classes });
  const linha = (nome: string) => elementos(arvore).find((e) => e.props['data-salao-dia'] === nome)!;
  assert.match(texto(linha('Salão A')), /Livre/);
  assert.match(texto(linha('Salão inteiro')), /Indisponível: Salão B desativado/);
  assert.doesNotMatch(texto(linha('Salão inteiro')), /Livre/);
  assert.equal(linha('Salão inteiro').props.className, 'ocupado');
});

// Rodada 2 do Astra (P2-2): texto inválido e linha incompleta também são pendência; durante a gravação nenhum controle
// aceita edição; e, se o rascunho mudar mesmo assim durante a requisição, ele é preservado no retorno.
test('rodada 2: "abc" no limite, capacidade inválida e salão sem nome contam como pendência (nada é convertido nem filtrado)', async () => {
  const t = telas([], { n: 0 });
  const { formDaAgenda, formAlterado } = t.assistente.modulo as {
    formDaAgenda: (a: unknown) => { limite: string; saloes: Array<{ chave: string; nome: string; capacidade: string }> };
    formAlterado: (f: unknown, a: unknown) => boolean;
  };
  const f = formDaAgenda(agenda);
  assert.equal(formAlterado({ ...f, limite: 'abc' }, agenda), true);
  assert.equal(formAlterado({ ...f, saloes: f.saloes.map((s, i) => (i === 0 ? { ...s, capacidade: 'abc' } : s)) }, agenda), true);
  assert.equal(formAlterado({ ...f, saloes: [...f.saloes, { chave: 'x', nome: '', capacidade: '' }] }, agenda), true);
  // Pela tela: "abc" no limite (antes vazio) bloqueia a criação e continua digitado.
  const pedidos: Array<Record<string, unknown>> = [];
  const gets = { n: 0 };
  const u = telas(pedidos, gets);
  let render = await carregada(u);
  const limite = elementos(render()).find((e) => e.type === 'input' && e.props.placeholder === 'Sem limite')!;
  (limite.props.onChange as (e: unknown) => void)({ target: { value: 'abc' } });
  render = () => u.tela.render();
  const p = props(render(), u.SaloesCombinados);
  assert.equal(p.pendenteSalvar, true);
  assert.equal(await p.onCriar({ nome: 'Outro', capacidadeConvidados: null, membros: [A, B] }), false);
  assert.deepEqual(pedidos, []);
  assert.equal(gets.n, 1);
  assert.ok(elementos(render()).some((e) => e.type === 'input' && e.props.value === 'abc'), '"abc" continua na tela');
});

for (const acao of ['criar', 'desativar'] as const) {
  test(`rodada 2: durante ${acao} combinado (resposta atrasada) os controles ficam bloqueados e um rascunho alterado é preservado`, async () => {
    let liberar!: () => void;
    const esperar = new Promise<void>((ok) => { liberar = ok; });
    const pedidos: Array<Record<string, unknown>> = [];
    const gets = { n: 0 };
    const t = telas(pedidos, gets, esperar);
    let render = await carregada(t);
    const p = props(render(), t.SaloesCombinados);
    assert.equal(p.pendenteSalvar, false);
    const operacao = acao === 'criar' ? p.onCriar({ nome: 'Outro', capacidadeConvidados: null, membros: [A, B] }) : p.onDesativar({ id: AB, nome: 'Salão inteiro' });
    await tique();
    render = () => t.tela.render();
    // Durante o POST: todos os campos e botões de edição da agenda desabilitados.
    const editaveis = elementos(render()).filter((e) => (e.type === 'input' || e.type === 'select') && e.props.onChange);
    assert.ok(editaveis.length >= 5, 'há campos na tela');
    assert.deepEqual(editaveis.filter((e) => e.props.disabled !== true).map((e) => String(e.props.value ?? e.props.placeholder)), [], 'nenhum campo editável');
    assert.equal(achar(render(), 'button', '+ Adicionar horário').props.disabled, true);
    // Defesa em profundidade: mesmo forçando a mudança (handler chamado direto), o rascunho sobrevive ao retorno.
    const intervalo = elementos(render()).find((e) => e.type === 'select' && e.props.value === '60')!;
    (intervalo.props.onChange as (e: unknown) => void)({ target: { value: '90' } });
    t.tela.render();
    t.tela.efeitos();
    liberar();
    await operacao;
    await tique();
    assert.equal(pedidos.length, 1);
    assert.equal(gets.n, 2, 'recarregou a agenda salva');
    assert.ok(elementos(render()).some((e) => e.type === 'select' && e.props.value === '90'), 'edição feita durante a requisição preservada');
    assert.match(texto(render()), /alterações ainda não salvas foram mantidas/);
    assert.equal(props(render(), t.SaloesCombinados).pendenteSalvar, true, 'continua pendente para salvar ou descartar');
  });
}

// Rodada 3 do Astra (P2-2): desativar horário, cancelar a desativação e trocar de unidade também gravam ou recarregam a
// agenda inteira; com edição pendente, exigem salvar ou descartar (nada gravado, nada recarregado, rascunho mantido).
const U1 = { estabelecimentoId: '00000000-0000-4000-8000-000000000001', nome: 'Moema', configurado: true };
const U2 = { estabelecimentoId: '00000000-0000-4000-8000-000000000002', nome: 'Pinheiros', configurado: true };
const H2 = '00000000-0000-4000-8000-000000000072';
const comHorarios = {
  ...agenda,
  escopo: U1,
  horarios: [
    { ...agenda.horarios[0]!, festasFuturas: { quantidade: 2, proxima: '2099-01-10', ultima: '2099-02-10' } },
    { id: H2, codigo: 'TURNO_2', nome: 'Noite', inicio: '19:00', fim: '23:00', dias: [5, 6], capacidade: 2, desativadoAPartirDe: '2099-03-01',
      saloes: [A, B], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } },
  ],
};
const dadosUnidades = { instalada: true, gestao: true, escopos: [U1, U2], agenda: comHorarios };

async function comPendencia() {
  const pedidos: Array<Record<string, unknown>> = [];
  const gets = { n: 0 };
  const t = telas(pedidos, gets, undefined, dadosUnidades);
  const render = await carregada(t);
  assert.equal(gets.n, 1);
  const intervalo = elementos(render()).find((e) => e.type === 'select' && e.props.value === '60')!;
  (intervalo.props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  const r = () => t.tela.render();
  assert.equal(props(r(), t.SaloesCombinados).pendenteSalvar, true);
  assert.match(texto(r()), /Há alterações não salvas\. Salve ou descarte/);
  const manteve = () => assert.ok(elementos(r()).some((e) => e.type === 'select' && e.props.value === '90'), 'intervalo 90 mantido');
  return { t, r, pedidos, gets, manteve };
}

test('rodada 3: desativar horário com edição pendente — botão desabilitado; forçado, não grava, não recarrega e mantém o rascunho', async () => {
  const { r, pedidos, gets, manteve } = await comPendencia();
  const botao = achar(r(), 'button', 'Desativar a partir desta data');
  assert.equal(botao.props.disabled, true);
  (botao.props.onClick as () => void)();
  const confirmar = elementos(r()).find((e) => e.type === Botao && /Desativar a partir de/.test(texto(e)))!;
  await (confirmar.props.onClick as () => Promise<void>)();
  await tique();
  assert.deepEqual(pedidos, []);
  assert.equal(gets.n, 1);
  assert.match(texto(r()), /antes de desativar um horário/);
  manteve();
});

test('rodada 3: cancelar a desativação de horário com edição pendente — desabilitado; forçado, nada gravado e rascunho mantido', async () => {
  const { r, pedidos, gets, manteve } = await comPendencia();
  const botao = achar(r(), 'button', 'Cancelar desativação');
  assert.equal(botao.props.disabled, true);
  await (botao.props.onClick as () => Promise<void>)();
  await tique();
  assert.deepEqual(pedidos, []);
  assert.equal(gets.n, 1);
  manteve();
});

test('rodada 3: trocar de unidade com edição pendente — seletor desabilitado; forçado, não recarrega e mantém o rascunho', async () => {
  const { r, gets, manteve } = await comPendencia();
  const unidade = elementos(r()).find((e) => e.type === 'select' && e.props.value === U1.estabelecimentoId)!;
  assert.equal(unidade.props.disabled, true);
  (unidade.props.onChange as (e: unknown) => void)({ target: { value: U2.estabelecimentoId } });
  await tique();
  assert.equal(gets.n, 1, 'nada recarregado');
  assert.ok(elementos(r()).some((e) => e.type === 'select' && e.props.value === U1.estabelecimentoId), 'continua na unidade');
  assert.match(texto(r()), /antes de trocar de unidade/);
  manteve();
});

test('rodada 3: sem pendência, as três ações seguem normalmente (controle)', async () => {
  const pedidos: Array<Record<string, unknown>> = [];
  const gets = { n: 0 };
  const t = telas(pedidos, gets, undefined, dadosUnidades);
  const r = await carregada(t);
  assert.equal(achar(r(), 'button', 'Desativar a partir desta data').props.disabled, false);
  assert.equal(achar(r(), 'button', 'Cancelar desativação').props.disabled, false);
  await (achar(r(), 'button', 'Cancelar desativação').props.onClick as () => Promise<void>)();
  await tique();
  assert.equal((pedidos[0] as Record<string, unknown>).acao, 'cancelar_desativacao');
  const unidade = elementos(r()).find((e) => e.type === 'select' && e.props.value === U1.estabelecimentoId)!;
  assert.equal(unidade.props.disabled, false);
});

test('conferência final (P3): agenda do dia não mostra a lista do dia anterior enquanto a nova busca não volta', async () => {
  let liberar!: () => void;
  const segunda = new Promise<void>((ok) => { liberar = ok; });
  const respostas: Record<string, unknown[]> = {
    '2026-11-21': [{ id: A, nome: 'Salão A', combinado: false, membros: [], ocupacoes: [], elegivel: true, membrosInativos: [] }],
    '2026-11-22': [{ id: B, nome: 'Salão B', combinado: false, membros: [], ocupacoes: [{ inicio: '15:00', fim: '19:00', reservadoEm: 'Salão B', remarcacao: false }], elegivel: true, membrosInativos: [] }],
  };
  const tela = carregarComponente('components/admin/SaloesDoDia.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async (url: string) => {
      const dataPedida = new URL(url, 'http://x').searchParams.get('data')!;
      if (dataPedida === '2026-11-22') await segunda;
      return Response.json({ ok: true, data: { saloes: respostas[dataPedida] } });
    } },
  });
  const classes = { painel: 'p', lista: 'l', livre: 'livre', ocupado: 'ocupado' };
  const render = (data: string) => tela.render('SaloesDoDia', { data, unidadeId: '', classes });
  render('2026-11-21');
  tela.efeitos();
  await tique();
  await tique();
  assert.match(texto(render('2026-11-21')), /Salão A.*Livre/);
  // Troca para o dia 22 com a resposta atrasada: nada do dia 21 aparece.
  render('2026-11-22');
  tela.efeitos();
  await tique();
  const durante = render('2026-11-22');
  assert.doesNotMatch(texto(durante), /Salão A|Livre/);
  assert.match(texto(durante), /Carregando os salões deste dia/);
  liberar();
  await tique();
  await tique();
  const depois = texto(render('2026-11-22'));
  assert.match(depois, /Salão B/);
  assert.match(depois, /15:00–19:00/);
  assert.doesNotMatch(depois, /Salão A/);
});
