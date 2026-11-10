import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABAS_LISTA, FalhaContrato, MENSAGEM_LINK_INVALIDO, MENSAGEM_SEM_ACESSO, PREFIXO_IMPORTADO, criarSequenciador, listaDaUrl, urlSemBuscaAntiga, urlComVersao, urlSemVersao, mensagemFalhaContrato, opcaoForaDaLista, pedidoDaUrl, urlDaLista, urlDaSelecao, valorDaSelecao,
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

test('contrato importado: `importacaoId` na URL é um pedido próprio; o seletor usa o prefixo e a troca limpa o contrato do Core', () => {
  const I = '00000000-0000-4000-8000-0000000000a1';
  assert.deepEqual(pedidoDaUrl(new URLSearchParams(`importacaoId=${I.toUpperCase()}`)), { tipo: 'importado', importacaoId: I });
  assert.deepEqual(pedidoDaUrl(new URLSearchParams(`importacaoId=${I}&contratoId=${A}`)), { tipo: 'importado', importacaoId: I }, 'importacaoId prevalece');
  assert.deepEqual(pedidoDaUrl(new URLSearchParams('importacaoId=nao-uuid')), { tipo: 'invalido' });
  assert.equal(valorDaSelecao({ id: I, origem: 'IMPORTACAO' }), `${PREFIXO_IMPORTADO}${I}`);
  assert.equal(valorDaSelecao({ id: A }), A);
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams(`contratoId=${A}&versaoId=${V}&returnTo=x`), `${PREFIXO_IMPORTADO}${I}`), `/admin/contratos?returnTo=x&importacaoId=${I}`);
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams(`importacaoId=${I}`), B), `/admin/contratos?contratoId=${B}`);
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams(`importacaoId=${I}`), ''), '/admin/contratos');
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

test('O-1: só o filtro da lista vai à URL — leitura validada, gravação mínima e preservação ao abrir/fechar contrato', () => {
  assert.deepEqual(listaDaUrl(new URLSearchParams('filtro=todas')), { aba: 'todas', emUso: true });
  assert.deepEqual(listaDaUrl(new URLSearchParams('filtro=qualquer')), { aba: 'proximas', emUso: true }, 'filtro desconhecido cai no padrão');
  assert.deepEqual(listaDaUrl(new URLSearchParams('')), { aba: 'proximas', emUso: false }, 'sem filtro é a lista limpa');
  for (const aba of ABAS_LISTA) assert.equal(listaDaUrl(new URLSearchParams(`filtro=${aba}`)).aba, aba);
  assert.equal(urlDaLista('/admin/contratos', new URLSearchParams('returnTo=%2Ffestas'), 'importados', true), '/admin/contratos?returnTo=%2Ffestas&filtro=importados');
  assert.equal(urlDaLista('/admin/contratos', new URLSearchParams('filtro=todas'), 'proximas', false), '/admin/contratos');
  assert.equal(urlDaLista('/admin/contratos', new URLSearchParams(''), 'proximas', true), '/admin/contratos?filtro=proximas', 'com busca, o padrão fica explícito');
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams('filtro=todas'), A), `/admin/contratos?filtro=todas&contratoId=${A}`);
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams(`filtro=todas&contratoId=${A}&versaoId=${B}`), ''), '/admin/contratos?filtro=todas');
});

test('O-1: o termo de busca de links antigos é ignorado e nunca regravado', () => {
  const antigo = new URLSearchParams(`filtro=todas&busca=lucas&contratoId=${A}`);
  assert.deepEqual(listaDaUrl(antigo), { aba: 'todas', emUso: true }, 'a leitura não devolve o termo');
  assert.deepEqual(listaDaUrl(new URLSearchParams('busca=lucas')), { aba: 'proximas', emUso: false });
  assert.equal(urlDaLista('/admin/contratos', new URLSearchParams('filtro=todas&busca=lucas'), 'canceladas', true), '/admin/contratos?filtro=canceladas');
  assert.equal(urlDaLista('/admin/contratos', new URLSearchParams('busca=lucas'), 'proximas', false), '/admin/contratos');
  assert.equal(urlDaSelecao('/admin/contratos', antigo, ''), '/admin/contratos?filtro=todas');
  assert.equal(urlDaSelecao('/admin/contratos', new URLSearchParams('filtro=todas&busca=lucas'), `importacao:${B}`), `/admin/contratos?filtro=todas&importacaoId=${B}`);
  assert.equal(urlSemBuscaAntiga('/admin/contratos', antigo), `/admin/contratos?filtro=todas&contratoId=${A}`);
  assert.equal(urlSemBuscaAntiga('/admin/contratos', new URLSearchParams('busca=lucas')), '/admin/contratos');
  assert.equal(urlSemBuscaAntiga('/admin/contratos', new URLSearchParams('filtro=todas')), null);
});

test('O-1: o proxy redireciona o link antigo antes de a aplicação ser entregue, e só nesta rota', () => {
  const proxy = readFileSync('proxy.ts', 'utf8');
  assert.match(proxy, /pareceListaDeContratos\(request\.nextUrl\.pathname\) \? urlSemBuscaAntiga\("\/admin\/contratos", request\.nextUrl\.searchParams\) : null/);
  assert.match(proxy, /if \(limpa\) return NextResponse\.redirect\(new URL\(limpa, request\.url\), \{ status: 307, headers: \{ "Cache-Control": "no-store" \} \}\);/);
  assert.equal(urlSemBuscaAntiga('/admin/contratos', new URLSearchParams(`returnTo=a&busca=lucas&busca=theo&contratoId=${A}`)), `/admin/contratos?returnTo=a&contratoId=${A}`);
  assert.equal(urlSemBuscaAntiga('/admin/contratos', new URLSearchParams('busca=')), '/admin/contratos', 'busca vazia também sai');
});

test('O-1: abrir e fechar a consulta de versão nunca levam adiante o termo de link antigo', () => {
  const antigo = new URLSearchParams(`filtro=todas&busca=lucas&contratoId=${A}&versaoId=${V}`);
  assert.equal(urlSemVersao('/admin/contratos', antigo), `/admin/contratos?filtro=todas&contratoId=${A}`);
  assert.equal(urlComVersao('/admin/contratos', antigo, V), `/admin/contratos?filtro=todas&contratoId=${A}&versaoId=${V}#historico`);
  assert.equal(urlSemVersao('/admin/contratos', new URLSearchParams(`versaoId=${V}`)), '/admin/contratos');
});
