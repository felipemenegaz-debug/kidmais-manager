// Alvo dos roteiros de staging (plano D4, H14). Sem a variável, segue o host de sempre. A variável só escolhe entre os
// hosts do serviço de staging: ela não abre o roteiro para outro destino, e as demais guardas de cada roteiro continuam.
// O webhook do provedor não segue a variável: entre as fases ele fica no host antigo, e trocar o painel de host não pode
// criar nem alterar webhook.
const ORIGENS_DO_STAGING = ['https://kidmais-manager-staging.onrender.com', 'https://staging-iafest.demerzellabs.com.br'];

const ORIGEM_WEBHOOK_STAGING = ORIGENS_DO_STAGING[0];

function origemDoStaging(env = process.env) {
    const valor = env.KIDMAIS_STAGING_ORIGEM;
    if (!valor) return ORIGENS_DO_STAGING[0];
    if (!ORIGENS_DO_STAGING.includes(valor)) throw Error('KIDMAIS_STAGING_ORIGEM_RECUSADA');
    return valor;
}

module.exports = { ORIGENS_DO_STAGING, ORIGEM_WEBHOOK_STAGING, origemDoStaging };
