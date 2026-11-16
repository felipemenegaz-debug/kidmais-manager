import test from 'node:test';
import assert from 'node:assert/strict';
import { carregarComponente, cssFalso, elementos, tique, type Elemento } from './teste-componente.ts';
import * as calculos from '../../lib/financeiro/calculos.ts';
import * as submissao from '../../lib/financeiro/submissao.ts';

/** P2 fase B na tela: com as flags desligadas nada muda; ligadas, aparecem só as ações previstas. */
function telas() {
  return carregarComponente('components/admin/FinanceiroTelas.tsx', {
    'next/link': { default: function Link() {} },
    '@/lib/http/admin-fetch': { adminFetch: async () => { throw new Error('não acessar rede'); } },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/submissao': submissao,
    './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    './financeiro.module.css': cssFalso,
    './PixParcela': { PixParcela: 'div' },
  });
}

const LIGADAS = { liquidacao: true, reversao: true, abertura: true };
const entrada = (id: string, status: string, saldoCentavos: number) =>
  ({ id, origem: 'ENTRADA_MANUAL', cliente: 'Avulsa', pacote: '—', festaId: null, parcela: 1, vencimento: '2026-11-09', valorCentavos: 1000, recebidoCentavos: 1000 - saldoCentavos, saldoCentavos, forma: 'PIX', status, diasAtraso: 0 });
const conta = (id: string, status: string, pagoCentavos: number) =>
  ({ id, descricao: 'Aluguel', favorecido: null, categoria: 'Fixos', categoriaId: 'c', vencimento: '2026-11-09', valorCentavos: 1000, saldoCentavos: 1000 - pagoCentavos, pagoCentavos, status, forma: 'PIX' });

type Linha = { acao?: () => void; extra?: { rotulo: string; aoClicar: () => void } };
function linhas(arvore: unknown) {
  const tabela = elementos(arvore as Elemento).find((e) => (e.type as { name?: string }).name === 'Tabela');
  assert(tabela, 'tabela');
  return tabela.props.linhas as Linha[];
}

test('flags desligadas: entrada avulsa sem ação e conta paga sem "Reverter" (tela igual à fase A)', () => {
  const t = telas();
  const receber = linhas(t.render('default', { tela: 'receber', amostra: { recebiveis: [entrada('e1', 'A receber', 1000)] } }));
  assert.equal(receber[0].acao, undefined);
  const pagar = linhas(telas().render('default', { tela: 'pagar', amostra: { contas: [conta('c1', 'Pago', 1000)], categorias: [] } }));
  assert.equal(pagar[0].extra, undefined);
});

test('liquidação ligada: entrada avulsa em aberto abre o diálogo próprio; paga ou cancelada não', () => {
  const t = telas();
  const amostra = { recebiveis: [entrada('e1', 'Parcialmente pago', 400), entrada('e2', 'Pago', 0), entrada('e3', 'Cancelado', 1000)], operacoes: LIGADAS };
  const [aberta, paga, cancelada] = linhas(t.render('default', { tela: 'receber', amostra }));
  assert.equal(paga.acao, undefined);
  assert.equal(cancelada.acao, undefined);
  assert.ok(aberta.acao);
  aberta.acao();
  const depois = t.render('default', { tela: 'receber', amostra });
  const dialogo = elementos(depois as Elemento).find((e) => (e.type as { name?: string }).name === 'Dialogo');
  assert.equal(dialogo?.props.titulo, 'Registrar recebimento da entrada');
  const valor = elementos(depois as Elemento).find((e) => (e.type as { name?: string }).name === 'Campo' && e.props.nome === 'valor');
  assert.equal(valor?.props.padrao, '4.00', 'sugere o saldo, que pode ser alterado para parcial');
});

test('reversão ligada: "Reverter" só em conta com algo pago, inclusive parcial', () => {
  const t = telas();
  const amostra = { contas: [conta('c1', 'Pago', 1000), conta('c2', 'Parcialmente paga', 300), conta('c3', 'A pagar', 0)], categorias: [], operacoes: LIGADAS };
  const [paga, parcial, aberta] = linhas(t.render('default', { tela: 'pagar', amostra }));
  assert.equal(paga.extra?.rotulo, 'Reverter');
  assert.equal(parcial.extra?.rotulo, 'Reverter');
  assert.equal(aberta.extra, undefined);
});

/** Tela com rede simulada: cada chamada fica pendente até o teste responder (ou falhar). */
function comRede() {
  const pedidos: Array<{ url: string; corpo: Record<string, unknown> | null; responder: (status: number, corpo: unknown) => void; falhar: () => void }> = [];
  const adminFetch = (url: string, init?: { body?: string }) => new Promise((resolve, reject) => {
    pedidos.push({
      url,
      corpo: init?.body ? JSON.parse(init.body) : null,
      responder: (status, corpo) => resolve({ status, json: async () => corpo }),
      falhar: () => reject(new TypeError('rede')),
    });
  });
  const t = carregarComponente('components/admin/FinanceiroTelas.tsx', {
    'next/link': { default: function Link() {} },
    '@/lib/http/admin-fetch': { adminFetch },
    '@/lib/financeiro/calculos': calculos,
    '@/lib/financeiro/submissao': submissao,
    './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    './financeiro.module.css': cssFalso,
    './PixParcela': { PixParcela: 'div' },
  });
  return { t, pedidos };
}
const formulario = (valores: Record<string, string>) => ({ get: (nome: string) => valores[nome] ?? null });
const porNome = (arvore: unknown, nome: string) => elementos(arvore as Elemento).find((e) => (e.type as { name?: string }).name === nome);

test('liquidação: recusa do servidor renova a chave; falha de rede preserva a chave para o retry', async () => {
  const { t, pedidos } = comRede();
  const amostra = { recebiveis: [entrada('e1', 'A receber', 1000)], operacoes: LIGADAS };
  linhas(t.render('default', { tela: 'receber', amostra }))[0].acao!();
  const enviar = async () => {
    const dialogo = porNome(t.render('default', { tela: 'receber', amostra }), 'Dialogo');
    (dialogo!.props.aoEnviar as (f: unknown) => void)(formulario({ valor: '4', data: '2026-11-09', forma: 'PIX' }));
    await tique();
    return pedidos[pedidos.length - 1];
  };
  const primeiro = await enviar();
  assert.match(primeiro.url, /\/contas-receber\/e1\/liquidacoes$/);
  primeiro.responder(409, { ok: false, erro: 'Esta chave já registrou outro recebimento.', code: 'IDEMPOTENCIA_CONFLITANTE' });
  await tique(); await tique();
  const segundo = await enviar();
  assert.notEqual(segundo, primeiro);
  assert.notEqual(segundo.corpo?.chave, primeiro.corpo?.chave, 'o servidor respondeu: o formulário corrigido vai com chave nova');
  segundo.falhar();
  await tique(); await tique();
  const terceiro = await enviar();
  assert.notEqual(terceiro, segundo);
  assert.equal(terceiro.corpo?.chave, segundo.corpo?.chave, 'sem resposta: a mesma chave, para não gravar duas vezes');
});

const LEITURA = (dataBase: string, hash: string) => ({
  ok: true,
  data: { disponivel: true, podeGerir: true, hoje: '2026-11-10', vigente: null, pendencias: { quantidade: 0, centavos: 0, itens: [] }, previa: { dataBase, janela: null, movimentos: [], conjuntoHash: hash, movimentoDesdeD0Centavos: 0 } },
});

test('abertura: não confirma enquanto a prévia não é da data escolhida; resposta antiga de outra data é descartada', async () => {
  const { t, pedidos } = comRede();
  const props = { aoMudar: () => undefined };
  const FormDataOriginal = globalThis.FormData;
  globalThis.FormData = function FormDataFalso() { return formulario({ saldo: '100', justificativa: 'extrato' }); } as unknown as typeof FormData;
  try {
    t.render('PainelAbertura', props);
    t.efeitos();
    pedidos[0].responder(200, LEITURA('2026-11-10', 'h-hoje'));
    await tique(); await tique();
    const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
    const campoData = () => arvore().find((e) => e.type === 'input' && e.props['aria-label'] === 'Data do saldo')!;
    const confirmar = () => arvore().find((e) => e.type === 'button' && e.props.type === 'submit')!;
    const submeter = () => {
      const form = arvore().find((e) => e.type === 'form')!;
      return (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {} });
    };
    assert.equal(confirmar().props.disabled, false);

    (campoData().props.onChange as (e: unknown) => void)({ target: { value: '2026-10-01' } });
    (campoData().props.onChange as (e: unknown) => void)({ target: { value: '2026-09-01' } });
    assert.equal(campoData().props.value, '2026-09-01');
    assert.equal(confirmar().props.disabled, true, 'a prévia ainda é de hoje: não confirma');
    const antes = pedidos.length;
    void submeter();
    await tique();
    assert.equal(pedidos.length, antes, 'enviar antes da prévia chegar não faz POST');

    const [deOutubro, deSetembro] = pedidos.slice(1, 3);
    assert.match(deOutubro.url, /dataBase=2026-10-01/);
    assert.match(deSetembro.url, /dataBase=2026-09-01/);
    deSetembro.responder(200, LEITURA('2026-09-01', 'h-setembro'));
    await tique(); await tique();
    deOutubro.responder(200, LEITURA('2026-10-01', 'h-outubro'));
    await tique(); await tique();
    assert.equal(campoData().props.value, '2026-09-01', 'a resposta antiga não troca a data');
    assert.equal(confirmar().props.disabled, false);

    void submeter();
    await tique();
    const post = pedidos[pedidos.length - 1];
    assert.match(post.url, /\/abertura$/);
    assert.equal(post.corpo?.dataBase, '2026-09-01');
    assert.equal(post.corpo?.conjuntoHash, 'h-setembro');
  } finally {
    globalThis.FormData = FormDataOriginal;
  }
});

test('abertura: apagar a data invalida a leitura pendente; a resposta não repõe a data nem libera o envio', async () => {
  const { t, pedidos } = comRede();
  const props = { aoMudar: () => undefined };
  const FormDataOriginal = globalThis.FormData;
  globalThis.FormData = function FormDataFalso() { return formulario({ saldo: '100', justificativa: 'extrato' }); } as unknown as typeof FormData;
  try {
    t.render('PainelAbertura', props);
    t.efeitos();
    pedidos[0].responder(200, LEITURA('2026-11-10', 'h-hoje'));
    await tique(); await tique();
    const arvore = () => elementos(t.render('PainelAbertura', props) as Elemento);
    const campoData = () => arvore().find((e) => e.type === 'input' && e.props['aria-label'] === 'Data do saldo')!;
    const confirmar = () => arvore().find((e) => e.type === 'button' && e.props.type === 'submit')!;
    const status = () => arvore().find((e) => e.type === 'p' && e.props.role === 'status');
    const submeter = () => {
      const form = arvore().find((e) => e.type === 'form')!;
      return (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: {} });
    };

    (campoData().props.onChange as (e: unknown) => void)({ target: { value: '2026-10-01' } });
    (campoData().props.onChange as (e: unknown) => void)({ target: { value: '' } });
    assert.equal(campoData().props.value, '');
    assert.equal(confirmar().props.disabled, true);
    assert.ok(status(), 'avisa que a prévia não é da data escolhida');

    const deOutubro = pedidos[1];
    assert.match(deOutubro.url, /dataBase=2026-10-01/);
    deOutubro.responder(200, LEITURA('2026-10-01', 'h-outubro'));
    await tique(); await tique();
    assert.equal(campoData().props.value, '', 'a resposta da data apagada não repõe a data');
    assert.equal(confirmar().props.disabled, true, 'campo vazio continua sem confirmar');
    const antes = pedidos.length;
    void submeter();
    await tique();
    assert.equal(pedidos.length, antes, 'nenhum POST com a data apagada');

    // Escolher de novo depois volta a funcionar normalmente.
    (campoData().props.onChange as (e: unknown) => void)({ target: { value: '2026-09-01' } });
    pedidos[pedidos.length - 1].responder(200, LEITURA('2026-09-01', 'h-setembro'));
    await tique(); await tique();
    assert.equal(campoData().props.value, '2026-09-01');
    assert.equal(confirmar().props.disabled, false);
    void submeter();
    await tique();
    const post = pedidos[pedidos.length - 1];
    assert.match(post.url, /\/abertura$/);
    assert.equal(post.corpo?.dataBase, '2026-09-01');
    assert.equal(post.corpo?.conjuntoHash, 'h-setembro');
  } finally {
    globalThis.FormData = FormDataOriginal;
  }
});
