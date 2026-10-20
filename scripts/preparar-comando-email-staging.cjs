/* eslint-disable @typescript-eslint/no-require-imports */
// Preparacao offline do comando; nao configura Render e nao envia mensagem.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const raiz=path.resolve(__dirname,'..'),fonte=fs.readFileSync(path.join(raiz,'scripts/email-staging-lancamento.cjs'),'utf8').replace(/\r\n/g,'\n');
const pacote={sha256:createHash('sha256').update(fonte).digest('hex'),base64:Buffer.from(fonte).toString('base64')};
const linhas=[
 "node --experimental-strip-types - --email-staging-autorizado <<'KIDMAIS_EMAIL_NODE'",
 "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');",
 "assert.deepEqual(process.argv.slice(2),['--email-staging-autorizado']);",
 'const pacote='+JSON.stringify(pacote)+';',
 "const fonte=Buffer.from(pacote.base64,'base64');assert.equal(crypto.createHash('sha256').update(fonte).digest('hex'),pacote.sha256);",
 "const dir=fs.mkdtempSync('/tmp/kidmais-email-');fs.chmodSync(dir,0o700);const arquivo=path.join(dir,'email.cjs');fs.writeFileSync(arquivo,fonte,{flag:'wx',mode:0o600});",
 "require(arquivo).testar().then(r=>console.log(JSON.stringify(r)),()=>{console.error('EMAIL_TESTE_NAO_CONCLUIDO: conferir estado, sem repetir automaticamente.');process.exitCode=1;});",
 'KIDMAIS_EMAIL_NODE',
];
fs.writeFileSync(path.join(raiz,'docs/evidencias/email-staging-comando-codex-20261011.txt'),linhas.join('\n')+'\n');console.log('COMANDO_EMAIL_PREPARADO_SEM_ENVIO');
