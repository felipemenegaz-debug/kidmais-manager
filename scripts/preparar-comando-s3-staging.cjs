/* eslint-disable @typescript-eslint/no-require-imports */
// Preparação offline dos três comandos do S3 (antes, depois, restaurado) para o Web Shell de staging. Não conecta em nada.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const raiz=path.resolve(__dirname,'..');
const CNPJ_SINTETICO='82654321000174';
function bloco(args){
 const fonte=fs.readFileSync(path.join(raiz,'scripts/s3-cadastro-staging.cjs'),'utf8').replace(/\r\n/g,'\n');
 const p={sha256:createHash('sha256').update(fonte).digest('hex'),base64:Buffer.from(fonte).toString('base64')};
 return ["node - "+args.join(' ')+" <<'KIDMAIS_S3_NODE'",
  "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');",
  'const p='+JSON.stringify(p)+';',
  "const t=Buffer.from(p.base64,'base64');assert.equal(crypto.createHash('sha256').update(t).digest('hex'),p.sha256);",
  "const dir=fs.mkdtempSync('/tmp/kidmais-s3-');fs.chmodSync(dir,0o700);const f=path.join(dir,'s3.cjs');fs.writeFileSync(f,t,{flag:'wx',mode:0o600});",
  "const r=spawnSync(process.execPath,[f,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,NODE_PATH:'/opt/render/project/src/node_modules'},timeout:60000});process.exitCode=r.status??1;",
  'KIDMAIS_S3_NODE'].join('\n');
}
function comandos(){
 return ['# S3-A — antes do cadastro (somente leitura): esperado PRONTO_PARA_CADASTRO',bloco(['--s3-antes']),'',
  '# S3-B — depois do cadastro (somente leitura): esperado S3_PASS',bloco(['--s3-depois',CNPJ_SINTETICO]),'',
  '# S3-C — depois de remover as chaves e do deploy de restauração (sem banco): esperado RESTAURADO',bloco(['--s3-restaurado']),''].join('\n');
}
if(require.main===module){fs.writeFileSync(path.join(raiz,'docs/evidencias/s3-staging-comandos-20261013.txt'),comandos());console.log('COMANDOS_S3_PREPARADOS_SEM_EXECUCAO');}
module.exports={CNPJ_SINTETICO,comandos};
