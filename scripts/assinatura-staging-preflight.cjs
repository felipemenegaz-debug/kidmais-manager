// Diagnóstico remoto somente leitura, sem importar pg, acessar banco ou imprimir secrets/respostas.
// Referência reservada à retomada; a primeira rodada não chegou ao checkout.
const REFERENCIA = 'e4b274ca-3a51-40c5-bef6-39012a96cfbc';
const REFERENCIA_QUARTA = '531f9c46-6026-4bfe-86aa-babce78b0cfd';
const REFERENCIA_QUINTA = 'cbfbdb83-09d8-46d9-a1d4-9aeb6dc2b9dd';
const SERVICOS = new Set(['crn-db493i142hec73ahmoe0', 'srv-daif418ae00c73e8k2gg']);
async function verificar(env, requisitar = fetch, referencia = REFERENCIA) {
    if (![REFERENCIA, REFERENCIA_QUARTA, REFERENCIA_QUINTA].includes(referencia)) throw Error('REFERENCIA_RECUSADA');
    if (env.RENDER !== 'true' || !SERVICOS.has(env.RENDER_SERVICE_ID)
        || env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.ASAAS_AMBIENTE !== 'sandbox') throw Error('ALVO_RECUSADO');
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(env);
    if (!cfg.ligado) throw Error('CONFIGURACAO_RECUSADA');
    const cliente = criarClienteAsaas(cfg.config, {fetch: (url, init) => {
        const u = new URL(url);
        if (u.origin !== 'https://api-sandbox.asaas.com' || u.pathname !== '/v3/customers'
            || u.searchParams.get('externalReference') !== referencia || init.method !== 'GET') throw Error('OPERACAO_RECUSADA');
        return requisitar(url, {...init, redirect: 'error'});
    }});
    const encontrado = await cliente.buscarClientePorReferencia(referencia);
    return {asaas: 'AUTENTICACAO_APROVADA', ambiente: 'sandbox', servico: env.RENDER_SERVICE_ID,
        clienteReferenciaEncontrado: encontrado !== null, bancoAcessado: false, cobrancasCriadas: 0};
}
function referenciaArgumentos(args) {
    if(args.length===0)return REFERENCIA;
    if(args.length!==1)throw Error('RODADA_AMBIGUA');
    if(args[0]==='--rodada-4')return REFERENCIA_QUARTA;
    if(args[0]==='--rodada-5')return REFERENCIA_QUINTA;
    throw Error('RODADA_RECUSADA');
}
if (require.main === module) Promise.resolve().then(()=>verificar(process.env,fetch,referenciaArgumentos(process.argv.slice(2)))).then(r => console.log(JSON.stringify(r))).catch(e => {
    console.error(JSON.stringify({asaas:'DIAGNOSTICO_RECUSADO', http:Number.isInteger(e.status) ? e.status : null}));
    process.exitCode = 1;
});
module.exports = {verificar, REFERENCIA, REFERENCIA_QUARTA, REFERENCIA_QUINTA, referenciaArgumentos};
