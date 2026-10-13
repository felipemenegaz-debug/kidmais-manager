/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), {createHash}=require('node:crypto');
const p=require('./preflight-lancamento-production.cjs');
const d=require('./diagnostico-lancamento-production.cjs');
const raiz=path.resolve(__dirname,'..');
const env={RENDER:'true',RENDER_SERVICE_ID:p.ALVO.servico,KIDMAIS_DEPLOY_ENV:'production',DATABASE_SSL:'true',DATABASE_URL:'postgres://sintetico:sintetico@'+p.ALVO.host+'/kidmais_production'};
test('SQL embutido identico aos seis arquivos revisados; hashes dos 18 arquivos de cutover conferem',()=>{
 p.revisar(); assert.equal(p.ETAPAS.length,6);
 for(const e of p.ETAPAS)assert.equal(e.sql,fs.readFileSync(path.join(raiz,e.arquivo),'utf8').replace(/\r\n/g,'\n'));
 const m=JSON.parse(fs.readFileSync(path.join(raiz,'docs/MIGRATIONS_PRODUCTION_LANCAMENTO_20261011.json'),'utf8'));
 assert.deepEqual(m.migrations.map(x=>x.id),['074a','075','076','077','078','079']);
 for(const e of m.migrations.flatMap(x=>x.arquivos))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz,e.arquivo),'utf8').replace(/\r\n/g,'\n')).digest('hex'),e.sha256);
});
test('mesma trava P0: alvo prod fixo e TLS, nenhum secret na saida',()=>{
 assert.deepEqual(p.alvo(env),d.alvo(env));
 for(const extra of [{RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg'},{KIDMAIS_DEPLOY_ENV:'staging'},{DATABASE_SSL:'false'},{DATABASE_URL:'postgres://u:s@localhost/kidmais_manager'}])assert.throws(()=>p.alvo({...env,...extra}));
});
function fake(falha){const log=[];return {log,async query(sql){log.push(sql);if(sql.includes('current_database() AS db'))return {rows:[{db:'kidmais_production',tls:true}]};if(sql===p.ETAPAS[falha]?.sql)throw Error('FALHA_PRECHECK');return {rows:[]};}};}
test('seis etapas com leitura e rollback; nao inclui precheck 075 antes de 074a',async()=>{
 const c=fake(-1),r=await p.conferir(c);assert.equal(r.etapas.length,6);
 assert.equal(c.log.at(-1),'ROLLBACK'); assert.ok(!p.ETAPAS.some(e=>e.nome==='075'));
 assert.equal(c.log.filter(s=>s==='BEGIN TRANSACTION READ ONLY').length,7);
});
test('falha interrompe etapas posteriores e encerra transacao',async()=>{
 const c=fake(2);await assert.rejects(p.conferir(c),/FALHA_PRECHECK/);
 assert.equal(c.log.at(-1),'ROLLBACK');assert.ok(!c.log.includes(p.ETAPAS[3].sql));
});
test('SQL de bloqueios tem alvo comprovado, limite de escopo e nao revela motivo ou identidade pessoal do autor',()=>{
 const sql=p.ETAPAS[0].sql;assert.match(sql,/7e990a2b-e64b-4630-9aae-4646fe936ede/);assert.match(sql,/MAIS_DE_20_BLOQUEIOS/);
 assert.doesNotMatch(sql,/b\.motivo|SELECT[^;]*email|SELECT[^;]*nome|UPDATE|DELETE|INSERT/i);
});
