import assert from 'node:assert/strict';
import test from 'node:test';
import { conteudoDialogoAlteracoes } from './dialogo-alteracoes.ts';

// O1 (revisão de 30b93fb): o pedido de saída é preservado depois de um salvamento que termina durante a espera; a
// mensagem e as ações têm de refletir o estado REAL. Comportamento integrado (editor/hook/guardião reais): RV-I5 no Next.

test('O1: tudo salvo → não afirma perda nem exige salvar de novo; "Continuar editando" ou sair (decisão explícita)', () => {
  for (const acao of ['sair', 'trocar'] as const) {
    const r = conteudoDialogoAlteracoes('salvo', acao, 'Unidade Centro', true);
    assert.doesNotMatch(r.texto, /ainda não foram salvas|se perdem/);
    assert.match(r.texto, /já foram salvas/);
    assert.deepEqual(r.acoes, ['continuar', 'sair']);
  }
});

test('O1: alterações não salvas (inclusive digitadas durante o envio) → protege e oferece salvar ou sair sem salvar', () => {
  const r = conteudoDialogoAlteracoes('sujo', 'sair', 'empresa (sem unidade)', true);
  assert.equal(r.texto, 'O site da empresa (sem unidade) tem alterações que ainda não foram salvas. Se sair agora sem salvar, elas se perdem.');
  assert.deepEqual(r.acoes, ['continuar', 'salvar-e-sair', 'sair-sem-salvar']);
  assert.deepEqual(conteudoDialogoAlteracoes('sujo', 'sair', 'x', false).acoes, ['continuar', 'sair-sem-salvar'], 'sem permissão de editar: não oferece salvar');
});

test('O1: salvamento em andamento → ainda não salvo (o botão de salvar mostra o progresso; sair sem salvar fica desabilitado no componente)', () => {
  const r = conteudoDialogoAlteracoes('salvando', 'sair', 'x', true);
  assert.match(r.texto, /ainda não foram salvas/);
  assert.deepEqual(r.acoes, ['continuar', 'salvar-e-sair', 'sair-sem-salvar']);
});

test('O1: erro ao salvar nunca aparece como salvo', () => {
  const r = conteudoDialogoAlteracoes('erro', 'trocar', 'x', true);
  assert.match(r.texto, /falhou: as alterações ainda não foram salvas\. Se trocar agora sem salvar, elas se perdem\./);
  assert.doesNotMatch(r.texto, /já foram salvas/);
  assert.deepEqual(r.acoes, ['continuar', 'salvar-e-sair', 'sair-sem-salvar']);
});
