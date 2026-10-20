/* eslint-disable @typescript-eslint/no-require-imports */
// Somente transporte do aviso sintético. Não importa pg, cliente Asaas ou executor de renovação.
const { createHash } = require('node:crypto');
const ORIGEM = 'https://kidmais-manager-staging.onrender.com';
const DESTINO = 'felipemenegaz@gmail.com';
const REMETENTE = 'Kidmais Manager — Teste <onboarding@resend.dev>';

function janela(argv) {
    if (argv.length !== 3 || argv[0] !== '--enviar-teste'
        || !argv[1].startsWith('--inicio=') || !argv[2].startsWith('--fim=')) throw Error('ARGUMENTOS_RECUSADOS');
    const inicio = argv[1].slice(9), fim = argv[2].slice(6);
    for (const data of [inicio,fim])
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(data)
            || !Number.isFinite(Date.parse(data)) || new Date(data).toISOString() !== data) throw Error('JANELA_INVALIDA');
    const duracao = Date.parse(fim) - Date.parse(inicio);
    if (duracao <= 0 || duracao > 4 * 60000) throw Error('JANELA_INVALIDA');
    return { inicio, fim };
}

async function mensagem(inicio) {
    const { mensagemRenovacao } = await import('../lib/assinatura/renovacao-fundador.ts');
    const dia = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(inicio));
    const data = new Date(dia + 'T12:00:00Z'); data.setUTCDate(data.getUTCDate()+30);
    const id = createHash('sha256').update('aviso-email-staging/' + inicio).digest('hex');
    const m = mensagemRenovacao({email:DESTINO,plano:'essencial',ciclo:'MENSAL',valorFinal:11820,valorRegular:19700},id,data.toISOString().slice(0,10),ORIGEM);
    const aviso = 'TESTE com dados sintéticos. Não é uma cobrança ou alteração da assinatura da Kidmais Festas.';
    return {...m,assunto:'[TESTE] '+m.assunto,texto:aviso+'\n\n'+m.texto,html:'<p><strong>'+aviso+'</strong></p>'+m.html};
}

async function executar(env, argv, fetcher = fetch, agora = new Date()) {
    if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== 'crn-db493i142hec73ahmoe0'
        || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox'
        || env.EMAIL_PROVIDER !== 'resend' || env.EMAIL_REMETENTE !== REMETENTE
        || env.ADMIN_AUTH_ORIGIN !== ORIGEM || !env.RESEND_API_KEY) throw Error('CONFIGURACAO_RECUSADA');
    const j = janela(argv);
    if (!Number.isFinite(agora.getTime())) throw Error('RELOGIO_INVALIDO');
    if (agora.getTime() < Date.parse(j.inicio) || agora.getTime() >= Date.parse(j.fim))
        return {resultado:'FORA_JANELA_SEM_ENVIO',requisicoes:0,bancoConsultado:false,cobrancasAlteradas:0};
    const m = await mensagem(j.inicio);
    const { criarEnviarEmail } = await import('../lib/acessos/email.ts');
    let requisicoes = 0;
    const enviar = criarEnviarEmail(env,async (url,init) => {
        if (url !== 'https://api.resend.com/emails' || init?.method !== 'POST') throw Error('REDE_RECUSADA');
        const body = JSON.parse(init.body);
        if (body.to.length !== 1 || body.to[0] !== DESTINO || body.from !== REMETENTE
            || init.headers['Idempotency-Key'] !== m.idempotencia || ++requisicoes > 2) throw Error('DESTINO_RECUSADO');
        // Não registrar body, Authorization ou resposta do provedor. Nenhum redirect de credencial.
        return fetcher(url,{...init,redirect:'error'});
    });
    const primeiro = await enviar(m);
    if (!primeiro.idExterno) throw Error('ENVIO_SEM_IDENTIFICADOR');
    // Replay imediato do MESMO payload/chave, dentro da retenção de 24h do Resend.
    const replay = await enviar(m);
    if (replay.idExterno !== primeiro.idExterno) throw Error('REPLAY_DIVERGENTE');
    return {resultado:'ACEITO_REPLAY_MESMO_ID',requisicoes,bancoConsultado:false,cobrancasAlteradas:0,
        entregaNaCaixa:'AGUARDA_CONFIRMACAO',avisoNaTelaValidado:false,renovacaoRemotaHabilitada:false};
}

if (require.main === module) executar(process.env,process.argv.slice(2)).then(r=>console.log(JSON.stringify(r)))
    .catch(()=>{console.error(JSON.stringify({resultado:'ENVIO_NAO_CONCLUIDO',entregaNaCaixa:'NAO_CONFIRMADA',semRetryAutomatico:true}));process.exitCode=2;});
module.exports = { janela, mensagem, executar };
