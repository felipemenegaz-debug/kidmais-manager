/* eslint-disable @typescript-eslint/no-require-imports */
// Somente cluster novo sintetico. Nao aceita URL, credenciais ou alvo remoto.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const cluster=require('./cluster-descartavel-postgres.cjs');
const receita=require('./regressao-v1-postgres-receita.cjs');
const aplicador=require('./migrations-lancamento-production.cjs');
const raiz=path.resolve(__dirname,'..');
const datas=['2026-10-15','2026-11-01','2026-11-07','2026-11-13','2027-05-27'];
const ids=['57618aab-a62c-4be1-9385-17308ac8dda3','3b06e365-7ac1-42e6-ba1a-6b82de76af8b','11b9459d-35f8-4a9f-8e6f-aeb7311ff651','e4cc53fd-b423-46bc-98b4-86b318a0d688','d4e6cf8c-1b42-4bd1-8d18-1750cc3b958e'];
async function main(){
 assert.deepEqual(process.argv.slice(2),['--ensaio-local-autorizado']);
 // Retira configuracao herdada somente deste processo, nunca le seus valores.
 const {variavelDeConexaoHerdada}=require('./regressao-v1-selecao.cjs');
 for(const k of Object.keys(process.env))if(variavelDeConexaoHerdada(k)||k==='KIDMAIS_HOMOLOGACAO_DATABASE_URL')delete process.env[k];
 Object.assign(process.env,{KIDMAIS_PG_BIN:'C:/Program Files/PostgreSQL/18/bin',KIDMAIS_POSTGRES_DESCARTAVEL:'kidmais_pacotes_v1_descartavel',KIDMAIS_DESCARTAVEL_PORTA:'55498',KIDMAIS_DESCARTAVEL_AUTORIZACAO:'127.0.0.1:55498/kidmais_pacotes_v1_descartavel'});
 const plano=aplicador.carregar();for(const e of plano)for(const a of e.arquivos)aplicador.corpo(a.sql,a.tipo);
 let pasta,admin,c,iniciado=false;const resultados=[];
 const log=x=>{resultados.push(x);console.log(JSON.stringify(x));};
 try{
  const criado=await cluster.principal(['criar','--cluster','kidmais_descartavel','--criar-autorizado'],process.env);pasta=criado.pasta;log(criado);
  log(await cluster.principal(['iniciar','--pasta',pasta,'--iniciar-autorizado'],process.env));iniciado=true;
  log(await cluster.principal(['conferir','--pasta',pasta],process.env));
  ({admin}=await receita.conectarAdmin());await receita.construirModelo(admin,55498,'063');
  await receita.restaurar(admin,'kidmais_pacotes_v1_descartavel','063');c=await receita.conectar(55498,'kidmais_pacotes_v1_descartavel');
  const inventario=await import(pathToFileURL(path.join(raiz,'scripts/production/check-migrations.mjs')).href);
  const fim=inventario.approvedFiles.findIndex(x=>x.split('_')[1]==='074');
  const inicio=inventario.approvedFiles.findIndex(x=>x.split('_')[1]==='063');
  for(const arq of inventario.approvedFiles.slice(inicio+1,fim+1)){
   const checks=inventario.requiredChecks(arq);
   for(const nome of checks.filter(x=>x.includes('precheck')))await c.query(fs.readFileSync(path.join(raiz,'database/checks',nome),'utf8'));
   await c.query(fs.readFileSync(path.join(raiz,'database/migrations',arq),'utf8'));
   for(const nome of checks.filter(x=>!x.includes('precheck')))await c.query(fs.readFileSync(path.join(raiz,'database/checks',nome),'utf8'));
  }
  const kidmais=(await c.query("SELECT id FROM empresas WHERE codigo='kidmais'")).rows[0].id;
  for(let i=0;i<5;i++)await c.query("INSERT INTO bloqueios_agenda(id,data,horario_inicio,horario_fim,motivo) VALUES($1,$2,'17:00','21:00','Bloqueio sintetico do ensaio')",[ids[i],datas[i]]);
  const original=fs.readFileSync(path.join(raiz,'database/repairs/20261011_lancamento_bloqueios_kidmais.sql'),'utf8');
  // Apenas os dois identificadores de destino sao substituidos. O arquivo de producao permanece intacto.
  const sql=original.replaceAll('kidmais_production','kidmais_pacotes_v1_descartavel').replaceAll('7e990a2b-e64b-4630-9aae-4646fe936ede',kidmais);
  async function recusa(texto,erro){try{await assert.rejects(c.query(texto),erro);}finally{await c.query('ROLLBACK');}assert.equal((await c.query('SELECT count(*)::int AS n FROM agenda_062_bloqueios_resolucao')).rows[0].n,0);}
  await recusa(original,/BANCO_RECUSADO/);log({caso:'alvo_production_recusado_localmente',resultado:'PASS'});
  await recusa(sql,/REPARO_NAO_AUTORIZADO/);log({caso:'flag_ausente',resultado:'PASS'});
  await c.query("SET kidmais.reparo_lancamento='cinco-bloqueios-kidmais-20261011'");
  await c.query("UPDATE bloqueios_agenda SET horario_fim='22:00' WHERE id=$1",[ids[0]]);
  await recusa(sql,/BLOQUEIOS_DIVERGENTES/);log({caso:'horario_divergente_sem_escrita',resultado:'PASS'});
  await c.query("UPDATE bloqueios_agenda SET horario_fim='21:00' WHERE id=$1",[ids[0]]);
  // Regra robusta à passagem das datas: global FUTURO fora dos cinco recusa; global PASSADO fora dos cinco é ignorado.
  const extraFuturo=(await c.query("INSERT INTO bloqueios_agenda(data,horario_inicio,horario_fim,motivo) VALUES(current_date+40,'10:00','12:00','Global sintetico extra') RETURNING id")).rows[0].id;
  await recusa(sql,/CONJUNTO_GLOBAL_DIVERGENTE/);log({caso:'global_futuro_fora_do_alvo_recusado',resultado:'PASS'});
  await c.query('UPDATE bloqueios_agenda SET ativo=false WHERE id=$1',[extraFuturo]);
  await c.query("INSERT INTO bloqueios_agenda(data,horario_inicio,horario_fim,motivo) VALUES(current_date-3,'10:00','12:00','Global sintetico passado')");
  const antes=(await c.query('SELECT to_jsonb(b)-\'atualizado_em\'-\'empresa_id\' AS dados FROM bloqueios_agenda b ORDER BY id')).rows;
  await c.query(sql);
  assert.deepEqual((await c.query('SELECT to_jsonb(b)-\'atualizado_em\'-\'empresa_id\' AS dados FROM bloqueios_agenda b ORDER BY id')).rows,antes);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE empresa_id=$1 AND estabelecimento_id IS NULL AND ativo',[kidmais])).rows[0].n,5);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM agenda_062_bloqueios_resolucao WHERE empresa_id=$1',[kidmais])).rows[0].n,5);
  log({caso:'cinco_bloqueios_preservados',resultado:'PASS'});
  try{await assert.rejects(c.query(sql),/BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO/);}finally{await c.query('ROLLBACK');}log({caso:'repeticao_reparo_recusada',resultado:'PASS'});
  const validarIdentidade=r=>{assert.equal(r.db,'kidmais_pacotes_v1_descartavel');assert.equal(r.tls,false);};
  // Falha no postcheck deve desfazer a migration inteira, mantendo a conexao utilizavel.
  const quebrado=plano.map(e=>e.id==='074a'?{...e,arquivos:e.arquivos.map(a=>a.tipo==='postcheck'?{...a,sql:"DO $$ BEGIN RAISE EXCEPTION 'FALHA_INJETADA'; END $$;"}:a)}:e);
  await assert.rejects(aplicador.etapa(c,quebrado,'074a',{validarIdentidade}),/FALHA_INJETADA/);
  assert.equal((await c.query("SELECT to_regclass('planos_comerciais') IS NULL AS ausente")).rows[0].ausente,true);log({caso:'postcheck_falha_rollback_integral',resultado:'PASS'});
  const catalogo=(await c.query('SELECT id,codigo,nome FROM buffet_itens ORDER BY id')).rows;
  for(const e of plano)log(await aplicador.etapa(c,plano,e.id,{validarIdentidade}));
  for(const e of plano)log(await aplicador.etapa(c,plano,e.id,{validarIdentidade}));
  assert.deepEqual((await c.query('SELECT id,codigo,nome FROM buffet_itens ORDER BY id')).rows,catalogo);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM empresa_assinaturas WHERE empresa_id=$1',[kidmais])).rows[0].n,0);
  log({caso:'catalogo_preservado_kidmais_sem_assinatura',resultado:'PASS'});
 }finally{
  if(c)await c.end().catch(()=>{});if(admin)await admin.end().catch(()=>{});
  if(iniciado)log(await cluster.principal(['parar','--pasta',pasta,'--parar-autorizado'],process.env));
  if(pasta)fs.writeFileSync(path.join(raiz,pasta,'ensaio-lancamento.json'),JSON.stringify(resultados,null,2));
 }
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).slice(0,250));process.exitCode=1;});
