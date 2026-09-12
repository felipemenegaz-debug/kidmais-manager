/* eslint-disable @typescript-eslint/no-require-imports */
const { Client } = require('pg');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
async function main() {
 const reportPath='.backups/pre-013-20260909-183215/teste-isolado.json';
 const report=JSON.parse(fs.readFileSync(reportPath));
 assert.match(report.banco,/^kidmais_013_test_\d+$/);
 const url=new URL(process.env.DATABASE_URL);url.pathname='/'+report.banco;
 const c=new Client({connectionString:url.toString()});await c.connect();
 try {
  const u=(await c.query('SELECT id,nome,cargo FROM usuarios_administrativos LIMIT 1')).rows[0];
  const f=(await c.query('SELECT f.id FROM fechamentos f WHERE NOT EXISTS(SELECT 1 FROM contratos c WHERE c.fechamento_id=f.id) LIMIT 1')).rows[0];
  assert(f,'fixture precisa de fechamento sem contrato');
  const source=(await c.query('SELECT snapshot,snapshot_hash FROM contrato_versoes LIMIT 1')).rows[0];
  const cid=crypto.randomUUID(),vid=crypto.randomUUID();
  await c.query('BEGIN');
  await c.query('INSERT INTO contratos(id,fechamento_id,versao_atual) VALUES($1,$2,1)',[cid,f.id]);
  await c.query('INSERT INTO contrato_versoes(id,contrato_id,numero_versao,snapshot,snapshot_hash) VALUES($1,$2,1,$3,$4)',[vid,cid,source.snapshot,source.snapshot_hash]);
  await c.query("INSERT INTO contrato_edicoes(contrato_versao_id,contrato_id,tipo,estado,dados_fonte,alteracoes,criado_por_usuario_id,atualizado_por_usuario_id) VALUES($1,$2,'INICIAL','EM_ELABORACAO','{\"schemaVersao\":1}','{}',$3,$3)",[vid,cid,u.id]);
  await c.query('INSERT INTO contrato_fluxos(contrato_id,versao_em_preparacao_id) VALUES($1,$2)',[cid,vid]);
  await c.query('COMMIT');
  report.results.push('versão/edição/fluxo sintéticos em transação OK');
  const bytes=Buffer.from('%PDF-1.4\nSynthetic migration integrity fixture\n%%EOF');
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const insert="INSERT INTO contrato_documentos(contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf,gerado_por_usuario_id) VALUES($1,'CONTRATO',1,$2,'SYNTHETIC',1,$3,$4,$5,$6) RETURNING id";
  const args=[vid,source.snapshot_hash,hash,bytes.length,bytes,u.id];
  const d=(await c.query(insert,args)).rows[0];
  await assert.rejects(c.query(insert,[vid,source.snapshot_hash,'0'.repeat(64),bytes.length,bytes,u.id]),e=>e.code==='23514');
  await assert.rejects(c.query(insert,[vid,source.snapshot_hash,hash,bytes.length+1,bytes,u.id]),e=>e.code==='23514');
  await assert.rejects(c.query('UPDATE contrato_documentos SET template_versao=2 WHERE id=$1',[d.id]),e=>e.code==='23514');
  await assert.rejects(c.query('DELETE FROM contrato_documentos WHERE id=$1',[d.id]),e=>e.code==='23514');
  assert((await c.query('SELECT conteudo_pdf FROM contrato_documentos WHERE id=$1',[d.id])).rows[0].conteudo_pdf.equals(bytes));
  report.results.push('BYTEA exato; hash/tamanho incompatíveis e UPDATE/DELETE recusados');
  await c.query('UPDATE contrato_edicoes SET documento_revisado_id=$2,revisado_por_usuario_id=$3,revisado_em=now(),revisao_comercial_aprovada=1,aprovado_comercial_por_usuario_id=$3,aprovado_comercial_em=now() WHERE contrato_versao_id=$1',[vid,d.id,u.id]);
  const session=(await c.query("INSERT INTO sessoes_administrativas(usuario_id,token_hash,csrf_hash,autenticado_em,ultima_atividade_em,expira_em) VALUES($1,$2,$3,now(),now(),now()+interval '1 hour') RETURNING id,autenticado_em::text",[u.id,crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')])).rows[0];
  await c.query('BEGIN');
  const proofDoc=(await c.query("INSERT INTO contrato_documentos(contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf,gerado_por_usuario_id) VALUES($1,'COMPROVANTE_ASSINATURA',1,$2,'SYNTHETIC',1,$3,$4,$5,$6) RETURNING id",args)).rows[0];
  await c.query("INSERT INTO contrato_assinaturas(contrato_versao_id,parte,documento_id,usuario_id,sessao_id,autenticacao_metodo,autenticado_em,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,request_id,chave_idempotencia,comprovante_documento_id) VALUES($1,'KIDMAIS',$2,$3,$4,'SENHA',$5,$6,$7,$8,'SESSAO_REAUTENTICADA','INTERNAL',clock_timestamp(),$9,$10,$11)",[vid,d.id,u.id,session.id,session.autenticado_em,{schemaVersao:1,usuarioId:u.id,nome:u.nome,cargo:u.cargo,papel:'REPRESENTANTE_AUTORIZADO'},source.snapshot_hash,hash,crypto.randomUUID(),crypto.randomUUID(),proofDoc.id]);
  await c.query("UPDATE contrato_edicoes SET estado='ASSINADA_KIDMAIS' WHERE contrato_versao_id=$1",[vid]);
  await c.query('COMMIT');
  const signatureBefore=(await c.query('SELECT to_jsonb(a)::text AS row FROM contrato_assinaturas a WHERE contrato_versao_id=$1',[vid])).rows;
  await c.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE id=$1',[session.id]);
  await c.query('DELETE FROM sessoes_administrativas WHERE id=$1',[session.id]);
  await c.query("UPDATE contrato_edicoes SET estado='AGUARDANDO_CLIENTE',liberado_por_usuario_id=$2,liberado_em=clock_timestamp() WHERE contrato_versao_id=$1",[vid,u.id]);
  assert.deepEqual((await c.query('SELECT to_jsonb(a)::text AS row FROM contrato_assinaturas a WHERE contrato_versao_id=$1',[vid])).rows,signatureBefore);
  await assert.rejects(c.query("UPDATE contrato_versoes SET snapshot='{}' WHERE id=$1",[vid]),e=>e.code==='23514');
  await assert.rejects(c.query('DELETE FROM contrato_assinaturas WHERE contrato_versao_id=$1',[vid]),e=>e.code==='23514');
  report.results.push('assinatura Kidmais; sessão excluída sem invalidar prova/liberação; fonte/prova congeladas');
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 } finally {await c.query('ROLLBACK');await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
