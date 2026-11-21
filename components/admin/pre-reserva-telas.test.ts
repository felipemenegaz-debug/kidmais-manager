import assert from 'node:assert/strict';
import test from 'node:test';
import * as preReserva from '../../lib/pre-reserva/apresentacao-admin.ts';
import * as agenda from '../../lib/agenda/disponibilidade.ts';
import * as periodos from '../fechamento/periodos.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';

const pedido = '11111111-1111-4111-8111-111111111111';
const pix = 'E12345678202611201234Ab123456789';
const deps = {
  '@/lib/pre-reserva/apresentacao-admin': preReserva,
  '@/lib/contratos/documento/formatters': { formatarMoeda: (valor: number) => `R$ ${valor.toFixed(2)}` },
  '@/components/admin/AdminPrimaryButton': { AdminPrimaryButton: 'button' },
  '@/components/admin/workspace.module.css': cssFalso,
  './RevisaoComercial.module.css': cssFalso,
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
  const tela = carregarComponente('app/admin/configuracoes/pre-reserva/page.tsx', {
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
  tela.render();
  tela.efeitos();
  await tique();
  const estado = tela.render();
  assert.match(texto(estado), /orçamento online.*recebedor Pix/);
  assert.equal(achar(achar(estado, 'label', /Piloto ligado/), 'input').props.disabled, true);
  digitar(estado, /Sua senha/, 'senha sintética');
  await (achar(tela.render(), 'form').props.onSubmit as (e: object) => Promise<void>)({ preventDefault() {} });
  assert.deepEqual(chamadas, ['senha sintética', { habilitada: false, sinalCentavos: 10000, versao: 3 }]);
  assert.match(texto(tela.render()), /Atualize a configuração/);
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
  assert.match(texto(render()), /Pix registrado para devolução. Valor recebido diferente do sinal/);
});

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

test('agenda marca somente ocupações projetadas e atualiza o dia aberto', async () => {
  let leituras = 0;
  const tela = carregarComponente('components/admin/AdminDisponibilidade.tsx', {
    ...deps,
    './SaloesDoDia': { SaloesDoDia: () => null },
    './AdminDisponibilidade.module.css': cssFalso,
    '@/components/fechamento/data': { PACOTES: [] },
    '@/components/fechamento/periodos': periodos,
    '@/lib/agenda/disponibilidade': agenda,
    '@/lib/comercial/descontos': { descontoPersonalizadoDaData: () => null, avisoDescontoDoPacote: () => null },
    '@/lib/comercial/descontos-dia': {},
    '@/lib/http/admin-fetch': { adminFetch: async (url: string) => {
      const q = new URL(url, 'http://localhost').searchParams;
      assert.equal(q.get('preReservas'), '1');
      const data = q.get('inicio')!;
      const ocupacao = { data, inicio: '16:00', fim: '20:00', garantiaAte: `${data}T21:00Z`, salao: 'Salão A' };
      return Response.json({ preReservas: ++leituras === 1
        ? [{ ...ocupacao, fechamentoId: pedido }, { ...ocupacao, fechamentoId: null, inicio: '11:00' }]
        : [] });
    } },
  });
  tela.render();
  tela.efeitos();
  await tique();
  const primeiroDia = elementos(tela.render()).find((e) => e.type === 'button' && /-01$/.test(String((e as { key?: string }).key)));
  assert.ok(primeiroDia);
  (primeiroDia.props.onClick as () => void)();
  const selecionado = tela.render();
  const rotulo = /Pré-reserva garantida até .*18:00/;
  assert.equal(achar(selecionado, 'a', rotulo).props.href, `/admin/fechamentos/${pedido}/revisao`);
  assert.equal(elementos(selecionado).filter((e) => e.type === 'b' && rotulo.test(texto(e))).length, 2);
  await clicar(selecionado, '↻');
  assert.doesNotMatch(texto(tela.render()), /Pré-reserva garantida/);
});
