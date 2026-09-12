/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
const fs=require('node:fs'),assert=require('node:assert/strict'),{Client}=require('pg');
require('./pagamentos-test-support.cjs');
async function main(){
 const origem=new URL(process.env.DATABASE_URL),template=JSON.parse(fs.readFileSync('.local-festa/results/migration.json')).clone;
 const registry=JSON.parse(fs.readFileSync('.local-festa/environments.json'));assert(registry.automated.includes(template));
 const name='kidmais_release_'+Date.now();assert(!/^kidmais_016_/.test(name));
 const admin=new Client({connectionString:origem.toString()});await admin.connect();try{await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);}finally{await admin.end();}
 registry.automated.push(name);fs.writeFileSync('.local-festa/environments.json',JSON.stringify(registry,null,2));origem.pathname='/'+name;
 const c=new Client({connectionString:origem.toString()});await c.connect();const flag=process.env.FESTA_ENABLED;
 try{
  assert.equal((await c.query('SELECT current_database() nome')).rows[0].nome,name);await c.query('BEGIN');require('./pagamentos-test-support.cjs').installPool(c);
  const {ambienteFesta,consultarFestas}=require('../lib/festas/service.ts');
  process.env.FESTA_ENABLED='true';await ambienteFesta(c);
  const auth=await require('./admin-test-support.cjs').autenticarTeste(c);
  await c.query("INSERT INTO festa_usuario_capacidades(usuario_id,capacidade,concedido_por,motivo) VALUES($1,'FESTA_CONSULTAR',$1,'Teste explícito no clone de validação')",[auth.usuarioId]);
  const contexto={token:auth.token,requestId:require('node:crypto').randomUUID(),userAgent:'validação de ambiente'};
  assert.equal((await consultarFestas(contexto)).festas.length,0);
  process.env.FESTA_ENABLED='false';await assert.rejects(consultarFestas(contexto),e=>e.status===503);process.env.FESTA_ENABLED='true';
  const checks=[];
  for(const [nome,sql]of [
   ['tabela ausente','ALTER TABLE festa_buffet RENAME TO buffet_temporario_teste'],
   ['coluna ausente','ALTER TABLE festa_buffet DROP COLUMN bolo'],
   ['trigger desabilitado','ALTER TABLE festa_eventos DISABLE TRIGGER festa_eventos_imutavel'],
   ['constraint ausente','ALTER TABLE festa_contagens_convidados DROP CONSTRAINT festa_correcao_motivo_obrigatorio'],
   ['função incompatível',"CREATE OR REPLACE FUNCTION festa016_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"],
   ['tipo incorreto','ALTER TABLE festa_buffet ALTER COLUMN bolo TYPE varchar(2000)']
  ]){await c.query('SAVEPOINT estrutura');await c.query(sql);await assert.rejects(ambienteFesta(c),e=>e.status===503&&e.message==='Módulo Festa indisponível: instalação não validada.');await c.query('ROLLBACK TO SAVEPOINT estrutura');await ambienteFesta(c);checks.push(nome);}
  fs.writeFileSync('.local-festa/results/ambiente-producao.json',JSON.stringify({clone:name,flagHabilitada:true,consultaAutenticada:true,flagDesabilitadaRecusada:true,incompletaRecusada:checks,rollbackDadosTeste:true},null,2));console.log('PASS: nome alternativo, consulta autenticada, flag desabilitada e seis estruturas incompatíveis.');
 }finally{await c.query('ROLLBACK');await c.end();delete globalThis.__kidmaisPgPool;if(flag===undefined)delete process.env.FESTA_ENABLED;else process.env.FESTA_ENABLED=flag;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
