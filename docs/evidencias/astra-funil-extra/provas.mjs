import fs from 'node:fs';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
delete process.env.DATABASE_URL;delete process.env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
const read=p=>fs.readFileSync(p,'utf8');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const m=JSON.parse(read('docs/evidencias/funil-20261114/manifesto.json')),e=JSON.parse(read('docs/evidencias/funil-extra-20261114/sha256.json'));
for(const a of [...m.arquivos,...e.evidencias])assert.equal(sha(a.arquivo),a.sha256,a.arquivo);
const js=p=>stripTypeScriptTypes(read(p).replace(/^import .*;\r?\n/gm,'').replace(/export async function/g,'async function'));
class MarketingError extends Error {constructor(code,message,status){super(message);this.code=code;this.status=status;}}
const results=[];
function fixture({owner=null,existing=false,bound=null,missingContact=false,wrongTarget=false,fail=false}={}){
 const state={bound,owner,action:true,attr:existing?{origemCodigo:'INDICACAO',campanhaId:'propria'}:null,writes:[],events:[]};
 const tx={query:async(sql,args)=>{
 if(sql.includes('to_regclass'))return {rows:[{ok:true}]};
 if(sql.startsWith('SELECT empresa_id'))return {rows:[{empresa_id:'E',cliente_id:'C',usuario_responsavel_id:state.owner}]};
 if(sql.startsWith('SELECT a.id'))return {rows:state.action?[{id:'act',contato_id:'K',criada_por:'B',responsavel_id:'B'}]:[]};
 if(sql.startsWith('SELECT 1'))return {rows:[]};
 if(sql.startsWith('SELECT cliente_id')){assert.deepEqual(args,['E','K']);return {rows:missingContact?[]:[{cliente_id:'C',fechamento_id:state.bound}]};}
 if(sql.startsWith('SELECT id::text FROM fechamentos')){assert.deepEqual(args,['F','E','C']);return {rows:wrongTarget?[]:[{id:'F'}]};}
 state.writes.push({sql,args});
 if(sql.startsWith('UPDATE marketing_contatos'))state.bound=args[1];
 else if(sql.startsWith('UPDATE fechamentos'))state.owner=args[2];
 else if(sql.startsWith('UPDATE oportunidades_acoes')){state.action=false;assert.equal(args[3],state.owner);}
 else throw Error('SQL não previsto: '+sql);
 return {rows:[]};}};
 const hist=async(ev,t)=>{assert.equal(t,tx);state.events.push(ev);};
 const origem={origemCodigo:'INSTAGRAM',campanhaId:'campanha',metodo:'INFORMADO',canalAtendimento:'TELEFONE',utm:{source:'instagram'},detalhe:'retorno'};
 const common=new Function('MarketingError','naoEncontrado','atribuicaoVigente','registrarSeAusente','registrarEventoHistorico',js('lib/marketing/conversao.ts')+';return vincularContatoNegociacao;')(MarketingError,msg=>{throw new MarketingError('404',msg,404);},async(t,emp,tipo,id)=>{assert.equal(t,tx);assert.deepEqual([emp,tipo,id],['E','CONTATO','K']);return origem;},async(t,emp,nova)=>{assert.equal(t,tx);assert.equal(emp,'E');if(fail)throw Error('falha atribuicao');if(state.attr)return null;state.attr=nova;return nova;},hist);
 const hook=new Function('vincularContatoNegociacao','registrarEventoHistorico',js('lib/oportunidades/conversao.ts')+';return herdarAcoesDoContato;')(common,hist);
 return {state,tx,common,hook};
}
for(const owner of [null,'A']){
 const f=fixture({owner});await f.hook(f.tx,'F');assert.equal(f.state.bound,'F');assert.equal(f.state.owner,owner??'B');assert.equal(f.state.attr.campanhaId,'campanha');assert.equal(f.state.attr.origemCodigo,'INSTAGRAM');assert.equal(f.state.attr.metodo,'HERDADO');
 const before=JSON.stringify(f.state);for(let i=0;i<2;i++)await f.common(f.tx,'E','B',{id:'K',fechamentoId:'F'});assert.equal(JSON.stringify(f.state),before);results.push('heranca e repeticao; responsavel '+(owner??'B herdado'));
}
{const f=fixture({existing:true});await f.hook(f.tx,'F');assert.deepEqual(f.state.attr,{origemCodigo:'INDICACAO',campanhaId:'propria'});results.push('origem propria preservada');}
for(const [opts,status] of [[{bound:'OUTRA'},409],[{missingContact:true},404],[{wrongTarget:true},404]]){const f=fixture(opts);await assert.rejects(()=>f.common(f.tx,'E','B',{id:'K',fechamentoId:'F'}),err=>err.status===status);assert.equal(f.state.writes.length,0);results.push('recusa sem escrita '+JSON.stringify(opts));}
{const f=fixture({fail:true});await assert.rejects(()=>f.hook(f.tx,'F'),/falha atribuicao/);results.push('falha de heranca propaga ao chamador; rollback depende da transacao real');}
const contatos=read('lib/marketing/contatos.ts');assert.match(contatos,/const resultado = await vincularContatoNegociacao\(tx,empresaId,usuarioId,acao\);\s*await herdarAcoesDoContato\(tx,acao.fechamentoId\);/);
const atr=read('lib/marketing/atribuicao.ts');const insert=atr.slice(atr.indexOf('export async function registrarSeAusente'),atr.indexOf('export async function corrigirAtribuicao'));assert.match(insert,/ON CONFLICT[\s\S]*DO NOTHING/);assert(!/UPDATE marketing_atribuicoes/.test(insert));
const output={data:new Date().toISOString(),hashes:{fontes:m.arquivos.length,evidencias:e.evidencias.length},resultados:results,limite:'Funcoes reais com tipos/imports removidos, SQL e dependencias falsos. Sem PostgreSQL, navegador ou build próprios. Sem prova de concorrencia/rollback real.'};
fs.writeFileSync('docs/evidencias/astra-funil-extra/resultado.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
