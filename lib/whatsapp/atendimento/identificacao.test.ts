import assert from 'node:assert/strict';
import test from 'node:test';
import { entradaGupshup, nomePerfilSeguro, situacaoCadastro, NOME_PERFIL_MAX } from './core.ts';
import { formatarTelefone, identificar, ROTULO_PERFIL } from './identificacao.ts';

// Identificação do contato na tela de Atendimento: número completo, nome CADASTRADO e nome de PERFIL (não verificado).
const evento = (sender?: unknown) => ({ app: 'KidmaisManager', version: 2, type: 'message', timestamp: 1, payload: { id: 'sintetico', source: '5561900000101', type: 'text', payload: { text: 'Olá' }, ...(sender === undefined ? {} : { sender }) } });

test('webhook: nome de perfil vem de payload.sender.name (formato oficial v2 do Gupshup) e é saneado', () => {
  assert.equal(entradaGupshup(evento({ phone: '5561900000101', name: 'Ana Souza', country_code: '55', dial_code: '61900000101' }))?.nomePerfil, 'Ana Souza');
  assert.equal(entradaGupshup(evento())?.nomePerfil, null, 'sem sender: sem nome');
  assert.equal(entradaGupshup(evento({ phone: '5561900000101' }))?.nomePerfil, null, 'sender sem name: sem nome');
  // sender malformado não derruba o evento: a mensagem continua chegando, só sem nome.
  const malformado = entradaGupshup(evento('não é objeto'));
  assert.equal(malformado?.texto, 'Olá'); assert.equal(malformado?.nomePerfil, null);
  assert.equal(entradaGupshup(evento({ name: 42 }))?.nomePerfil, null);
});

test('nome de perfil: controle/formatação removidos, espaços colapsados, limite de 80, vazio vira null', () => {
  assert.equal(nomePerfilSeguro('  Ana\u0000​  \n Souza‮ '), 'Ana Souza');
  assert.equal(nomePerfilSeguro('Ｊｏãｏ'), 'João', 'NFKC');
  assert.equal(nomePerfilSeguro('​ \n'), null);
  assert.equal(nomePerfilSeguro(''), null); assert.equal(nomePerfilSeguro(null), null); assert.equal(nomePerfilSeguro({}), null);
  const longo = nomePerfilSeguro('😀'.repeat(200))!;
  assert.equal(Array.from(longo).length, NOME_PERFIL_MAX, 'conta caracteres, não unidades UTF-16 (não parte emoji)');
});

test('cadastro: um cliente dá o nome; vários dão só a quantidade (nenhum escolhido); nenhum é sem cadastro', () => {
  assert.deepEqual(situacaoCadastro(1, ' Maria Lima '), { situacao: 'UNICO', nome: 'Maria Lima' });
  assert.deepEqual(situacaoCadastro(3, null), { situacao: 'AMBIGUO', quantidade: 3 });
  assert.deepEqual(situacaoCadastro(2, 'Não deve aparecer'), { situacao: 'AMBIGUO', quantidade: 2 });
  assert.deepEqual(situacaoCadastro(0, null), { situacao: 'SEM_CADASTRO' });
});

test('número completo formatado: celular e fixo do Brasil; outros países com +', () => {
  assert.equal(formatarTelefone('5561900000101'), '+55 (61) 90000-0101');
  assert.equal(formatarTelefone('556132221234'), '+55 (61) 3222-1234');
  assert.equal(formatarTelefone('14155550123'), '+14155550123');
});

test('identificação: nome cadastrado tem prioridade; perfil sempre rotulado como não verificado; ambíguo não escolhe', () => {
  const base = { contato: '5561900000101' };
  const unico = identificar({ ...base, nome_perfil: 'Aninha 🎈', cadastro: { situacao: 'UNICO', nome: 'Ana Souza' } });
  assert.equal(unico.titulo, 'Ana Souza'); assert.equal(unico.origemTitulo, 'CADASTRO');
  assert.equal(unico.telefone, '+55 (61) 90000-0101');
  assert.equal(unico.perfil, `Aninha 🎈 (${ROTULO_PERFIL})`, 'o perfil continua visível e rotulado, separado do cadastro');

  const ambiguo = identificar({ ...base, nome_perfil: 'Aninha', cadastro: { situacao: 'AMBIGUO', quantidade: 2 } });
  assert.equal(ambiguo.titulo, `Aninha (${ROTULO_PERFIL})`, 'título vem do perfil, rotulado — nunca de um dos cadastros');
  assert.equal(ambiguo.origemTitulo, 'PERFIL');
  assert.match(ambiguo.cadastro, /2 clientes cadastrados com este número\. Nenhum foi escolhido/);
  assert.ok(ambiguo.ambiguo);

  const semNada = identificar({ ...base, nome_perfil: null, cadastro: { situacao: 'SEM_CADASTRO' } });
  assert.equal(semNada.titulo, '+55 (61) 90000-0101'); assert.equal(semNada.origemTitulo, 'NUMERO');
  assert.equal(semNada.perfil, 'Não informado pelo WhatsApp');
  assert.equal(semNada.cadastro, 'Nenhum cliente cadastrado com este número.');
});
