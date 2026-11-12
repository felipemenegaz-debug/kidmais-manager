import test from 'node:test';
import assert from 'node:assert/strict';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from './teste-componente.ts';

/**
 * Plano "Agenda: concorrência otimista do agregado" (rev. 1.1, seção 7), clientes:
 * - T-E1: o salvar envia a versão da BASE do rascunho; quem recarrega e mantém o rascunho mantém a versão antiga;
 * - T-E2: 409 AGENDA_MUDOU na tela mantém o rascunho, mostra a mensagem e "Recarregar agenda", sem reenviar;
 * - T-E3: no assistente, AGENDA_MUDOU oferece recomeçar e AGENDA_JA_CONFIGURADA, fechar;
 * - T-E4: ler() expõe o código do erro sem mudar a mensagem.
 */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const HORARIO = '00000000-0000-4000-8000-000000000071';
const V1 = `va1:${'1'.repeat(64)}`;
const V2 = `va1:${'2'.repeat(64)}`;
const agendaCom = (versaoAgenda: string, intervalo = 60) => ({
  escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: true },
  config: { modo: 'FIXO', capacidadeTipo: 'POR_SALAO', limiteFestasDia: null, intervaloMinimoMinutos: intervalo, configuradoPor: 'Ana', configuradoEm: '2026-10-22T15:00:00Z' },
  saloes: [{ id: A, nome: 'Salão A', capacidadeConvidados: null }, { id: B, nome: 'Salão B', capacidadeConvidados: null }],
  combinados: [], combinadosDisponiveis: true,
  horarios: [{ id: HORARIO, codigo: 'TURNO_1', nome: 'Tarde', inicio: '15:00', fim: '19:00', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 2,
    desativadoAPartirDe: null, saloes: [A, B], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } }],
  versaoAgenda,
});
const MUDOU = { ok: false, erro: 'A agenda mudou depois que você abriu esta tela (outra aba ou outra pessoa salvou). Nada foi gravado. Recarregue para ver a versão atual.', codigo: 'AGENDA_MUDOU', detalhes: null };

function Botao(props: { children?: unknown }) { return props.children; }

type Resposta = { status: number; corpo: unknown };
function telas(opcoes: { gets: unknown[]; posts: Array<Resposta | (() => Promise<Resposta>)> }) {
  const pedidos: Array<Record<string, unknown>> = [];
  const contagem = { gets: 0 };
  const adminFetch = async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      const dados = opcoes.gets[Math.min(contagem.gets, opcoes.gets.length - 1)];
      contagem.gets++;
      return Response.json({ ok: true, data: dados });
    }
    pedidos.push(JSON.parse(String(init.body)));
    const proxima = opcoes.posts.shift() ?? { status: 201, corpo: { ok: true, data: {} } };
    const r = typeof proxima === 'function' ? await proxima() : proxima;
    return Response.json(r.corpo, { status: r.status });
  };
  const base = { 'next/link': { default: (p: { children?: unknown }) => p.children }, '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao,
    './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso };
  const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', base);
  const combinados = carregarComponente('components/admin/SaloesCombinados.tsx', base);
  const tela = carregarComponente('components/admin/AgendaConfiguracao.tsx', { ...base, './AssistenteAgenda': assistente.modulo, './SaloesCombinados': combinados.modulo });
  return { tela, assistente, combinados, pedidos, contagem };
}

async function carregada(t: ReturnType<typeof telas>) {
  t.tela.render();
  t.tela.efeitos();
  await tique();
  await tique();
  return () => { const arvore = t.tela.render(); t.tela.efeitos(); return arvore; };
}
const dados = (agenda: ReturnType<typeof agendaCom>) => ({ instalada: true, gestao: true, escopos: [agenda.escopo], agenda });
const intervaloSelect = (arvore: unknown) => elementos(arvore).find((e) => e.type === 'select' && INTERVALOS_TEXTO.has(String(e.props.value)))!;
const INTERVALOS_TEXTO = new Set(['0', '30', '60', '90', '120']);
const salvar = (arvore: unknown) => (achar(arvore, Botao, 'Salvar configurações').props.onClick as () => void)();
const pedidosSalvar = (pedidos: Array<Record<string, unknown>>) => pedidos.filter((p) => p.acao === 'salvar');

test('T-E1: formDaAgenda guarda a versão como base do rascunho e corpoSalvar a envia', () => {
  const t = telas({ gets: [dados(agendaCom(V1))], posts: [] });
  const m = t.assistente.modulo as { formDaAgenda: (a: unknown) => { versaoBase: string }; corpoSalvar: (f: unknown, e: null, o: string) => { versaoAgenda: string } };
  const form = m.formDaAgenda(agendaCom(V1));
  assert.equal(form.versaoBase, V1);
  assert.equal(m.corpoSalvar(form, null, 'CONFIGURACOES').versaoAgenda, V1);
  assert.equal(m.corpoSalvar({ ...form, versaoBase: V2 }, null, 'ASSISTENTE').versaoAgenda, V2);
});

test('T-E1: depois de salvar, a tela recarrega e o próximo salvar leva a versão nova', async () => {
  const t = telas({ gets: [dados(agendaCom(V1)), dados(agendaCom(V2, 90))], posts: [] });
  const render = await carregada(t);
  (intervaloSelect(render()).props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  salvar(render());
  await tique(); await tique(); await tique();
  assert.equal(pedidosSalvar(t.pedidos)[0]?.versaoAgenda, V1, 'o primeiro salvar leva a versão do GET');
  (intervaloSelect(render()).props.onChange as (e: unknown) => void)({ target: { value: '120' } });
  salvar(render());
  await tique(); await tique(); await tique();
  assert.equal(pedidosSalvar(t.pedidos)[1]?.versaoAgenda, V2, 'o recarregamento renovou a base');
});

test('T-E1: recarregar preservando o rascunho (combinado criado com edição feita durante o pedido) mantém a versão ANTIGA', async () => {
  let liberar!: () => void;
  const segura = new Promise<void>((fim) => { liberar = fim; });
  const t = telas({
    gets: [dados(agendaCom(V1)), dados({ ...agendaCom(V2), combinados: [{ id: 'AB', nome: 'Salão inteiro', capacidadeConvidados: null, elegivel: true, membros: [] }] } as never)],
    posts: [async () => { await segura; return { status: 201, corpo: { ok: true, data: { id: 'AB' } } }; }],
  });
  const render = await carregada(t);
  const painel = (elementos(render()).find((e) => e.type === t.combinados.modulo.SaloesCombinados) as Elemento).props as {
    onCriar: (d: { nome: string; capacidadeConvidados: number | null; membros: string[] }) => Promise<boolean>;
  };
  const criando = painel.onCriar({ nome: 'Salão inteiro', capacidadeConvidados: null, membros: [A, B] });
  // Edição feita enquanto o pedido estava pendente (defesa em profundidade do rascunho).
  (intervaloSelect(render()).props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  render();
  liberar();
  assert.equal(await criando, true);
  render();
  assert.match(texto(render()), /Suas alterações ainda não salvas foram mantidas/);
  salvar(render());
  await tique(); await tique(); await tique();
  assert.equal(pedidosSalvar(t.pedidos)[0]?.versaoAgenda, V1, 'rascunho preservado continua com a versão em que se baseia (o servidor responde 409)');
});

test('T-E2: 409 AGENDA_MUDOU mantém o rascunho, mostra a mensagem e "Recarregar agenda"; não reenvia; recarregar renova', async () => {
  const t = telas({ gets: [dados(agendaCom(V1)), dados(agendaCom(V2, 30))], posts: [{ status: 409, corpo: MUDOU }] });
  const render = await carregada(t);
  (intervaloSelect(render()).props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  salvar(render());
  await tique(); await tique(); await tique();
  const arvore = render();
  assert.match(texto(arvore), /A agenda mudou depois que você abriu esta tela/);
  assert.ok(elementos(arvore).some((e) => e.props['data-agenda-mudou'] !== undefined), 'oferece recarregar');
  assert.equal(intervaloSelect(arvore).props.value, '90', 'o rascunho continua na tela');
  assert.equal(t.contagem.gets, 1, 'não recarregou sozinho');
  assert.equal(t.pedidos.length, 1, 'não reenviou');
  (achar(arvore, 'button', 'Recarregar agenda').props.onClick as () => void)();
  await tique(); await tique();
  const depois = render();
  assert.equal(t.contagem.gets, 2);
  assert.equal(intervaloSelect(depois).props.value, '30', 'agenda atual na tela, rascunho descartado');
  assert.equal(elementos(depois).some((e) => e.props['data-agenda-mudou'] !== undefined), false);
  salvar(depois);
  await tique(); await tique(); await tique();
  assert.equal(t.pedidos.length, 2);
  assert.equal(pedidosSalvar(t.pedidos)[1]?.versaoAgenda, V2);
});

test('T-E2 (controle): outro erro de gravação não oferece recarregar', async () => {
  const t = telas({ gets: [dados(agendaCom(V1))], posts: [{ status: 409, corpo: { ok: false, erro: 'Não dá para mudar o horário Tarde.', codigo: 'HORARIO_COM_FESTAS', detalhes: null } }] });
  const render = await carregada(t);
  (intervaloSelect(render()).props.onChange as (e: unknown) => void)({ target: { value: '90' } });
  salvar(render());
  await tique(); await tique(); await tique();
  assert.match(texto(render()), /Não dá para mudar o horário Tarde/);
  assert.equal(elementos(render()).some((e) => e.props['data-agenda-mudou'] !== undefined), false);
});

function assistente(posts: Resposta[]) {
  const agenda = { ...agendaCom(V1), config: null, escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: false } };
  const t = telas({ gets: [dados(agenda as never)], posts });
  const chamadas = { recomecar: 0, concluido: 0 };
  const props = { escopo: agenda.escopo, agenda, onConcluido: () => { chamadas.concluido++; }, onDepois: () => {}, onRecomecar: () => { chamadas.recomecar++; } };
  const render = () => t.assistente.render('AssistenteAgenda', props);
  return { t, render, chamadas };
}

async function concluirAssistente(render: () => unknown) {
  for (let i = 0; i < 6 && !/Concluir/.test(texto(render())); i++) {
    (achar(render(), Botao, /Começar|Continuar/).props.onClick as () => void)();
  }
  (achar(render(), Botao, 'Concluir').props.onClick as () => void)();
  await tique(); await tique(); await tique();
}

test('T-E3: assistente com AGENDA_MUDOU: mensagem e "Recomeçar com os dados atuais", que chama onRecomecar; não reenvia', async () => {
  const { t, render, chamadas } = assistente([{ status: 409, corpo: MUDOU }]);
  await concluirAssistente(render);
  assert.equal(t.pedidos[0]?.versaoAgenda, V1, 'enviou a versão do GET');
  assert.match(texto(render()), /mudou enquanto você respondia/);
  assert.doesNotMatch(texto(render()), /Concluir/);
  (achar(render(), Botao, 'Recomeçar com os dados atuais').props.onClick as () => void)();
  assert.equal(chamadas.recomecar, 1);
  assert.equal(t.pedidos.length, 1);
});

test('T-E3: assistente com AGENDA_JA_CONFIGURADA: mensagem do servidor e "Fechar", que conclui', async () => {
  const { render, chamadas } = assistente([{ status: 409, corpo: { ok: false, erro: 'A agenda desta unidade já foi configurada. Altere em Configurações › Agenda.', codigo: 'AGENDA_JA_CONFIGURADA', detalhes: null } }]);
  await concluirAssistente(render);
  assert.match(texto(render()), /já foi configurada/);
  (achar(render(), Botao, 'Fechar').props.onClick as () => void)();
  assert.equal(chamadas.concluido, 1);
});

test('T-E4: ler() lança ErroApi com o código e a mensagem do servidor', async () => {
  const t = telas({ gets: [{}], posts: [] });
  const m = t.assistente.modulo as { ler: (r: Response) => Promise<unknown>; codigoDoErro: (e: unknown) => string | null };
  const erro = await m.ler(Response.json(MUDOU, { status: 409 })).catch((e: unknown) => e);
  assert.ok(erro instanceof Error);
  assert.equal((erro as Error).message, MUDOU.erro);
  assert.equal(m.codigoDoErro(erro), 'AGENDA_MUDOU');
  const semCodigo = await m.ler(Response.json({ ok: false, erro: 'x' }, { status: 500 })).catch((e: unknown) => e);
  assert.equal(m.codigoDoErro(semCodigo), null);
  assert.deepEqual(await m.ler(Response.json({ ok: true, data: 1 })), { ok: true, data: 1 });
});

test('T-E3 (pai, P3-3): AssistenteAgendaPendente — recomeçar refaz o GET e remonta com key nova e a versão nova; sem pendência, some e dispara o evento', async () => {
  const escopo = { estabelecimentoId: null, nome: 'Buffet', configurado: false };
  const semConfig = (versaoAgenda: string) => ({ ...agendaCom(versaoAgenda), config: null, escopo });
  const pendentes = [[escopo], [escopo], []];
  const agendas = [semConfig(V1), semConfig(V2)];
  const urls: string[] = [];
  const adminFetch = async (url: string) => {
    urls.push(url);
    if (url.includes('pendentes=1')) return Response.json({ ok: true, data: { instalada: true, pendentes: pendentes.shift() ?? [] } });
    return Response.json({ ok: true, data: { instalada: true, agenda: agendas.shift() } });
  };
  const eventos: string[] = [];
  const g = globalThis as { window?: unknown };
  const antes = g.window;
  g.window = { sessionStorage: { getItem: () => null, setItem: () => {} }, dispatchEvent: (e: Event) => { eventos.push(e.type); return true; } };
  try {
    const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', {
      '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao,
      './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso,
    });
    assistente.render('AssistenteAgendaPendente');
    assistente.efeitos();
    await tique(); await tique(); await tique();
    type Filho = { type: unknown; key: string | null; props: { agenda: { versaoAgenda: string }; onRecomecar: () => void } };
    let filho = assistente.render('AssistenteAgendaPendente') as Filho;
    assert.equal(filho.type, assistente.modulo.AssistenteAgenda);
    assert.equal(filho.props.agenda.versaoAgenda, V1);
    const chaveInicial = filho.key;
    assert.notEqual(chaveInicial, null, 'o assistente tem key (remonta a cada leitura)');
    filho.props.onRecomecar();
    await tique(); await tique(); await tique();
    filho = assistente.render('AssistenteAgendaPendente') as Filho;
    assert.equal(filho.props.agenda.versaoAgenda, V2, 'GET novo: versão nova');
    assert.notEqual(filho.key, chaveInicial, 'key nova: formulário, versão e passo 1 recriados (não só a prop agenda)');
    assert.equal(urls.filter((u) => u.includes('pendentes=1')).length, 2, 'recomeçar refaz a leitura das pendências');
    // Sem unidade pendente (outra pessoa concluiu): o assistente some e a tela da agenda é avisada.
    filho.props.onRecomecar();
    await tique(); await tique(); await tique();
    assert.equal(assistente.render('AssistenteAgendaPendente'), null);
    assert.deepEqual(eventos, ['kidmais:agenda-configurada']);
  } finally {
    g.window = antes;
  }
});
