/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'), assert=require('node:assert/strict');
const {alvo,lerArquivos}=require('./migration-099-staging.cjs');
const env={RENDER:'true',RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg',KIDMAIS_DEPLOY_ENV:'staging',
  DATABASE_SSL:'false',DATABASE_URL:'postgres://synthetic:synthetic@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'};
test('099 só aceita staging exato; alvo divergente para antes da conexão',()=>{
  assert.equal(alvo(env).application_name,'kidmais-convites-099');
  for(const patch of [{RENDER:'false'},{RENDER_SERVICE_ID:'srv-producao'},{KIDMAIS_DEPLOY_ENV:'production'},
    {DATABASE_URL:env.DATABASE_URL.replace('kidmais_staging_1z91','kidmais_production')},
    {DATABASE_URL:env.DATABASE_URL.replace('dpg-daidko3m8hqs73ce4jt0-a','127.0.0.1')},
    {DATABASE_URL:env.DATABASE_URL+'?sslmode=disable'},{DATABASE_SSL:''}]) assert.throws(()=>alvo({...env,...patch}));
});
test('099 TLS exige verificação e os três arquivos batem com o manifesto',()=>{
  assert.equal(alvo({...env,DATABASE_SSL:'true'}).ssl.rejectUnauthorized,true);
  assert.throws(()=>alvo({...env,DATABASE_SSL:'true',DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}));
  assert.equal(lerArquivos().length,3);
});
