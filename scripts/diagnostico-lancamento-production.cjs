/* eslint-disable @typescript-eslint/no-require-imports */
// P0 do lançamento (docs/LANCAMENTO_VENDA_20261011.md §7): diagnóstico SOMENTE LEITURA de produção, executado por Felipe no
// Web Shell do srv-dak77m2d0e5s73b8rkkg, com a flag única --diagnostico-somente-leitura:
//   cd /opt/render/project/src && node scripts/diagnostico-lancamento-production.cjs --diagnostico-somente-leitura
// Transação READ ONLY, timeouts curtos, ROLLBACK no fim. Saída: só presença de objetos, contagens e nomes de variáveis
// presentes (nunca valores, nunca dados de clientes). Não aplica migration, não grava, não chama provedores.
const assert = require('node:assert/strict');
// Autossuficiente: pode ser copiado para /tmp e rodar ANTES do deploy, usando só o pg já instalado no serviço.
// O teste exige igualdade com a conferência diária para evitar divergência entre as duas leituras.
const SQL_KIDMAIS = `SELECT count(*)::int AS empresas,
    count(*) FILTER (WHERE e.status = 'ATIVA')::int AS ativas,
    (SELECT count(*) FROM empresa_assinaturas a JOIN empresas k ON k.id = a.empresa_id WHERE k.codigo = 'kidmais')::int AS assinaturas,
    (SELECT count(*) FROM assinatura_contratacoes c JOIN empresas k ON k.id = c.empresa_id WHERE k.codigo = 'kidmais')::int AS contratacoes,
    (SELECT count(*) FROM assinatura_fundadores f JOIN empresas k ON k.id = f.empresa_id WHERE k.codigo = 'kidmais')::int AS fundadores,
    (SELECT count(*) FROM assinatura_isencoes i JOIN empresas k ON k.id = i.empresa_id WHERE k.codigo = 'kidmais')::int AS isencoes
  FROM empresas e WHERE e.codigo = 'kidmais'`;

const FLAG = '--diagnostico-somente-leitura';
const ALVO = Object.freeze({ servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432 });
/** Um objeto característico por migration (criado por ela e por nenhuma anterior). */
const MIGRATIONS = Object.freeze([
    ['062', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bloqueios_agenda' AND column_name='empresa_id')"],
    ['063', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sessoes_administrativas' AND column_name='empresa_ativa_id')"],
    ['064', "to_regprocedure('public.kidmais_064_importacao_guarda()') IS NOT NULL"],
    ['066', "to_regclass('public.empresa_pix_recebimento') IS NOT NULL"],
    ['067', "to_regclass('public.empresa_assinaturas') IS NOT NULL"],
    ['068', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='empresa_assinaturas' AND column_name='provedor_situacao')"],
    ['069', "to_regclass('public.cadastros_publicos') IS NOT NULL"],
    ['070', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND column_name='origem_buffet_item_id')"],
    ['071', "to_regclass('public.importacoes_comerciais') IS NOT NULL"],
    ['072', "to_regclass('public.modelos_contrato_empresa') IS NOT NULL"],
    ['073', "to_regclass('public.convite_carteiras') IS NOT NULL"],
    ['074', "to_regclass('public.convite_familias') IS NOT NULL"],
    ['074a', "to_regclass('public.assinatura_isencoes') IS NOT NULL"],
    ['075', "to_regclass('public.assinatura_renovacoes') IS NOT NULL"],
    ['076', "to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL"],
    ['077', "to_regclass('public.empresa_regras_pagamento') IS NOT NULL"],
    ['078', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='buffet_categorias' AND column_name='empresa_id')"],
    ['079', "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes' AND column_name='resolucao_resultado')"],
]);
/** Variáveis cuja PRESENÇA importa para o lançamento (valores nunca são lidos para a saída). */
const VARIAVEIS = Object.freeze(['ASAAS_AMBIENTE', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'ASSINATURA_PLANOS_ATIVOS', 'ASSINATURA_TESTE_DIAS',
    'ASSINATURA_REGULARIZACAO_DIAS', 'ASSINATURA_SOMENTE_LEITURA_DIAS', 'CADASTRO_PUBLICO_ATIVO', 'USUARIOS_CRIACAO_DIRETA',
    'COTACAO_PUBLICA_POR_EMPRESA', 'EMAIL_PROVIDER', 'EMAIL_REMETENTE', 'RESEND_API_KEY', 'RECUPERACAO_SENHA_ATIVA', 'SITE_PRECOS_PUBLICADOS',
    'SITE_URL', 'SITE_RAZAO_SOCIAL', 'SITE_CNPJ', 'SITE_ENDERECO', 'SITE_ATENDIMENTO_EMAIL', 'SITE_ATENDIMENTO_WHATSAPP',
    'SITE_ATENDIMENTO_HORARIO', 'SITE_ENCARREGADO_DADOS', 'AGENDA_PUBLICA_EMPRESA_ID', 'CONVITES_ENABLED']);

function autorizado(argv) { return argv.length === 1 && argv[0] === FLAG; }

/** Trava de alvo: só o web de produção, o banco interno exato e TLS como o serviço (DATABASE_SSL=true). */
function alvo(env) {
    assert.equal(env.RENDER, 'true', 'FORA_DO_RENDER');
    assert.equal(env.RENDER_SERVICE_ID, ALVO.servico, 'SERVICO_RECUSADO');
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'production', 'AMBIENTE_RECUSADO');
    assert.equal(env.DATABASE_SSL, 'true', 'TLS_OBRIGATORIO');
    const u = new URL(env.DATABASE_URL);
    assert.equal(u.hostname, ALVO.host, 'HOST_RECUSADO');
    assert.equal(decodeURIComponent(u.pathname.slice(1)), ALVO.database, 'BANCO_RECUSADO');
    assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
    assert.ok(![...u.searchParams.keys()].some(k => /^ssl/i.test(k)), 'SSL_URL_RECUSADO');
    return { connectionString: u.toString(), connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2' } };
}

async function diagnosticar(client, env) {
    await client.query('BEGIN TRANSACTION READ ONLY');
    try {
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '3s'");
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        assert.equal(id.db, ALVO.database, 'BANCO_CONECTADO_DIVERGENTE');
        assert.equal(id.tls, true, 'SEM_TLS');
        const presenca = (await client.query(`SELECT ${MIGRATIONS.map(([m, sql]) => `(${sql}) AS "m${m}"`).join(', ')}`)).rows[0];
        const migrations = Object.fromEntries(MIGRATIONS.map(([m]) => [m, presenca[`m${m}`] === true]));
        const ausentes = MIGRATIONS.map(([m]) => m).filter(m => !migrations[m]);
        // Kidmais: com 074a, o invariante completo da conferência diária; sem ela, o essencial (empresa e situação comercial).
        const kidmais = migrations['074a']
            ? (await client.query(SQL_KIDMAIS)).rows[0]
            : (await client.query(`SELECT count(*)::int AS empresas, count(*) FILTER (WHERE status = 'ATIVA')::int AS ativas
                ${migrations['067'] ? ", (SELECT count(*) FROM empresa_assinaturas a JOIN empresas k ON k.id = a.empresa_id WHERE k.codigo = 'kidmais')::int AS assinaturas" : ''}
                FROM empresas WHERE codigo = 'kidmais'`)).rows[0];
        const kidmaisId = kidmais.empresas === 1 ? (await client.query("SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais'")).rows[0].id : null;
        const bloqueiosGlobais = migrations['062']
            ? (await client.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE empresa_id IS NULL AND ativo AND data >= current_date')).rows[0].n
            : null;
        const assinaturas = migrations['067'] ? (await client.query('SELECT count(*)::int AS n FROM empresa_assinaturas')).rows[0].n : null;
        const variaveis = Object.fromEntries(VARIAVEIS.map(k => [k, env[k] !== undefined && env[k] !== '']));
        return { resultado: 'DIAGNOSTICO', banco: id.db, tls: id.tls, migrations, ausentes, kidmais: { ...kidmais, id: kidmaisId },
            bloqueiosGlobaisAtivosFuturos: bloqueiosGlobais, empresasComAssinatura: assinaturas, variaveisPresentes: variaveis };
    } finally {
        await client.query('ROLLBACK').catch(() => {});
    }
}

if (require.main === module) {
    if (!autorizado(process.argv.slice(2))) { console.error('AGUARDANDO_AUTORIZACAO_P0'); process.exitCode = 1; }
    else {
        (async () => {
            const { Client } = require('pg');
            const c = new Client({ ...alvo(process.env), application_name: 'kidmais-p0-somente-leitura' });
            c.on('error', () => undefined);
            await c.connect();
            try { console.log(JSON.stringify(await diagnosticar(c, process.env), null, 2)); } finally { await c.end(); }
        })().catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
    }
}
module.exports = { FLAG, ALVO, MIGRATIONS, VARIAVEIS, SQL_KIDMAIS, autorizado, alvo, diagnosticar };
