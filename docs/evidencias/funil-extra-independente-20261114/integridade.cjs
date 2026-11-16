const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const raiz=path.resolve(__dirname,'../../..');process.chdir(raiz);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const atual=JSON.parse(fs.readFileSync('docs/evidencias/funil-20261114/manifesto.json'));
const anterior=JSON.parse(fs.readFileSync('docs/evidencias/funil-extra-20261114/manifesto-anterior.json'));
const ev=JSON.parse(fs.readFileSync('docs/evidencias/funil-extra-20261114/sha256.json')).evidencias;
const novos=atual.arquivos.filter(x=>!anterior.arquivos.some(y=>x.arquivo===y.arquivo));
const alterados=atual.arquivos.filter(x=>anterior.arquivos.some(y=>x.arquivo===y.arquivo&&x.sha256!==y.sha256));
const r={data:new Date().toISOString(),head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),atual:{n:atual.arquivos.length,divergentes:atual.arquivos.filter(x=>hash(x.arquivo)!==x.sha256)},evidencias:{n:ev.length,divergentes:ev.filter(x=>hash(x.arquivo)!==x.sha256)},adicionados:novos.map(x=>x.arquivo),alterados:alterados.map(x=>x.arquivo),intocados:atual.intocadosConferidos.map(arquivo=>({arquivo,igual:atual.arquivos.find(x=>x.arquivo===arquivo).sha256===anterior.arquivos.find(x=>x.arquivo===arquivo).sha256})),codigo:[]};
for(const dir of ['app','components','lib','scripts','database']){
 function scan(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())scan(p);else r.codigo.push({arquivo:p,sha256:hash(p)});}}scan(dir);
}
const destino=path.join(__dirname,process.argv[2]==='fim'?'integridade-final.json':'integridade-inicial.json');
if(process.argv[2]==='fim'){
 const ini=JSON.parse(fs.readFileSync(path.join(__dirname,'integridade-inicial.json')));
 r.codigoDivergente=r.codigo.filter(x=>ini.codigo.find(y=>y.arquivo===x.arquivo)?.sha256!==x.sha256);
 if(r.codigo.length!==ini.codigo.length||r.codigoDivergente.length)throw Error('código alterado durante revisão');
}
fs.writeFileSync(destino,JSON.stringify(r,null,2));
console.log(JSON.stringify({head:r.head,manifesto:r.atual,evidencias:r.evidencias,adicionados:r.adicionados,alterados:r.alterados,intocados:r.intocados.length,codigo:r.codigo.length,codigoDivergente:r.codigoDivergente?.length}));
if(r.atual.divergentes.length||r.evidencias.divergentes.length||r.intocados.some(x=>!x.igual))process.exitCode=1;
