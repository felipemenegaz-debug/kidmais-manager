/* eslint-disable @typescript-eslint/no-require-imports */
// Leitura pontual autorizável. Não concede isenção nem chama provedores.
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');
const fs = require('node:fs');
const path = require('node:path');
const SQL = fs.readFileSync(path.join(__dirname, '../database/checks/20261009_kidmais_isencao_identidade_staging.sql'), 'utf8');

function configuracao(env) {
    if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== 'crn-db493i142hec73ahmoe0'
        || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox') throw Error('ALVO_RECUSADO');
    const alvo = validarAlvo(env);
    if (alvo.database !== 'kidmais_staging_1z91' || alvo.host !== 'dpg-daidko3m8hqs73ce4jt0-a'
        || alvo.port !== 5432) throw Error('BANCO_RECUSADO');
    return opcoesConexao(alvo, env);
}

async function diagnosticar(env, argv = [], criarCliente) {
    if (argv.length === 0) return { modo: 'PREPARADO_OFFLINE', bancoConsultado: false, isencaoConcedida: false };
    if (argv.length !== 1 || argv[0] !== '--consultar-staging') throw Error('ARGUMENTO_RECUSADO');
    const conexao = configuracao(env);
    const factory = criarCliente ?? (opcoes => new (require('pg').Client)(opcoes));
    const client = factory({ ...conexao, connectionTimeoutMillis: 10000,
        application_name: 'kidmais-isencao-identidade-readonly' });
    client.on('error', () => undefined);
    try {
        await client.connect();
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '3s'");
        const id = (await client.query(`SELECT current_database() AS db,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`)).rows[0];
        if (id?.db !== 'kidmais_staging_1z91' || id.tls !== true) throw Error('IDENTIDADE_BANCO_RECUSADA');
        const dados = (await client.query(SQL)).rows;
        if (dados.length > 1 || dados.some(r => r.banco !== 'kidmais_staging_1z91')) throw Error('RESULTADO_AMBIGUO');
        return { modo: 'IDENTIDADE_SOMENTE_LEITURA', bancoConsultado: true, isencaoConcedida: false,
            provedoresChamados: false, empresasEncontradas: dados.length, dados };
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end();
    }
}

if (require.main === module) diagnosticar(process.env, process.argv.slice(2))
    .then(r => console.log(JSON.stringify(r)))
    .catch(() => { console.error('DIAGNOSTICO_NAO_CONCLUIDO_SEM_ESCRITA'); process.exitCode = 1; });
module.exports = { diagnosticar, configuracao };
