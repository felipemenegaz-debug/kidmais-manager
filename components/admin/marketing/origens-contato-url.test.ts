import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';
import * as acoesUi from '../../../lib/marketing/acoes-ui.ts';
import { TELEFONE_ANONIMIZADO } from '../../../lib/whatsapp/atendimento/walle/oportunidade.ts';

// Wall-e 1a r4 (P1-2): o link "a revisar" da Privacidade do atendimento abre /admin/marketing/origens?contato=<id> e a
// tela abre direto o detalhe desse cartão (carregado pela API, que corta por empresa e ambiente). Id fora do formato: nada.
// r5 (P3): o detalhe filho é renderizado e a requisição dele precisa ser a do UUID pedido. r5 (P2): cartão anonimizado
// mostra os registros a conferir e nenhum controle de edição.
const K = '44444444-4444-4444-8444-444444444444';

function carregar(urls: string[], respostaDetalhe: unknown = null) {
  const useMarketing = (url: string) => {
    urls.push(url);
    const dados = url.startsWith('/api/admin/marketing/contatos?id=') ? respostaDetalhe : null;
    return { dados, falha: null, carregando: dados === null, recarregar: () => undefined };
  };
  return { h: carregarComponente('components/admin/marketing/MarketingOrigens.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children }, 'next/navigation': { useRouter: () => ({ push: () => undefined }) },
    '@/lib/clientes/utils': { statusFechamentoLabel: () => '' }, '@/lib/marketing/acoes-ui': acoesUi,
    '@/lib/http/admin-fetch': { adminFetch: async () => ({ ok: true, json: async () => ({}) }) },
    '@/lib/marketing/apresentacao': { clientesDaBusca: () => [], dataBr: () => '', dataHoraBr: (v: string) => v, ROTULO_STATUS_CONTATO: {} },
    '../AdminPrimaryButton': { AdminPrimaryButton: () => null }, './AtribuicaoExplicada': { AtribuicaoExplicada: () => null },
    './comum': { CabecalhoMarketing: () => null, EstadoCarga: () => null, enviarMarketing: async () => ({}), novaChave: () => 'k', useMarketing },
    './marketing.module.css': cssFalso,
  }) };
}

async function montar(search: string) {
  const urls: string[] = [];
  const { h } = carregar(urls);
  globalThis.window = { setTimeout, clearTimeout, location: { search } } as never;
  globalThis.document = { addEventListener: () => undefined, removeEventListener: () => undefined } as never;
  h.render(); h.efeitos(); await new Promise((r) => setTimeout(r, 5)); await tique();
  const arvore = h.render(); h.efeitos();
  return { urls, arvore, h };
}

test('r4/r5: ?contato=<uuid> abre o detalhe do cartão e ele pede exatamente esse UUID; id fora do formato é ignorado', async () => {
  const certo = await montar(`?contato=${K}`);
  const dialogo = elementos(certo.arvore).find((e) => e.type === certo.h.modulo.DetalheDialogo);
  assert.ok(dialogo, 'o detalhe está aberto');
  assert.equal(dialogo.props.id, K);
  // O filho é renderizado de verdade: a URL que ele pede é a do cartão pedido (e só ela).
  const urlsFilho: string[] = [];
  const filho = carregar(urlsFilho).h;
  filho.render('DetalheDialogo', dialogo.props);
  assert.deepEqual(urlsFilho, [`/api/admin/marketing/contatos?id=${K}`]);

  const errado = await montar('?contato=javascript:alert(1)');
  assert.equal(elementos(errado.arvore).some((e) => e.type === errado.h.modulo.DetalheDialogo), false, 'nada aberto com id fora do formato');
  assert.equal(errado.urls.some((u) => u.startsWith('/api/admin/marketing/contatos?id=')), false);
});

test('r5 (P2): cartão anonimizado é só leitura e mostra os registros da equipe a conferir', () => {
  const contato = {
    id: K, nome: 'Contato anonimizado', canal: 'WHATSAPP', recebidoEm: '2026-11-23T10:00:00Z', status: 'NOVO', clienteId: null, clienteNome: null,
    telefone: null, email: null, dataDesejada: null, convidados: null, mensagem: null, fechamentoId: null, atribuicoes: [], origemCliente: null,
    vinculoCliente: 'NENHUM', fechamentosDoCliente: [], anonimizado: true,
    registrosParaRevisar: [
      { tipo: 'HISTORICO', id: 'h1', quando: '2026-11-23T09:00:00Z', rotulo: 'Histórico do cliente: CONTATO_MARKETING_VINCULADO', texto: 'ligou pedindo orçamento', por: 'Ana' },
      { tipo: 'ATRIBUICAO', id: 'a1', quando: '2026-11-23T09:30:00Z', rotulo: 'Origem INSTAGRAM do cliente', texto: 'veio do post', por: null },
    ],
  };
  const urls: string[] = [];
  const { h } = carregar(urls, { contato, origens: [] });
  const arvore = h.render('DetalheDialogo', { id: K, podeEditar: true, aoFechar: () => undefined });
  const tudo = texto(arvore);
  assert.match(tudo, /anonimizado a pedido do titular: só leitura/);
  const registros = elementos(arvore).filter((e) => e.props['data-registro-revisar']);
  assert.deepEqual(registros.map((e) => e.props['data-registro-revisar']), ['HISTORICO', 'ATRIBUICAO']);
  assert.match(texto(registros[0]), /CONTATO_MARKETING_VINCULADO · 2026-11-23T09:00:00Z · ligou pedindo orçamento · por Ana/);
  assert.match(texto(registros[1]), /Origem INSTAGRAM do cliente/);
  // Nenhum controle de edição: busca/vínculo de cliente, status. O AcoesPedido filho recebe o contato anonimizado e
  // também não oferece "Abrir negociação" (renderizado abaixo).
  assert.equal(elementos(arvore).some((e) => e.props['aria-label'] === 'Buscar cliente'), false);
  assert.doesNotMatch(tudo, /Buscar|Vincular|Marcar em atendimento/);
  const acoes = elementos(arvore).find((e) => e.type === h.modulo.AcoesPedido);
  assert.ok(acoes);
  const acoesArvore = carregar([]).h.render('AcoesPedido', acoes.props);
  assert.doesNotMatch(texto(acoesArvore), /Abrir negociação/);
  // Controle: o mesmo cartão sem anonimização oferece os controles (o teste acima não passa por acaso).
  const editavel = carregar([], { contato: { ...contato, anonimizado: false, registrosParaRevisar: [] }, origens: [] }).h
    .render('DetalheDialogo', { id: K, podeEditar: true, aoFechar: () => undefined });
  assert.match(texto(editavel), /Buscar/);
  assert.equal(elementos(editavel).some((e) => e.props['data-registro-revisar']), false);
  assert.match(texto(carregar([]).h.render('AcoesPedido', { contato: { ...contato, anonimizado: false }, podeEditar: true })), /Abrir negociação/);
});

test('r6 (P3-1): cartão anonimizado nunca oferece "Chamar" (linkChamar real, telefone neutro de verdade)', () => {
  const base = {
    id: K, nome: 'Contato anonimizado', canal: 'WHATSAPP', recebidoEm: '2026-11-23T10:00:00Z', status: 'NOVO', clienteId: null, clienteNome: null,
    email: null, dataDesejada: null, convidados: null, fechamentoId: null, vinculoCliente: 'SEM_CLIENTE', anonimizado: true,
  };
  const chamar = (contato: Record<string, unknown>, podeEditar = true) =>
    elementos(carregar([]).h.render('AcoesPedido', { contato, podeEditar })).filter((e) => typeof e.props.href === 'string' && e.props.href.startsWith('https://wa.me/'));
  // O telefone que a exclusão grava de fato, com a função real: nenhum link.
  assert.equal(TELEFONE_ANONIMIZADO, '0000000000');
  assert.equal(acoesUi.linkChamar(TELEFONE_ANONIMIZADO, 'Contato anonimizado'), null);
  assert.deepEqual(chamar({ ...base, telefone: TELEFONE_ANONIMIZADO }), []);
  assert.deepEqual(chamar({ ...base, telefone: TELEFONE_ANONIMIZADO }, false), []);
  // A tela também esconde pelo `anonimizado`, independente do número (proteção própria, não só do formato).
  assert.deepEqual(chamar({ ...base, telefone: '5561999990000' }), []);
  // Controle: o mesmo cartão sem anonimização e com número real oferece "Chamar".
  const controle = chamar({ ...base, anonimizado: false, nome: 'Ana', telefone: '5561999990000' });
  assert.equal(controle.length, 1);
  assert.match(String(controle[0].props.href), /^https:\/\/wa\.me\/5561999990000\?text=/);
});
