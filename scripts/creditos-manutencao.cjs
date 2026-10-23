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
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');

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
            console.error('[creditos-manutencao] empresa adiada', error instanceof Error ? error.name : typeof error);
        }
    }
    return relatorio;
}

async function main() {
    const { aplicar, enviar, autorizacao } = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    if (alvo.producao && aplicar && !autorizacao) throw new Error('Produção: escrita só com --autorizacao "<registro da autorização de Felipe>".');
    const ledger = await import('../lib/creditos/ledger.ts');
    const man = await import('../lib/creditos/manutencao.ts');
    const { Client } = require('pg');
    const client = new Client({ ...opcoesConexao(alvo, process.env), connectionTimeoutMillis: 10_000, application_name: 'kidmais-creditos-manutencao' });
    client.on('error', () => undefined);
    await client.connect();
    try {
        if ((await client.query('SELECT current_database() AS db')).rows[0].db !== alvo.database) throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        if (!await ledger.creditosInstalados(client)) { console.log(JSON.stringify({ instalado: false })); return; }
        const relatorio = await executar({ client, aplicar, manutencao: man.manutencaoEmpresa, empresasComCarteira: man.empresasComCarteira });
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
                    console.error('[creditos-manutencao] pedido adiado', error instanceof Error ? error.name : typeof error);
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
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Manutenção recusada/interrompida: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { argumentos, executar };
