/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da virada: nenhuma conexão, nenhum Shell. Execução simulada das etapas e conferência do comando gerado.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const cut=require('./cutover-lancamento-production.cjs');
const gen=require('./preparar-comando-cutover-production.cjs');
const BACKUP='/opt/render/project/src/data/lancamento-venda-20261011/backup-registro.json';

test('etapas: as seis migrations do manifesto na ordem e o reparo por último', ()=>{
 assert.deepEqual(cut.etapas().map(e=>e.id),['074a','075','076','077','078','079','bloqueios-kidmais']);
 assert.deepEqual(cut.comando({tipo:'migration',id:'078'},BACKUP,'/x').slice(1),['--aplicar-migration-autorizada','078','--backup',BACKUP]);
 assert.deepEqual(cut.comando({tipo:'reparo'},BACKUP,'/x').slice(1),['--aplicar-reparo-autorizado','--backup',BACKUP]);
});

test('sequência: para na primeira falha (sem tentar as seguintes) e só passa com todas', ()=>{
 const chamadas=[];
 const parou=cut.sequencia(BACKUP,args=>{chamadas.push(args[2]??args[1]);return args.includes('076')?{status:1,saida:'PRECHECK_076'}:{status:0,saida:'{"resultado":"APLICADA_POSTCHECK_PASS"}'};});
 assert.equal(parou.resultado,'PARADO');assert.equal(parou.etapa,'076');assert.deepEqual(parou.feitas.map(f=>f.etapa),['074a','075']);
 assert.deepEqual(chamadas,['074a','075','076']);
 const ok=cut.sequencia(BACKUP,()=>({status:0,saida:'ok'}));
 assert.equal(ok.resultado,'CUTOVER_BANCO_PASS');assert.equal(ok.feitas.length,7);
});

test('comando gerado: arquivos com hash do conteúdo atual, sintaxe válida, registro de backup obrigatório, sem segredo', ()=>{
 const p=gen.pacote();
 assert.equal(p.length,7+18-1,'5 scripts/docs + reparo + 18 SQL do manifesto');
 for(const f of p){const t=fs.readFileSync(path.join(__dirname,'..',f.rel),'utf8').replace(/\r\n/g,'\n');assert.equal(Buffer.from(f.base64,'base64').toString(),t,f.rel);}
 const c=gen.comando();
 assert.match(c,/REGISTRO_BACKUP/);assert.match(c,/NODE_PATH:'\/opt\/render\/project\/src\/node_modules'/);
 assert.doesNotMatch(c,/DATABASE_URL=|postgres(ql)?:\/\/|\$aact_|re_[A-Za-z0-9]{8}/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutover-'));const f=path.join(dir,'c.sh');fs.writeFileSync(f,c);
 const b=spawnSync('bash',['-n',f],{encoding:'utf8'});assert.equal(b.status,0,b.stderr);
 // O JavaScript embutido no heredoc compila.
 const js=c.split('\n').slice(1,-2).join('\n');assert.doesNotThrow(()=>new Function('require','process',js));
});

test('o arquivo versionado do comando corresponde ao gerador (regerar se algum arquivo mudar)', ()=>{
 const arquivo=path.join(__dirname,'..','docs/evidencias/cutover-production-comando-20261013.txt');
 assert.equal(fs.readFileSync(arquivo,'utf8').replace(/\r\n/g,'\n'),gen.comando());
});
