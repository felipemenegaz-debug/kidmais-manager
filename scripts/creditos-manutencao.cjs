/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Manutenção diária dos créditos de IA (090): expiração dos lotes vencidos, franquia mensal de Convites das empresas
 * CORTADAS (o mesmo limite legado configurado; nenhuma franquia proposta), avisos de vencimento (outbox) e, opcionalmente,
 * o envio dos e-mails pendentes. Idempotente por chave (lote, mês, marco). Nunca roda no startup nem no deploy.
 *
 *   node scripts/creditos-manutencao.cjs                               simulação (padrão): cada empresa em BEGIN … ROLLBACK
 *   node scripts/creditos-manutencao.cjs --aplicar                     grava (COMMIT por empresa)
 *   node scripts/creditos-manutencao.cjs --aplicar --enviar-emails     também drena o outbox (EMAIL_PROVIDER do ambiente)
 *   Saída: 0 sem falhas; 2 empresa com falha; 1 configuração inválida/interrupção.
 *
 * Alvo SEMPRE explícito, com as MESMAS regras da reconciliação (scripts/assinatura-reconciliar.cjs → validarAlvo): nunca
 * DATABASE_URL nem .env.local, banco kidmais_manager recusado, KIDMAIS_RECONCILIAR_ALVO literal. Produção: só simulação
 * (`--aplicar` recusado; escrita em produção exige pacote e autorização próprios). Staging também exige autorização.
 * Não chama o Asaas (pagamentos ficam com o webhook e a reconciliação).
 */
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');

function argumentos(argv) {
    const conhecidos = new Set(['--aplicar', '--enviar-emails']);
    const extras = argv.filter((a) => !conhecidos.has(a));
    if (extras.length) throw new Error(`Argumento desconhecido: ${extras[0]}`);
    const aplicar = argv.includes('--aplicar'), enviar = argv.includes('--enviar-emails');
    if (enviar && !aplicar) throw new Error('--enviar-emails exige --aplicar.');
    return { aplicar, enviar };
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
    const { aplicar, enviar } = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    if (alvo.producao && aplicar) throw new Error('Produção aceita só simulação nesta versão: escrita exige pacote e autorização próprios.');
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
