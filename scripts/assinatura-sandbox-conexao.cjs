/* eslint-disable @typescript-eslint/no-require-imports */
/** Escopo fixo: GET Asaas sandbox por referência aleatória + um email de teste ao destinatário autorizado.
 * Sem banco, criação de cobrança, webhook ou alteração de configuração remota. Nunca imprime segredos/respostas.
 */
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const dir=path.resolve(__dirname,'../.local-assinatura-sandbox');
const arquivo=path.join(dir,'teste-conexao.json');
const destino='felipemenegaz@gmail.com';
async function main(){
    const {configuracaoAsaas,criarClienteAsaas}=await import('../lib/assinatura/asaas.ts');
    const {criarEnviarEmail}=await import('../lib/acessos/email.ts');
    const cfg=configuracaoAsaas(process.env);
    if(!cfg.ligado||process.env.KIDMAIS_EMAIL_TESTE!==destino)throw Error('CONFIGURACAO_RECUSADA');
    fs.mkdirSync(dir,{recursive:true});
    let registro;
    if(fs.existsSync(arquivo))registro=JSON.parse(fs.readFileSync(arquivo,'utf8'));
    else {registro={id:randomUUID(),inicio:new Date().toISOString(),asaas:'NAO_TESTADO',email:'NAO_TESTADO'};fs.writeFileSync(arquivo,JSON.stringify(registro,null,2),{flag:'wx'});}
    const salvar=()=>fs.writeFileSync(arquivo,JSON.stringify(registro,null,2));
    try{
        const cliente=criarClienteAsaas(cfg.config,{fetch:async(url,init)=>{
            if(!url.startsWith('https://api-sandbox.asaas.com/v3/customers?externalReference=')||init.method!=='GET')throw Error('ESCOPO_RECUSADO');
            return fetch(url,{...init,redirect:'error'});
        }});
        await cliente.buscarClientePorReferencia(`kidmais-teste-conexao-${registro.id}`);
        registro.asaas='AUTENTICACAO_APROVADA';
    }catch(e){registro.asaas=Number.isInteger(e.status)?`HTTP_${e.status}`:'FALHA_CONEXAO';}
    salvar();
    if(registro.email!=='ACEITO_PELO_RESEND'){
        if(registro.tentativaEmail && Date.now()-Date.parse(registro.tentativaEmail)>23*3600000){registro.email='RETRY_RECUSADO_JANELA';salvar();}
        else{
            registro.tentativaEmail??=new Date().toISOString();salvar();
            let status=null;
            const enviar=criarEnviarEmail({...process.env,EMAIL_PROVIDER:'resend',EMAIL_REMETENTE:'Kidmais Manager — Teste <onboarding@resend.dev>'},async(url,init)=>{
                if(url!=='https://api.resend.com/emails'||init?.method!=='POST')throw Error('ESCOPO_RECUSADO');
                const r=await fetch(url,{...init,redirect:'error'});status=r.status;
                if(!r.ok){
                    const erro=await r.clone().json().catch(()=>null);
                    const permitidos=['validation_error','missing_api_key','restricted_api_key','invalid_api_key','invalid_permission','suspended_api_key','rate_limit_exceeded'];
                    registro.erroEmail=permitidos.includes(erro?.name)?erro.name:'ERRO_NAO_CLASSIFICADO';
                    registro.chaveRecusada=typeof erro?.message==='string' && /api key is invalid|invalid api key/i.test(erro.message);
                }
                return r;
            });
            try{
                const texto='Felipe, este é um e-mail de TESTE da integração do Kidmais Manager.\n\nNão é uma cobrança nem um aviso real de mudança de preço. Nenhuma assinatura foi criada ou alterada.\n\nSe recebeu esta mensagem, informe no chat para confirmarmos a entrega.';
                const r=await enviar({para:destino,assunto:'[TESTE] Kidmais Manager — integração de e-mail',texto,html:`<p>${texto.replaceAll('\n\n','</p><p>')}</p>`,idempotencia:`kidmais-conexao/${registro.id}`});
                if(!r.idExterno)throw Error('SEM_COMPROVANTE');
                registro.email='ACEITO_PELO_RESEND';registro.idEmail=r.idExterno;
                delete registro.erroEmail;delete registro.chaveRecusada;
            }catch{registro.email=status?`HTTP_${status}`:'RESULTADO_INCERTO';}
            salvar();
        }
    }
    console.log(JSON.stringify({asaas:registro.asaas,email:registro.email,erroEmail:registro.erroEmail,chaveRecusada:registro.chaveRecusada,cobrancasCriadas:0,entregaNaCaixa:registro.email==='ACEITO_PELO_RESEND'?'AGUARDA_CONFIRMACAO':'NAO_CONFIRMADA'},null,2));
    if(registro.asaas!=='AUTENTICACAO_APROVADA'||registro.email!=='ACEITO_PELO_RESEND')process.exitCode=2;
}
main().catch(()=>{console.error('Teste interrompido. Nenhuma credencial ou resposta externa exibida.');process.exitCode=1;});
