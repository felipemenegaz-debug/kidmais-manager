import assert from 'node:assert/strict';
import test from 'node:test';
import * as preReserva from '../../lib/pre-reserva/apresentacao-admin.ts';
import * as agenda from '../../lib/agenda/disponibilidade.ts';
import * as periodos from '../fechamento/periodos.ts';
import { pedidoDaUrl } from './contrato-url.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';
import { carregarModulo, executorFalso } from '../../lib/acessos/teste-carregador.ts';

const pedido = '11111111-1111-4111-8111-111111111111';
const pix = 'E12345678202611201234Ab123456789';
function MotivoPerda() { return null; }
const deps = {
  '@/lib/pre-reserva/apresentacao-admin': preReserva,
  '@/lib/contratos/documento/formatters': { formatarMoeda: (valor: number) => `R$ ${valor.toFixed(2)}` },
  '@/components/admin/AdminPrimaryButton': { AdminPrimaryButton: 'button' },
  '@/components/admin/workspace.module.css': cssFalso,
  './RevisaoComercial.module.css': cssFalso,
  './oportunidades/MotivoPerda': { MotivoPerda },
};

function clicar(arvore: unknown, rotulo: string) {
  return (achar(arvore, 'button', rotulo).props.onClick as () => void)();
}

function digitar(arvore: unknown, rotulo: RegExp, value: string) {
  const input = achar(achar(arvore, 'label', rotulo), 'input');
  (input.props.onChange as (evento: { target: { value: string } }) => void)({ target: { value } });
}

test('configuração explica os dois pré-requisitos e salva com reautenticação e versão', async () => {
  const config = { habilitada: false, sinalCentavos: 10000, versao: 3, orcamentoOnline: false, recebedorPix: false };
  const chamadas: unknown[] = [];
  const tela = carregarComponente('components/admin/PreReservaConfiguracao.tsx', {
    ...deps,
    '@/lib/http/admin-fetch': {
      reautenticarSessao: async (senha: string) => { chamadas.push(senha); return { ok: true }; },
      adminFetch: async (_: string, init: RequestInit) => {
        if (!init.body) return Response.json({ ok: true, data: config });
        chamadas.push(JSON.parse(String(init.body)));
        return Response.json({ erro: 'Atualize a configuração antes de salvar.' }, { status: 409 });
      },
    },
  });
  tela.render('PreReservaConfiguracao');
  tela.efeitos();
  await tique();
  const estado = tela.render('PreReservaConfiguracao');
  assert.match(texto(estado), /orçamento online.*recebedor Pix/);
  assert.equal(achar(achar(estado, 'label', /Piloto ligado/), 'input').props.disabled, true);
  digitar(estado, /Sua senha/, 'senha sintética');
  await (achar(tela.render('PreReservaConfiguracao'), 'form').props.onSubmit as (e: object) => Promise<void>)({ preventDefault() {} });
  assert.deepEqual(chamadas, ['senha sintética', { habilitada: false, sinalCentavos: 10000, versao: 3 }]);
  assert.match(texto(tela.render('PreReservaConfiguracao')), /Atualize a configuração/);
});

test('revisão recarrega no 409 e pede uma ação separada para confirmar o Pix divergente', async () => {
  const dados: preReserva.RevisaoPreReserva = {
    sequencia: 1, sinalCentavos: 10000, aceitoEm: '2026-11-21T12:00Z',
    inicio: '2026-12-21T19:00Z', fim: '2026-12-21T22:00Z', unidade: 'Unidade', salao: 'Salão',
    recebedor: 'Buffet', garantiaAte: null, garantia: null, destinos: [],
  };
  const envios: Array<{ acao: string }> = [];
  const tela = carregarComponente('components/admin/RevisaoPreReserva.tsx', {
    ...deps,
    '@/lib/http/admin-fetch': { adminFetch: async (_: string, init: RequestInit) => {
      envios.push(JSON.parse(String(init.body)));
      return envios.length === 1
        ? Response.json({ codigo: 'PIX_VALOR_DIVERGENTE', erro: 'Confira o crédito no extrato.' }, { status: 409 })
        : Response.json({ ok: true, data: { motivo: 'VALOR_DIVERGENTE' } });
    } },
  });
  let leituras = 0;
  const render = () => tela.render('RevisaoPreReserva', { dados, fechamentoId: pedido, atualizar: async () => { leituras++; return dados; } });
  digitar(render(), /Valor recebido/, '99,00');
  digitar(render(), /Identificador da transferência/, pix);
  const segundoPasso = 'Conferi o crédito no extrato. Registrar para devolução';
  assert.ok(!elementos(render()).some((e) => texto(e) === segundoPasso));
  (achar(render(), 'form').props.onSubmit as (e: object) => void)({ preventDefault() {} });
  await tique();
  assert.equal(leituras, 1);
  assert.match(texto(render()), /Confira o crédito no extrato/);
  clicar(render(), segundoPasso);
  await tique();
  assert.equal(leituras, 2);
  assert.deepEqual(envios.map((e) => e.acao), ['CONFIRMAR', 'REGISTRAR_DIVERGENTE_A_DEVOLVER']);
  assert.match(texto(render()), /Recebimento Pix identificado. Valor recebido diferente do sinal/);

  dados.destinos = ['DEVOLVIDO'];
  digitar(render(), /Valor recebido/, '99,00');
  digitar(render(), /Identificador da transferência/, pix);
  (achar(render(), 'form').props.onSubmit as (e: object) => void)({ preventDefault() {} });
  await tique();
  assert.equal(leituras, 3);
  assert.deepEqual(envios[2], envios[0]);
  assert.match(texto(render()), /Devolvido.*Recebimento Pix identificado. Valor recebido diferente do sinal/);
  assert.doesNotMatch(texto(render()), /Pix registrado para devolução/);
});

test('revisão mantém o pedido recusado quando a leitura da confirmação chega depois', async () => {
  const fechamento = {
    id: pedido, status: 'AGUARDANDO_CONTRATO', dataEvento: '2026-12-21',
    horarioInicio: '16:00', horarioFim: '19:00', valorTabela: 1000, valorNegociado: null,
  };
  const aceite: preReserva.RevisaoPreReserva = {
    sequencia: 1, sinalCentavos: 10000, aceitoEm: '2026-11-21T12:00Z',
    inicio: '2026-12-21T19:00Z', fim: '2026-12-21T22:00Z', unidade: 'Unidade', salao: 'Salão',
    recebedor: 'Buffet', garantiaAte: null, garantia: null, destinos: [],
  };
  const inicial = { fechamento, aprovacoes: [], recusa: 'SEM_CONTRATO', preReserva: aceite };
  const garantiaAte = '2026-11-23T12:00Z';
  const leituraAtrasada = Promise.withResolvers<Response>();
  let leituras = 0;
  const http = { async adminFetch(url: string, init: RequestInit) {
    if (url.endsWith('/confirmar-sinal') && init.method === 'POST') return Response.json({ data: { garantiaAte } });
    if (url.endsWith('/recusar') && init.method === 'POST') return Response.json({ ok: true });
    assert.equal(url, `/api/admin/fechamentos/${pedido}/revisao`);
    assert.equal(init.method, undefined);
    leituras++;
    if (leituras === 1) return Response.json({ data: inicial });
    if (leituras === 2) return leituraAtrasada.promise;
    assert.equal(leituras, 3);
    return Response.json({ data: {
      fechamento: { ...fechamento, status: 'RECUSADO' }, aprovacoes: [],
      preReserva: { ...aceite, garantiaAte, garantia: 'RECUSA', destinos: ['A_DEVOLVER'] },
    } });
  } };
  const sinal = carregarComponente('components/admin/RevisaoPreReserva.tsx', { ...deps, '@/lib/http/admin-fetch': http });
  const RevisaoPreReserva = sinal.modulo.RevisaoPreReserva;
  const tela = carregarComponente('components/admin/RevisaoComercial.tsx', {
    ...deps,
    '@/lib/http/admin-fetch': http,
    '@/lib/comercial/condicao-pagamento': {},
    '@/lib/contratos/documento/formatters': {
      ...deps['@/lib/contratos/documento/formatters'],
      formatarFormaPagamento: () => 'Pix', formatarCondicaoPix: () => 'À vista',
    },
    './contrato-url': {},
    './RevisaoPreReserva': { RevisaoPreReserva },
  });
  const render = () => tela.render('default', { fechamentoId: pedido });
  const renderSinal = (revisao: unknown) => sinal.render('RevisaoPreReserva', achar(revisao, RevisaoPreReserva).props);
  render();
  tela.efeitos();
  await tique();
  digitar(renderSinal(render()), /Valor recebido/, '100,00');
  digitar(renderSinal(render()), /Identificador da transferência/, pix);
  const submeter = (form: ReturnType<typeof achar>) =>
    (form.props.onSubmit as (e: object) => void)({ preventDefault() {} });
  submeter(achar(renderSinal(render()), 'form'));
  await tique();
  assert.equal(leituras, 2);

  clicar(render(), 'Recusar pedido');
  // Motivo em opções de escolha única (23/11/2026): a janela entrega o componente com o valor e o callback.
  (achar(achar(render(), 'dialog'), MotivoPerda).props.aoMudar as (m: string) => void)('Outro');
  const observacao = achar(achar(render(), 'dialog'), 'textarea');
  (observacao.props.onChange as (e: object) => void)({ target: { value: 'Recusa de teste' } });
  submeter(achar(achar(render(), 'dialog'), 'form'));
  await tique();
  assert.equal(leituras, 3);
  assert.match(texto(render()), /Estado: RECUSADO/);

  leituraAtrasada.resolve(Response.json({ data: {
    ...inicial, preReserva: { ...aceite, garantiaAte, garantia: 'ATIVA', destinos: ['EM_GARANTIA'] },
  } }));
  await tique();
  const estado = render();
  assert.match(texto(estado), /Estado: RECUSADO/);
  assert.doesNotMatch(texto(estado), /Recusar pedido/);
  assert.doesNotMatch(texto(renderSinal(estado)), /Pré-reserva garantida até/);
});

const pedidoCanonico = 'abcdef12-abcd-4def-8abc-abcdef123456';
for (const { idNaUrl, cenario, recusaInicial } of [
  { idNaUrl: pedidoCanonico, cenario: 'contrato já em preparação', recusaInicial: 'COM_PREPARACAO' },
  { idNaUrl: pedidoCanonico.toUpperCase(), cenario: 'UUID em maiúsculas e mesmo Pix reenviado', recusaInicial: 'COM_PREPARACAO' },
  { idNaUrl: pedidoCanonico, cenario: 'contrato entra em preparação durante a confirmação', recusaInicial: 'SEM_CONTRATO' },
]) {
  test(`revisão exibe o aceite e os atalhos que chegam após a confirmação do sinal (${cenario})`, async () => {
    const aceite: preReserva.RevisaoPreReserva = {
      sequencia: 1, sinalCentavos: 10000, aceitoEm: '2026-11-21T12:00Z',
      inicio: '2026-12-21T19:00Z', fim: '2026-12-21T22:00Z', unidade: 'Unidade', salao: 'Salão',
      recebedor: 'Buffet', garantiaAte: null, garantia: null, destinos: [],
    };
    const garantiaAte = '2026-11-23T12:00Z';
    const contratoId = '22222222-2222-4222-8222-222222222222';
    const consulta = Promise.withResolvers<Response>();
    let leituras = 0;
    let consultas = 0;
    const envios: Array<{ url: string; corpo: unknown }> = [];
    const http = { async adminFetch(url: string, init: RequestInit) {
      if (url === `/api/admin/contratos?fechamentoId=${idNaUrl}`) {
        consultas++;
        return consulta.promise;
      }
      if (url.endsWith('/confirmar-sinal')) {
        assert.equal(init.method, 'POST');
        envios.push({ url, corpo: JSON.parse(String(init.body)) });
        if (url !== `/api/admin/fechamentos/${pedidoCanonico}/confirmar-sinal`) {
          return Response.json({ codigo: 'PIX_JA_LANCADO', erro: 'Pix já lançado em outro pedido.' }, { status: 409 });
        }
        return Response.json({ data: { garantiaAte } });
      }
      assert.equal(url, `/api/admin/fechamentos/${idNaUrl}/revisao`);
      leituras++;
      return Response.json({ data: {
        fechamento: {
          id: pedidoCanonico, status: 'AGUARDANDO_CONTRATO', dataEvento: '2026-12-21',
          horarioInicio: '16:00', horarioFim: '19:00', valorTabela: 1000, valorNegociado: null,
        },
        aprovacoes: [], recusa: leituras === 1 ? recusaInicial : 'COM_PREPARACAO',
        preReserva: leituras === 1 ? aceite : { ...aceite, garantiaAte, garantia: 'ATIVA', destinos: ['EM_GARANTIA'] },
      } });
    } };
    const sinal = carregarComponente('components/admin/RevisaoPreReserva.tsx', { ...deps, '@/lib/http/admin-fetch': http });
    const { RevisaoPreReserva } = sinal.modulo;
    const tela = carregarComponente('components/admin/RevisaoComercial.tsx', {
      ...deps,
      '@/lib/http/admin-fetch': http,
      '@/lib/comercial/condicao-pagamento': {},
      '@/lib/contratos/documento/formatters': {
        ...deps['@/lib/contratos/documento/formatters'], formatarFormaPagamento: () => 'Pix',
        formatarCondicaoPix: () => 'À vista',
      },
      './contrato-url': { pedidoDaUrl },
      './RevisaoPreReserva': { RevisaoPreReserva },
    });
    const render = () => tela.render('default', { fechamentoId: idNaUrl });
    const renderSinal = () => sinal.render('RevisaoPreReserva', achar(render(), RevisaoPreReserva).props);
    render();
    tela.efeitos();
    await tique();
    assert.equal(consultas, recusaInicial === 'SEM_CONTRATO' ? 0 : 1);
    assert.match(texto(renderSinal()), /Aceito em/);
    async function confirmarMesmoPix() {
      digitar(renderSinal(), /Valor recebido/, '100,00');
      digitar(renderSinal(), /Identificador da transferência/, pix);
      (achar(renderSinal(), 'form').props.onSubmit as (e: object) => void)({ preventDefault() {} });
      await tique();
    }
    await confirmarMesmoPix();
    assert.equal(leituras, 2);
    assert.match(texto(renderSinal()), /Pré-reserva garantida até/);
    assert.doesNotMatch(texto(render()), /Abrir contrato para assinar/);

    consulta.resolve(Response.json({ data: { versao: { contratoId } } }));
    await tique();
    const estado = render();
    assert.equal(consultas, 1);
    assert.equal(achar(estado, 'a', 'Abrir contrato para assinar').props.href, `/admin/contratos?contratoId=${contratoId}`);
    assert.equal(achar(estado, 'a', 'Abrir Resumo da Contratação').props.href, `/api/admin/contratos/resumo?fechamentoId=${idNaUrl}`);

    if (idNaUrl !== pedidoCanonico) {
      await confirmarMesmoPix();
      assert.equal(leituras, 3);
      assert.equal(consultas, 1);
      assert.equal(envios.length, 2);
      assert.equal(envios[0].url, `/api/admin/fechamentos/${pedidoCanonico}/confirmar-sinal`);
      assert.deepEqual(envios[1], envios[0]);
      assert.match(texto(renderSinal()), /Sinal registrado/);
      assert.doesNotMatch(texto(renderSinal()), /Pix já lançado em outro pedido/);
    }
  });
}

test('fila só permite baixa após assunção e recarrega no conflito; histórico mostra os dois autores', async () => {
  const movimento = {
    fechamento_id: pedido, end_to_end_id: pix, motivo: 'VALOR_DIVERGENTE', valor_centavos: '9900',
    situacao: 'A_DEVOLVER', responsavel_nome: null,
  };
  let leituras = 0;
  const tela = carregarComponente('app/admin/financeiro/devolucoes-pre-reserva/page.tsx', {
    ...deps,
    '@/lib/http/admin-fetch': { adminFetch: async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        assert.ok(url.endsWith('/assumir'));
        return Response.json({ erro: 'Outra pessoa assumiu este Pix.' }, { status: 409 });
      }
      if (url.endsWith('?historico=1')) return Response.json({ data: [
        { ...movimento, situacao: 'DEVOLVIDO', responsavel_nome: 'Gestora A', devolvido_por_nome: 'Gestor B' },
      ] });
      leituras++;
      return Response.json({ data: leituras === 1 ? [movimento] : [
        { ...movimento, situacao: 'EM_DEVOLUCAO', responsavel_nome: 'Gestora A' },
      ] });
    } },
  });
  tela.render();
  tela.efeitos();
  await tique();
  assert.doesNotMatch(texto(tela.render()), /Dar baixa/);
  clicar(tela.render(), 'Assumir');
  await tique();
  assert.equal(leituras, 2);
  assert.match(texto(tela.render()), /Outra pessoa assumiu este Pix/);
  clicar(tela.render(), 'Dar baixa');
  assert.match(texto(tela.render()), /Valor integral.*Data da saída.*Hora da saída.*Conferi a saída no extrato/);
  clicar(tela.render(), 'Histórico');
  tela.render();
  tela.efeitos();
  await tique();
  assert.match(texto(tela.render()), /Assumiu Gestora A.*Baixou Gestor B/);
  assert.doesNotMatch(texto(tela.render()), /Dar baixa/);
});

function carregarAgenda(adminFetch: (url: string, init: RequestInit) => Promise<Response>) {
  return carregarComponente('components/admin/AdminDisponibilidade.tsx', {
    ...deps,
    './SaloesDoDia': { SaloesDoDia: () => null },
    './AdminDisponibilidade.module.css': cssFalso,
    '@/components/fechamento/data': { PACOTES: [] },
    '@/components/fechamento/periodos': periodos,
    '@/lib/agenda/disponibilidade': agenda,
    '@/lib/comercial/descontos': { descontoPersonalizadoDaData: () => null, avisoDescontoDoPacote: () => null },
    '@/lib/comercial/descontos-dia': {},
    '@/lib/http/admin-fetch': { adminFetch },
  });
}

function abrirPrimeiroDia(arvore: unknown) {
  const primeiroDia = elementos(arvore).find((e) => e.type === 'button' && /-01$/.test(String((e as { key?: string }).key)));
  assert.ok(primeiroDia);
  (primeiroDia.props.onClick as () => void)();
}

test('agenda marca somente ocupações projetadas e atualiza o dia aberto', async () => {
  let leituras = 0;
  const tela = carregarAgenda(async (url) => {
    const q = new URL(url, 'http://localhost').searchParams;
    assert.equal(q.get('preReservas'), '1');
    const data = q.get('inicio')!;
    const ocupacao = { data, inicio: '16:00', fim: '20:00', garantiaAte: `${data}T21:00Z`, salao: 'Salão A' };
    return Response.json({ preReservas: ++leituras === 1
      ? [{ ...ocupacao, fechamentoId: pedido }, { ...ocupacao, fechamentoId: null, inicio: '11:00' }]
      : [] });
  });
  tela.render();
  tela.efeitos();
  await tique();
  abrirPrimeiroDia(tela.render());
  const selecionado = tela.render();
  const rotulo = /Pré-reserva garantida até .*18:00/;
  assert.equal(achar(selecionado, 'a', rotulo).props.href, `/admin/fechamentos/${pedido}/revisao`);
  assert.equal(elementos(selecionado).filter((e) => e.type === 'b' && rotulo.test(texto(e))).length, 2);
  await clicar(selecionado, '↻');
  assert.doesNotMatch(texto(tela.render()), /Pré-reserva garantida/);
});

for (const statusAntigo of [200, 500]) {
  test(`agenda preserva garantias do mês visível quando a atualização antiga termina depois (HTTP ${statusAntigo})`, async () => {
    const consultas: Array<{ data: string; resolver: (r: Response) => void }> = [];
    const tela = carregarAgenda((url) => new Promise((resolver) => {
      const data = new URL(url, 'http://localhost').searchParams.get('inicio')!;
      consultas.push({ data, resolver });
    }));
    tela.render();
    tela.efeitos();
    consultas[0].resolver(Response.json({}));
    await tique();

    const antiga = clicar(tela.render(), '↻');
    clicar(tela.render(), '→');
    tela.render();
    tela.efeitos();
    const [mesA, mesB] = consultas.slice(1);
    assert.notEqual(mesA.data, mesB.data);
    mesB.resolver(Response.json({ preReservas: [{
      data: mesB.data, inicio: '16:00', fim: '20:00', garantiaAte: `${mesB.data}T21:00Z`, fechamentoId: pedido, salao: 'Salão B',
    }] }));
    await tique();
    abrirPrimeiroDia(tela.render());
    const rotulo = /Pré-reserva garantida até .*18:00/;
    assert.ok(achar(tela.render(), 'a', rotulo));

    mesA.resolver(Response.json({ preReservas: [] }, { status: statusAntigo }));
    await antiga;
    const estado = tela.render();
    assert.equal(achar(estado, 'a', rotulo).props.href, `/admin/fechamentos/${pedido}/revisao`);
    assert.equal(achar(estado, 'button', '↻').props.disabled, false);
    assert.doesNotMatch(texto(estado), /Não foi possível carregar a disponibilidade/);
  });
}

test('agenda relê o mês A quando o bloqueio termina após navegar de A para B e voltar', async () => {
  const gravacao = Promise.withResolvers<Response>();
  const consultas: string[] = [];
  const envios: unknown[] = [];
  let bloqueado = false;
  const tela = carregarAgenda(async (url, init) => {
    if (init.method === 'POST') {
      envios.push(JSON.parse(String(init.body)));
      return gravacao.promise;
    }
    const data = new URL(url, 'http://localhost').searchParams.get('inicio')!;
    consultas.push(data);
    return Response.json({ dias: [{ data, periodos: [{
      configuracaoId: 'turno', codigo: 'TURNO_1',
      horarios: [{ ajusteMinutos: 0, inicio: '16:00', fim: '20:00', status: bloqueado ? 'INDISPONIVEL' : 'DISPONIVEL' }],
    }] }] });
  });
  async function aplicarConsulta() {
    tela.render();
    tela.efeitos();
    await tique();
  }
  function disponibilidade() {
    return texto(elementos(tela.render()).find((elemento) => elemento.props.className?.toString().includes('physicalStatus')));
  }

  await aplicarConsulta();
  abrirPrimeiroDia(tela.render());
  clicar(tela.render(), '⊘ Bloquear esta data');
  digitar(tela.render(), /Motivo obrigatório/, 'Manutenção');
  clicar(tela.render(), 'Criar bloqueio físico');
  assert.deepEqual(envios, [{
    tipo: 'criar_bloqueio', data: consultas[0], escopo: 'horario', configuracaoId: 'turno', motivo: 'Manutenção',
  }]);

  clicar(tela.render(), '→');
  await aplicarConsulta();
  clicar(tela.render(), '←');
  await aplicarConsulta();
  const [mesA, mesB] = consultas;
  assert.notEqual(mesA, mesB);
  assert.deepEqual(consultas, [mesA, mesB, mesA]);
  abrirPrimeiroDia(tela.render());
  assert.match(disponibilidade(), /Disponibilidade físicaDisponível/);

  bloqueado = true;
  gravacao.resolve(Response.json({ ok: true }));
  await tique();
  assert.deepEqual(consultas, [mesA, mesB, mesA, mesA]);
  assert.match(disponibilidade(), /Disponibilidade físicaIndisponível/);
  assert.match(texto(tela.render()), /Alteração salva/);
});

test('GET da agenda inclui link comercial para Equipe da empresa comprovada', async () => {
  const empresaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const data = '2026-11-21';
  const ocupacao = { data, inicio: '16:00', fim: '20:00', garantiaAte: `${data}T21:00Z`, salao: 'Salão A', fechamentoId: pedido };
  const tx = executorFalso([
    [/to_regprocedure/, () => [{ instalada: true }]],
    [/FROM kidmais094_ocupacoes/, () => [ocupacao]],
  ]);
  const inertes = Object.fromEntries([
    'agenda/trava-configuracao', 'comercial/pacotes-v1', 'comercial/repositories',
    'fechamentos/rota-publica', 'comercial/cotacao-publica', 'comercial/descontos-dia',
    'disponibilidade/bloqueios-legados', 'disponibilidade/config-legada-armazem', 'enderecos/roteamento',
  ].map((id) => [`lib/${id}`, {}]));
  const { GET } = carregarModulo('app/api/admin/disponibilidade/route.ts', {
    ...inertes,
    'next/server': { NextResponse: { json: Response.json } },
    'lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => ({ papel: 'ADMINISTRATIVO' }) },
    'lib/http/api-response': { apiErrorResponse: (erro: unknown) => { throw erro; } },
    'lib/saas/provar-tenant': {
      withTenantTransaction: (_: unknown, __: unknown, consultar: (db: typeof tx, tenant: object) => unknown) =>
        consultar(tx, { empresaComprovada: empresaId, papelAtual: 'ADMINISTRATIVO' }),
    },
    'lib/disponibilidade/escopo': {
      escopoDaEmpresa: (_: unknown, empresa: string) => ({ empresaId: empresa, estabelecimentoId: null }),
      agendaPorEscopoInstalada: async () => false,
    },
    'lib/disponibilidade/services': {
      duracaoAceita: () => null, duracaoDoPacoteDaEmpresa: async () => 240, consultarDisponibilidadeData: async () => ({}),
    },
    // Sem a 133 (Agenda lenta F6), como em staging e production hoje: a projeção segue na 094.
    'lib/disponibilidade/repositories': {
      listarTodosBloqueiosAtivos: async () => [],
      ocupacoesPorEmpresaInstaladas: async () => false,
      fonteOcupacoesDoRecurso: (v133: boolean) => (v133 ? 'kidmais133_ocupacoes_escopo($1::date,$2::date,$3::uuid,$4::uuid) o' : 'kidmais094_ocupacoes($1::date,$2::date) o'),
    },
    'lib/disponibilidade/config-legada': { ehDonaDaConfigLegada: async () => false },
    'lib/comercial/disponibilidade-pacote-publica': { pacotesDaAgendaDaEmpresa: async () => null },
    'lib/comercial/descontos-dia-publico': { descontosPublicosDaEmpresa: async () => null },
  }) as { GET: (r: { nextUrl: URL }) => Promise<Response> };
  const resposta = await GET({ nextUrl: new URL(`http://localhost/api/admin/disponibilidade?data=${data}&preReservas=1`) });
  assert.equal(resposta.status, 200);
  assert.deepEqual((await resposta.json()).preReservas, [ocupacao]);
  const projecao = tx.executados.find(({ sql }) => /FROM kidmais094_ocupacoes/.test(sql));
  assert.ok(projecao);
  assert.match(projecao.sql, /o\.fechamento_id AS "fechamentoId"/);
  assert.match(projecao.sql, /o\.empresa_id=\$3/);
  assert.deepEqual(projecao.params, [data, data, empresaId, null]);
});
