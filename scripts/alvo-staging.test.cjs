/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { origemDoStaging } = require('./alvo-staging.cjs');

test('sem a variável, o host de sempre; com ela, só os hosts do serviço de staging', () => {
    assert.equal(origemDoStaging({}), 'https://kidmais-manager-staging.onrender.com');
    assert.equal(origemDoStaging({ KIDMAIS_STAGING_ORIGEM: 'https://staging-iafest.demerzellabs.com.br' }), 'https://staging-iafest.demerzellabs.com.br');
    for (const v of ['https://iafest.demerzellabs.com.br', 'https://manager.kidmaisfestas.com', 'http://staging-iafest.demerzellabs.com.br', 'https://staging-iafest.demerzellabs.com.br/', 'https://kidmais-manager-production.onrender.com'])
        assert.throws(() => origemDoStaging({ KIDMAIS_STAGING_ORIGEM: v }), /KIDMAIS_STAGING_ORIGEM_RECUSADA/, v);
});

test('roteiros de H14 leem o alvo da variável, sem host fixo no código', () => {
    for (const f of ['assinatura-aviso-email-staging', 'assinatura-staging-ensaio', 'fixture-atualizacao-staging', 'homologacao-fundador-staging', 'homologacao-pagamento-renovacao-staging', 'homologacao-pagamento-staging', 'homologacao-planos-cotacao-staging', 'homologacao-renovacao-staging']) {
        const fonte = readFileSync(`${__dirname}/${f}.cjs`, 'utf8');
        assert.match(fonte, /origemDoStaging\(\)/, f);
        assert.doesNotMatch(fonte, /= 'https:\/\/kidmais-manager-staging\.onrender\.com'/, f);
    }
});

const NOVA = 'https://staging-iafest.demerzellabs.com.br';
const ANTIGA = 'https://kidmais-manager-staging.onrender.com';
const ROTA_DO_WEBHOOK = '/api/integracoes/asaas/webhook';

test('nenhum roteiro monta o webhook a partir da origem do painel', () => {
    const { readdirSync } = require('node:fs');
    const { join } = require('node:path');
    for (const nome of readdirSync(__dirname).filter((n) => n.endsWith('.cjs') && !n.endsWith('.test.cjs'))) {
        const fonte = readFileSync(join(__dirname, nome), 'utf8');
        assert.doesNotMatch(fonte, /\b(BASE|ORIGEM)\s*\+\s*(ROTA\b|ROTA_WEBHOOK|'\/api\/integracoes\/asaas\/webhook)/, nome);
    }
});

test('roteiros que expõem o webhook: painel em N, webhook em A', () => {
    const { spawnSync } = require('node:child_process');
    const programa = "console.log(require('./scripts/s3s4-staging-20261020.cjs').ROTA_WEBHOOK)";
    const r = spawnSync(process.execPath, ['-e', programa], { encoding: 'utf8', cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, KIDMAIS_STAGING_ORIGEM: NOVA } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), ANTIGA + ROTA_DO_WEBHOOK);
});

test('preparador com o painel em N: reutiliza o webhook em A, sem criar nem alterar', () => {
    const { spawnSync } = require('node:child_process');
    const programa = `
      const { prepararWebhook } = require('./scripts/assinatura-staging-ensaio.cjs');
      const w = { id: 'h', url: '${ANTIGA}${ROTA_DO_WEBHOOK}', enabled: true, interrupted: false, events: ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'] };
      const chamadas = [];
      const r = { empresa: 'e' };
      prepararWebhook(async (caminho, metodo = 'GET') => {
        chamadas.push(metodo);
        if (caminho === '/webhooks?limit=100') return { totalCount: 1, hasMore: false, data: [w] };
        if (caminho === '/webhooks/h') return w;
        throw Error('CHAMADA_NAO_PERMITIDA');
      }, { webhookToken: 's'.repeat(32) }, r, () => {}).then(() => console.log(JSON.stringify({ reutilizado: r.webhookReutilizado, intencao: r.intencaoWebhook ?? null, chamadas })));
    `;
    const r = spawnSync(process.execPath, ['-e', programa], { encoding: 'utf8', cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, KIDMAIS_STAGING_ORIGEM: NOVA } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { reutilizado: true, intencao: null, chamadas: ['GET', 'GET'] });
});
