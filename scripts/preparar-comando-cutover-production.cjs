/* eslint-disable @typescript-eslint/no-require-imports */
// Preparação offline do comando autossuficiente da virada (migrations + reparo) para o Web Shell de produção.
// Não conecta em nada. Gera docs/evidencias/cutover-production-comando-20261013.txt com cada arquivo em base64 + SHA-256.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const raiz=path.resolve(__dirname,'..');
const MANIFESTO='docs/MIGRATIONS_PRODUCTION_LANCAMENTO_20261011.json';
function arquivos(){
 const m=JSON.parse(fs.readFileSync(path.join(raiz,MANIFESTO),'utf8'));
 return ['scripts/cutover-lancamento-production.cjs','scripts/migrations-lancamento-production.cjs','scripts/reparo-bloqueios-production.cjs',
  'scripts/diagnostico-lancamento-production.cjs',MANIFESTO,'database/repairs/20261011_lancamento_bloqueios_kidmais.sql',
  ...m.migrations.flatMap(e=>e.arquivos.map(a=>a.arquivo))];
}
/** Conteúdo normalizado (LF), igual ao que os verificadores de hash leem. */
function pacote(){
 return arquivos().map(rel=>{const t=fs.readFileSync(path.join(raiz,rel),'utf8').replace(/\r\n/g,'\n');
  return {rel,sha256:createHash('sha256').update(t).digest('hex'),base64:Buffer.from(t).toString('base64')};});
}
function comando(){
 const p=pacote();
 return ["node - --cutover-autorizado REGISTRO_BACKUP <<'KIDMAIS_CUTOVER_NODE'",
  "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');",
  "const a=process.argv.slice(2);assert.equal(a.length,2);assert.equal(a[0],'--cutover-autorizado');assert.match(a[1],/^\\/opt\\/render\\/project\\/src\\/data\\/lancamento-venda-20261011\\/[A-Za-z0-9._-]+\\.json$/,'REGISTRO_BACKUP_INVALIDO');",
  'const pacote='+JSON.stringify(p)+';',
  "const dir=fs.mkdtempSync('/tmp/kidmais-cutover-');fs.chmodSync(dir,0o700);",
  "for(const f of pacote){const t=Buffer.from(f.base64,'base64');assert.equal(crypto.createHash('sha256').update(t).digest('hex'),f.sha256,'HASH '+f.rel);const d=path.join(dir,f.rel);fs.mkdirSync(path.dirname(d),{recursive:true,mode:0o700});fs.writeFileSync(d,t,{flag:'wx',mode:0o600});}",
  "const r=spawnSync(process.execPath,[path.join(dir,'scripts/cutover-lancamento-production.cjs'),'--cutover-autorizado','--backup',a[1]],{stdio:'inherit',env:{...process.env,NODE_PATH:'/opt/render/project/src/node_modules'},timeout:540000});",
  "process.exitCode=r.status??1;",
  'KIDMAIS_CUTOVER_NODE'].join('\n')+'\n';
}
if(require.main===module){fs.writeFileSync(path.join(raiz,'docs/evidencias/cutover-production-comando-20261013.txt'),comando());console.log('COMANDO_CUTOVER_PREPARADO_SEM_EXECUCAO');}
module.exports={arquivos,pacote,comando};
