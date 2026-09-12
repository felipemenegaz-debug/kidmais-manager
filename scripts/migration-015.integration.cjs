/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
async function main(){
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  const banco=(await c.query('SELECT current_database() banco')).rows[0].banco;
  assert.match(banco,/^kidmais_015_\d+$/,'Este runner recusa banco real');
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map(x=>x.tablename);
  assert.equal(tables.length,40,'Iniciar com clone anterior à 015');
  async function fingerprints(){const result={};for(const t of tables){const rows=(await c.query('SELECT to_jsonb(t)::text row FROM "'+t+'" t ORDER BY to_jsonb(t)::text')).rows;result[t]=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');}return result;}
  const antes=await fingerprints();
  async function sql(p){await c.query(fs.readFileSync(p,'utf8'));}
  const migration='database/migrations/20260910_015_tratamento_financeiro.sql',pre='database/checks/20260910_015_precheck.sql',post='database/checks/20260910_015_postcheck.sql',down='database/rollback/20260910_015_tratamento_financeiro_down.sql';
  await sql(pre);await sql(migration);await sql(post);assert.deepEqual(await fingerprints(),antes);
  assert.equal((await c.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'52');
  await sql(down);assert.deepEqual(await fingerprints(),antes);await sql(pre);await sql(migration);await sql(post);
  const p=(await c.query('SELECT p.id,v.contrato_id FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id LIMIT 1')).rows[0];
  // Uma gestão já é história: nem o rollback pode apagá-la.
  await c.query('BEGIN');await c.query('INSERT INTO pagamento_gestoes(pagamento_id,contrato_id) VALUES($1,$2)',[p.id,p.contrato_id]);
  await assert.rejects(c.query(fs.readFileSync(down,'utf8')),/Rollback recusado/);await c.query('ROLLBACK');
  assert.deepEqual(await fingerprints(),antes);
  for(const query of ["UPDATE pagamentos SET valor_total_contratado=valor_total_contratado+1", "UPDATE pagamento_recebimentos SET observacoes='alteração indevida' WHERE status='CONFIRMADO'", "DELETE FROM pagamento_estornos WHERE status='CONFIRMADO'"]){await c.query('BEGIN');await assert.rejects(c.query(query));await c.query('ROLLBACK');}
  console.log(JSON.stringify({banco,precheck:true,postcheck:true,aplicacaoRollbackReaplicacao:true,rollbackComHistoricoRecusado:true,tabelasAntigasIntactas:tables.length}));
 }finally{await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
