import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { montarPainel, periodoPadrao, validarPeriodo } from './metricas.ts';
import { percentual, reais, rotuloDominio, centavosDeTexto } from './apresentacao.ts';

const periodo = { de: '2026-10-01', ate: '2026-10-31', unidadeId: null };
const camp = '11111111-1111-4111-8111-111111111111';

test('painel: clique, contato, negociação e contrato são contagens separadas; receita por campanha sem duplicar', () => {
  const p = montarPainel(periodo, {
    cliques: [{ campanha_id: camp, tipo: 'CLIQUE_LINK_CAMPANHA', n: '40' }, { campanha_id: null, tipo: 'CLIQUE_WHATSAPP', n: '7' }],
    contatos: [{ campanha_id: camp, origem_codigo: 'INSTAGRAM', n: '4', extra: '1' }, { campanha_id: null, origem_codigo: 'DESCONHECIDA', n: '3', extra: '0' }],
    negociacoes: [{ campanha_id: camp, origem_codigo: 'INSTAGRAM', n: '2' }, { campanha_id: null, origem_codigo: null, n: '5' }],
    contratos: [{ campanha_id: camp, origem_codigo: 'INSTAGRAM', n: '1', valor: '450000' }],
    cancelados: [],
    recebido: [{ campanha_id: camp, origem_codigo: 'INSTAGRAM', n: '1', valor: '100000' }],
    campanhas: [{ id: camp, nome: 'Novembro Centro', origem_codigo: 'INSTAGRAM', orcamento_centavos: '80000' }],
    negociacoesSemOrigem: 5,
  });
  const c = p.linhas.find((l) => l.campanhaId === camp)!;
  assert.equal(c.campanhaNome, 'Novembro Centro');
  assert.equal(c.cliquesLink, 40);
  assert.equal(c.contatos, 4);
  assert.equal(c.negociacoes, 2);
  assert.equal(c.contratos, 1);
  assert.equal(c.receitaContratadaCentavos, 450000);
  assert.equal(c.receitaRecebidaCentavos, 100000);
  assert.equal(c.conversao, 0.25);
  assert.equal(c.orcamentoCentavos, 80000);
  // Receita aparece uma vez no total (toque único).
  assert.equal(p.total.receitaContratadaCentavos, 450000);
  assert.equal(p.total.cliquesWhatsapp, 7);
  assert.equal(p.total.contatos, 7);
  const desconhecida = p.linhas.find((l) => l.origemCodigo === 'DESCONHECIDA')!;
  assert.equal(desconhecida.conversao, 0, 'tem contatos: conversão calculada (0%)');
  const semRegistro = p.linhas.find((l) => l.origemCodigo === 'SEM_REGISTRO')!;
  assert.equal(semRegistro.negociacoes, 5);
  assert.equal(semRegistro.conversao, null, 'sem contato na linha: indisponível, não zero');
  assert.equal(p.linhas[0].campanhaId, camp, 'campanhas primeiro');
  assert.equal(p.negociacoesSemOrigem, 5);
});

test('painel: negociações herdadas do cliente são informadas à parte (padrão 0 quando a consulta não informa)', () => {
  const vazio = { cliques: [], contatos: [], negociacoes: [], contratos: [], cancelados: [], recebido: [], campanhas: [], negociacoesSemOrigem: 0 };
  assert.equal(montarPainel(periodo, { ...vazio, negociacoesHerdadas: 2 }).negociacoesHerdadas, 2);
  assert.equal(montarPainel(periodo, vazio).negociacoesHerdadas, 0);
});

test('origem da negociação: uma só regra de herança (primeira negociação, sem desconhecida) no painel; festa mostra o painel', () => {
  const atrib = readFileSync('lib/marketing/atribuicao.ts', 'utf8');
  assert.ok(atrib.includes("AND a1.origem_codigo <> '${ORIGEM_DESCONHECIDA}'"), 'desconhecida não é herdada');
  assert.ok(atrib.includes('AND (f0.iniciado_em, f0.id) < (f.iniciado_em, f.id))'), 'só a primeira negociação do cliente');
  const metricas = readFileSync('lib/marketing/metricas.ts', 'utf8');
  assert.ok(metricas.includes('LEFT JOIN LATERAL (${SQL_ORIGEM_NEGOCIACAO}) a ON true'));
  assert.doesNotMatch(metricas, /alvo_tipo = 'FECHAMENTO'/, 'nenhuma junção paralela que ignore a herança');
  assert.ok(readFileSync('components/festas/FestaConsole.tsx', 'utf8')
    .includes('<OrigemPainel key={data.contrato.fechamento_id} alvoTipo="FECHAMENTO" alvoId={data.contrato.fechamento_id}/>'), 'festa mostra a origem da negociação');
});

test('painel vazio: totais zerados e conversão indisponível (nunca número ilustrativo)', () => {
  const p = montarPainel(periodo, { cliques: [], contatos: [], negociacoes: [], contratos: [], cancelados: [], recebido: [], campanhas: [], negociacoesSemOrigem: 0 });
  assert.deepEqual(p.linhas, []);
  assert.equal(p.total.conversao, null);
  assert.equal(percentual(p.total.conversao), 'indisponível');
});

test('período: padrão de 30 dias e limite de 2 anos', () => {
  assert.deepEqual(periodoPadrao('2026-10-14'), { de: '2026-09-15', ate: '2026-10-14' });
  assert.equal(validarPeriodo('2026-10-01', '2026-10-31'), true);
  assert.equal(validarPeriodo('2026-10-31', '2026-10-01'), false);
  assert.equal(validarPeriodo('2020-01-01', '2026-10-01'), false);
  assert.equal(validarPeriodo('2026-13-01', '2026-10-01'), false);
});

test('apresentação: valor desconhecido é "indisponível"; domínio simulado nunca aparece como ativo real', () => {
  assert.equal(reais(null), 'indisponível');
  assert.match(reais(450000), /4\.500,00/);
  assert.equal(rotuloDominio('ATIVO', true), 'Ativo (simulado)');
  assert.equal(rotuloDominio('ATIVO', false), 'Ativo');
  assert.equal(centavosDeTexto('1.500,50'), 150050);
  assert.equal(centavosDeTexto('abc'), null);
});
