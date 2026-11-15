import fs from 'node:fs';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
delete process.env.DATABASE_URL;delete process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const m=JSON.parse(fs.readFileSync('docs/evidencias/funil-20261114/manifesto.json')),e=JSON.parse(fs.readFileSync('docs/evidencias/funil-r2-20261114/sha256.json'));
for(const a of [...m.arquivos,...e.evidencias])assert.equal(hash(a.arquivo),a.sha256,a.arquivo);
const fonte=fs.readFileSync('lib/oportunidades/conversao.ts','utf8');
const js=stripTypeScriptTypes(fonte.replace(/^import .*;\r?\n/gm,'').replace('export async function','async function'));
const resultados=[];
for(const dono of [null,'A']){
 const escritas=[],eventos=[];let vinculo=null;
 const tx={query:async(sql,args)=>{if(sql.includes('to_regclass'))return {rows:[{ok:true}]};if(sql.startsWith('SELECT empresa_id'))return {rows:[{empresa_id:'E',cliente_id:'C',usuario_responsavel_id:dono}]};if(sql.startsWith('SELECT a.id'))return {rows:[{id:'acao',contato_id:'contato',criada_por:'B',responsavel_id:'B'}]};if(sql.startsWith('SELECT 1'))return {rows:[]};escritas.push({sql,args});if(sql.startsWith('UPDATE marketing_contatos'))vinculo=args[2];return {rows:[]};}};
 const fn=new Function('registrarEventoHistorico',js+';return herdarAcoesDoContato;')(async ev=>eventos.push(ev));await fn(tx,'F');
 assert.equal(escritas.find(x=>x.sql.startsWith('UPDATE fechamentos')).args[2],dono??'B');assert.equal(escritas.find(x=>x.sql.startsWith('UPDATE oportunidades_acoes')).args[3],dono??'B');assert.equal(eventos[0].metadata.responsavelId,dono??'B');assert.equal(vinculo,'F');
 assert(!escritas.some(x=>x.sql.includes('marketing_atribuicoes')));
 resultados.push({negociacaoAntes:dono,negociacaoDepois:dono??'B',contatoVinculado:vinculo,escritasAtribuicao:0});
}
const contatos=fs.readFileSync('lib/marketing/contatos.ts','utf8');assert(contatos.indexOf('if (contato.fechamento_id) throw',contatos.indexOf('// vincular-negociacao'))<contatos.indexOf('const origemContato ='));
const saida={fontes:m.arquivos.length,evidencias:e.evidencias.length,hashes:'PASS',prova:'função real com tipos removidos, executor/histórico falsos; sem PostgreSQL',resultados,regressao:'vínculo automático sem atribuição; caminho explícito recusa contato já vinculado antes de herdar a origem'};fs.writeFileSync('docs/evidencias/astra-funil-r2/resultado.json',JSON.stringify(saida,null,2));console.log(JSON.stringify(saida,null,2));
