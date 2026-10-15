import assert from 'node:assert/strict';
import test from 'node:test';
import { dentroDaJanela, fusoValido, proximoHorarioPermitido } from './janela.ts';
import { mascararTelefone, renderizarModelo, validarModelo } from './modelo.ts';
import { assinarRetorno, assinaturaConfere, automacoesHabilitadas, FalhaTransporte, transporteDoAmbiente, transporteSimulado } from './transporte.ts';
import { chaveExecucao, cicloDaChave } from './alvos.ts';
import { CATALOGO_REGRAS, esquemaSalvarRegra, regraPadrao } from './regras.ts';
import { configuracaoWorker } from '../../../scripts/marketing-automacoes-worker.mjs';

const SP = { inicio: '09:00', fim: '18:00', fuso: 'America/Sao_Paulo', fimDeSemana: false };

test('janela no fuso de São Paulo: dentro, fora, noite e fim de semana', () => {
  // 2026-10-14 (quarta) 12:00 em SP = 15:00Z.
  assert.equal(dentroDaJanela(new Date('2026-10-14T15:00:00Z'), SP), true);
  assert.equal(dentroDaJanela(new Date('2026-10-14T23:00:00Z'), SP), false, '20h em SP');
  assert.equal(dentroDaJanela(new Date('2026-10-14T11:59:00Z'), SP), false, '08:59 em SP');
  assert.equal(dentroDaJanela(new Date('2026-10-14T12:00:00Z'), SP), true, '09:00 em SP');
  assert.equal(dentroDaJanela(new Date('2026-10-14T21:00:00Z'), SP), false, '18:00 é o fim (exclusivo)');
  // Noite de quarta → quinta 09:00 SP (12:00Z).
  assert.equal(proximoHorarioPermitido(new Date('2026-10-14T23:00:00Z'), SP).toISOString(), '2026-10-15T12:00:00.000Z');
  // Sexta 19h SP → segunda 09:00 SP (sem fim de semana).
  assert.equal(proximoHorarioPermitido(new Date('2026-10-16T22:00:00Z'), SP).toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(proximoHorarioPermitido(new Date('2026-10-16T22:00:00Z'), { ...SP, fimDeSemana: true }).toISOString(), '2026-10-17T12:00:00.000Z');
  const dentro = new Date('2026-10-14T15:00:00Z');
  assert.equal(proximoHorarioPermitido(dentro, SP), dentro, 'dentro da janela: agora');
  assert.equal(fusoValido('America/Sao_Paulo'), true);
  assert.equal(fusoValido('Lua/Base'), false);
});

test('modelo: só marcadores conhecidos, obrigatório informar PARAR; render sem padrões de String.replace', () => {
  assert.deepEqual(validarModelo('Olá {{nome}}, aqui é do {{buffet}}. Responda PARAR para sair.'), []);
  assert.ok(validarModelo('Olá {{cpf}}! Responda PARAR.').some((p) => p.includes('{{cpf}}')));
  assert.ok(validarModelo('Olá {{nome}}, venha ao buffet!').some((p) => p.includes('PARAR')));
  const texto = renderizarModelo('Oi {{nome}}! {{buffet}} em {{data_festa}}. PARAR', { nome: "Ana $' Souza", buffet: "Buffet R$'& Cia", dataFesta: '2026-11-20' });
  assert.equal(texto, "Oi Ana! Buffet R$'& Cia em 20/11/2026. PARAR");
  assert.equal(mascararTelefone('5511999990000'), '*********0000');
});

test('regras pré-definidas: datas vagas só sugere; mensagens têm texto padrão com PARAR', () => {
  assert.deepEqual(CATALOGO_REGRAS.DATAS_VAGAS.acoes, ['SUGESTAO']);
  for (const tipo of ['PROPOSTA_PARADA', 'POS_FESTA', 'RECOMPRA'] as const) assert.deepEqual(validarModelo(CATALOGO_REGRAS[tipo].texto ?? ''), [], tipo);
  assert.equal(regraPadrao('PROPOSTA_PARADA', null).acao, 'TAREFA_INTERNA', 'padrão conservador: tarefa interna');
  const base = { acao: 'salvar-regra', tipo: 'PROPOSTA_PARADA', versao: 0, acaoRegra: 'TAREFA_INTERNA', esperaDias: 3, janelaInicio: '09:00', janelaFim: '18:00', fuso: 'America/Sao_Paulo', fimDeSemana: false, limiteFrequenciaDias: 30, maxTentativas: 3 };
  assert.equal(esquemaSalvarRegra.safeParse(base).success, true);
  assert.equal(esquemaSalvarRegra.safeParse({ ...base, maxTentativas: 9 }).success, false);
  assert.equal(esquemaSalvarRegra.safeParse({ ...base, janelaInicio: '25:00' }).success, false);
  assert.equal(esquemaSalvarRegra.safeParse({ ...base, empresaId: 'x' }).success, false);
});

test('chave de idempotência: regra + ação + alvo + ciclo (repetir o planejamento não duplica; novo ciclo gera nova)', () => {
  const regra = '11111111-1111-4111-8111-111111111111', alvo = '22222222-2222-4222-8222-222222222222';
  const a = chaveExecucao(regra, 'TAREFA_INTERNA', { alvoId: alvo, ciclo: 'AGUARDANDO_CONTRATO:2026-10-10' });
  assert.equal(a, chaveExecucao(regra, 'TAREFA_INTERNA', { alvoId: alvo, ciclo: 'AGUARDANDO_CONTRATO:2026-10-10' }));
  assert.notEqual(a, chaveExecucao(regra, 'TAREFA_INTERNA', { alvoId: alvo, ciclo: 'AGUARDANDO_CONTRATO:2026-10-12' }));
  assert.notEqual(a, chaveExecucao(regra, 'MENSAGEM_WHATSAPP', { alvoId: alvo, ciclo: 'AGUARDANDO_CONTRATO:2026-10-10' }));
  assert.equal(cicloDaChave(a), 'AGUARDANDO_CONTRATO:2026-10-10');
});

test('transporte: só o simulado existe; ganchos de falha classificados; idempotente pela chave; nunca usa rede', async () => {
  assert.throws(() => transporteDoAmbiente(() => ({ query: async () => ({ rows: [], rowCount: 0 }) }), { MARKETING_TRANSPORTE: 'gupshup' }), { code: 'TRANSPORTE_NAO_CONFIGURADO' });
  assert.equal(automacoesHabilitadas({}), false, 'desligado por padrão');
  assert.equal(automacoesHabilitadas({ MARKETING_AUTOMACOES_ENABLED: 'true' }), true);
  const gravados = new Map<string, string>();
  const t = transporteSimulado(() => ({ async query(_sql: string, p: unknown[] = []) {
    const chave = String(p[2]); if (!gravados.has(chave)) gravados.set(chave, String(p[3]));
    return { rows: [{ provedor_mensagem_id: gravados.get(chave) }], rowCount: 1 };
  } }) as never);
  const msg = { empresaId: 'e', execucaoId: 'x', idempotencia: 'x:1', telefone: '5511988887777', templateProvedor: 'retomar_v1', texto: 'Olá PARAR' };
  const a = await t.enviar(msg), b = await t.enviar(msg);
  assert.equal(a.provedorMensagemId, b.provedorMensagemId, 'mesma chave, mesma mensagem');
  for (const [final, tipo] of [['0000', 'RECUSADO'], ['1111', 'TEMPORARIO'], ['9999', 'DESCONHECIDO']] as const)
    await assert.rejects(t.enviar({ ...msg, telefone: `551198888${final}` }), (e: unknown) => e instanceof FalhaTransporte && e.tipo === tipo);
  await assert.rejects(t.enviar({ ...msg, templateProvedor: '' }), (e: unknown) => e instanceof FalhaTransporte && e.tipo === 'RECUSADO');
});

test('retorno do provedor simulado: só com assinatura HMAC válida', () => {
  const segredo = 's'.repeat(32), corpo = '{"provedorMensagemId":"sim_x","status":"ENTREGUE"}';
  const assinatura = assinarRetorno(segredo, corpo);
  assert.equal(assinaturaConfere(segredo, corpo, assinatura), true);
  assert.equal(assinaturaConfere(segredo, corpo + ' ', assinatura), false, 'corpo alterado');
  assert.equal(assinaturaConfere(segredo, corpo, assinatura.replace(/^./, 'f') === assinatura ? assinatura.replace(/^./, '0') : assinatura.replace(/^./, 'f')), false);
  assert.equal(assinaturaConfere(undefined, corpo, assinatura), false, 'sem segredo configurado');
  assert.equal(assinaturaConfere('curto', corpo, assinarRetorno('curto', corpo)), false, 'segredo fraco recusado');
});

test('worker local: só aceita localhost/127.0.0.1 no caminho do processador e segredo forte', () => {
  const secret = 'x'.repeat(40);
  assert.deepEqual(configuracaoWorker({ MARKETING_AUTOMACOES_WORKER_URL: 'http://127.0.0.1:3000/api/integracoes/marketing/automacoes/processar', MARKETING_AUTOMACOES_WORKER_SECRET: secret }),
    { url: 'http://127.0.0.1:3000/api/integracoes/marketing/automacoes/processar', secret });
  for (const url of ['https://staging.kidmais.com/api/integracoes/marketing/automacoes/processar', 'http://127.0.0.1:3000/outro', 'http://u:p@localhost/api/integracoes/marketing/automacoes/processar'])
    assert.throws(() => configuracaoWorker({ MARKETING_AUTOMACOES_WORKER_URL: url, MARKETING_AUTOMACOES_WORKER_SECRET: secret }), /LOCAL/, url);
  assert.throws(() => configuracaoWorker({ MARKETING_AUTOMACOES_WORKER_URL: 'http://localhost:3000/api/integracoes/marketing/automacoes/processar', MARKETING_AUTOMACOES_WORKER_SECRET: 'curto' }), /SECRET/);
});
