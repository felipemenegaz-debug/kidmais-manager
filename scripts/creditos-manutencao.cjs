/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Manutenção diária dos créditos de IA (095): expiração dos lotes vencidos, franquia mensal de Convites das empresas
 * CORTADAS (o mesmo limite legado configurado; nenhuma franquia proposta), avisos de vencimento (outbox) e, opcionalmente,
 * o envio dos e-mails pendentes. Idempotente por chave (lote, mês, marco). Nunca roda no startup nem no deploy.
 *
 *   node scripts/creditos-manutencao.cjs                               simulação (padrão): cada empresa em BEGIN … ROLLBACK
 *   node scripts/creditos-manutencao.cjs --aplicar                     grava (COMMIT por empresa)
 *   node scripts/creditos-manutencao.cjs --aplicar --enviar-emails     também drena o outbox (EMAIL_PROVIDER do ambiente)
 *   ... --aplicar --autorizacao "<registro>"                         obrigatório em PRODUÇÃO (P2-3): escrita só com o registro
 *                                                                     da autorização de Felipe, gravado no relatório
 * Com o Asaas configurado no ambiente, também revisita os pedidos abertos/em revisão/estorno pelo MESMO serviço do webhook
 * (lib/creditos/pagamento.ts): repara o evento que falhou depois do 200 (P2-3).
 *   Saída: 0 sem falhas; 2 empresa com falha; 1 configuração inválida/interrupção.
 *
 * Alvo SEMPRE explícito, com as MESMAS regras da reconciliação (scripts/assinatura-reconciliar.cjs → validarAlvo): nunca
 * DATABASE_URL nem .env.local, banco kidmais_manager recusado, KIDMAIS_RECONCILIAR_ALVO literal. Produção: `--aplicar` só
 * com `--autorizacao "<registro>"` (sem ele, recusado). Staging também exige autorização (operacional, não técnica).
 * Não chama o Asaas (pagamentos ficam com o webhook e a reconciliação).
 */
const { validarAlvo, opcoesConexao, SERVICOS_TLS_RECONCILIACAO } = require('./assinatura-reconciliar.cjs');
// Mesmas proteções já revisadas no job dos avisos (Astra, 03/11/2026): parâmetros de destino na URL e falha sem texto.
const { recusarParametrosDeDestino, descreverFalha } = require('./assinatura-avisos.cjs');
const { parse: parseConexaoDoDriver } = require('pg-connection-string');

/**
 * Lista FECHADA da exceção TLS `render-interno-criptografado` para a manutenção (04/11/2026, Felipe: "Cron novo + PR"), nas
 * mesmas condições da reconciliação (Render, staging, sandbox, alvo literal de staging):
 *   - cron da reconciliação de staging (já estava: o Shell dele roda a manutenção à mão);
 *   - cron da manutenção de staging (`kidmais-creditos-manutencao-staging`, criado em aguardando em 04/11/2026).
 * O web não entra. Production não usa esta exceção (TLS de production em opcoesConexao).
 */
const CRON_MANUTENCAO_STAGING = 'crn-dblpgn3m8hqs739r366g'; // kidmais-creditos-manutencao-staging, criado em aguardando em 04/11/2026
const SERVICOS_TLS_MANUTENCAO = Object.freeze([...SERVICOS_TLS_RECONCILIACAO, CRON_MANUTENCAO_STAGING]);

/**
 * P2-1 (Astra, cron da manutenção r1, 04/11/2026): validarAlvo confere host/porta/banco da URL, mas o driver pg deixa a query
 * string (host, port, hostaddr, dbname, user, options…) substituir o destino. Recusa qualquer parâmetro fora dos de TLS,
 * confere o que o PARSER DO DRIVER lê na URL final contra o alvo validado e entrega ao Client só campos explícitos.
 */
function conexaoDaManutencao(alvo, env) {
    recusarParametrosDeDestino(alvo.connectionString);
    const { connectionString: limpa, ssl } = opcoesConexao(alvo, env, SERVICOS_TLS_MANUTENCAO);
    let lido;
    try { lido = parseConexaoDoDriver(limpa); } catch { throw new Error('URL do alvo ilegível.'); }
    if ((lido.host ?? '').toLowerCase() !== alvo.host || Number(lido.port) !== alvo.port || lido.database !== alvo.database)
        throw new Error('URL do alvo diverge do alvo validado (host, porta ou banco).');
    if (!lido.user) throw new Error('URL do alvo sem usuário.');
    return { host: alvo.host, port: alvo.port, database: alvo.database, user: lido.user, password: lido.password ?? undefined, ssl };
}

/** Mensagens próprias desta manutenção → código fechado (as da reconciliação/avisos já vêm de descreverFalha). */
const MOTIVOS_MANUTENCAO = Object.freeze([
    ['PRODUCAO_EXIGE_AUTORIZACAO', /^Produção: escrita só com --autorizacao /],
    ['ENVIAR_EXIGE_APLICAR', /^--enviar-emails exige --aplicar.$/],
    ['AUTORIZACAO_INVALIDA', /^--autorizacao exige --aplicar /],
    ['BANCO_CONECTADO_DIVERGE', /^Alvo recusado: o banco conectado não é o confirmado.$/],
]);

/**
 * P2-2 (Astra, cron da manutenção r1): a saída nunca leva o texto do erro (DNS revela host; autenticação, usuário). Só etapa,
 * tipo e código de listas fechadas/formatos restritos, como no job dos avisos.
 */
function falhaSegura(error, etapa) {
    const falha = descreverFalha(error, etapa);
    if (falha.motivo === null && error instanceof Error) {
        const achado = MOTIVOS_MANUTENCAO.find(([, padrao]) => padrao.test(error.message));
        if (achado) falha.motivo = achado[0];
    }
    return falha;
}

function argumentos(argv) {
    let aplicar = false, enviar = false, autorizacao = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--aplicar') aplicar = true;
        else if (argv[i] === '--enviar-emails') enviar = true;
        else if (argv[i] === '--autorizacao') autorizacao = argv[++i] ?? '';
        else throw new Error(`Argumento desconhecido: ${argv[i]}`);
    }
    if (enviar && !aplicar) throw new Error('--enviar-emails exige --aplicar.');
    if (autorizacao !== null && (!aplicar || !/^[A-Za-z0-9:._/ -]{6,120}$/.test(autorizacao))) throw new Error('--autorizacao exige --aplicar e um registro seguro (6–120 caracteres).');
    return { aplicar, enviar, autorizacao };
}

async function executar({ client, aplicar, manutencao, empresasComCarteira }) {
    const relatorio = { modo: aplicar ? 'APLICAR' : 'SIMULACAO', empresas: 0, falhas: 0, expirados: 0, franquias: 0, avisos: 0 };
    for (const empresaId of await empresasComCarteira(client)) {
        relatorio.empresas += 1;
        await client.query('BEGIN');
        try {
            const r = await manutencao(client, empresaId);
            await client.query(aplicar ? 'COMMIT' : 'ROLLBACK');
            relatorio.expirados += r.expirados.CONVITES + r.expirados.WALLE;
            relatorio.franquias += r.franquia.concedida ? 1 : 0;
            relatorio.avisos += r.avisos;
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            relatorio.falhas += 1;
            console.error('[creditos-manutencao] empresa adiada', JSON.stringify(falhaSegura(error, 'execucao')));
        }
    }
    return relatorio;
}

/** Etapa corrente, para o registro da falha (lista fechada ETAPAS do job dos avisos). */
let etapa = 'configuracao';

async function main() {
    etapa = 'configuracao';
    const { aplicar, enviar, autorizacao } = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    if (alvo.producao && aplicar && !autorizacao) throw new Error('Produção: escrita só com --autorizacao "<registro da autorização de Felipe>".');
    etapa = 'conexao-parametros';
    const parametros = conexaoDaManutencao(alvo, process.env);
    etapa = 'modulos';
    const ledger = await import('../lib/creditos/ledger.ts');
    const man = await import('../lib/creditos/manutencao.ts');
    const { Client } = require('pg');
    const client = new Client({ ...parametros, connectionTimeoutMillis: 10_000, application_name: 'kidmais-creditos-manutencao' });
    client.on('error', () => undefined);
    etapa = 'conexao';
    await client.connect();
    try {
        etapa = 'identidade';
        if ((await client.query('SELECT current_database() AS db')).rows[0].db !== alvo.database) throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        etapa = 'execucao';
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if (!await ledger.creditosInstalados(client)) { console.log(JSON.stringify({ instalado: false })); return; }
        // Franquias por plano (116): pendências da sincronização primeiro, cada uma na própria transação (simulação = ROLLBACK).
        const { flagsCreditos } = await import('../lib/creditos/config.ts');
        let pendencias = null;
        if (flagsCreditos(process.env).franquiaPlano) {
            const { processarPendenciasFranquia } = await import('../lib/creditos/franquias.ts');
            const tx = async (w) => { await client.query('BEGIN'); try { const r = await w(client); await client.query(aplicar ? 'COMMIT' : 'ROLLBACK'); return r; } catch (e) { await client.query('ROLLBACK'); throw e; } };
            pendencias = await processarPendenciasFranquia(tx, 200);
        }
        const relatorio = await executar({ client, aplicar, manutencao: man.manutencaoEmpresa, empresasComCarteira: man.empresasComCarteira });
        if (pendencias) { relatorio.pendenciasFranquia = pendencias; relatorio.falhas += pendencias.falhas; }
        if (autorizacao) relatorio.autorizacao = autorizacao;
        // P2-3: pedidos pelo mesmo serviço do webhook (só leitura no Asaas), uma transação por pedido.
        const asaas = await import('../lib/assinatura/asaas.ts');
        const estado = asaas.configuracaoAsaas(process.env);
        if (estado.ligado) {
            const pagamento = await import('../lib/creditos/pagamento.ts');
            const { contaProvedor, contaValida } = await import('../lib/creditos/config.ts');
            relatorio.pedidos = {};
            // R4-P2-2: conta inválida pula só os pedidos (franquia/expiração acima já rodaram); R4-P2-1: seleção justa.
            const ctx = contaValida(process.env) ? { provedor: asaas.criarClienteAsaas(estado.config), ambiente: estado.config.ambiente, conta: contaProvedor(process.env) } : null;
            const selecao = ctx ? await pagamento.selecionarParaReconciliar(client, 200, estado.config.ambiente) : { ids: [], truncado: false };
            if (!ctx) { relatorio.pedidos.CONFIG_CONTA_INVALIDA = 1; relatorio.falhas += 1; }
            if (selecao.truncado) relatorio.pedidos.TRUNCADO = 1;
            for (const pedidoId of selecao.ids) {
                // R5-P2-1: marca a tentativa em transação própria (fica mesmo se o processamento falhar).
                await client.query('BEGIN');
                await pagamento.marcarTentativa(client, pedidoId);
                await client.query(aplicar ? 'COMMIT' : 'ROLLBACK');
                await client.query('BEGIN');
                try {
                    const r = await pagamento.processarPedido(client, pedidoId, ctx);
                    await client.query(aplicar ? 'COMMIT' : 'ROLLBACK');
                    relatorio.pedidos[r.resultado] = (relatorio.pedidos[r.resultado] ?? 0) + 1;
                }
                catch (error) {
                    await client.query('ROLLBACK').catch(() => undefined);
                    relatorio.falhas += 1;
                    console.error('[creditos-manutencao] pedido adiado', JSON.stringify(falhaSegura(error, 'execucao')));
                }
            }
        }
        if (enviar) {
            const { drenarNotificacoes } = await import('../lib/creditos/notificacoes.ts');
            const { criarEnviarEmail } = await import('../lib/acessos/email.ts');
            const transacao = async (w) => { await client.query('BEGIN'); try { const r = await w(client); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK'); throw e; } };
            relatorio.emails = await drenarNotificacoes({ withTransaction: transacao, enviarEmail: criarEnviarEmail() }, 100);
        }
        process.exitCode = relatorio.falhas ? 2 : 0;
        console.log(JSON.stringify(relatorio, null, 2));
        if (!aplicar) console.log('Simulação: nada foi gravado. Use --aplicar (com autorização para o alvo) para gravar.');
    }
    finally {
        await client.end().catch(() => undefined);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ estado: 'MANUTENCAO_RECUSADA_OU_INTERROMPIDA', falha: falhaSegura(error, etapa) }));
        process.exitCode = 1;
    });
}

module.exports = { argumentos, executar, conexaoDaManutencao, falhaSegura, SERVICOS_TLS_MANUTENCAO, CRON_MANUTENCAO_STAGING };
