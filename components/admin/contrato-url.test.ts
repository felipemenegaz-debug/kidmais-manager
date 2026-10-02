import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FalhaContrato, MENSAGEM_LINK_INVALIDO, MENSAGEM_SEM_ACESSO, criarSequenciador, mensagemFalhaContrato, opcaoForaDaLista, pedidoDaUrl, urlDaSelecao,
} from './contrato-url.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const V = '00000000-0000-4000-8000-0000000000f1';

test('pedidoDaUrl: contrato e versão válidos; versão inválida é ignorada; contrato inválido é recusado', () => {
  assert.deepEqual(pedidoDaUrl(new URLSearchParams('')), { tipo: 'nenhum' });
  assert.deepEqual(pedidoDaUrl(new URLSearchParams(`contratoId=${A}&versaoId=${V}`)), { tipo: 'contrato', contratoId: A, versaoId: V });
  assert.deepEqual(pedidoDaUrl(new URLSearchParams(`contratoId=${A.toUpperCase()}`)), { tipo: 'contrato', contratoId: A, versaoId: null });
  assert.deepEqual(pedidoDaUrl(new URLSearchParams(`contratoId=${A}&versaoId=x`)), { tipo: 'contrato', contratoId: A, versaoId: null });
  assert.deepEqual(pedidoDaUrl(new URLSearchParams('contratoId=nao-uuid')), { tipo: 'invalido' });
});

test('urlDaSelecao: troca o contrato, descarta a versão anterior e preserva os demais parâmetros', () => {
  const atual = new URLSearchParams(`contratoId=${A}&versaoId=${V}&returnTo=%2Fadmin%2Ffestas%2Fx`);
  assert.equal(urlDaSelecao('/admin/contratos', atual, B), `/admin/contratos?contratoId=${B}&returnTo=%2Fadmin%2Ffestas%2Fx`);
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams(`contratoId=${A}`), ''), '/admin/contratos');
});

test('mensagemFalhaContrato: inexistente/outra empresa (404) e sem permissão (403) têm mensagem clara', () => {
  assert.equal(mensagemFalhaContrato(404, 'Contrato não encontrado.'), MENSAGEM_SEM_ACESSO);
  assert.equal(mensagemFalhaContrato(403, 'Acesso negado.'), MENSAGEM_SEM_ACESSO);
  assert.equal(mensagemFalhaContrato(400, 'Contrato inválido.'), MENSAGEM_LINK_INVALIDO);
  assert.equal(mensagemFalhaContrato(500, 'Falha interna.'), 'Falha interna.');
  assert.match(mensagemFalhaContrato(500, null), /Não foi possível carregar o contrato/);
  assert.equal(new FalhaContrato(404, MENSAGEM_SEM_ACESSO).status, 404);
});

test('criarSequenciador: só o último pedido é vigente (resposta atrasada é descartada)', () => {
  const s = criarSequenciador();
  const primeiro = s.iniciar();
  const segundo = s.iniciar();
  assert.equal(s.vigente(primeiro), false);
  assert.equal(s.vigente(segundo), true);
});

test('opcaoForaDaLista: só para o contrato aberto que a lista não contém, com os dados da versão atual', () => {
  const painel = {
    contrato: { id: B, status: 'CANCELADO', versao_atual: 2 },
    versoes: [
      { numero_versao: 1, snapshot: { contratante: { nomeCompleto: 'Antigo' } } },
      { numero_versao: 2, snapshot: { contratante: { nomeCompleto: 'Cliente B' }, evento: { data: '2099-01-02', pacote: { nome: 'Premium' }, convidados: 40 } } },
    ],
  };
  assert.deepEqual(opcaoForaDaLista([{ id: A, nome: 'Cliente A' }], B, painel), {
    id: B, nome: 'Cliente B', data_evento: '2099-01-02', pacote: 'Premium', convidados: 40, status: 'CANCELADO',
  });
  assert.equal(opcaoForaDaLista([{ id: B, nome: 'Cliente B' }], B, painel), null, 'já está na lista');
  assert.equal(opcaoForaDaLista([], A, painel), null, 'painel de outro contrato (resposta ainda não aplicada)');
  assert.equal(opcaoForaDaLista([], B, null), null, 'ainda carregando');
});
