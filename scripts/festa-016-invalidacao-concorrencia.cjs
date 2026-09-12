/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto'),{Client}=require('pg');
async function main(){
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try{
 const v=(await a.query("SELECT c.id,cf.versao_vigente_id FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id WHERE c.status='ASSINADO' AND cf.versao_vigente_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM festas f WHERE f.contrato_id=c.id) LIMIT 1")).rows[0];assert(v,'Crie contrato elegível no clone automatizado.');
 const user=(await a.query('SELECT id FROM usuarios_administrativos WHERE ativo=true LIMIT 1')).rows[0].id;
 const insert=client=>client.query('INSERT INTO festas(contrato_id,versao_contratual_criacao_id,chave_criacao,payload_hash,criado_por) VALUES($1,$2,$3,$4,$5) RETURNING id',[v.id,v.versao_vigente_id,randomUUID(),'a'.repeat(64),user]);
 async function blocked(){const pid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;return pid;}
 const pid=await blocked();
 async function waitLock(){for(let i=0;i<100;i++){const r=(await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];if(r?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20));}throw Error('Operação concorrente não aguardou bloqueio.');}
 await a.query('BEGIN');const first=(await insert(a)).rows[0].id;
 const duplicate=insert(b).then(()=>null,e=>e.code);await waitLock();await a.query('COMMIT');assert.equal(await duplicate,'23505');
 await a.query('BEGIN');await a.query('UPDATE festas SET invalidada_em=clock_timestamp(),invalidada_por=$2,motivo_invalidacao=$3 WHERE id=$1',[first,user,'Fixture concorrência: criada por engano']);
 const child=b.query("INSERT INTO festa_pendencias(festa_id,descricao,natureza,prioridade,criado_por) VALUES($1,'Concorrência','OPERACIONAL','NORMAL',$2)",[first,user]).then(()=>null,e=>e.code);await waitLock();await a.query('COMMIT');assert.equal(await child,'23514');
 const next=(await insert(a)).rows[0].id;assert.notEqual(next,first);assert.equal((await a.query('SELECT count(*) n FROM festas WHERE contrato_id=$1 AND invalidada_em IS NULL',[v.id])).rows[0].n,'1');
 fs.writeFileSync('.local-festa/results/invalidation-concurrency.json',JSON.stringify({criacaoConcorrente:'23505',atividadeDuranteInvalidacao:'23514',recriacao:true,umaAtiva:true},null,2));console.log('PASS concorrência física: criação duplicada, invalidação versus pendência, recriação e uma ativa.');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await a.end();await b.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
