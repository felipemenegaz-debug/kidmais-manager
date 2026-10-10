/* eslint-disable @typescript-eslint/no-require-imports */
/** Execução explícita, SANDBOX. Sem .env.local/DATABASE_URL. Padrão: simulação, transações READ ONLY.
 * --aplicar requer autorização para o alvo e EMAIL_PROVIDER=arquivo (nenhum e-mail real nesta entrega).
 * Não agenda nada no Render. Ver docs/RENOVACAO_FUNDADOR_20261009.md.
 */
const { validarAlvo, argumentos } = require('./assinatura-reconciliar.cjs');

function configuracaoExecucao(env, argv) {
    const { aplicar } = argumentos(argv);
    const alvo = validarAlvo(env);
    if (env.ASAAS_AMBIENTE !== 'sandbox') throw new Error('Renovação aceita somente sandbox.');
    if (aplicar && (env.EMAIL_PROVIDER !== 'arquivo' || !alvo.local))
        throw new Error('Aplicação desta entrega exige banco local isolado e e-mail em arquivo.');
    return { aplicar, alvo };
}

async function main() {
    const { aplicar, alvo } = configuracaoExecucao(process.env, process.argv.slice(2));
    const { criarClienteAsaas, configuracaoAsaas } = await import('../lib/assinatura/asaas.ts');
    const { processarRenovacao } = await import('../lib/assinatura/renovacao-fundador.ts');
    const { repositorioRenovacao, empresasParaRenovacao } = await import('../lib/assinatura/renovacao-repositorio.ts');
    const { criarEnviarEmail, situacaoEmail, origemPublica } = await import('../lib/acessos/email.ts');
    const { travaPorEmpresa } = await import('../lib/assinatura/cobranca.ts');
    const config = configuracaoAsaas(process.env);
    if (!config.ligado) throw new Error('Asaas sandbox não configurado.');
    if (aplicar && !situacaoEmail(process.env).configurado) throw new Error('E-mail em arquivo não configurado.');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: alvo.connectionString, max: 3, ssl: alvo.local ? false : { rejectUnauthorized: true },
        connectionTimeoutMillis: 10000, application_name: 'kidmais-renovacao-fundador' });
    pool.on('error', () => undefined);
    const transacao = async f => {
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
        const db = await pool.query('SELECT current_database() AS db');
        if (db.rows[0].db !== alvo.database) throw new Error('Banco conectado diverge do alvo confirmado.');
        const provedor = criarClienteAsaas(config.config);
        const deps = { repositorio: repositorioRenovacao(transacao), provedor,
            enviar: aplicar ? criarEnviarEmail(process.env) : async () => { throw new Error('Envio proibido na simulação.'); },
            origem: origemPublica(), agora: () => new Date(), simular: !aplicar, travar: travaPorEmpresa(transacao) };
        const resultados = {};
        for (const empresaId of await transacao(empresasParaRenovacao)) {
            let resultado;
            try { resultado = await processarRenovacao(empresaId, deps); }
            catch { resultado = 'ERRO_REPROCESSAVEL'; }
            resultados[resultado] = (resultados[resultado] ?? 0) + 1;
        }
        console.log(JSON.stringify({ modo: aplicar ? 'APLICAR_SANDBOX_EMAIL_ARQUIVO' : 'SIMULACAO_SEM_ESCRITA', resultados }, null, 2));
        if (Object.keys(resultados).some(x => /ERRO|DIVERGENTE|INCERTO|PERDIDA|ALTERADO|INVALIDO|REVISAO|PROCESSADA|PRAZO/.test(x))) process.exitCode = 2;
    } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { console.error('Renovação interrompida. Verifique configuração, autorização e alvo; nenhum dado sensível é registrado.'); process.exitCode = 1; });
module.exports = { configuracaoExecucao };
