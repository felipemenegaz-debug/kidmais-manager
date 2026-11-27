import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import { conectarDescartavel } from '../../comercial/postgres-descartavel.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import * as preferencias from '../../marketing/automacoes/preferencias.ts';
import { executarNoTenant, type SessaoParaTenant } from '../../saas/provar-tenant.ts';
import * as supressao from '../../satisfacao/supressao.ts';
import * as arquivos from './arquivos.ts';
import * as core from './core.ts';
import { cod, db, withTransaction } from './harness-postgres.ts';
import * as multiempresa from './multiempresa.ts';
import * as avisoEquipe from './aviso-equipe.ts';
import * as entendimento from './walle/entendimento.ts';
import * as mesSaoPaulo from './mes-sao-paulo.ts';
import * as tetoMensal from './teto-mensal.ts';

const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`;
const AGORA = new Date('2027-01-20T15:00:00Z');

test('resultado: sessões de 24 h, virada, custos e isolamento de empresa e ambiente', { timeout: 600_000 }, async t => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') {
    t.skip('opt-in ausente: harness PostgreSQL não executado');
    return;
  }
  const c = await conectarDescartavel();
  try {
    assert.equal((await c.query(`SELECT to_regclass('public.whatsapp_atendimento_mensagens') IS NOT NULL
      AND to_regclass('public.ia_uso_modelo') IS NOT NULL AS ok`)).rows[0].ok, true);

    const id = async (sql: string, valores: unknown[]) => (await c.query(sql, valores)).rows[0].id as string;
    async function empresa(papel: string) {
      const empresa = await id(`INSERT INTO empresas (codigo, nome, status)
        VALUES ($1, 'Empresa sintética de resultado', 'PROVISIONAMENTO') RETURNING id`, [cod('res')]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1`, [empresa]);
      const usuario = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
        VALUES ($1, 'Usuário sintético de resultado', $2, $3, true) RETURNING id`, [`${cod('u')}@example.test`, SENHA, papel]);
      const membership = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel)
        VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresa, usuario, papel]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1`, [membership]);
      const sessao = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4) RETURNING id`,
      [usuario, randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), empresa]);
      return { id: sessao, usuario_id: usuario, papel, empresa_ativa_id: empresa } satisfies SessaoParaTenant;
    }

    const a = await empresa('REPRESENTANTE_AUTORIZADO');
    const b = await empresa('ADMINISTRATIVO');
    const vazia = await empresa('REPRESENTANTE_AUTORIZADO');
    // Só o serviço REAL (guarda de empresa ativa, direito e papel), com uma conexão por transação e a prova real de
    // tenant. O worker e a biblioteca do harness não participam desta suíte.
    const configuracao = { ambienteAtendimento: () => 'staging', canalEnvio: () => 'GUPSHUP' as const, empresaPiloto: () => a.empresa_ativa_id, atendimentoAtivo: () => true, recepcaoAtiva: () => true, receptorDoNumero: () => true, contatoPermitido: () => true, entendimentoSoRegras: () => true, origemMidia: () => 'https://midia.kidmais.example' };
    const tenant = { withTenantTransaction: (s: SessaoParaTenant, e: string, w: Parameters<typeof executarNoTenant>[3]) => withTransaction((tx: DbExecutor) => executarNoTenant(tx, s, e, w)) };
    const servico = carregarComponente('lib/whatsapp/atendimento/service.ts', {
      '../../db/postgres.ts': { withTransaction, db }, '../../saas/provar-tenant.ts': tenant, './configuracao.ts': configuracao, './core.ts': core, './arquivos.ts': arquivos,
      './walle/entendimento.ts': entendimento, './multiempresa.ts': multiempresa, './aviso-equipe.ts': avisoEquipe, './teto-mensal.ts': tetoMensal, '../../satisfacao/supressao.ts': supressao, '../../marketing/automacoes/preferencias.ts': preferencias,
    }).modulo as typeof import('./service.ts');
    const { resultadoAtendimento } = carregarComponente('lib/whatsapp/atendimento/resultado.ts', {
      './service.ts': servico,
      './configuracao.ts': { ambienteAtendimento: () => 'staging', canalEnvio: () => 'GUPSHUP', empresaPiloto: () => a.empresa_ativa_id },
      './mes-sao-paulo.ts': mesSaoPaulo, './teto-mensal.ts': tetoMensal,
    }).modulo as typeof import('./resultado.ts');

    async function conversa(sessao: typeof a, contato: string, ambiente = 'staging') {
      const empresa = sessao.empresa_ativa_id;
      const conversa = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato)
        VALUES ($1, $2, $3) RETURNING id`, [empresa, ambiente, contato]);
      return { conversa, empresa, ambiente };
    }
    async function entrada(alvo: Awaited<ReturnType<typeof conversa>>, em: string) {
      await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, externa_id, direcao, estado, versao_conversa, criada_em)
        VALUES ($1, $2, $3, $4, 'ENTRADA', 'PROCESSADA', 0, $5)`, [alvo.conversa, alvo.empresa, alvo.ambiente, cod('e'), em]);
    }
    async function saida(alvo: Awaited<ReturnType<typeof conversa>>, em: string, estado: string, autor: string | null = null) {
      await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, autor_usuario_id, direcao, estado, versao_conversa, criada_em)
        VALUES ($1, $2, $3, $4, 'SAIDA', $5, 0, $6)`, [alvo.conversa, alvo.empresa, alvo.ambiente, autor, estado, em]);
    }
    async function uso(sessao: typeof a, dia: string, moeda: string | null, custo: number | null, capacidade = 'whatsapp_atendimento') {
      await c.query(`INSERT INTO ia_uso_modelo (empresa_id, correlation_id, capacidade, workload, tier, provedor, modelo,
        tokens_entrada, tokens_saida, duracao_ms, custo_estimado_micros, moeda, sucesso, fallback, criado_em, periodo_dia, periodo_mes)
        VALUES ($1, $2, $3, 'INTERATIVO', 'ECONOMY', 'OPENAI', 'modelo-sintetico', 10, 5, 20, $4, $5, true, false,
          $6::date + interval '1 hour', $6, to_char($6::date, 'YYYY-MM'))`, [sessao.empresa_ativa_id, cod('ia'), capacidade, custo, moeda, dia]);
    }

    const contato = '5561900000101';
    const a1 = await conversa(a, contato), a2 = await conversa(a, '5561900000102');
    const aOutroAmbiente = await conversa(a, contato, 'production');
    const b1 = await conversa(b, contato);
    // Inícios em 27/11 às 22 h, 29/11 às 20 h e 1/12 às 18 h. Só recuar 24 h desde 1/12 perderia a sessão de dezembro.
    for (const em of ['2026-11-27T22:00', '2026-11-28T21:00', '2026-11-29T20:00', '2026-11-30T19:00', '2026-12-01T18:00']) {
      await entrada(a1, `${em}:00-03:00`);
    }
    // 0 h, 23 h, 25 h e uma entrada simultânea: dois inícios, quatro entradas.
    for (const em of ['2026-12-04T01:00', '2026-12-03T23:00', '2026-12-03T00:00', '2026-12-04T01:00']) {
      await entrada(a1, `${em}:00-03:00`);
    }
    await entrada(a2, '2026-12-31T22:00:00-03:00');
    await entrada(a2, '2027-01-01T10:00:00-03:00');
    await entrada(aOutroAmbiente, '2027-01-03T12:00:00-03:00');
    await entrada(b1, '2027-01-08T12:00:00-03:00');
    await saida(a1, '2026-11-20T12:00:00-03:00', 'ENTREGUE');
    await saida(aOutroAmbiente, '2026-11-01T00:00:00-03:00', 'ENTREGUE');
    await saida(b1, '2027-01-08T12:01:00-03:00', 'FALHOU');
    await saida(a2, '2026-12-31T23:59:59-03:00', 'SUBMETIDA');
    await saida(a2, '2027-01-01T00:00:00-03:00', 'ENTREGUE', a.usuario_id);
    await saida(a2, '2027-01-01T10:01:00-03:00', 'ENTREGUE');
    await saida(a2, '2027-01-01T10:02:00-03:00', 'INCERTO');
    await saida(a2, '2027-01-01T10:03:00-03:00', 'CANCELADA', a.usuario_id);
    await saida(a2, '2027-02-01T00:00:00-03:00', 'FALHOU', a.usuario_id);

    await uso(a, '2026-12-31', 'USD', 2_500_000);
    await uso(a, '2027-01-01', 'USD', 1_100_000);
    await uso(a, '2027-01-01', 'USD', 2_300_000);
    await uso(a, '2027-01-01', 'BRL', 50);
    await uso(a, '2027-01-01', null, null);
    await uso(a, '2027-01-01', 'USD', 40_000_000, 'outra_capacidade');
    await uso(a, '2027-02-01', 'USD', 80_000_000);
    await uso(b, '2027-01-01', 'USD', 10_000);

    const antes = await resultadoAtendimento(a, AGORA);
    assert.deepEqual(antes.meses.map(m => [m.mes, m.sessoes, m.entradas]), [['2027-01', 0, 1], ['2026-12', 4, 6]]);
    await entrada(a2, '2027-01-01T23:00:00-03:00');
    assert.equal((await resultadoAtendimento(a, AGORA)).meses[0].sessoes, 1);
    await entrada(a2, '2027-01-02T23:00:00-03:00');

    const resultado = await resultadoAtendimento(a, AGORA);
    const [janeiro, dezembro] = resultado.meses;
    assert.equal(resultado.primeiraMensagemEm, '2026-11-20T15:00:00.000Z');
    assert.deepEqual(resultado.meses.map(m => [m.mes, m.sessoes, m.entradas]), [['2027-01', 2, 3], ['2026-12', 4, 6]]);
    const porEstado = (mes: typeof janeiro) => mes.saidas.map(s => [s.estado, s.equipe, s.automatica]);
    const zeros = [['ENTREGUE', 0, 0], ['SUBMETIDA', 0, 0], ['FALHOU', 0, 0], ['INCERTO', 0, 0], ['CANCELADA', 0, 0], ['PENDENTE', 0, 0], ['ENVIANDO', 0, 0]];
    assert.deepEqual(porEstado(janeiro), [['ENTREGUE', 1, 1], ...zeros.slice(1, 3), ['INCERTO', 0, 1], ['CANCELADA', 1, 0], ...zeros.slice(5)]);
    assert.deepEqual(porEstado(dezembro), [zeros[0], ['SUBMETIDA', 0, 1], ...zeros.slice(2)]);
    assert.deepEqual(janeiro.ia, { chamadas: 4, semPreco: 1, custos: [{ moeda: 'BRL', custoEstimadoMicros: '50' }, { moeda: 'USD', custoEstimadoMicros: '3400000' }] });
    assert.deepEqual(dezembro.ia, { chamadas: 1, semPreco: 0, custos: [{ moeda: 'USD', custoEstimadoMicros: '2500000' }] });

    const resultadoB = await resultadoAtendimento(b, AGORA);
    assert.equal(resultadoB.primeiraMensagemEm, '2027-01-08T15:00:00.000Z');
    assert.deepEqual(resultadoB.meses.map(m => [m.sessoes, m.entradas]), [[1, 1], [0, 0]]);
    assert.deepEqual(porEstado(resultadoB.meses[0]), [...zeros.slice(0, 2), ['FALHOU', 0, 1], ...zeros.slice(3)]);
    assert.deepEqual(porEstado(resultadoB.meses[1]), zeros);
    assert.deepEqual(resultadoB.meses.map(m => m.ia), [
      { chamadas: 1, semPreco: 0, custos: [{ moeda: 'USD', custoEstimadoMicros: '10000' }] }, { chamadas: 0, semPreco: 0, custos: [] },
    ]);
    const resultadoVazio = await resultadoAtendimento(vazia, AGORA);
    assert.equal(resultadoVazio.primeiraMensagemEm, null);
    for (const mes of resultadoVazio.meses) {
      assert.equal(mes.sessoes, 0);
      assert.equal(mes.entradas, 0);
      assert.deepEqual(porEstado(mes), zeros);
      assert.deepEqual(mes.ia, { chamadas: 0, semPreco: 0, custos: [] });
    }
    await assert.rejects(resultadoAtendimento({ ...b, empresa_ativa_id: a.empresa_ativa_id }, AGORA), /ATENDIMENTO_SEM_ACESSO/);
  } finally {
    await c.end();
  }
});
