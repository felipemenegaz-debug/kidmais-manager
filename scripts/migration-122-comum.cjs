/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual: hash revisado, alvo dos adaptadores existentes, conferência READ ONLY,
// marcador exclusivo no disco persistente e precheck → migration → postcheck → COMMIT.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {lerRevisado}=require('./migration-092-094-comum.cjs');
const {commitNaFalha}=require('./migration-118-comum.cjs');
const HASHES=require('./migration-122-hashes.json');
const arquivos=['database/checks/20261114_122_precheck.sql','database/migrations/20261114_122_oportunidades.sql','database/checks/20261114_122_postcheck.sql'];
const raiz=path.resolve(__dirname,'..');
function corpos(){return arquivos.map((a,i)=>lerRevisado(raiz,a,HASHES[i]));}
// [etapa, arquivo, sha256 LF]: lido pelo gerador dos blocos de produção (scripts/bloco-shell-promocao-production.cjs).
const ETAPAS=Object.freeze(arquivos.map((a,i)=>Object.freeze([['precheck','migration','postcheck'][i],a,HASHES[i]])));
function modo(argv){
 if(!argv.length)return 'plano';
 if(argv.length===1&&argv[0]==='--conferir-122')return 'conferir';
 if(argv.length===3&&argv[0]==='--aplicar-122-autorizado'&&argv[1]==='--backup'&&/^[A-Za-z0-9:._/ -]{6,120}$/.test(argv[2]))return 'aplicar';
 throw Error('ARGUMENTOS_OU_BACKUP_RECUSADOS');
}
const SQL_ESTADO=`SELECT to_regclass('public.oportunidades_acoes') IS NOT NULL AS a,
 to_regclass('public.oportunidades_marcos') IS NOT NULL AS m,to_regclass('public.oportunidades_resumos') IS NOT NULL AS r,
 EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='perdida_em') AS f,
 EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='marketing_contatos' AND column_name='perdida_em') AS c`;
function estado(linha){const n=Object.values(linha).filter(Boolean).length;if(n===0)return 'ausente';if(n===5)return 'presente';throw Error('ESTADO_PARCIAL');}
function corpo(sql){return sql.split(/\r?\n/).filter(l=>!/^\s*(BEGIN|COMMIT);\s*$/i.test(l)).join('\n');}
async function privilegios(db){
 const l=(await db.query(`SELECT has_schema_privilege(current_user,'public','USAGE') AS uso,
 has_schema_privilege(current_user,'public','CREATE') AS criar,
 (SELECT bool_and(pg_has_role(current_user,c.relowner,'MEMBER')) FROM pg_class c WHERE c.oid IN ('public.fechamentos'::regclass,'public.marketing_contatos'::regclass)) AS dono,
 has_table_privilege(current_user,'public.empresas','REFERENCES') AND has_table_privilege(current_user,'public.usuarios_administrativos','REFERENCES') AS referencias`)).rows[0];
 assert.ok(l?.uso&&l?.criar&&l?.dono&&l?.referencias,'PRIVILEGIOS_INSUFICIENTES');
}
function criarAplicador(amb){
 async function conferirCliente(db,env){
  await db.query('BEGIN TRANSACTION READ ONLY');
  try{await db.query("SET LOCAL lock_timeout='5s'");amb.identidade((await db.query(amb.SQL_IDENTIDADE)).rows[0],env);await privilegios(db);
   const s=estado((await db.query(SQL_ESTADO)).rows[0]),sql=corpos();await db.query(corpo(s==='ausente'?sql[0]:sql[2]));await db.query('COMMIT');return s;
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 }
 // Contrato dos núcleos da cadeia de promoção (como a 118): 0 PLANO/CONFERIDO/PASS; 1 recusa local lançada (argumentos, alvo,
 // hash, disco, marcador anterior); 2 FALHA devolvida, com falha.etapa (CONEXAO no primeiro passo). Marcador exclusivo ANTES de conectar.
 // Não ecoa mensagens do driver (podem conter credencial ou dado comercial): só rótulos próprios (ESTADO_PARCIAL...) e o SQLSTATE.
 const mensagem=e=>{const t=String(e?.message??'');return /^[A-Z][A-Z0-9_]{2,79}$/.test(t)?t:'mensagem do driver omitida (ver codigoSql)';};
 const sqlstate=e=>/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:null;
 async function principal(argv,env,deps={}){
  const m=modo(argv),sql=corpos();
  if(m==='plano')return {codigo:0,saida:{resultado:'PLANO',conecta:false,ambiente:amb.nome,arquivos:arquivos.map((arquivo,i)=>({arquivo,sha256:HASHES[i]}))}};
  const cfg=amb.alvo(env),Client=deps.Client??require('pg').Client;
  if(m==='conferir'){
   const db=new Client(cfg);db.on?.('error',()=>undefined);let etapa='CONEXAO';
   try{await db.connect();etapa='CONFERIR';const s=await conferirCliente(db,env);
    return {codigo:0,saida:{resultado:s==='presente'?'JA_APLICADA_POSTCHECK_PASS':'PRONTA_PARA_APLICAR'}};
   }catch(e){return {codigo:2,saida:{resultado:'FALHA',commit:'NAO_SE_APLICA',falha:{etapa,mensagem:mensagem(e)},codigoSql:sqlstate(e)}};}
   finally{await db.end().catch(()=>{});}
  }
  amb.exigirDisco();fs.mkdirSync(amb.DIR,{recursive:true,mode:0o700});const arquivo=path.join(amb.DIR,'migration-122.json');
  const registro={ambiente:amb.nome,inicio:new Date().toISOString(),backup:argv[2],etapa:'INICIADA',commit:'NAO_COMMITADA'};
  try{fs.writeFileSync(arquivo,JSON.stringify(registro),{flag:'wx',mode:0o600});}
  catch(e){if(e?.code==='EEXIST')assert.fail('TENTATIVA_ANTERIOR_REVISAR '+arquivo);throw e;}
  const db=new Client(cfg);db.on?.('error',()=>undefined);let commit='NAO_COMMITADA',etapa='CONEXAO';
  try{await db.connect();etapa='CONFERIR';const s=await conferirCliente(db,env);
   assert.equal(s,'ausente','JA_PRESENTE_NAO_REAPLICAR');
   await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
   amb.identidade((await db.query(amb.SQL_IDENTIDADE)).rows[0],env);await privilegios(db);
   for(let i=0;i<sql.length;i++){etapa=['PRECHECK','MIGRATION','POSTCHECK'][i];await db.query(corpo(sql[i]));}
   etapa='COMMIT';const r=await db.query('COMMIT');assert.notEqual(r.command,'ROLLBACK','COMMIT_RESPONDEU_ROLLBACK');commit='CONFIRMADO';
   etapa='RECONFERIR';await conferirCliente(db,env);fs.writeFileSync(arquivo,JSON.stringify({...registro,etapa:'PASS',commit}));
   return {codigo:0,saida:{resultado:'APLICADA_POSTCHECK_PASS',commit}};
  }catch(e){if(etapa==='COMMIT')commit=commitNaFalha(e);await db.query('ROLLBACK').catch(()=>{});
   const saida={resultado:'FALHA',commit,falha:{etapa,mensagem:mensagem(e)},codigoSql:sqlstate(e)};
   try{fs.writeFileSync(arquivo,JSON.stringify({...registro,etapa,commit,falha:saida.falha,codigoSql:saida.codigoSql}));}catch{saida.marcadorDesatualizado=true;}
   return {codigo:2,saida};
  }finally{await db.end().catch(()=>{});}
 }
 function cli(){principal(process.argv.slice(2),process.env).then(r=>{console.log(JSON.stringify(r.saida));process.exitCode=r.codigo;}).catch(e=>{
  // Só recusas locais chegam aqui (argumentos, ambiente, alvo, hash): falhas do driver viram saída do principal.
  console.error('RECUSADO '+String(e?.message??e).replace(/postgres(?:ql)?:\/\/\S+/gi,'<url>').slice(0,160));process.exitCode=1;});}
 return {principal,cli,conferirCliente};
}
module.exports={criarAplicador,modo,corpo,SQL_ESTADO,estado,arquivos,ETAPAS};
