/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do P0 de produção: sem rede, sem banco. Cliente simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const d = require('./diagnostico-lancamento-production.cjs');

const fonte = fs.readFileSync(__dirname + '/diagnostico-lancamento-production.cjs', 'utf8');
const env = (o = {}) => ({ RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
    DATABASE_URL: 'postgresql://sintetico:sintetico@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production', ...o });

function cliente({ presentes, kidmais = { empresas: 1, ativas: 1, assinaturas: 0, contratacoes: 0, fundadores: 0, isencoes: 0 }, db = 'kidmais_production', tls = true }) {
    const log = [];
    return { log, async query(t) {
        log.push(t);
        if (t.includes('current_database()')) return { rows: [{ db, tls }] };
        if (t.includes('AS "m062"')) return { rows: [Object.fromEntries(d.MIGRATIONS.map(([m]) => [`m${m}`, presentes.includes(m)]))] };
        if (t.includes("codigo = 'kidmais'") && t.includes('count(*)')) return { rows: [kidmais] };
        if (t.includes("SELECT id::text AS id FROM empresas")) return { rows: [{ id: '7e990a2b-e64b-4630-9aae-4646fe936ede' }] };
        if (t.includes('FROM bloqueios_agenda')) return { rows: [{ n: 0 }] };
        if (t.includes('FROM empresa_assinaturas')) return { rows: [{ n: 3 }] };
        return { rows: [] };
    } };
}

test('sem a flag única não conecta', () => {
    assert.equal(d.autorizado([]), false); assert.equal(d.autorizado([d.FLAG, '--x']), false); assert.equal(d.autorizado([d.FLAG]), true);
    const r = spawnSync(process.execPath, [__dirname + '/diagnostico-lancamento-production.cjs'], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_P0/);
});

test('trava: só o web de produção, banco interno exato, TLS do serviço; staging e banco real recusados', () => {
    assert.deepEqual(d.alvo(env()).ssl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    for (const v of [{ RENDER: undefined }, { RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg' }, { KIDMAIS_DEPLOY_ENV: 'staging' }, { DATABASE_SSL: 'false' },
        { DATABASE_URL: 'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91' }, { DATABASE_URL: 'postgresql://u:s@localhost:5432/kidmais_manager' },
        { DATABASE_URL: 'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production?sslmode=disable' }])
        assert.throws(() => d.alvo(env(v)), undefined, JSON.stringify(v));
});

test('schema antigo (até 073): lista ausentes, Kidmais essencial, só leitura com ROLLBACK', async () => {
    const c = cliente({ presentes: ['062', '063', '064', '066', '067', '068', '069', '070', '071', '072', '073'], kidmais: { empresas: 1, ativas: 1, assinaturas: 0 } });
    const r = await d.diagnosticar(c, env({ ASAAS_API_KEY: 'segredo-que-nao-sai' }));
    assert.deepEqual(r.ausentes, ['074', '074a', '075', '076', '077', '078', '079']);
    assert.equal(r.kidmais.assinaturas, 0); assert.equal(r.kidmais.id, '7e990a2b-e64b-4630-9aae-4646fe936ede');
    assert.equal(c.log[0], 'BEGIN TRANSACTION READ ONLY'); assert.equal(c.log.at(-1), 'ROLLBACK');
    assert.ok(!c.log.some(t => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(t)));
    assert.equal(r.variaveisPresentes.ASAAS_API_KEY, true);
    assert.ok(!JSON.stringify(r).includes('segredo'), 'nunca imprime valores');
});

test('schema completo: invariante da Kidmais da conferência diária; banco ou TLS divergentes recusam', async () => {
    const r = await d.diagnosticar(cliente({ presentes: d.MIGRATIONS.map(([m]) => m) }), env());
    assert.deepEqual(r.ausentes, []); assert.equal(r.kidmais.contratacoes, 0); assert.equal(r.bloqueiosGlobaisAtivosFuturos, 0);
    await assert.rejects(d.diagnosticar(cliente({ presentes: [], db: 'outro' }), env()), /BANCO_CONECTADO_DIVERGENTE/);
    await assert.rejects(d.diagnosticar(cliente({ presentes: [], tls: false }), env()), /SEM_TLS/);
});

test('código-fonte: nenhuma escrita, nenhuma chamada de rede', () => {
    assert.doesNotMatch(fonte, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP |TRUNCATE|ALTER TABLE)\b/);
    assert.doesNotMatch(fonte, /fetch\(|https?:\/\/(?!creativecommons)/);
    assert.match(fonte, /BEGIN TRANSACTION READ ONLY/);
});
