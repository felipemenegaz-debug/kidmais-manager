/* eslint-disable @typescript-eslint/no-require-imports */
// Reparo delimitado dos cinco bloqueios globais da Kidmais em produção (decisão de Felipe, P0b de 11/10/2026).
// Uma execução: backup conferido, alvo fixo, flags de abertura desligadas, marcador exclusivo, SQL revisado por hash.
//   node scripts/reparo-bloqueios-production.cjs --aplicar-reparo-autorizado --backup <registro do backup>
// Sem argumentos: plano sem conexão. Nunca apaga nem desativa bloqueio; só vincula os cinco à Kidmais inteira.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {alvo,ALVO}=require('./diagnostico-lancamento-production.cjs');
const {conferirBackup,identidadeProduction}=require('./migrations-lancamento-production.cjs');
const ARQUIVO='database/repairs/20261011_lancamento_bloqueios_kidmais.sql';
const AUTORIZACAO='cinco-bloqueios-kidmais-20261011';
const DISCO='/opt/render/project/src/data';
const hash=s=>createHash('sha256').update(s).digest('hex');
function ler(raiz=path.resolve(__dirname,'..')){return fs.readFileSync(path.join(raiz,ARQUIVO),'utf8').replace(/\r\n/g,'\n');}
/** Executa o SQL revisado numa conexão já aberta. O próprio SQL confere banco, Kidmais, alvos, ausência de outros globais e postcheck. */
async function reparar(c,sql,{validarIdentidade=identidadeProduction}={}){
 const r=(await c.query('SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls')).rows[0];
 validarIdentidade(r);
 await c.query(`SET kidmais.reparo_lancamento='${AUTORIZACAO}'`);
 try{await c.query(sql);}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 const depois=(await c.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data>=current_date')).rows[0].n;
 assert.equal(depois,0,'POSTCHECK_AINDA_GLOBAL');
 return {resultado:'REPARO_APLICADO_POSTCHECK_PASS',globaisFuturos:depois};
}
async function main(){
 const args=process.argv.slice(2),sql=ler();
 if(args.length===0){console.log(JSON.stringify({modo:'PLANO_SEM_CONEXAO',alvo:ALVO,arquivo:ARQUIVO,sha256:hash(sql)}));return;}
 assert.equal(args.length,3,'USO_RECUSADO');assert.equal(args[0],'--aplicar-reparo-autorizado');assert.equal(args[1],'--backup');
 const opts=alvo(process.env);await conferirBackup(args[2]);
 for(const k of ['CADASTRO_PUBLICO_ATIVO','ASSINATURA_PLANOS_ATIVOS','COTACAO_PUBLICA_POR_EMPRESA'])assert.notEqual(process.env[k],'true','FLAG_DE_ABERTURA_ATIVA '+k);
 const tentativa=path.join(DISCO,'lancamento-venda-20261011','reparo-bloqueios.json');
 fs.writeFileSync(tentativa,JSON.stringify({inicio:new Date().toISOString(),sha256:hash(sql),situacao:'INICIADO'}),{flag:'wx',mode:0o600});
 const c=new(require('pg').Client)({...opts,application_name:'kidmais-cutover-reparo-bloqueios'});c.on('error',()=>undefined);
 try{
  await c.connect();const r=await reparar(c,sql);
  fs.writeFileSync(tentativa,JSON.stringify({...r,sha256:hash(sql),em:new Date().toISOString()}),{mode:0o600});console.log(JSON.stringify(r));
 }catch(e){fs.writeFileSync(tentativa,JSON.stringify({situacao:'FALHA_NAO_REPETIR',sha256:hash(sql),em:new Date().toISOString()}),{mode:0o600});throw e;}
 finally{await c.end().catch(()=>{});}
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).slice(0,160));process.exitCode=1;});
module.exports={ARQUIVO,AUTORIZACAO,ler,reparar,hash};
