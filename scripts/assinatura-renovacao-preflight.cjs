/* eslint-disable @typescript-eslint/no-require-imports */
// Diagnóstico de preparação. Padrão OFFLINE; --consultar-schema exige autorização para leitura do alvo.
// Nunca importa o processador de renovação, envia e-mail ou chama o Asaas. Não carrega .env.
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');
const SERVICO = 'crn-db493i142hec73ahmoe0';
const SCHEMA_SQL = `SELECT
  to_regclass('public.assinatura_renovacoes') IS NOT NULL AS renovacoes,
  to_regclass('public.assinatura_contratacoes') IS NOT NULL AS contratacoes,
  to_regclass('public.assinatura_fundadores') IS NOT NULL AS fundadores,
  (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('public.assinatura_renovacoes')
    AND NOT tgisinternal AND tgenabled = 'O'
    AND tgname IN ('assinatura_renovacoes_075_guarda','assinatura_renovacoes_075_truncate')) AS guardas`;

function argumentos(argv) {
    if (argv.length === 0) return false;
    if (argv.length === 1 && argv[0] === '--consultar-schema') return true;
    throw Error('ARGUMENTO_RECUSADO');
}

async function configuracao(env) {
    if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== SERVICO
        || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox') throw Error('ALVO_RECUSADO');
    const alvo = validarAlvo(env);
    if (alvo.database !== 'kidmais_staging_1z91' || alvo.host !== 'dpg-daidko3m8hqs73ce4jt0-a'
        || alvo.port !== 5432) throw Error('BANCO_RECUSADO');
    const conexao = opcoesConexao(alvo, env);
    const { configuracaoAsaas } = await import('../lib/assinatura/asaas.ts');
    const { situacaoEmail } = await import('../lib/acessos/email.ts');
    const email = situacaoEmail(env);
    const bloqueios = [];
    if (!configuracaoAsaas(env).ligado) bloqueios.push('ASAAS_NAO_CONFIGURADO');
    if (!email.configurado || email.provedor !== 'resend') bloqueios.push('RESEND_NAO_CONFIGURADO');
    if (env.ADMIN_AUTH_ORIGIN !== 'https://kidmais-manager-staging.onrender.com') bloqueios.push('ORIGEM_STAGING_DIVERGENTE');
    if (env.KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO !== '074-075') bloqueios.push('SCHEMA_NAO_LIBERADO');
    return { alvo, conexao, bloqueios };
}

async function verificar(env, argv = [], criarCliente) {
    const consultar = argumentos(argv);
    const cfg = await configuracao(env);
    const resultado = { modo: consultar ? 'SCHEMA_SOMENTE_LEITURA' : 'DIAGNOSTICO_OFFLINE',
        bloqueios: [...cfg.bloqueios], bancoConsultado: false, provedoresChamados: false,
        emailsEnviados: 0, cobrancasAlteradas: 0, rotinaAplicacaoRemotaHabilitada: false };
    // A configuração não confirma autenticação, entrega ou condições de negócio.
    if (consultar) {
        const factory = criarCliente ?? (opcoes => new (require('pg').Client)(opcoes));
        const client = factory({ ...cfg.conexao, connectionTimeoutMillis: 10000,
            application_name: 'kidmais-renovacao-preflight' });
        client.on('error', () => undefined);
        try {
            await client.connect();
            await client.query('BEGIN READ ONLY');
            await client.query("SET LOCAL statement_timeout = '10s'");
            await client.query("SET LOCAL lock_timeout = '3s'");
            const id = (await client.query(`SELECT current_database() AS db,
                (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`)).rows[0];
            if (id?.db !== cfg.alvo.database || id.tls !== true) throw Error('IDENTIDADE_BANCO_RECUSADA');
            const schema = (await client.query(SCHEMA_SQL)).rows[0];
            resultado.bancoConsultado = true;
            resultado.schemaEstrutural = !!schema && schema.renovacoes === true && schema.contratacoes === true
                && schema.fundadores === true && schema.guardas === 2;
            if (!resultado.schemaEstrutural) resultado.bloqueios.push('SCHEMA_ESTRUTURAL_INCOMPLETO');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            await client.end();
        }
    }
    resultado.resultado = resultado.bloqueios.length ? 'PENDENTE' : 'PREPARACAO_CONFERIDA';
    return resultado;
}

if (require.main === module) verificar(process.env, process.argv.slice(2)).then(r => {
    console.log(JSON.stringify(r));
    if (r.bloqueios.length) process.exitCode = 2;
}).catch(() => {
    console.error(JSON.stringify({ resultado: 'DIAGNOSTICO_RECUSADO', detalhesSensíveisOmitidos: true }));
    process.exitCode = 1;
});
module.exports = { argumentos, configuracao, verificar, SCHEMA_SQL };
