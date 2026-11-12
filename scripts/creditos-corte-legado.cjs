/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Corte do motor legado dos Convites para os créditos de IA (095), UMA empresa por execução (lib/creditos/corte.ts).
 * Nunca roda no startup nem no deploy. Simulação por padrão; aplicação só com a referência da autorização de dados.
 *
 *   node scripts/creditos-corte-legado.cjs --empresa <uuid>                                         simulação (somente leitura)
 *   node scripts/creditos-corte-legado.cjs --empresa <uuid> --aplicar --autorizacao "<registro>"     corte (uma vez; repetir devolve o mesmo)
 *   Saída: 0 elegível/aplicado/já cortado; 3 recusaria (motivo); 2 falha; 1 configuração inválida.
 *
 * Antes de aplicar: vendas fechadas para a empresa, gerações pendentes reconciliadas (o corte recusa RESERVADA/INCERTA),
 * conferência da simulação e autorização registrada. Depois do corte, a empresa nunca volta ao motor legado por este
 * caminho (o rollback da 095 recusa com dados). Mesmas regras de alvo da reconciliação (validarAlvo). Produção: aplicação
 * com o mesmo `--autorizacao` obrigatório (P2-3: o corte é necessário antes da venda; a autorização é de Felipe, por empresa).
 */
const { validarAlvo, opcoesConexao } = require('./assinatura-reconciliar.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function argumentos(argv) {
    const r = { empresa: null, aplicar: false, autorizacao: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--empresa') r.empresa = argv[++i] ?? null;
        else if (a === '--aplicar') r.aplicar = true;
        else if (a === '--autorizacao') r.autorizacao = argv[++i] ?? null;
        else throw new Error(`Argumento desconhecido: ${a}`);
    }
    if (!r.empresa || !UUID.test(r.empresa)) throw new Error('Informe --empresa <uuid>.');
    if (r.aplicar && !/^[A-Za-z0-9:._/ -]{6,120}$/.test(r.autorizacao ?? '')) throw new Error('--aplicar exige --autorizacao "<registro da autorização>".');
    if (!r.aplicar && r.autorizacao) throw new Error('--autorizacao só vale com --aplicar.');
    return r;
}

async function main() {
    const args = argumentos(process.argv.slice(2));
    const alvo = validarAlvo(process.env);
    const corte = await import('../lib/creditos/corte.ts');
    const { Client } = require('pg');
    const client = new Client({ ...opcoesConexao(alvo, process.env), connectionTimeoutMillis: 10_000, application_name: 'kidmais-creditos-corte' });
    client.on('error', () => undefined);
    await client.connect();
    try {
        if ((await client.query('SELECT current_database() AS db')).rows[0].db !== alvo.database) throw new Error('Alvo recusado: o banco conectado não é o confirmado.');
        await client.query("SET statement_timeout = '60s'");
        await client.query("SET lock_timeout = '5s'");
        await client.query(args.aplicar ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
        try {
            const sim = await corte.simularCorte(client, args.empresa);
            if (!args.aplicar) { await client.query('ROLLBACK'); console.log(JSON.stringify({ modo: 'SIMULACAO', ...sim }, null, 2)); process.exitCode = sim.elegivel || sim.jaCortada ? 0 : 3; return; }
            const r = await corte.aplicarCorte(client, args.empresa, args.autorizacao);
            await client.query('COMMIT');
            console.log(JSON.stringify({ modo: 'APLICADO', simulacao: sim, ...r }, null, 2));
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            console.error(`Corte não aplicado: ${error instanceof Error ? error.message.slice(0, 80) : 'erro'}`);
            process.exitCode = 2;
        }
    }
    finally {
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Corte recusado: ${error instanceof Error ? error.message : 'erro'}`);
        process.exitCode = 1;
    });
}

module.exports = { argumentos };
