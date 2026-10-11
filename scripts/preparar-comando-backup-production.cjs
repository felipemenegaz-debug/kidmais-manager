/* eslint-disable @typescript-eslint/no-require-imports */
// Gera apenas documento local. Nao conecta, nao carrega secrets e nao executa backup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const raiz=path.resolve(__dirname,'..');
const arquivos=['backup-lancamento-production.cjs','diagnostico-lancamento-production.cjs','migrations-lancamento-production.cjs'].map(nome=>{
 const conteudo=fs.readFileSync(path.join(raiz,'scripts',nome),'utf8').replace(/\r\n/g,'\n');
 return {nome,sha256:crypto.createHash('sha256').update(conteudo).digest('hex'),base64:Buffer.from(conteudo).toString('base64')};
});
const linhas=[
 "node - --backup-production-autorizado --pitr-confirmado 'HORA_UTC_PITR_CONFIRMADA' <<'KIDMAIS_BACKUP_NODE'",
 "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');",
 "assert.equal(process.argv[2],'--backup-production-autorizado');assert.equal(process.argv[3],'--pitr-confirmado');assert.equal(process.argv.length,5);",
 'const arquivos='+JSON.stringify(arquivos)+';',
 "const dir=fs.mkdtempSync('/tmp/kidmais-backup-');fs.chmodSync(dir,0o700);",
 "for(const a of arquivos){const dados=Buffer.from(a.base64,'base64');assert.equal(crypto.createHash('sha256').update(dados).digest('hex'),a.sha256);fs.writeFileSync(path.join(dir,a.nome),dados,{flag:'wx',mode:0o600});}",
 "const backup=require(path.join(dir,'backup-lancamento-production.cjs'));",
 "backup.exportar({pitr:process.argv[4],criarCliente:opts=>new(require('/opt/render/project/src/node_modules/pg').Client)(opts)}).then(r=>console.log(JSON.stringify(r)),()=>{console.error('BACKUP_NAO_CONCLUIDO: parar, preservar arquivos e investigar sem repetir.');process.exitCode=1;});",
 'KIDMAIS_BACKUP_NODE',
];
fs.writeFileSync(path.join(raiz,'docs/evidencias/backup-production-comando-codex-20261011.txt'),linhas.join('\n')+'\n');
console.log('COMANDO_PREPARADO_SEM_CONEXAO');
