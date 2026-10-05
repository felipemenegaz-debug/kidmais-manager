import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { bloqueioDoCodigo } from './acesso-tela.ts';
import { respostaDeErroAtendimento } from './erros.ts';

test('três situações distintas na tela: divergência, seleção pendente e falta de acesso', () => {
  const divergente = bloqueioDoCodigo('ATENDIMENTO_EMPRESA_DIVERGENTE'), pendente = bloqueioDoCodigo('ATENDIMENTO_EMPRESA_NAO_SELECIONADA');
  const semAcesso = bloqueioDoCodigo('ATENDIMENTO_SEM_ACESSO'), papel = bloqueioDoCodigo('ATENDIMENTO_ACESSO_NEGADO');
  assert.equal(divergente?.tipo, 'EMPRESA_DIVERGENTE');
  assert.equal(pendente?.tipo, 'EMPRESA_NAO_SELECIONADA');
  assert.equal(semAcesso?.tipo, 'SEM_ACESSO');
  assert.equal(papel?.tipo, 'SEM_ACESSO', 'papel sem acesso e vínculo ausente são a mesma situação para quem vê');
  const titulos = new Set([divergente?.titulo, pendente?.titulo, semAcesso?.titulo]);
  assert.equal(titulos.size, 3, 'cada situação tem título próprio');
  assert.match(divergente!.orientacao, /Troque a empresa ativa/);
  assert.match(pendente!.orientacao, /Selecione a empresa/);
  assert.match(semAcesso!.orientacao, /Peça a liberação/);
});

test('outros erros não viram bloqueio (seguem como mensagem comum)', () => {
  for (const codigo of ['ATENDIMENTO_INDISPONIVEL', 'ATENDIMENTO_DESATUALIZADO', 'TENANT_NAO_COMPROVADO', undefined, null, 42]) assert.equal(bloqueioDoCodigo(codigo), null);
});

test('a rota responde 403 com código próprio para cada recusa de acesso', () => {
  for (const codigo of ['ATENDIMENTO_EMPRESA_DIVERGENTE', 'ATENDIMENTO_EMPRESA_NAO_SELECIONADA', 'ATENDIMENTO_SEM_ACESSO', 'ATENDIMENTO_ACESSO_NEGADO']) {
    const r = respostaDeErroAtendimento(new Error(codigo));
    assert.equal(r.status, 403, codigo);
    assert.equal(r.corpo.codigo, codigo);
    assert.doesNotMatch(r.corpo.erro, /indisponível/i, codigo);
  }
});

test('nenhuma suíte PostgreSQL do atendimento espera a mensagem crua do tenant: a recusa chega como ATENDIMENTO_SEM_ACESSO', () => {
  // Guarda estática (roda no gate sem banco): a rodada PostgreSQL de 2442f37 falhou porque 060/064/065 ainda esperavam o texto antigo.
  const dir = 'lib/whatsapp/atendimento';
  const suites = readdirSync(dir).filter((f) => f.endsWith('.postgres.test.ts'));
  assert.ok(suites.length >= 4, 'suítes PostgreSQL do atendimento encontradas');
  for (const f of suites) assert.doesNotMatch(readFileSync(`${dir}/${f}`, 'utf8'), /não comprova a empresa autorizada/, f);
});
