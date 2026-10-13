/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do reparo: cliente simulado, sem banco nem rede.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const r=require('./reparo-bloqueios-production.cjs');
const sql=r.ler();

function cliente({db='kidmais_production',tls=true,falhar=false,restantes=0}={}){
 const log=[];return {log,async query(t){log.push(t);
  if(t===sql){if(falhar)throw new Error('BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO');return [];}
  if(t.includes('current_database()'))return {rows:[{db,tls}]};
  if(t.includes('count(*)::int AS n FROM bloqueios_agenda'))return {rows:[{n:restantes}]};
  return {rows:[]};}};
}

test('SQL revisado: alvo fixo de produção, autorização de sessão, cinco IDs, nenhum DELETE e regra robusta às datas', ()=>{
 assert.match(sql,/current_database\(\)<>'kidmais_production'/);
 assert.match(sql,new RegExp(`current_setting\\('kidmais.reparo_lancamento',true\\) IS DISTINCT FROM '${r.AUTORIZACAO}'`));
 assert.equal((sql.match(/\$\$/g)||[]).length%2,0,'delimitadores $$ íntegros');
 assert.doesNotMatch(sql,/\bDELETE\b|\bTRUNCATE\b|SET ativo\s*=\s*false/i);
 assert.match(sql,/AND id NOT IN \(/,'globais futuros fora dos cinco recusam; os cinco valem com qualquer data');
 assert.equal((sql.match(/57618aab-a62c-4be1-9385-17308ac8dda3/g)||[]).length,4);
});

test('reparar: confere identidade, define a autorização na sessão e exige zero globais futuros depois', async ()=>{
 const c=cliente();assert.deepEqual(await r.reparar(c,sql),{resultado:'REPARO_APLICADO_POSTCHECK_PASS',globaisFuturos:0});
 assert.equal(c.log[1],`SET kidmais.reparo_lancamento='${r.AUTORIZACAO}'`);assert.equal(c.log[2],sql);
 await assert.rejects(r.reparar(cliente({db:'kidmais_staging_1z91'}),sql),/BANCO_DIVERGENTE/);
 await assert.rejects(r.reparar(cliente({tls:false}),sql),/SEM_TLS/);
 const f=cliente({falhar:true});await assert.rejects(r.reparar(f,sql),/REPARO_JA_INICIADO/);assert.equal(f.log.at(-1),'ROLLBACK');
 await assert.rejects(r.reparar(cliente({restantes:1}),sql),/POSTCHECK_AINDA_GLOBAL/);
});

test('CLI: sem argumentos só mostra o plano (sem conexão); argumentos errados recusam antes de conectar', ()=>{
 const p=spawnSync(process.execPath,[__dirname+'/reparo-bloqueios-production.cjs'],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:20000});
 assert.equal(p.status,0);const j=JSON.parse(p.stdout);assert.equal(j.modo,'PLANO_SEM_CONEXAO');assert.equal(j.sha256,r.hash(sql));
 const e=spawnSync(process.execPath,[__dirname+'/reparo-bloqueios-production.cjs','--aplicar-reparo-autorizado'],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:20000});
 assert.equal(e.status,1);assert.match(e.stderr,/USO_RECUSADO/);
 const fonte=fs.readFileSync(__dirname+'/reparo-bloqueios-production.cjs','utf8');
 assert.ok(fonte.indexOf('conferirBackup(args[2])')<fonte.indexOf("flag:'wx'")&&fonte.indexOf("flag:'wx'")<fonte.indexOf('await c.connect()'),'backup e marcador antes de conectar');
});
