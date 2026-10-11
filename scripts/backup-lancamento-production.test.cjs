/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const b=require('./backup-lancamento-production.cjs');
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg',KIDMAIS_DEPLOY_ENV:'production',DATABASE_SSL:'true',DATABASE_SSL_REJECT_UNAUTHORIZED:'false',DATABASE_URL:'postgresql://synthetic:synthetic@dpg-dak750gae00c73fudmg0-a/kidmais_production',PATH:'synthetic-path',RESEND_API_KEY:'synthetic-secret',PGHOST:'wrong'};
test('ambiente libpq fixa alvo, leitura/TLS e nao herda outros segredos',()=>{
 const e=b.ambientePg(env);assert.equal(e.PGHOST,'dpg-dak750gae00c73fudmg0-a');assert.equal(e.PGSSLMODE,'require');assert.match(e.PGOPTIONS,/default_transaction_read_only=on/);assert.equal(e.RESEND_API_KEY,undefined);assert.equal(e.DATABASE_URL,undefined);assert.equal(e.PATH,env.PATH);
 assert.equal(b.ambientePg({...env,DATABASE_SSL_REJECT_UNAUTHORIZED:'true'}).PGSSLMODE,'verify-full');
});
test('PITR invalido, futuro ou antigo e recusado',()=>{
 const agora=Date.now();for(const iso of ['invalid',new Date(agora+1000).toISOString(),new Date(agora-86400000).toISOString()])assert.throws(()=>b.recente(iso,agora));b.recente(new Date(agora-1000).toISOString(),agora);
});
function fixture({falhaRestore=false,db='kidmais_production',montado=true}={}){
 const chamadas=[],registros=[];const cliente={on(){},async connect(){},async end(){chamadas.push('end');},async query(sql){chamadas.push(sql);return {rows:[{db,tls:true}]};}};
 const discoFs={lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:2}),statSync:p=>p==='/opt/render/project/src'?{dev:montado?1:2}:{size:12},mkdirSync(){},chmodSync(){},closeSync(){},openSync(){return 1;},createReadStream(){return Readable.from(['dump sintetico']);},writeFileSync(...args){registros.push(args);}};
 return {chamadas,registros,opcoes:{env,pitr:new Date().toISOString(),plataforma:'linux',discoFs,criarCliente:()=>cliente,versaoBin:()=>{},rodar:(bin,args)=>{chamadas.push({bin,args});if(falhaRestore&&bin==='pg_restore')throw Error('RESTORE_FALHOU');}}};
}
test('exporta custom, le arquivo inteiro sem destino DB e registra somente no sucesso',async()=>{
 const f=fixture();assert.equal((await b.exportar(f.opcoes)).resultado,'BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE');const subprocessos=f.chamadas.filter(x=>typeof x==='object');assert.equal(subprocessos.length,2);assert.ok(subprocessos[0].args.includes('--format=custom'));assert.ok(subprocessos[1].args.includes('--file=/dev/null'));assert.ok(!subprocessos[1].args.some(x=>x.startsWith('--dbname')));assert.equal(f.registros.length,1);const r=JSON.parse(f.registros[0][1]);assert.equal(r.arquivoIntegralmenteLido,true);assert.equal(r.restauracaoRealComprovada,false);assert.match(r.sha256,/^[a-f0-9]{64}$/);assert.equal(f.registros[0][2].flag,'wx');
});
test('arquivo invalido nao produz registro aprovavel',async()=>{
 const f=fixture({falhaRestore:true});await assert.rejects(b.exportar(f.opcoes),/RESTORE_FALHOU/);assert.equal(f.registros.length,0);
});
test('identidade divergente encerra conexao antes de exportar',async()=>{
 const f=fixture({db:'outro'});await assert.rejects(b.exportar(f.opcoes),/BANCO_DIVERGENTE/);assert.equal(f.chamadas.at(-1),'end');assert.equal(f.registros.length,0);assert.ok(!f.chamadas.some(x=>typeof x==='object'));
});
test('sem disco montado, flag aberta ou ambiente errado nada conecta',async()=>{
 for(const alteracao of [{montado:false},{env:{...env,CADASTRO_PUBLICO_ATIVO:'true'}},{env:{...env,KIDMAIS_DEPLOY_ENV:'staging'}}]){const f=fixture(alteracao);if(alteracao.env)f.opcoes.env=alteracao.env;await assert.rejects(b.exportar(f.opcoes));assert.equal(f.chamadas.length,0);assert.equal(f.registros.length,0);}
});
test('comando Shell contem scripts atuais e JavaScript valido sem executar',()=>{
 const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{Script}=require('node:vm');const raiz=path.resolve(__dirname,'..');
 const comando=fs.readFileSync(path.join(raiz,'docs/evidencias/backup-production-comando-codex-20261011.txt'),'utf8');
 const js=comando.split('\n').slice(1,-2).join('\n');new Script(js);
 const arquivos=JSON.parse(js.match(/^const arquivos=(.*);$/m)[1]);assert.equal(arquivos.length,3);
 for(const a of arquivos){const atual=fs.readFileSync(path.join(raiz,'scripts',a.nome),'utf8').replace(/\r\n/g,'\n');assert.equal(Buffer.from(a.base64,'base64').toString(),atual);assert.equal(createHash('sha256').update(atual).digest('hex'),a.sha256);}
});
