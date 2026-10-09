/* eslint-disable @typescript-eslint/no-require-imports */
/** Preparação offline por padrão. Execução exige autorização específica para o alvo abaixo.
 * Não lê .env, não reutiliza bancos, não remove bancos e não chama provedores.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const raiz = path.resolve(__dirname, '..');
const webhook = process.argv.includes('--webhook');
const banco = webhook ? 'kidmais_webhook_20261009_sintetica' : 'kidmais_renovacao_075_completa';
const cluster = 'kidmais_renovacao_075';
const alvo = `127.0.0.1:55475/${banco}`;
const manifesto = path.join(raiz, webhook ? 'docs/evidencias/assinatura-webhook-schema-20261009.json' : 'docs/evidencias/assinatura-schema-completo-20261009.json');
const ler = relativo => fs.readFileSync(path.join(raiz, relativo), 'utf8');
const hash = relativo => createHash('sha256').update(fs.readFileSync(path.join(raiz, relativo))).digest('hex');
global.fetch = async () => { throw new Error('Rede externa proibida neste ensaio.'); };

async function plano() {
    const { approvedFiles, requiredChecks } = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
    assert.equal(approvedFiles.at(-1), '20261009_075_renovacao_fundador.sql', 'Inventário mudou: revisar plano.');
    const arquivos = [...approvedFiles];
    const etapas = arquivos.map(arquivo => {
        const checks = (arquivo === '20261009_074a_planos_comerciais.sql' ? ['20261009_074a_precheck.sql', '20261009_074a_postcheck.sql'] : requiredChecks(arquivo)).map(p => `database/checks/${p}`);
        // O inventário exige o postcheck 011 separadamente de requiredChecks.
        if (arquivo.split('_')[1] === '011') checks.push('database/checks/20260908_011_pagamentos_postcheck.sql');
        return { migration: `database/migrations/${arquivo}`,
            antes: checks.filter(p => p.includes('precheck')),
            depois: checks.filter(p => !p.includes('precheck')) };
    });
    const rollbacks = ['database/rollback/20261009_075_renovacao_fundador_down.sql', 'database/rollback/20261009_074a_planos_comerciais_down.sql'];
    const fontes = [...new Set([...etapas.flatMap(e => [...e.antes, e.migration, ...e.depois]), ...rollbacks])];
    return { alvo, cluster, banco, versao: 1, etapas, rollbacks, fontes: fontes.map(arquivo => ({ arquivo, sha256: hash(arquivo) })) };
}

async function conectar(database) {
    const { Client } = require('pg');
    const c = new Client({ host: '127.0.0.1', port: 55475, database, user: cluster, ssl: false,
        password: async () => { throw new Error('Pedido de senha inesperado: alvo recusado.'); },
        connectionTimeoutMillis: 5000, application_name: 'kidmais-schema-completo-075' });
    await c.connect();
    try {
        const r = (await c.query(`SELECT current_database() AS db, current_user AS papel,
          host(inet_server_addr()) AS endereco, inet_server_port() AS porta, current_setting('cluster_name') AS cluster,
          EXISTS(SELECT 1 FROM pg_database WHERE datname='kidmais_manager') AS tem_real`)).rows[0];
        assert.deepEqual(r, { db: database, papel: cluster, endereco: '127.0.0.1', porta: 55475, cluster, tem_real: false });
        await c.query("SET statement_timeout='60s'");
        await c.query("SET lock_timeout='5s'");
        return c;
    } catch (e) { await c.end(); throw e; }
}

async function executar(p) {
    assert.equal(process.env.KIDMAIS_SCHEMA_COMPLETO_AUTORIZACAO, alvo, 'Falta autorização literal do alvo. Nenhuma conexão tentada.');
    assert.ok(!Object.keys(process.env).some(k => k === 'DATABASE_URL' || /^PG/i.test(k)), 'Configuração de conexão herdada recusada.');
    assert.deepEqual(JSON.parse(fs.readFileSync(manifesto, 'utf8')), p, 'Arquivos mudaram: revisar e gerar manifesto novamente.');
    const admin = await conectar('postgres');
    try {
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [banco])).rowCount, 0, 'Banco já existe; não substituir.');
        await admin.query(`CREATE DATABASE ${banco} TEMPLATE template0`);
    } finally { await admin.end(); }
    const c = await conectar(banco);
    try {
        for (const etapa of p.etapas) {
            if (etapa.migration.includes('_046_')) {
                // Pré-condição da migration histórica, igual à receita canônica; nunca autentica ou envia e-mail.
                const email = ler(etapa.migration).match(/email_alvo text := '([^']+)'/)?.[1];
                assert.ok(email, 'Fixture 046 precisa de revisão.');
                const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
                const senha = `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`;
                await c.query(`INSERT INTO usuarios_administrativos(email,nome,cargo,senha_hash,papel,ativo)
                  VALUES(lower(btrim($1)),'Representante Fixture Sintética','Fixture de teste',$2,'REPRESENTANTE_AUTORIZADO',true)`, [email, senha]);
            }
            for (const arquivo of [...etapa.antes, etapa.migration, ...etapa.depois]) {
                console.log(`EXEC ${arquivo}`);
                await c.query(ler(arquivo));
            }
        }
        const antes = (await c.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows;
        for (const arquivo of p.rollbacks) await c.query(ler(arquivo));
        for (const etapa of p.etapas.slice(-2))
            for (const arquivo of [...etapa.antes, etapa.migration, ...etapa.depois]) await c.query(ler(arquivo));
        assert.deepEqual((await c.query('SELECT * FROM empresa_assinaturas ORDER BY empresa_id')).rows, antes);
        console.log(`PASS ${p.etapas.length} migrations e checks; 074/075 up/down/reaplicação; assinaturas sintéticas preservadas.`);
        console.log('Isto valida instalação do schema; fluxos de aplicação e provedores exigem ensaios separados.');
    } finally { await c.query('ROLLBACK').catch(() => {}); await c.end(); }
}

async function principal() {
    const modo = process.argv[2] ?? '--plano';
    assert.ok(['--plano', '--aplicar'].includes(modo) && (process.argv.length <= 3 || (process.argv.length === 4 && process.argv[3] === '--webhook')), 'Use --plano ou --aplicar, opcionalmente --webhook.');
    const p = await plano();
    if (modo === '--plano') {
        fs.mkdirSync(path.dirname(manifesto), { recursive: true });
        fs.writeFileSync(manifesto, JSON.stringify(p, null, 2) + '\n');
        console.log(`PLANO OFFLINE: ${p.etapas.length} migrations, ${p.fontes.length} arquivos verificados, alvo ${alvo}. Nenhuma conexão.`);
        return;
    }
    await executar(p);
}
principal().catch(e => { console.error(`FAIL ${e.code ?? e.name}: ${e.message}`); process.exitCode = 1; });
