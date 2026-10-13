/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const m=require('./migrations-lancamento-production.cjs');
test('manifesto confere todos os 18 hashes e molduras sem alterar corpos SQL',()=>{
 const plano=m.carregar();assert.deepEqual(plano.map(x=>x.id),['074a','075','076','077','078','079']);
 for(const e of plano)for(const a of e.arquivos){const corpo=m.corpo(a.sql,a.tipo);assert.equal((corpo.match(/\$\$/g)||[]).length,(a.sql.match(/\$\$/g)||[]).length);}
});
test('identidade production exige banco fixo e TLS',()=>{
 assert.throws(()=>m.identidadeProduction({db:'outro',tls:true}),/BANCO_DIVERGENTE/);
 assert.throws(()=>m.identidadeProduction({db:'kidmais_production',tls:false}),/SEM_TLS/);
 m.identidadeProduction({db:'kidmais_production',tls:true});
});
function simulador({presente=false,falha=false,db='kidmais_production'}={}){
 const chamadas=[];return {chamadas,async query(sql){chamadas.push(sql);if(sql.startsWith('SELECT current_database'))return {rows:[{db,tls:true}]};if(sql.startsWith('SELECT ('))return {rows:[{presente}]};if(falha&&sql.includes('POSTCHECK_SIMULADO'))throw Error('FALHA_POSTCHECK');return {rows:[]};}};
}
const plano=[{id:'074a',arquivos:[{tipo:'precheck',sql:'SELECT 1; -- PRECHECK_SIMULADO'},{tipo:'migration',sql:'BEGIN;\nSELECT 2; -- MIGRATION_SIMULADA\nCOMMIT;'},{tipo:'postcheck',sql:'SELECT 3; -- POSTCHECK_SIMULADO'}]}];
test('postcheck falha antes do COMMIT e encerra transacao',async()=>{
 const c=simulador({falha:true});await assert.rejects(m.etapa(c,plano,'074a'),/FALHA_POSTCHECK/);assert.equal(c.chamadas.at(-1),'ROLLBACK');assert.ok(!c.chamadas.includes('COMMIT'));
});
test('sucesso confirma COMMIT depois do postcheck',async()=>{
 const c=simulador();assert.equal((await m.etapa(c,plano,'074a')).resultado,'APLICADA_POSTCHECK_PASS');assert.equal(c.chamadas.at(-1),'COMMIT');
});
test('migration existente executa apenas postcheck em somente leitura',async()=>{
 const c=simulador({presente:true});assert.equal((await m.etapa(c,plano,'074a')).resultado,'JA_APLICADA_POSTCHECK_PASS');assert.ok(!c.chamadas.some(x=>x.includes('MIGRATION_SIMULADA')||x.includes('PRECHECK_SIMULADO')));assert.equal(c.chamadas.filter(x=>x==='BEGIN TRANSACTION READ ONLY').length,2);
});
test('alvo divergente recusa antes de escrita e rollback funciona',async()=>{
 const c=simulador({db:'outro'});await assert.rejects(m.etapa(c,plano,'074a'),/BANCO_DIVERGENTE/);assert.equal(c.chamadas.at(-1),'ROLLBACK');assert.ok(!c.chamadas.includes('BEGIN'));
});
test('molduras extras e checks de escrita sao recusados',()=>{
 assert.throws(()=>m.corpo('BEGIN;\nBEGIN;\nCOMMIT;','migration'));
 assert.throws(()=>m.corpo('DELETE FROM empresas;','postcheck'),/CHECK_NAO_LEITURA/);
});
test('dependencia ausente impede iniciar a migration seguinte',async()=>{
 const c=simulador();await assert.rejects(m.etapa(c,[...plano,{...plano[0],id:'075'}],'075'),/DEPENDENCIA_AUSENTE 074a/);assert.ok(!c.chamadas.includes('BEGIN'));
});
test('erro original sobrevive a falha adicional do rollback',async()=>{
 const c=simulador({falha:true}),query=c.query.bind(c);c.query=async sql=>{if(sql==='ROLLBACK')throw Error('ROLLBACK_TAMBEM_FALHOU');return query(sql);};await assert.rejects(m.etapa(c,plano,'074a'),/FALHA_POSTCHECK/);
});
test('backup fora do disco fixo e recusado antes de abrir o arquivo',async()=>{
 await assert.rejects(m.conferirBackup('C:/tmp/backup.json'),/REGISTRO_FORA_DO_DISCO/);
});
function backupSimulado(alteracoes={}){
 const path=require('node:path'),{createHash}=require('node:crypto'),{Readable}=require('node:stream');const dados='arquivo sintetico';
 const agora=Date.now(),registro={servico:m.ALVO.servico,banco:m.ALVO.database,arquivo:'backup-teste.dump',sha256:createHash('sha256').update(dados).digest('hex'),criadoEm:new Date(agora).toISOString(),pitrConferidoEm:new Date(agora).toISOString(),manifestoSha256:m.HASH_MANIFESTO,arquivoIntegralmenteLido:true,...alteracoes};
 return {agora,arquivo:path.resolve('/opt/render/project/src/data/lancamento-venda-20261011/backup-teste.json'),fs:{lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:2}),statSync:()=>({dev:1,size:dados.length}),readFileSync:()=>JSON.stringify(registro),createReadStream:()=>Readable.from([dados])}};
}
test('registro recente com arquivo integral e hash correto passa',async()=>{
 const b=backupSimulado();assert.equal((await m.conferirBackup(b.arquivo,b.agora,b.fs)).arquivo,'backup-teste.dump');
});
test('backup incompleto, hash alterado ou pacote divergente impede migration',async()=>{
 for(const alteracoes of [{arquivoIntegralmenteLido:false},{sha256:'0'.repeat(64)},{manifestoSha256:'0'.repeat(64)},{criadoEm:'2020-01-01T00:00:00Z'}]){const b=backupSimulado(alteracoes);await assert.rejects(m.conferirBackup(b.arquivo,b.agora,b.fs));}
});
