import assert from 'node:assert/strict';
import test from 'node:test';
import { ROTULO_ESTADO, motivoLegivel, resumoRegra } from './explicacao.ts';

/** Frases das automações (UX de 15/10/2026): fiéis aos valores configurados e ao comportamento real do motor. */
const base = { janelaInicio: '09:00', janelaFim: '18:00', fuso: 'America/Sao_Paulo', fimDeSemana: false, limiteFrequenciaDias: 30, maxTentativas: 3 };

test('resumo: proposta parada com tarefa, nos valores configurados', () => {
  assert.equal(resumoRegra({ ...base, tipo: 'PROPOSTA_PARADA', acao: 'TAREFA_INTERNA', esperaDias: 3 }),
    'Quando uma negociação em andamento (aguardando aprovação, aprovada ou aguardando contrato) ficar 3 dias sem movimentação, com a festa ainda no futuro e sem contrato assinado ou cancelado, criar uma tarefa para a equipe, entre 09:00 e 18:00 (horário de Brasília), de segunda a sexta.');
  assert.match(resumoRegra({ ...base, tipo: 'PROPOSTA_PARADA', acao: 'TAREFA_INTERNA', esperaDias: 1, fimDeSemana: true }), /ficar 1 dia sem movimentação.*todos os dias\.$/);
  assert.doesNotMatch(resumoRegra({ ...base, tipo: 'PROPOSTA_PARADA', acao: 'TAREFA_INTERNA', esperaDias: 3 }), /frequência|mensagem/, 'tarefa não fala de limite de mensagens');
});

test('resumo: recompra é ANTES de completar um ano da última festa (não espera posterior nem aniversário)', () => {
  const r = resumoRegra({ ...base, tipo: 'RECOMPRA', acao: 'MENSAGEM_WHATSAPP', esperaDias: 45 });
  assert.match(r, /^45 dias antes de completar um ano da última festa com contrato assinado/);
  assert.doesNotMatch(r, /aniversário|depois de 45/);
  assert.match(r, /número autorizado/);
  assert.match(r, /No máximo uma mensagem automática por cliente a cada 30 dias \(somando todas as regras\); até 3 tentativas/);
});

test('resumo: pós-festa (inclusive no dia), datas vagas sem campos de envio, fuso explícito quando não é o padrão', () => {
  assert.match(resumoRegra({ ...base, tipo: 'POS_FESTA', acao: 'TAREFA_INTERNA', esperaDias: 1 }), /^Quando fizer 1 dia de uma festa com contrato assinado/);
  assert.match(resumoRegra({ ...base, tipo: 'POS_FESTA', acao: 'TAREFA_INTERNA', esperaDias: 0 }), /^No dia de uma festa/);
  const vagas = resumoRegra({ ...base, tipo: 'DATAS_VAGAS', acao: 'SUGESTAO', esperaDias: 0 });
  assert.match(vagas, /Nada é enviado, reservado ou descontado/);
  assert.doesNotMatch(vagas, /entre 09:00|mensagem automática/);
  assert.match(resumoRegra({ ...base, tipo: 'PROPOSTA_PARADA', acao: 'TAREFA_INTERNA', esperaDias: 3, fuso: 'America/Manaus' }), /fuso America\/Manaus/);
});

test('histórico: “aceita” nunca é chamada de entregue; motivos do motor viram texto, desconhecidos aparecem como vieram', () => {
  assert.match(ROTULO_ESTADO.ACEITA, /não é confirmação de entrega/);
  assert.doesNotMatch(ROTULO_ESTADO.ACEITA, /^Entregue/);
  assert.equal(motivoLegivel('SEM_AUTORIZACAO_DESTINO'), 'a autorização é de um número que não está no cadastro atual');
  assert.equal(motivoLegivel('EMPRESA_INAPTA: SEM_RECURSO_MARKETING'), 'empresa sem acesso ao Marketing no momento (SEM_RECURSO_MARKETING)');
  assert.equal(motivoLegivel('MOTIVO_NOVO_X'), 'MOTIVO_NOVO_X');
  assert.equal(motivoLegivel(null), '');
});

test('retorno de salvar: vem da regra devolvida pelo servidor (U5), não do estado anterior', async () => {
  const { retornoAoSalvarRegra } = await import('./explicacao.ts');
  // Texto de mensagem ativa alterado: o servidor devolve PAUSADA sem revisão.
  const texto = retornoAoSalvarRegra({ status: 'ATIVA' }, { status: 'PAUSADA', acao: 'MENSAGEM_WHATSAPP', templateRevisadoEm: null });
  assert.equal(texto.tipo, 'alerta');
  assert.match(texto.texto, /PAUSADA.*nova revisão.*canceladas/);
  assert.doesNotMatch(texto.texto, /continua ativa/);
  // Tarefa ativa trocada para mensagem sem revisão: também pausa.
  assert.match(retornoAoSalvarRegra({ status: 'ATIVA' }, { status: 'PAUSADA', acao: 'MENSAGEM_WHATSAPP', templateRevisadoEm: null }).texto, /PAUSADA/);
  // Só horário/prazo: continua ativa.
  const horario = retornoAoSalvarRegra({ status: 'ATIVA' }, { status: 'ATIVA', acao: 'MENSAGEM_WHATSAPP', templateRevisadoEm: '2026-10-15T12:00:00Z' });
  assert.equal(horario.tipo, 'ok');
  assert.match(horario.texto, /continua ativa/);
  // Regra pausada salva: continua pausada (e pede revisão quando falta).
  assert.equal(retornoAoSalvarRegra({ status: 'PAUSADA' }, { status: 'PAUSADA', acao: 'TAREFA_INTERNA', templateRevisadoEm: null }).texto, 'Regra salva; continua pausada.');
  assert.match(retornoAoSalvarRegra({ status: 'PAUSADA' }, { status: 'PAUSADA', acao: 'MENSAGEM_WHATSAPP', templateRevisadoEm: null }).texto, /continua pausada\. Revise o texto/);
  // Rascunho.
  assert.match(retornoAoSalvarRegra({ status: 'NAO_CONFIGURADA' }, { status: 'RASCUNHO', acao: 'TAREFA_INTERNA', templateRevisadoEm: null }).texto, /^Regra salva como rascunho/);
});
