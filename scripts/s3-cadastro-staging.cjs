/* eslint-disable @typescript-eslint/no-require-imports */
// S3 — cadastro público real em staging (docs/RODADA_FINAL_LANCAMENTO_20261013.md). SOMENTE LEITURA: não cria conta, empresa
// ou cobrança; o cadastro é feito por Felipe no navegador. Executar no Web Shell do srv-daif418ae00c73e8k2gg:
//   --s3-antes                 configuração da janela + nenhum bloqueio global que faria o cadastro responder 503
//   --s3-depois <CNPJ>         empresa criada pelo CNPJ sintético: ATIVA, teste de 15 dias, uma Gestão, sem cobrança; Kidmais intacta
//   --s3-restaurado            chaves da janela de volta ao estado anterior (ausentes); sem banco
const assert=require('node:assert/strict');
const SHA='73618a298673b837ef52b0380b74d22b3cab9edc'; // candidata da janela de 20/10 (antes: e819772, 13/10)
const ALVO=Object.freeze({servico:'srv-daif418ae00c73e8k2gg',host:'dpg-daidko3m8hqs73ce4jt0-a',database:'kidmais_staging_1z91'});
const REMETENTE='Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>';
const CHAVES_JANELA=['CADASTRO_PUBLICO_ATIVO','USUARIOS_CRIACAO_DIRETA','ASSINATURA_PLANOS_ATIVOS','COTACAO_PUBLICA_POR_EMPRESA'];

function servico(env){
 assert.equal(env.RENDER,'true','FORA_RENDER');assert.equal(env.RENDER_SERVICE_ID,ALVO.servico,'SERVICO_RECUSADO');
 assert.equal(env.KIDMAIS_DEPLOY_ENV,'staging','AMBIENTE_RECUSADO');assert.equal(env.RENDER_GIT_COMMIT,SHA,'CANDIDATA_DIVERGENTE');
}
/** Janela do S3: cadastro aberto, criação direta desligada, e-mail do E0. */
function janela(env){
 servico(env);
 assert.equal(env.CADASTRO_PUBLICO_ATIVO,'true','CADASTRO_FECHADO');
 assert.equal(env.USUARIOS_CRIACAO_DIRETA,'desativada','CRIACAO_DIRETA_LIGADA');
 assert.equal(env.EMAIL_PROVIDER,'resend','EMAIL_PROVEDOR');assert.equal(env.EMAIL_REMETENTE,REMETENTE,'EMAIL_REMETENTE');
 assert.ok(/^re_\S+$/.test(env.RESEND_API_KEY||''),'EMAIL_CHAVE');
 assert.ok(!env.ASSINATURA_TESTE_DIAS||env.ASSINATURA_TESTE_DIAS==='15','TESTE_DIFERENTE_DE_15');
}
function restaurado(env){
 servico(env);
 const presentes=CHAVES_JANELA.filter(k=>env[k]!==undefined&&env[k]!=='');
 return {resultado:presentes.length?'NAO_RESTAURADO':'RESTAURADO',presentes};
}
function conexao(env){
 const u=new URL(env.DATABASE_URL);
 assert.equal(u.hostname,ALVO.host,'HOST_RECUSADO');assert.equal(decodeURIComponent(u.pathname.slice(1)),ALVO.database,'BANCO_RECUSADO');
 return {connectionString:u.toString(),connectionTimeoutMillis:5000,ssl:env.DATABASE_SSL==='true'?{rejectUnauthorized:env.DATABASE_SSL_REJECT_UNAUTHORIZED!=='false'}:undefined};
}
async function somenteLeitura(c,fn){
 await c.query('BEGIN TRANSACTION READ ONLY');
 try{
  await c.query("SET LOCAL statement_timeout='10s'");
  const id=(await c.query("SELECT current_database() AS db, coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]),false) AS privado")).rows[0];
  assert.equal(id.db,ALVO.database,'BANCO_CONECTADO_DIVERGENTE');assert.equal(id.privado,true,'REDE_NAO_PRIVADA');
  return await fn();
 }finally{await c.query('ROLLBACK').catch(()=>{});}
}
const SQL_KIDMAIS=`SELECT count(*)::int AS empresas,
  (SELECT count(*) FROM empresa_assinaturas a JOIN empresas k ON k.id=a.empresa_id WHERE k.codigo='kidmais')::int AS assinaturas
  FROM empresas WHERE codigo='kidmais' AND status='ATIVA'`;
async function antes(c){
 return somenteLeitura(c,async()=>{
  const globais=(await c.query('SELECT count(*)::int AS n FROM bloqueios_agenda WHERE empresa_id IS NULL AND ativo AND data>=current_date')).rows[0].n;
  const kidmais=(await c.query(SQL_KIDMAIS)).rows[0];
  return {resultado:globais===0?'PRONTO_PARA_CADASTRO':'CADASTRO_RECUSARIA_503',bloqueiosGlobaisFuturos:globais,kidmais};
 });
}
function cnpj(v){const d=String(v||'').replace(/\D/g,'');assert.match(d,/^\d{14}$/,'CNPJ_INVALIDO');assert.notEqual(d,'20119900000160','CNPJ_DA_KIDMAIS');return d;}
async function depois(c,documento){
 return somenteLeitura(c,async()=>{
  const linhas=(await c.query(`SELECT e.status,
     a.situacao, (a.teste_fim - a.teste_inicio) = interval '15 days' AS quinze_dias, a.provedor_assinatura_id IS NULL AS sem_provedor,
     a.teste_fim > clock_timestamp() AS teste_vigente,
     (SELECT count(*) FROM memberships m WHERE m.empresa_id=e.id AND m.status='ATIVA' AND m.papel='REPRESENTANTE_AUTORIZADO')::int AS gestao,
     (SELECT count(*) FROM assinatura_contratacoes x WHERE x.empresa_id=e.id)::int AS contratacoes
   FROM cadastros_empresas ce JOIN empresas e ON e.id=ce.empresa_id LEFT JOIN empresa_assinaturas a ON a.empresa_id=e.id
   WHERE ce.documento=$1`,[documento])).rows;
  const kidmais=(await c.query(SQL_KIDMAIS)).rows[0];
  const e=linhas[0];
  const ok=linhas.length===1&&e.status==='ATIVA'&&e.situacao==='TESTE'&&e.quinze_dias===true&&e.sem_provedor===true&&e.teste_vigente===true
    &&e.gestao===1&&e.contratacoes===0&&kidmais.empresas===1&&kidmais.assinaturas===0;
  return {resultado:ok?'S3_PASS':'S3_DIVERGENTE',empresasComEsteCnpj:linhas.length,empresa:e??null,kidmais};
 });
}
async function principal(argv,env=process.env,Client){
 if(argv.length===1&&argv[0]==='--s3-restaurado')return restaurado(env);
 if(argv.length===1&&argv[0]==='--s3-antes'){janela(env);}
 else if(argv.length===2&&argv[0]==='--s3-depois'){servico(env);}
 else throw new Error('USO_RECUSADO');
 const documento=argv[0]==='--s3-depois'?cnpj(argv[1]):null;
 const c=new Client({...conexao(env),application_name:'kidmais-s3-somente-leitura'});c.on?.('error',()=>undefined);
 await c.connect();
 try{return documento?await depois(c,documento):await antes(c);}finally{await c.end().catch(()=>{});}
}
if(require.main===module){
 principal(process.argv.slice(2),process.env,require('pg').Client).then(r=>console.log(JSON.stringify(r)),e=>{console.error(String(e?.message??'RECUSADO').slice(0,120));process.exitCode=1;});
}
module.exports={SHA,ALVO,CHAVES_JANELA,janela,restaurado,conexao,antes,depois,cnpj,principal};
