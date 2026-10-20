/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SHA,REMETENTE,validar,testar}=require('./email-staging-lancamento.cjs');
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',RENDER_GIT_COMMIT:SHA,EMAIL_PROVIDER:'resend',EMAIL_REMETENTE:REMETENTE,RESEND_API_KEY:'re_sintetica'};
test('comando preparado tem sintaxe valida e payload identico ao script revisado',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
 const comando=fs.readFileSync(path.resolve(__dirname,'../docs/evidencias/email-staging-comando-codex-20261011.txt'),'utf8');
 const linhas=comando.trimEnd().split('\n');assert.equal(linhas.shift(),"node --experimental-strip-types - --email-staging-autorizado <<'KIDMAIS_EMAIL_NODE'");assert.equal(linhas.pop(),'KIDMAIS_EMAIL_NODE');
 new vm.Script(linhas.join('\n'));
 const pacote=JSON.parse(linhas.find(l=>l.startsWith('const pacote=')).slice('const pacote='.length,-1));
 const fonte=fs.readFileSync(path.resolve(__dirname,'email-staging-lancamento.cjs'),'utf8').replace(/\r\n/g,'\n');
 assert.equal(Buffer.from(pacote.base64,'base64').toString(),fonte);assert.equal(pacote.sha256,crypto.createHash('sha256').update(fonte).digest('hex'));
});
function fixture({falha=false,existente=false}={}){const escritas=[],mensagens=[];let chamadas=0;const discoFs={lstatSync:()=>({dev:2,isDirectory:()=>true,isSymbolicLink:()=>false}),statSync:()=>({dev:1}),mkdirSync(){},writeFileSync(p,conteudo,opts){if(opts.flag==='wx'&&existente)throw Error('EXISTENTE');escritas.push(JSON.parse(conteudo));}};return {escritas,mensagens,opcoes:{env,discoFs,uuid:()=> 'id-sintetico',carregar:async()=>{chamadas++;return {criarEnviarEmail:()=>async m=>{mensagens.push(m);if(falha)throw Error('FALHA');return {provedor:'resend',idExterno:'id-sintetico-provedor'};}};}},chamadas:()=>chamadas};}
test('produção, outro SHA, flags abertas ou secret ausente recusam antes de envio',()=>{
 validar(env);for(const o of [{KIDMAIS_DEPLOY_ENV:'production'},{RENDER_SERVICE_ID:'srv-outro'},{RENDER_GIT_COMMIT:'outro'},{CADASTRO_PUBLICO_ATIVO:'true'},{ASSINATURA_PLANOS_ATIVOS:'true'},{COTACAO_PUBLICA_POR_EMPRESA:'true'},{RESEND_API_KEY:''},{EMAIL_REMETENTE:'outro@example.invalid'}])assert.throws(()=>validar({...env,...o}));
});
test('uma mensagem sem link, enviada pelo transporte do produto, com intenção gravada antes',async()=>{
 const f=fixture(),r=await testar(f.opcoes);assert.equal(r.resultado,'ACEITO_PROVEDOR_ENTREGA_PENDENTE');assert.equal(f.mensagens.length,1);assert.equal(f.mensagens[0].para,'felipemenegaz@gmail.com');assert.ok(!f.mensagens[0].texto.includes('https://'));assert.equal(f.escritas[0].situacao,'ENVIO_PREPARADO');assert.equal(f.escritas.at(-1).situacao,r.resultado);
});
test('falha de envio fica incerta sem retentativa',async()=>{
 const f=fixture({falha:true});await assert.rejects(testar(f.opcoes));assert.equal(f.mensagens.length,1);assert.equal(f.escritas.at(-1).situacao,'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR');
});
test('registro existente impede replay antes de carregar transporte',async()=>{
 const f=fixture({existente:true});await assert.rejects(testar(f.opcoes));assert.equal(f.chamadas(),0);assert.equal(f.mensagens.length,0);
});
test('transporte TypeScript real do produto e compativel, com rede substituida por mock',async()=>{
 const {pathToFileURL}=require('node:url'),path=require('node:path');const modulo=await import(pathToFileURL(path.resolve(__dirname,'../lib/acessos/email.ts')).href);
 const f=fixture();let chamadas=0;f.opcoes.carregar=async()=>({criarEnviarEmail:e=>modulo.criarEnviarEmail(e,async(url,opcoes)=>{chamadas++;assert.equal(url,'https://api.resend.com/emails');const corpo=JSON.parse(opcoes.body);assert.equal(corpo.from,REMETENTE);assert.deepEqual(corpo.to,['felipemenegaz@gmail.com']);return new Response(JSON.stringify({id:'id-mock-produto'}),{status:200});})});
 assert.equal((await testar(f.opcoes)).idExterno,'id-mock-produto');assert.equal(chamadas,1);
});
