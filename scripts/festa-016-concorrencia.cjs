/* eslint-disable @typescript-eslint/no-require-imports */
require('./festa-016-test-environment.cjs').assertAutomated();
/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),fs=require('node:fs'),{Client}=require('pg');
async function main(){
 const make=()=>new Client({connectionString:process.env.DATABASE_URL});const a=make(),b=make(),observer=make();await Promise.all([a.connect(),b.connect(),observer.connect()]);
 try{
 assert.match((await a.query('SELECT current_database() n')).rows[0].n,/^kidmais_016_\d+$/);
 const festaId=JSON.parse(fs.readFileSync('.local-festa/results/vigencia.json')).festaId;
 await a.query("INSERT INTO festa_contagens_convidados(festa_id,total_presentes,observado_em,versao_contratual_id,convidados_contratados,criado_por,chave_idempotencia) SELECT f.id,50,now(),cf.versao_vigente_id,70,f.criado_por,$2 FROM festas f JOIN contrato_fluxos cf ON cf.contrato_id=f.contrato_id WHERE f.id=$1",[festaId,randomUUID()]);
 const base=(await a.query('SELECT c.*,c.observado_em::text observado_em FROM festa_contagens_convidados c JOIN festas f ON f.id=c.festa_id WHERE festa_id=$1 AND NOT EXISTS(SELECT 1 FROM festa_contagens_convidados x WHERE x.corrige_contagem_id=c.id) ORDER BY sequencia DESC LIMIT 1',[festaId])).rows[0];
 const sql='INSERT INTO festa_contagens_convidados(festa_id,total_presentes,observado_em,corrige_contagem_id,motivo,versao_contratual_id,convidados_contratados,criado_por,chave_idempotencia) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id';
 const args=n=>[base.festa_id,n,base.observado_em,base.id,'Teste concorrente direto da constraint',base.versao_contratual_id,base.convidados_contratados,base.criado_por,randomUUID()];
 await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL statement_timeout='10s'");
 const winner=(await a.query(sql,args(60))).rows[0];
 const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const loser=b.query(sql,args(59)).then(()=>({code:'unexpected-success'}),e=>e);
 let blocked=false;for(let i=0;i<30;i++){if((await observer.query('SELECT cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n){blocked=true;break;}await new Promise(r=>setTimeout(r,30));}
 assert(blocked,'Conexão concorrente deve bloquear na origem da correção');await a.query('COMMIT');assert.equal((await loser).code,'23505');await b.query('ROLLBACK');
 assert.equal((await observer.query('SELECT count(*)::int n FROM festa_contagens_convidados WHERE corrige_contagem_id=$1',[base.id])).rows[0].n,1);
 await a.query('BEGIN');const nextArgs=args(58);nextArgs[3]=winner.id;await a.query(sql,nextArgs);await a.query('ROLLBACK');
 fs.writeFileSync('.local-festa/results/concurrency.json',JSON.stringify({bloqueioRealPostgreSQL:true,ramificacaoRecusada:'23505',correcaoDaUltimaPermitida:true}));console.log('PASS concorrência PostgreSQL: segundo corretor bloqueia; somente uma correção direta; próxima correção exige a folha.');
 }finally{await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')]);await Promise.all([a.end(),b.end(),observer.end()]);}
}
main().catch(e=>{console.error(e);process.exitCode=1});
