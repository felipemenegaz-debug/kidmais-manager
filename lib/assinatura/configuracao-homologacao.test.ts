import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { configuracaoAsaas } from './asaas.ts';
import { duracaoTesteDias, prazosDeAcesso, precoDoCiclo, TESTE_DIAS_PADRAO } from './configuracao.ts';
import { PRAZOS_PROPOSTOS } from './acesso.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

// publico.ts importa db/postgres (sem extensão): carregado com um banco falso que nunca é usado aqui.
const semBanco = { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } };
const { situacaoCadastro } = carregarModulo('lib/cadastro/publico.ts', { 'db/postgres': semBanco }, new Map()) as unknown as typeof import('../cadastro/publico.ts');

/**
 * A configuração SINTÉTICA de homologação (docs/homologacao/staging-venda-sintetica.env.exemplo) é aceita pelos mesmos
 * validadores da aplicação, não carrega segredo e continua separada das políticas comerciais (padrões propostos).
 */
const ARQUIVO = 'docs/homologacao/staging-venda-sintetica.env.exemplo';
const texto = readFileSync(ARQUIVO, 'utf8');
const linhas = texto.split(/\r?\n/);
const env: Record<string, string> = Object.fromEntries(linhas
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

test('configuração de homologação: marcada como sintética e só de staging', () => {
    assert.match(texto, /VALORES SINTÉTICOS/);
    assert.match(texto, /NÃO É POLÍTICA COMERCIAL/);
    assert.match(texto, /SOMENTE STAGING/);
    assert.match(texto, /Nunca copiar este arquivo para production/);
});

test('configuração de homologação: nenhum segredo no arquivo (chaves e token só como comentário de onde colar)', () => {
    for (const segredo of ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'RESEND_API_KEY', 'DATABASE_URL', 'ADMIN_AUTH_SECRET'])
        assert.equal(env[segredo], undefined, `${segredo} não pode ter valor no arquivo`);
    assert.doesNotMatch(linhas.filter((l) => !l.trimStart().startsWith('#')).join('\n'), /\$aact_|re_[A-Za-z0-9]{8,}/);
});

test('configuração de homologação: aceita pelos validadores da aplicação', () => {
    assert.equal(duracaoTesteDias(env), 1);
    assert.deepEqual(prazosDeAcesso(env), { regularizacaoDias: 1, somenteLeituraDias: 1 });
    assert.equal(precoDoCiclo('MENSAL', env), 990);
    assert.equal(precoDoCiclo('ANUAL', env), 9900);
    // Com os segredos colados no Render (aqui simulados), cobrança só em sandbox e cadastro aberto.
    const comSegredos = { ...env, ASAAS_API_KEY: '$aact_hmlg_simulado_no_teste', ASAAS_WEBHOOK_TOKEN: 'x'.repeat(48), RESEND_API_KEY: 'simulado-no-teste' };
    assert.equal(configuracaoAsaas(comSegredos).ligado, true);
    assert.equal(configuracaoAsaas({ ...comSegredos, ASAAS_AMBIENTE: 'producao' }).ligado, false, 'produção recusada');
    assert.deepEqual(situacaoCadastro({ ...comSegredos, KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true' }), { ativo: true, motivo: null });
    // Sem os segredos, nada liga sozinho.
    assert.equal(configuracaoAsaas(env).ligado, false);
    assert.equal(situacaoCadastro({ ...env, KIDMAIS_DEPLOY_ENV: 'staging', RENDER: 'true' }).ativo, false);
});

test('configuração de homologação: valores do ensaio diferem dos padrões propostos (não viram política por acidente)', () => {
    assert.notEqual(duracaoTesteDias(env), TESTE_DIAS_PADRAO);
    assert.notDeepEqual(prazosDeAcesso(env), PRAZOS_PROPOSTOS);
    // Sem as variáveis, o código volta aos padrões propostos (e eles também não são política aprovada).
    assert.equal(duracaoTesteDias({}), TESTE_DIAS_PADRAO);
    assert.deepEqual(prazosDeAcesso({}), PRAZOS_PROPOSTOS);
});
