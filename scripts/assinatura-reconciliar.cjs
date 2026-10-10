/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Reconciliação da cobrança (E8, Asaas SANDBOX): reprocessa eventos PENDENTE/FALHOU e ressincroniza todas as empresas
 * com assinatura vinculada ao provedor, aplicando o estado ATUAL do provedor (mesmas funções do webhook).
 *
 *   node scripts/assinatura-reconciliar.cjs            simulação (padrão): cada item roda em BEGIN … ROLLBACK
 *   node scripts/assinatura-reconciliar.cjs --aplicar  grava (COMMIT por item)
 *   Saída: 0 ciclo sem falhas; 2 itens falhos/recusados; 1 configuração inválida/interrupção.
 *
 * Alvo SEMPRE explícito (nunca DATABASE_URL, nunca .env.local):
 *   KIDMAIS_RECONCILIAR_DATABASE_URL  conexão do banco alvo (não é impressa)
 *   KIDMAIS_RECONCILIAR_ALVO          confirmação literal "<banco>@<host>:<porta>" — tem de bater com a URL e, depois de
 *                                     conectar, com current_database()
 *   ASAAS_AMBIENTE=sandbox, ASAAS_API_KEY ($aact_hmlg_…), ASAAS_WEBHOOK_TOKEN — mesmas regras do serviço
 * Recusados: banco kidmais_manager (proibido pela política) e bancos de produção (produção do Asaas não está
 * autorizada nesta versão). Executar em staging também exige autorização explícita (docs/OPERACAO_AGENTES.md):
 * --aplicar grava em empresa_assinaturas, cobranca_eventos e auditoria.
 *
 * Cron de staging criado em modo aguardando; habilitação depende das validações operacionais.
 */
const BANCOS_PROIBIDOS = new Set(['kidmais_manager', 'kidmais_production', 'kidmais-production']);

function hostLocal(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** Valida o alvo sem conectar. Lança Error com mensagem sem a URL. */
function validarAlvo(env) {
    if (env.DATABASE_URL && env.KIDMAIS_RECONCILIAR_DATABASE_URL === env.DATABASE_URL)
        throw new Error('Alvo recusado: use uma conexão própria em KIDMAIS_RECONCILIAR_DATABASE_URL, não a DATABASE_URL do serviço.');
    const bruto = env.KIDMAIS_RECONCILIAR_DATABASE_URL;
    if (!bruto)
        throw new Error('Defina KIDMAIS_RECONCILIAR_DATABASE_URL (DATABASE_URL não é usada).');
    let url;
    try {
        url = new URL(bruto);
    }
    catch {
        throw new Error('KIDMAIS_RECONCILIAR_DATABASE_URL inválida.');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
        throw new Error('KIDMAIS_RECONCILIAR_DATABASE_URL inválida.');
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9_-]+$/.test(database))
        throw new Error('Nome de banco inválido.');
    if (BANCOS_PROIBIDOS.has(database.toLowerCase()))
        throw new Error(`Banco ${database} recusado: proibido como alvo desta reconciliação (sandbox).`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port || 5432);
    const esperado = `${database}@${host}:${port}`;
    if (env.KIDMAIS_RECONCILIAR_ALVO !== esperado)
        throw new Error(`Confirme o alvo: defina KIDMAIS_RECONCILIAR_ALVO="${esperado}" (literal).`);
    return { connectionString: bruto, database, host, port, local: hostLocal(host) };
}

/**
 * Na SIMULAÇÃO o banco volta atrás (ROLLBACK), mas uma chamada ao provedor não volta: a remoção de duplicatas (compensação
 * das pendências de contratação) é só contada, nunca executada. Leituras continuam reais para o relatório ser fiel.
 */
function opcoesConexao(alvo, env = {}) {
    const url = new URL(alvo.connectionString);
    const modo = url.searchParams.get('sslmode');
    if (!alvo.local && modo && !['require', 'verify-full', 'verify-ca'].includes(modo)) throw Error('TLS_MODO_RECUSADO');
    for (const chave of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(chave);
    const politica = env.KIDMAIS_RECONCILIAR_TLS ?? 'verificado';
    if (!['verificado', 'render-interno-criptografado'].includes(politica)) throw Error('TLS_POLITICA_RECUSADA');
    if (politica === 'render-interno-criptografado') {
        // Opt-in operacional: Render não fornece verify-full para seu Postgres interno.
        // Limitado ao cron e banco exatos, dentro da rede privada. Nenhuma configuração global.
        const confirmado = validarAlvo(env);
        if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== 'crn-db493i142hec73ahmoe0'
            || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox'
            || confirmado.host !== 'dpg-daidko3m8hqs73ce4jt0-a' || confirmado.port !== 5432
            || confirmado.database !== 'kidmais_staging_1z91' || alvo.connectionString !== confirmado.connectionString) {
            throw Error('TLS_REDE_PRIVADA_RECUSADA');
        }
        return {connectionString: url.toString(), ssl: {rejectUnauthorized: false, minVersion: 'TLSv1.2'}};
    }
    const ca = env.KIDMAIS_RECONCILIAR_CA_PEM;
    return {connectionString: url.toString(), ssl: alvo.local ? false : {rejectUnauthorized: true, ...(ca ? {ca} : {})}};
}

function provedorDaExecucao(provedor, aplicar, relatorio) {
    if (aplicar)
        return provedor;
    return {
        ...provedor,
        removerAssinatura: async () => {
            relatorio.removeriaNoProvedor = (relatorio.removeriaNoProvedor ?? 0) + 1;
            return { removida: false };
        },
        atualizarValorAssinatura: async () => { throw new Error('Mutação proibida na simulação.'); },
        atualizarValorCobranca: async () => { throw new Error('Mutação proibida na simulação.'); },
        suspenderGeracao: async () => { throw new Error('Mutação proibida na simulação.'); },
    };
}

/**
 * Transação independente para o marcador de exclusão (COMMIT próprio, ANTES do DELETE).
 * Aplicando: uma conexão NOVA por transação (`abrirMarcador`, mesmo alvo conferido), com prazo do lado da aplicação
 * (`comPrazo`, lib/db/transacao-com-prazo.ts): vencido → a conexão é destruída e o resultado é desconhecido; a próxima
 * transação abre outra conexão. Simulação: SAVEPOINT da transação principal, que é desfeita no fim (nada persiste; a
 * simulação nunca chama o DELETE de verdade), sem prazo próprio (vale o statement_timeout da sessão).
 */
function transacaoIndependenteDaExecucao(aplicar, principal, abrirMarcador, comPrazo, prazoMs) {
    if (!aplicar)
        return async (trabalho) => {
            await principal.query('SAVEPOINT kidmais_simulacao_marcador');
            try {
                const r = await trabalho(principal);
                await principal.query('RELEASE SAVEPOINT kidmais_simulacao_marcador');
                return r;
            }
            catch (error) {
                await principal.query('ROLLBACK TO SAVEPOINT kidmais_simulacao_marcador');
                throw error;
            }
        };
    if (typeof abrirMarcador !== 'function' || typeof comPrazo !== 'function' || !(prazoMs > 0))
        throw new Error('Aplicar exige a conexão do marcador de exclusão com prazo.');
    return comPrazo(abrirMarcador, prazoMs);
}

/**
 * Conexão nova para UMA transação do marcador: confere o alvo antes de qualquer escrita; liberar/descartar a encerram
 * (descartar destrói o soquete). O adaptador é REGISTRADO no prazo antes de conectar e de conferir o banco: se a conexão
 * ou o `SELECT current_database()` nunca responderem, o prazo destrói o soquete (não fica conexão aberta para trás).
 */
async function abrirConexaoDoMarcador(Client, alvo, conexaoDeClientePg, registrar = () => undefined, env = {}) {
    const c = new Client({
        ...opcoesConexao(alvo, env),
        connectionTimeoutMillis: 10_000, application_name: 'kidmais-assinatura-reconciliar-marcador',
    });
    c.on('error', () => undefined);
    const conexao = conexaoDeClientePg(c, { liberar: () => { c.end().catch(() => undefined); }, descartar: () => { c.end().catch(() => undefined); } });
    registrar(conexao);
    try {
        await c.connect();
        const id = (await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true))
            throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
    }
    catch (error) {
        conexao.descartar(error);
        throw error;
    }
    return conexao;
}

function argumentos(argv) {
    const extras = argv.filter((a) => a !== '--aplicar');
    if (extras.length)
        throw new Error(`Argumento desconhecido: ${extras[0]}`);
    return { aplicar: argv.includes('--aplicar') };
}

/**
 * Ciclo compartilhado pelo CLI e pela homologacao, com transacao por item. `transacaoIndependente`: marcador de exclusão
 * (conexão própria com prazo ao aplicar; SAVEPOINT na simulação). Sem ela, nenhuma exclusão no provedor acontece.
 */
async function executarCiclo({ client, provedor, aplicar, banco, sinc, transacaoIndependente }) {
    const modo = aplicar ? 'APLICAR' : 'SIMULACAO';
    const item = async (trabalho) => {
        await client.query('BEGIN');
        try {
            const r = await trabalho();
            await client.query(aplicar ? 'COMMIT' : 'ROLLBACK');
            return r;
        }
        catch (error) {
            await client.query('ROLLBACK');
            return { erro: error instanceof Error ? error.name : 'Erro' };
        }
    };
    const relatorio = { modo, banco, eventos: {}, empresas: {} };
    const provedorUsado = provedorDaExecucao(provedor, aplicar, relatorio);
    const conta = (grupo, chave) => { grupo[chave] = (grupo[chave] ?? 0) + 1; };
    for (const eventoId of await sinc.eventosPendentes(client, 500)) {
        const r = await item(() => sinc.processarEvento(client, eventoId, { provedor: provedorUsado, transacaoIndependente }));
        conta(relatorio.eventos, r.erro ? `ERRO_${r.erro}` : r.situacao);
    }
    for (const empresaId of await sinc.empresasComProvedor(client)) {
        const r = await item(() => sinc.sincronizarEmpresa(client, empresaId, { provedor: provedorUsado }, { tipo: 'RECONCILIACAO' }));
        const chave = r.erro ? `ERRO_${r.erro}` : r.resultado === 'SINCRONIZADA' ? (r.mudou ? `MUDOU_${r.antes}_PARA_${r.depois}` : 'SEM_MUDANCA') : r.resultado;
        conta(relatorio.empresas, chave);
    }

    relatorio.incompleto = Object.entries(relatorio.eventos).some(([k, n]) => n > 0 && (k === 'FALHOU' || k.startsWith('ERRO_')))
        || Object.entries(relatorio.empresas).some(([k, n]) => n > 0 && (k === 'RECUSADA' || k.startsWith('ERRO_')));
    return relatorio;
}

async function main() {
    const { aplicar } = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    const asaas = await import('../lib/assinatura/asaas.ts');
    const sinc = await import('../lib/assinatura/sincronizacao.ts');
    const estado = asaas.configuracaoAsaas(process.env);
    if (!estado.ligado)
        throw new Error(asaas.explicarDesligado(estado.motivo));
    const provedor = asaas.criarClienteAsaas(estado.config);
    const { Client } = require('pg');
    const client = new Client({
        ...opcoesConexao(alvo, process.env),
        connectionTimeoutMillis: 10_000, application_name: 'kidmais-assinatura-reconciliar',
    });
    client.on('error', () => undefined);
    await client.connect();
    // Aplicando: o marcador de exclusão usa uma conexão nova por transação, com prazo do lado da aplicação.
    const { transacaoComPrazo, conexaoDeClientePg } = await import('../lib/db/transacao-com-prazo.ts');
    const { PRAZO_TRANSACAO_INDEPENDENTE_MS } = await import('../lib/assinatura/reconciliacao-contratacao.ts');
    const abrirMarcador = (registrar) => abrirConexaoDoMarcador(Client, alvo, conexaoDeClientePg, registrar, process.env);
    try {
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true))
            throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if (!(await client.query("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0].ok)
            throw new Error('Banco sem a 068 (cobranca_eventos): nada a reconciliar.');
        const transacaoIndependente = transacaoIndependenteDaExecucao(aplicar, client, abrirMarcador, transacaoComPrazo, PRAZO_TRANSACAO_INDEPENDENTE_MS);
        const relatorio = await executarCiclo({ client, provedor, aplicar, banco: alvo.database, sinc, transacaoIndependente });
        if (relatorio.incompleto) process.exitCode = 2;
        console.log(JSON.stringify(relatorio, null, 2));
        if (!aplicar)
            console.log('Simulação: nada foi gravado. Use --aplicar (com autorização para o alvo) para gravar.');
    }
    finally {
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Reconciliação recusada/interrompida: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { validarAlvo, argumentos, provedorDaExecucao, executarCiclo, opcoesConexao, transacaoIndependenteDaExecucao, abrirConexaoDoMarcador, BANCOS_PROIBIDOS };
