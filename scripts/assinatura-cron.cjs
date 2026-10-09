/* eslint-disable @typescript-eslint/no-require-imports */
// Entrada do cron de homologação. Nenhuma conexão enquanto a execução não for explicitamente habilitada.
const { spawnSync } = require('node:child_process');
const { validarAlvo } = require('./assinatura-reconciliar.cjs');
function planejar(env) {
    if (env.KIDMAIS_DEPLOY_ENV !== 'staging') throw Error('AMBIENTE_RECUSADO');
    const modo = env.KIDMAIS_RECONCILIAR_MODO;
    if (modo === 'aguardando') return null;
    if (!['simular','aplicar'].includes(modo)) throw Error('MODO_INVALIDO');
    const alvo = validarAlvo(env);
    if (alvo.database !== 'kidmais_staging_1z91' || alvo.host !== 'dpg-daidko3m8hqs73ce4jt0-a' || alvo.port !== 5432)
        throw Error('ALVO_STAGING_RECUSADO');
    if (env.ASAAS_AMBIENTE !== 'sandbox') throw Error('PROVEDOR_RECUSADO');
    if (env.KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO !== '074-075') throw Error('SCHEMA_NAO_LIBERADO');
    return modo === 'aplicar' ? ['--aplicar'] : [];
}
if (require.main === module) {
    try {
        const args=planejar(process.env);
        if (args === null) console.log(JSON.stringify({estado:'AGUARDANDO_HABILITACAO',conectou:false}));
        else {
            const filho=spawnSync(process.execPath,['--experimental-strip-types',require.resolve('./assinatura-reconciliar.cjs'),...args],{env:process.env,stdio:'inherit',timeout:240000,killSignal:'SIGTERM'});
            if(filho.error || filho.signal) {console.error('Reconciliação interrompida ou excedeu 4 minutos.');process.exitCode=1;}
            else process.exitCode=filho.status ?? 1;
        }
    } catch {console.error('Cron recusado: conferir ambiente, modo, alvo e liberação do schema.');process.exitCode=1;}
}
module.exports={planejar};
