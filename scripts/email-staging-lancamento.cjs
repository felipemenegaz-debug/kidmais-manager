/* eslint-disable @typescript-eslint/no-require-imports */
// Um envio real pelo transporte do produto. Nenhum banco, cadastro ou cobranca neste teste.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{pathToFileURL}=require('node:url');
const SHA='5386a4df36b8b8b7cb649bc15d17e48e6b853b90';
const DIR='/opt/render/project/src/data/lancamento-email-20261011';
const REMETENTE='Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>';
function validar(env){
 assert.equal(env.RENDER,'true','FORA_RENDER');assert.equal(env.RENDER_SERVICE_ID,'srv-daif418ae00c73e8k2gg','SERVICO_RECUSADO');
 assert.equal(env.KIDMAIS_DEPLOY_ENV,'staging','AMBIENTE_RECUSADO');assert.equal(env.RENDER_GIT_COMMIT,SHA,'CANDIDATA_DIVERGENTE');
 assert.equal(env.EMAIL_PROVIDER,'resend','PROVEDOR_RECUSADO');assert.equal(env.EMAIL_REMETENTE,REMETENTE,'REMETENTE_DIVERGENTE');
 assert.ok(/^re_[^\s]+$/.test(env.RESEND_API_KEY||''),'CHAVE_AUSENTE_OU_FORMATO');
 for(const k of ['CADASTRO_PUBLICO_ATIVO','ASSINATURA_PLANOS_ATIVOS','COTACAO_PUBLICA_POR_EMPRESA'])assert.notEqual(env[k],'true','ABERTURA_ATIVA '+k);
}
async function testar({env=process.env,discoFs=fs,carregar,uuid=randomUUID}={}){
 validar(env);
 const disco='/opt/render/project/src/data',mount=discoFs.lstatSync(disco);assert.ok(mount.isDirectory()&&!mount.isSymbolicLink()&&mount.dev!==discoFs.statSync(path.dirname(disco)).dev,'DISCO_NAO_MONTADO');
 discoFs.mkdirSync(DIR,{recursive:true,mode:0o700});assert.ok(!discoFs.lstatSync(DIR).isSymbolicLink(),'DIRETORIO_RECUSADO');
 const estado=path.join(DIR,'teste-envio.json'),id='kidmais-email-staging/'+uuid();
 discoFs.writeFileSync(estado,JSON.stringify({situacao:'ENVIO_PREPARADO',idempotencia:id,inicio:new Date().toISOString()}),{flag:'wx',mode:0o600});
 const modulo=carregar?await carregar():await import(pathToFileURL('/opt/render/project/src/lib/acessos/email.ts').href);
 const enviar=modulo.criarEnviarEmail(env);
 try{
  const r=await enviar({para:'felipemenegaz@gmail.com',assunto:'[TESTE] Kidmais Manager: e-mail de staging',texto:'Teste autorizado do transporte de e-mail do Kidmais Manager em staging. Nenhuma conta ou cobranca foi criada. Esta mensagem nao contem link de acesso.',html:'<p>Teste autorizado do transporte de e-mail do Kidmais Manager em staging.</p><p>Nenhuma conta ou cobrança foi criada. Esta mensagem não contém link de acesso.</p>',idempotencia:id});
  assert.equal(r.provedor,'resend','RESPOSTA_PROVEDOR_DIVERGENTE');assert.ok(r.idExterno,'ENVIO_SEM_IDENTIFICADOR');
  discoFs.writeFileSync(estado,JSON.stringify({situacao:'ACEITO_PROVEDOR_ENTREGA_PENDENTE',idempotencia:id,idExterno:r.idExterno,em:new Date().toISOString()}),{mode:0o600});
  return {resultado:'ACEITO_PROVEDOR_ENTREGA_PENDENTE',idExterno:r.idExterno};
 }catch(e){discoFs.writeFileSync(estado,JSON.stringify({situacao:'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR',idempotencia:id,em:new Date().toISOString()}),{mode:0o600});throw e;}
}
if(require.main===module){
 if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--email-staging-autorizado'])){console.error('FLAG_RECUSADA');process.exitCode=1;}
 else testar().then(r=>console.log(JSON.stringify(r)),()=>{console.error('EMAIL_TESTE_NAO_CONCLUIDO: conferir estado, sem repetir automaticamente.');process.exitCode=1;});
}
module.exports={SHA,REMETENTE,validar,testar};
