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
 * Tarefa agendada (Render cron) para rodar isto periodicamente é CUSTO NOVO e NÃO foi criada.
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
    for (const chave of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(chave);
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

function argumentos(argv) {
    const extras = argv.filter((a) => a !== '--aplicar');
    if (extras.length)
        throw new Error(`Argumento desconhecido: ${extras[0]}`);
    return { aplicar: argv.includes('--aplicar') };
}

/** Ciclo compartilhado pelo CLI e pela homologacao, com transacao por item. */
async function executarCiclo({ client, provedor, aplicar, banco, sinc }) {
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
        const r = await item(() => sinc.processarEvento(client, eventoId, { provedor: provedorUsado }));
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
    try {
        const id = (await client.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls')).rows[0];
        if (id.db !== alvo.database || (!alvo.local && id.tls !== true))
            throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if (!(await client.query("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0].ok)
            throw new Error('Banco sem a 068 (cobranca_eventos): nada a reconciliar.');
        const relatorio = await executarCiclo({ client, provedor, aplicar, banco: alvo.database, sinc });
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

module.exports = { validarAlvo, argumentos, provedorDaExecucao, executarCiclo, opcoesConexao, BANCOS_PROIBIDOS };
