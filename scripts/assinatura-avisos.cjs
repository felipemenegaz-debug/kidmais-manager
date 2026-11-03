/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Job dos avisos por e-mail da assinatura (087): enfileira os avisos por tempo (fim do teste, pagamento pendente,
 * somente leitura, suspensão próxima, suspensão) e envia os pendentes (inclusive os de pagamento confirmado e
 * cancelamento gravados pela sincronização). Não consulta o Asaas. Não agenda nada no Render.
 *
 *   node scripts/assinatura-avisos.cjs            simulação (padrão): transações READ ONLY, nada gravado nem enviado
 *   node scripts/assinatura-avisos.cjs --aplicar  grava e envia, em UM destes modos (qualquer outra combinação recusa
 *                                                 antes de conectar):
 *     APLICAR_LOCAL_EMAIL_ARQUIVO  banco local isolado + EMAIL_PROVIDER=arquivo (prova local, desde 20/10);
 *     APLICAR_STAGING / APLICAR_PRODUCAO  (rodada 2 de 02/11, P2-2 do Astra) só no serviço do Render
 *       (RENDER=true), no ambiente declarado (KIDMAIS_DEPLOY_ENV), com o alvo exato do banco daquele ambiente
 *       (production: a mesma trava de alvo do cron de reconciliação, PRODUCAO de assinatura-reconciliar.cjs),
 *       EMAIL_PROVIDER=resend configurado, ASSINATURA_AVISOS_EMAIL=ligado, KIDMAIS_AVISOS_MODO=aplicar e
 *       KIDMAIS_AVISOS_SCHEMA_VALIDADO=087 (só depois da 087 aplicada e conferida naquele banco).
 *   KIDMAIS_AVISOS_MODO=aguardando  → sai 0 sem conectar (estado inicial do cron, como o C1 da reconciliação);
 *   KIDMAIS_AVISOS_MODO=simular     → simulação (só leitura) MESMO com --aplicar, para o cron passar por aguardando →
 *                                      simular → aplicar mudando só a env; qualquer outro valor é recusado.
 *   A URL do alvo não pode ter fragmento nem parâmetros além dos de TLS: `?host=`/`?port=` trocariam o servidor depois
 *   da validação (o driver pg dá precedência a eles). Porta e usuário têm de ser explícitos (sem eles o driver lê PGPORT/
 *   PGUSER do ambiente). A conexão é montada só com host/porta/banco do alvo validado, nunca pela string. Recusado
 *   antes de conectar, em qualquer modo que conecte.
 *   Saída: 0 ciclo sem pendência humana; 2 aviso INCERTO, envio falho ou erro; 1 configuração recusada/interrupção/sem a 087.
 *
 * Alvo SEMPRE explícito, mesmas regras da reconciliação (scripts/assinatura-reconciliar.cjs → validarAlvo):
 * KIDMAIS_RECONCILIAR_DATABASE_URL + KIDMAIS_RECONCILIAR_ALVO; nunca DATABASE_URL nem .env.local; kidmais_manager
 * recusado. TLS pela mesma política (opcoesConexao: em produção DATABASE_SSL=true obrigatório). Executar em qualquer
 * banco exige autorização explícita de Felipe (docs/OPERACAO_AGENTES.md). Frequência recomendada do cron: a cada 12 h
 * (uma tentativa falha é repetida dentro da janela de 23 h da chave idempotente; P3 da revisão). Ver
 * docs/AVISOS_ASSINATURA_EMAIL_20261020.md e docs/RECORTE_COBRANCA_PRODUCTION_20261102.md.
 */
const { validarAlvo, argumentos, opcoesConexao } = require('./assinatura-reconciliar.cjs');
const { parse: parseConexaoDoDriver } = require('pg-connection-string');

const STAGING = Object.freeze({ database: 'kidmais_staging_1z91', host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432 });
const SCHEMA_EXIGIDO = '087';
const MODOS = new Set(['', 'aguardando', 'simular', 'aplicar']);
/** Únicos parâmetros de URL tolerados: os de TLS, em minúsculas (os mesmos nomes que opcoesConexao remove/valida). Qualquer outro (host, port, hostaddr,
 * dbname, user, password, options, application_name…) substituiria o destino DEPOIS da validação do alvo, porque o driver pg
 * dá precedência a eles (P2 #5 do Astra, 03/11/2026). */
const PARAMETROS_TLS = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']);

/** Recusa, sem imprimir a URL, fragmento ou parâmetro capaz de redirecionar a conexão. validarAlvo já garantiu URL válida. */
function recusarParametrosDeDestino(bruto) {
    const url = new URL(bruto);
    if (url.hash) throw new Error('URL do alvo recusada: fragmento não é permitido.');
    // P2 #7 (Astra r3): sem porta explícita o driver completa com PGPORT do ambiente; a validação teria assumido 5432.
    if (!url.port) throw new Error('URL do alvo recusada: a porta deve ser explícita (PGPORT do ambiente não é aceita).');
    // P3 #8 (Astra r4): o driver trata 0 como ausente e cairia em PGPORT; só porta inteira entre 1 e 65535.
    if (!/^\d{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('URL do alvo recusada: porta fora de 1..65535.');
    if (!url.username) throw new Error('URL do alvo recusada: o usuário deve ser explícito (PGUSER do ambiente não é aceito).');
    const estranhos = [...new Set([...url.searchParams.keys()])].filter((k) => !PARAMETROS_TLS.has(k));
    if (estranhos.length)
        throw new Error(`URL do alvo recusada: parâmetro(s) ${estranhos.map((k) => k.replace(/[^A-Za-z0-9_-]/g, '?')).join(', ')} podem substituir o destino validado.`);
}

const ligado = (env) => env.ASSINATURA_AVISOS_EMAIL?.trim().toLowerCase() === 'ligado';

/** Decide o modo sem conectar. Lança Error (sem URL) em qualquer combinação não prevista. */
function configuracaoExecucao(env, argv) {
    const { aplicar } = argumentos(argv);
    const modoEnv = (env.KIDMAIS_AVISOS_MODO ?? '').trim();
    if (!MODOS.has(modoEnv)) throw new Error('KIDMAIS_AVISOS_MODO desconhecido: use aguardando, simular ou aplicar.');
    if (modoEnv === 'aguardando') return { aguardando: true, aplicar: false, alvo: null, modo: 'AGUARDANDO_HABILITACAO' };
    const alvo = validarAlvo(env);
    recusarParametrosDeDestino(env.KIDMAIS_RECONCILIAR_DATABASE_URL);
    // `simular` vale mesmo com o --aplicar fixo do startCommand do cron (P3 #6): só leitura, nenhum envio.
    if (!aplicar || modoEnv === 'simular') return { aguardando: false, aplicar: false, alvo, modo: 'SIMULACAO_SEM_ESCRITA' };
    if (!ligado(env)) throw new Error('Avisos desligados: defina ASSINATURA_AVISOS_EMAIL=ligado para aplicar.');
    if (alvo.local) {
        if (env.EMAIL_PROVIDER !== 'arquivo') throw new Error('Aplicação local exige banco local isolado e e-mail em arquivo.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_LOCAL_EMAIL_ARQUIVO' };
    }
    // Remoto: só o serviço do Render, com liberação explícita, provedor de e-mail real e schema conferido.
    if (env.RENDER !== 'true' || modoEnv !== 'aplicar')
        throw new Error('Aplicação remota exige o serviço do Render e KIDMAIS_AVISOS_MODO=aplicar.');
    if (env.KIDMAIS_AVISOS_SCHEMA_VALIDADO?.trim() !== SCHEMA_EXIGIDO)
        throw new Error(`Schema não liberado: defina KIDMAIS_AVISOS_SCHEMA_VALIDADO=${SCHEMA_EXIGIDO} só depois da 087 aplicada e conferida.`);
    if (env.EMAIL_PROVIDER !== 'resend') throw new Error('Aplicação remota exige EMAIL_PROVIDER=resend.');
    const ambiente = env.KIDMAIS_DEPLOY_ENV?.trim();
    if (ambiente === 'production') {
        if (!alvo.producao) throw new Error('Alvo de produção recusado: production exige o alvo exato de kidmais_production.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_PRODUCAO' };
    }
    if (ambiente === 'staging') {
        if (alvo.producao || alvo.database !== STAGING.database || alvo.host !== STAGING.host || alvo.port !== STAGING.port)
            throw new Error('Alvo de staging recusado: staging exige o alvo exato de kidmais_staging_1z91.');
        return { aguardando: false, aplicar: true, alvo, modo: 'APLICAR_STAGING' };
    }
    throw new Error('Ambiente recusado: KIDMAIS_DEPLOY_ENV deve ser staging ou production para aplicar fora do local.');
}

/**
 * Parâmetros efetivos da conexão, montados SÓ a partir do alvo validado: host, porta e banco explícitos (o driver só lê
 * PGHOST/PGPORT/PGDATABASE/PGUSER quando o campo falta), credenciais lidas pelo parser do próprio driver e conferidas
 * contra o alvo, TLS por opcoesConexao (mesma política da reconciliação). Nunca repassa a connectionString ao Pool.
 */
function parametrosDeConexao(alvo, env) {
    recusarParametrosDeDestino(alvo.connectionString);
    // P3 #9 (Astra r4): a política TLS (opcoesConexao) decide o ssl e devolve a URL sem os parâmetros TLS; só ESSA URL vai ao
    // parser do driver, que senão leria sslcert/sslkey/sslrootcert do disco ou exigiria CA em verify-ca+uselibpqcompat.
    const { connectionString: limpa, ssl } = opcoesConexao(alvo, env);
    const lido = parseConexaoDoDriver(limpa);
    if (!Number.isInteger(alvo.port) || alvo.port < 1 || alvo.port > 65535) throw new Error('Alvo com porta fora de 1..65535.');
    if ((lido.host ?? '').toLowerCase() !== alvo.host || Number(lido.port) !== alvo.port || lido.database !== alvo.database)
        throw new Error('URL do alvo diverge do alvo validado (host, porta ou banco).');
    if (!lido.user) throw new Error('URL do alvo sem usuário.');
    return { host: alvo.host, port: alvo.port, database: alvo.database, user: lido.user, password: lido.password ?? undefined, ssl };
}

/** Saída 2 quando o relatório pede atenção humana; 1 sem a 087. */
function codigoDeSaida(relatorio, exigeAtencao) {
    if (!relatorio.instalado) return 1;
    return exigeAtencao(relatorio) ? 2 : 0;
}

async function main() {
    const cfg = configuracaoExecucao(process.env, process.argv.slice(2));
    if (cfg.aguardando) { console.log(JSON.stringify({ modo: cfg.modo, conectou: false })); return; }
    const { aplicar, alvo } = cfg;
    const { executarAvisos, exigeAtencao } = await import('../lib/assinatura/avisos-envio.ts');
    const { repositorioAvisos } = await import('../lib/assinatura/avisos-repositorio.ts');
    const { prazosDeAcesso } = await import('../lib/assinatura/configuracao.ts');
    const { criarEnviarEmail, situacaoEmail, origemPublica } = await import('../lib/acessos/email.ts');
    if (aplicar && !situacaoEmail(process.env).configurado) throw new Error('E-mail do ambiente não configurado.');
    const { Pool } = require('pg');
    const pool = new Pool({ ...parametrosDeConexao(alvo, process.env), max: 2, connectionTimeoutMillis: 10000, application_name: 'kidmais-assinatura-avisos' });
    pool.on('error', () => undefined);
    const transacao = async (f) => {
        const tx = await pool.connect();
        try {
            await tx.query(aplicar ? 'BEGIN' : 'BEGIN READ ONLY');
            await tx.query("SET LOCAL statement_timeout = '30s'");
            await tx.query("SET LOCAL lock_timeout = '5s'");
            const r = await f(tx); await tx.query('COMMIT'); return r;
        } catch (e) { await tx.query('ROLLBACK'); throw e; }
        finally { tx.release(); }
    };
    try {
        const id = (await pool.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database) throw new Error('Banco conectado diverge do alvo confirmado.');
        if (!alvo.local && id.tls !== true) throw new Error('Conexão remota sem TLS recusada.');
        const deps = { repositorio: repositorioAvisos(transacao), prazos: prazosDeAcesso(process.env), origem: origemPublica(), simular: !aplicar,
            enviar: aplicar ? criarEnviarEmail(process.env) : async () => { throw new Error('Envio proibido na simulação.'); } };
        const relatorio = await executarAvisos(deps);
        console.log(JSON.stringify({ modo: cfg.modo, banco: alvo.database, ...relatorio }, null, 2));
        if (!relatorio.instalado) console.error('Banco sem a 087 (assinatura_avisos): nada a fazer.');
        process.exitCode = codigoDeSaida(relatorio, exigeAtencao);
    } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { console.error('Avisos da assinatura interrompidos. Verifique configuração, autorização e alvo; nenhum dado sensível é registrado.'); process.exitCode = 1; });
module.exports = { configuracaoExecucao, codigoDeSaida, recusarParametrosDeDestino, parametrosDeConexao, STAGING, SCHEMA_EXIGIDO, PARAMETROS_TLS };
