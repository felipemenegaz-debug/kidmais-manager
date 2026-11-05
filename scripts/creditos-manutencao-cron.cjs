/* eslint-disable @typescript-eslint/no-require-imports */
// Entrada do cron diário da manutenção de créditos de IA em STAGING (kidmais-creditos-manutencao-staging). Nenhuma conexão
// enquanto a execução não for habilitada: KIDMAIS_MANUTENCAO_MODO = aguardando (padrão do serviço) | simular | aplicar.
//   - aguardando: imprime AGUARDANDO_HABILITACAO e sai com 0, sem ler o alvo nem conectar;
//   - simular: scripts/creditos-manutencao.cjs sem --aplicar (cada empresa em BEGIN … ROLLBACK);
//   - aplicar: com --aplicar (COMMIT por empresa). Mudar para aplicar é a autorização operacional de Felipe para staging.
// Só staging (production recusada aqui: outra entrada, com --autorizacao, nunca este cron). Alvo literal de staging e Asaas
// sandbox, como o cron da reconciliação. Nunca --enviar-emails: o outbox de e-mails fica fora deste cron.
const { spawnSync } = require('node:child_process');
const { validarAlvo } = require('./assinatura-reconciliar.cjs');
const { recusarParametrosDeDestino } = require('./assinatura-avisos.cjs');
const { falhaSegura } = require('./creditos-manutencao.cjs');

const STAGING = Object.freeze({ database: 'kidmais_staging_1z91', host: 'dpg-daidko3m8hqs73ce4jt0-a', port: 5432 });
const PRAZO_MS = 10 * 60 * 1000;
/** Recusas deste wrapper (código fechado). As demais viram motivo de lista fechada via falhaSegura, nunca texto. */
const RECUSAS_PROPRIAS = new Set(['AMBIENTE_RECUSADO', 'MODO_INVALIDO', 'ALVO_STAGING_RECUSADO', 'PROVEDOR_RECUSADO']);

function planejar(env) {
    if (env.KIDMAIS_DEPLOY_ENV !== 'staging') throw Error('AMBIENTE_RECUSADO');
    const modo = env.KIDMAIS_MANUTENCAO_MODO;
    if (modo === 'aguardando') return null;
    if (!['simular', 'aplicar'].includes(modo)) throw Error('MODO_INVALIDO');
    const alvo = validarAlvo(env);
    // P2-1 (Astra r1): host/port/dbname/options… na query string substituiriam o destino validado. A manutenção confere de
    // novo, no parser do driver, antes de conectar (conexaoDaManutencao).
    recusarParametrosDeDestino(alvo.connectionString);
    if (alvo.database !== STAGING.database || alvo.host !== STAGING.host || alvo.port !== STAGING.port)
        throw Error('ALVO_STAGING_RECUSADO');
    if (env.ASAAS_AMBIENTE !== 'sandbox') throw Error('PROVEDOR_RECUSADO');
    return modo === 'aplicar' ? ['--aplicar'] : [];
}

if (require.main === module) {
    try {
        const args = planejar(process.env);
        if (args === null) console.log(JSON.stringify({ estado: 'AGUARDANDO_HABILITACAO', conectou: false }));
        else {
            const filho = spawnSync(process.execPath, ['--experimental-strip-types', require.resolve('./creditos-manutencao.cjs'), ...args],
                { env: process.env, stdio: 'inherit', timeout: PRAZO_MS, killSignal: 'SIGTERM' });
            if (filho.error || filho.signal) { console.error('Manutenção interrompida ou excedeu 10 minutos.'); process.exitCode = 1; }
            else process.exitCode = filho.status ?? 1;
        }
    } catch (error) {
        const motivo = error instanceof Error && RECUSAS_PROPRIAS.has(error.message) ? error.message : (falhaSegura(error, 'configuracao').motivo ?? 'DESCONHECIDO');
        console.error(`Cron recusado (${motivo}): conferir ambiente, modo e alvo.`);
        process.exitCode = 1;
    }
}

module.exports = { planejar };
