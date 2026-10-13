/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do verificador S3: cliente simulado, sem banco nem rede.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const s3=require('./s3-cadastro-staging.cjs');
const base={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',RENDER_GIT_COMMIT:s3.SHA,DATABASE_SSL:'false',
 DATABASE_URL:'postgresql://sintetico:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'};
const janela={...base,CADASTRO_PUBLICO_ATIVO:'true',USUARIOS_CRIACAO_DIRETA:'desativada',EMAIL_PROVIDER:'resend',
 EMAIL_REMETENTE:'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>',RESEND_API_KEY:'re_sintetica'};

function Cliente({globais=0,linhas=[],kidmais={empresas:1,assinaturas:0},db='kidmais_staging_1z91',privado=true}={}){
 const log=[];return class{constructor(o){this.o=o;}on(){}async connect(){}async end(){}
  async query(t){log.push(t);Cliente.log=log;
   if(t.includes('current_database()'))return {rows:[{db,privado}]};
   if(t.includes('FROM bloqueios_agenda'))return {rows:[{n:globais}]};
   if(t.includes("codigo='kidmais'")&&!t.includes('cadastros_empresas'))return {rows:[kidmais]};
   if(t.includes('cadastros_empresas'))return {rows:linhas};
   return {rows:[]};}};
}
const empresaOk={status:'ATIVA',situacao:'TESTE',quinze_dias:true,sem_provedor:true,teste_vigente:true,gestao:1,contratacoes:0};

test('antes: exige a janela (cadastro aberto, criação direta desligada, e-mail do E0) e detecta bloqueio global', async ()=>{
 assert.equal((await s3.principal(['--s3-antes'],janela,Cliente())).resultado,'PRONTO_PARA_CADASTRO');
 assert.equal((await s3.principal(['--s3-antes'],janela,Cliente({globais:2}))).resultado,'CADASTRO_RECUSARIA_503');
 for(const [v,m] of [[{CADASTRO_PUBLICO_ATIVO:undefined},/CADASTRO_FECHADO/],[{USUARIOS_CRIACAO_DIRETA:undefined},/CRIACAO_DIRETA_LIGADA/],
  [{RENDER_GIT_COMMIT:'outro'},/CANDIDATA_DIVERGENTE/],[{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'},/SERVICO_RECUSADO/],
  [{EMAIL_REMETENTE:'x@y'},/EMAIL_REMETENTE/],[{ASSINATURA_TESTE_DIAS:'30'},/TESTE_DIFERENTE_DE_15/]])
  await assert.rejects(s3.principal(['--s3-antes'],{...janela,...v},Cliente()),m);
 await assert.rejects(s3.principal(['--s3-antes'],janela,Cliente({db:'kidmais_production'})),/BANCO_CONECTADO_DIVERGENTE/);
 await assert.rejects(s3.principal(['--s3-antes'],{...janela,DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},Cliente()),/HOST_RECUSADO/);
});

test('depois: S3_PASS só com uma empresa ATIVA, teste de 15 dias vigente, uma Gestão, sem provedor/contratação e Kidmais intacta', async ()=>{
 const cnpj='81.356.789/0001-10';
 assert.equal((await s3.principal(['--s3-depois',cnpj],base,Cliente({linhas:[empresaOk]}))).resultado,'S3_PASS');
 for(const ruim of [{linhas:[]},{linhas:[empresaOk,empresaOk]},{linhas:[{...empresaOk,quinze_dias:false}]},{linhas:[{...empresaOk,gestao:2}]},
  {linhas:[{...empresaOk,sem_provedor:false}]},{linhas:[empresaOk],kidmais:{empresas:1,assinaturas:1}}])
  assert.equal((await s3.principal(['--s3-depois',cnpj],base,Cliente(ruim))).resultado,'S3_DIVERGENTE',JSON.stringify(ruim));
 await assert.rejects(s3.principal(['--s3-depois','20.119.900/0001-60'],base,Cliente()),/CNPJ_DA_KIDMAIS/);
 await assert.rejects(s3.principal(['--s3-depois','123'],base,Cliente()),/CNPJ_INVALIDO/);
});

test('somente leitura: transação READ ONLY com ROLLBACK e nenhuma escrita; restaurado sem banco', async ()=>{
 await s3.principal(['--s3-antes'],janela,Cliente());
 assert.equal(Cliente.log[0],'BEGIN TRANSACTION READ ONLY');assert.equal(Cliente.log.at(-1),'ROLLBACK');
 const fonte=fs.readFileSync(__dirname+'/s3-cadastro-staging.cjs','utf8');
 assert.doesNotMatch(fonte,/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|DROP |TRUNCATE)\b/);
 assert.deepEqual(s3.restaurado(base),{resultado:'RESTAURADO',presentes:[]});
 assert.deepEqual(s3.restaurado({...base,CADASTRO_PUBLICO_ATIVO:'true'}),{resultado:'NAO_RESTAURADO',presentes:['CADASTRO_PUBLICO_ATIVO']});
 await assert.rejects(s3.principal(['--outro'],base,Cliente()),/USO_RECUSADO/);
});

test('comandos gerados: CNPJ sintético válido (não é da Kidmais), arquivo versionado igual ao gerador', ()=>{
 const gen=require('./preparar-comando-s3-staging.cjs');
 assert.equal(s3.cnpj(gen.CNPJ_SINTETICO),gen.CNPJ_SINTETICO);
 const arquivo=fs.readFileSync(__dirname+'/../docs/evidencias/s3-staging-comandos-20261013.txt','utf8').replace(/\r\n/g,'\n');
 assert.equal(arquivo,gen.comandos());
 assert.equal((arquivo.match(/<<'KIDMAIS_S3_NODE'/g)||[]).length,3);
 assert.doesNotMatch(arquivo,/postgres(ql)?:\/\/|re_[A-Za-z0-9]{8}/);
});
