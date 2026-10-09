/** Offline: só informa presença/validação. Não lê .env, não conecta a banco ou provedor. */
async function main() {
    const { configuracaoAsaas }=await import('../lib/assinatura/asaas.ts');
    const { situacaoEmail }=await import('../lib/acessos/email.ts');
    const asaas=configuracaoAsaas(process.env),email=situacaoEmail(process.env);
    const chaveEmail=process.env.RESEND_API_KEY??'';
    const resultado={modo:'DIAGNOSTICO_OFFLINE',asaas:asaas.ligado?'FORMATO_VALIDO_CONEXAO_NAO_TESTADA':asaas.motivo,
        email:email.configurado&&email.provedor==='resend'?'CONFIGURADO_ENTREGA_NAO_TESTADA':'RESEND_NAO_CONFIGURADO',
        formatoChaveResend:{prefixoEsperado:chaveEmail.startsWith('re_'),espacosOuQuebras:/\s/.test(chaveEmail),aspasNasExtremidades:/^["']|["']$/.test(chaveEmail)},
        destinatarioTesteDefinido:Boolean(process.env.KIDMAIS_EMAIL_TESTE),redeExecutada:false};
    console.log(JSON.stringify(resultado,null,2));
    if(!asaas.ligado||!email.configurado||email.provedor!=='resend')process.exitCode=2;
}
main().catch(()=>{console.error('Diagnóstico interrompido; nenhum valor de credencial é registrado.');process.exitCode=1;});
