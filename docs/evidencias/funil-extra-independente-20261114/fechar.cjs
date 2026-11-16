const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const raiz=path.resolve(__dirname,'../../..');
const workspace=path.resolve(raiz,'..');
const vault=path.join(workspace,'Kidmais-Manager-Second-Brain');
const alvos=[
 path.join(raiz,'docs/PARECER_ASTRA_FUNIL_EXTRA_INDEPENDENTE_20261114.md'),
 path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/Funil de oportunidades proposta 20261114.md'),
 path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/Fila unica 20261111.md'),
 path.join(vault,'02 - Kidmais Manager SaaS/07 - Roadmap/SaaS - Roadmap.md'),
 path.join(vault,'02 - Kidmais Manager SaaS/Kidmais Manager SaaS - Home.md'),
 path.join(workspace,'orquestracao/relatos.md'),
 path.join(__dirname,'registrar-documentacao.cjs')
];
// Ajustes apenas de espaços nos registros novos; a cronologia anterior é preservada.
const ajustes=[['das18:58','das 18:58'],['em127.0.0.1','em 127.0.0.1'],['modelos086','modelos 086'],['e122','e 122'],['Integridade:56','Integridade: 56'],['e77/77','e 77/77'],['dos3.221','dos 3.221'],['às19:13','às 19:13'],['0,42GB','0,42 GB'],['Node24.20.0','Node 24.20.0'],['Node22','Node 22'],['PostgreSQL18','PostgreSQL 18'],['19:16 UTC','19:16 UTC'],['14/11/2026,19:16','14/11/2026, 19:16'],['14/11,19:16','14/11, 19:16'],['em14/11/2026','em 14/11/2026'],['próprias44','próprias 44'],['próprias:44','próprias: 44'],['próprios44','próprios 44'],['Testado:44','Testado: 44'],['em5 arquivos','em 5 arquivos'],[';26 sem','; 26 sem'],[';9 grupos','; 9 grupos'],[';TS','; TS'],[';hashes56','; hashes 56'],['e3.221','e 3.221'],[';zero P1','; zero P1'],[';limpeza','; limpeza'],['cluster55834','cluster 55834'],[',temporário',', temporário'],['e0,42','e 0,42'],[';sem nova','; sem nova'],[';commit/PR','; commit/PR'],[';Área','; Área'],['modelos 086 e122','modelos 086 e 122'],['banco+9','banco + 9'],['PG+26','PG + 26'],['PG+','PG + '],['banco+','banco + ']];
for(const p of alvos){let s=fs.readFileSync(p,'utf8');let inicio=s.indexOf('<!-- FUNIL-EXTRA-INDEPENDENTE-20261114 -->');if(p.endsWith('relatos.md'))inicio=s.lastIndexOf('2026-11-14 19:16 UTC | Codex | Funil');if(p.endsWith('Kidmais Manager SaaS - Home.md'))inicio=s.indexOf('- [[Funil de oportunidades proposta 20261114]] — IMPLEMENTADO');if(p.includes('PARECER_ASTRA_FUNIL_EXTRA_INDEPENDENTE')||p.endsWith('registrar-documentacao.cjs'))inicio=0;if(inicio<0)throw Error('registro novo não localizado: '+p);let trecho=s.slice(inicio);for(const [a,b]of ajustes)trecho=trecho.split(a).join(b);fs.writeFileSync(p,s.slice(0,inicio)+trecho);}
const entradas=[];
function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else if(p!==path.join(__dirname,'sha256.json'))entradas.push({arquivo:path.relative(raiz,p).replace(/\\/g,'/'),bytes:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});}}
scan(__dirname);
const parecer=alvos[0];entradas.push({arquivo:path.relative(raiz,parecer).replace(/\\/g,'/'),bytes:fs.statSync(parecer).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(parecer)).digest('hex')});
fs.writeFileSync(path.join(__dirname,'sha256.json'),JSON.stringify({data:new Date().toISOString(),algoritmo:'SHA-256',excluiSomenteProprioManifesto:true,evidencias:entradas.sort((a,b)=>a.arquivo.localeCompare(b.arquivo))},null,2));
console.log(`Registros novos revisados; ${entradas.length} hashes de evidências próprias/parecer gravados.`);
