// Provas próprias. Os módulos de negócio são os arquivos reais, transpilados pelo carregador do projeto.
// Somente o acesso global ao banco é substituído pela conexão sintética validada; SQL, histórico e métricas são reais.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {conectarDescartavel,encerrarDescartavel} from '../../../lib/comercial/postgres-descartavel.ts';
import {empresa,cliente,comercial,fechamento,vincular,SENHA_FALSA,carregarComBanco,executor} from '../../../lib/marketing/harness-postgres.ts';
import {travarConfiguracaoAgenda} from '../../../lib/agenda/trava-configuracao.ts';
const pasta=path.dirname(fileURLToPath(import.meta.url));
const resultados=[];
const c=await conectarDescartavel();
const tx=executor(c);
const load=f=>carregarComBanco(f,c,()=>null,{},new Map());
const contatos=load('lib/marketing/contatos.ts'),atr=load('lib/marketing/atribuicao.ts'),conv=load('lib/oportunidades/conversao.ts'),vinculo=load('lib/marketing/conversao.ts'),met=load('lib/marketing/metricas.ts');
const id=async(sql,v=[])=>(await c.query(sql,v)).rows[0].id;
const rows=async(sql,v=[])=>(await c.query(sql,v)).rows;
async function caso(nome,fn){try{await fn();resultados.push({nome,ok:true});console.log('PASS',nome);}catch(e){await c.query('ROLLBACK');resultados.push({nome,ok:false,erro:e.stack});console.error('FAIL',nome,e.stack);}}
async function usuario(e,nome){const u=await id("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,$2,$3,'REPRESENTANTE_AUTORIZADO',true) RETURNING id",[randomUUID()+'@teste.test',nome,SENHA_FALSA]);await vincular(c,e,u,'REPRESENTANTE_AUTORIZADO');return u;}
async function fixture({recorrente=false,propria=false,responsavel=false}={}){
 await c.query('BEGIN');
 const e=await empresa(c,'Revisão independente sintética'),u=await usuario(e,'B sintético'),a=responsavel?await usuario(e,'A sintético'):null,cli=await cliente(c,e,'Cliente sintético',null),base=await comercial(c,e);
 await travarConfiguracaoAgenda(tx,e,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
 await atr.registrarSeAusente(tx,e,{alvoTipo:'CLIENTE',alvoId:cli,origemCodigo:'GOOGLE',metodo:'INFORMADO',registradoPor:u});
 if(recorrente)await fechamento(c,e,base,cli,{data:'2025-01-01',atualizadoHaDias:600});
 const campanha=await id("INSERT INTO marketing_campanhas(empresa_id,codigo,nome,canal,origem_codigo,inicio,utm_source,utm_medium,criada_por,atualizada_por) VALUES($1,$2,'Campanha sintética','INSTAGRAM','INSTAGRAM',current_date,'instagram','social',$3,$3) RETURNING id",[e,randomUUID(),u]);
 const k=await id("INSERT INTO marketing_contatos(empresa_id,cliente_id,nome,email,canal_atendimento,status,chave_idempotencia,vinculo_cliente,atualizado_por) VALUES($1,$2,'Contato sintético','contato@teste.test','TELEFONE','EM_ATENDIMENTO',$3,'MANUAL',$4) RETURNING id",[e,cli,randomUUID(),u]);
 const utm={source:'instagram',medium:'social',campaign:'retorno',content:'prova'};
 await atr.registrarSeAusente(tx,e,{alvoTipo:'CONTATO',alvoId:k,origemCodigo:'INSTAGRAM',canalAtendimento:'TELEFONE',campanhaId:campanha,metodo:'CAPTURADO',detalhe:'Detalhe sintético',utm,contatoId:k,registradoPor:u});
 const acao=await id("INSERT INTO oportunidades_acoes(empresa_id,contato_id,responsavel_id,tipo,data,criada_por) VALUES($1,$2,$3,'Ligar',current_date,$3) RETURNING id",[e,k,u]);
 const f=await fechamento(c,e,base,cli,{data:'2027-10-03'});
 if(a)await c.query('UPDATE fechamentos SET usuario_responsavel_id=$2 WHERE id=$1',[f,a]);
 if(propria)await atr.registrarSeAusente(tx,e,{alvoTipo:'FECHAMENTO',alvoId:f,origemCodigo:'GOOGLE',metodo:'INFORMADO',detalhe:'Própria',registradoPor:u});
 return {e,u,a,cli,base,campanha,k,acao,f,utm};
}
async function foto(s){return {
 contatos:await rows('SELECT * FROM marketing_contatos WHERE empresa_id=$1 ORDER BY id',[s.e]),
 atribuicoes:await rows('SELECT * FROM marketing_atribuicoes WHERE empresa_id=$1 ORDER BY id',[s.e]),
 acoes:await rows('SELECT * FROM oportunidades_acoes WHERE empresa_id=$1 ORDER BY id',[s.e]),
 fechamentos:await rows('SELECT * FROM fechamentos WHERE empresa_id=$1 ORDER BY id',[s.e]),
 historico:await rows('SELECT * FROM eventos_historico_cliente WHERE cliente_id=$1 ORDER BY id',[s.cli])};}
async function heranca(s){
 const origem=(await rows("SELECT origem_codigo,campanha_id,canal_atendimento,metodo,detalhe,utm,contato_id FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo='FECHAMENTO' AND alvo_id=$2 AND vigente",[s.e,s.f]))[0];
 assert.deepEqual(origem,{origem_codigo:'INSTAGRAM',campanha_id:s.campanha,canal_atendimento:'TELEFONE',metodo:'HERDADO',detalhe:'Detalhe sintético',utm:s.utm,contato_id:s.k});
 assert.deepEqual((await rows('SELECT status,fechamento_id FROM marketing_contatos WHERE id=$1',[s.k]))[0],{status:'CONVERTIDO',fechamento_id:s.f});
 assert.deepEqual((await rows('SELECT contato_id,fechamento_id,responsavel_id FROM oportunidades_acoes WHERE id=$1',[s.acao]))[0],{contato_id:null,fechamento_id:s.f,responsavel_id:s.a??s.u});
 assert.equal((await rows('SELECT usuario_responsavel_id FROM fechamentos WHERE id=$1',[s.f]))[0].usuario_responsavel_id,s.a??s.u);
 const hoje=(await rows("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia"))[0].dia;
 const painel=await met.painelMarketing(tx,s.e,{de:hoje,ate:hoje,unidadeId:null});
 assert.equal(painel.linhas.find(x=>x.campanhaId===s.campanha)?.negociacoes,1);
 assert.equal((await rows("SELECT origem_codigo FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo='CLIENTE' AND alvo_id=$2 AND vigente",[s.e,s.cli]))[0].origem_codigo,'GOOGLE');
 const h=await rows("SELECT tipo_evento,metadata FROM eventos_historico_cliente WHERE cliente_id=$1 AND entidade_id=$2 ORDER BY tipo_evento",[s.cli,s.f]);
 assert.equal(h.filter(x=>x.tipo_evento==='CONTATO_MARKETING_NEGOCIACAO').length,1);
 assert.equal(h.filter(x=>x.tipo_evento==='OPORTUNIDADE_ACAO_CONVERTIDA').length,1);
}
try{
 const ident=(await rows("SELECT current_database() AS banco,current_user AS papel,inet_server_port() AS porta,current_setting('cluster_name') AS cluster,current_setting('data_directory') AS pasta"))[0];
 fs.writeFileSync(path.join(pasta,'identidade.json'),JSON.stringify(ident,null,2));
 // Controle anterior extraído do diff completo da R2; a candidata permanece intacta.
 await caso('controle anterior R2: vínculo existe, atribuição da negociação ausente',async()=>{
  const patch=fs.readFileSync('docs/evidencias/funil-r2-20261114/diff-completo.patch','utf8').replace(/\r\n/g,'\n');
  const bloco=patch.split(/^diff --git /m).find(x=>x.startsWith('a/lib/oportunidades/conversao.ts b/lib/oportunidades/conversao.ts\n'));
  assert.ok(bloco,'módulo anterior no diff completo');
  const fonte=bloco.split('\n').filter(x=>x.startsWith('+')&&!x.startsWith('+++')).map(x=>x.slice(1)).join('\n')+'\n';
  const manifesto=JSON.parse(fs.readFileSync('docs/evidencias/funil-extra-20261114/manifesto-anterior.json'));
  const esperado=manifesto.arquivos.find(x=>x.arquivo==='lib/oportunidades/conversao.ts').sha256;
  const bytes=[fonte,fonte.replace(/\n/g,'\r\n')].find(x=>createHash('sha256').update(x).digest('hex')===esperado);
  assert.ok(bytes,'fonte anterior confere com o manifesto da R2');
  fs.writeFileSync(path.join(pasta,'conversao-r2-extraida.txt'),bytes);
  const exp={};new Function('require','exports',ts.transpileModule(bytes,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>load('lib/clientes/repositories/historico.repository.ts'),exp);
  const s=await fixture({recorrente:true});await exp.herdarAcoesDoContato(tx,s.f);
  assert.equal((await rows('SELECT fechamento_id FROM marketing_contatos WHERE id=$1',[s.k]))[0].fechamento_id,s.f);
  assert.equal((await rows("SELECT id FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo='FECHAMENTO' AND alvo_id=$2",[s.e,s.f])).length,0);
  await c.query('ROLLBACK');
 });
 for(const recorrente of [false,true])await caso(`automática ${recorrente?'recorrente/A prevalece':'novo/B herdado'}: origem completa, relatório e COMMIT`,async()=>{
  const s=await fixture({recorrente,responsavel:recorrente});await conv.herdarAcoesDoContato(tx,s.f);await heranca(s);await c.query('COMMIT');
  const antes=await foto(s),escritas=[];
  const monitor={async query(sql,params){if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))escritas.push(sql);return tx.query(sql,params);}};
  for(let n=0;n<2;n++)await contatos.executarAcaoContato(monitor,s.e,s.u,{acao:'vincular-negociacao',id:s.k,fechamentoId:s.f});
  await conv.herdarAcoesDoContato(monitor,s.f);
  assert.deepEqual(await foto(s),antes);assert.deepEqual(escritas,[]);
 });
 for(const manual of [false,true])await caso(`${manual?'manual':'automática'}: origem própria e primeira origem do cliente preservadas`,async()=>{
  const s=await fixture({recorrente:true,propria:true}),antes=await foto(s);
  if(manual)await contatos.executarAcaoContato(tx,s.e,s.u,{acao:'vincular-negociacao',id:s.k,fechamentoId:s.f});else await conv.herdarAcoesDoContato(tx,s.f);
  assert.deepEqual((await foto(s)).atribuicoes,antes.atribuicoes);await c.query('COMMIT');
  assert.equal((await rows('SELECT fechamento_id FROM marketing_contatos WHERE id=$1',[s.k]))[0].fechamento_id,s.f);
 });
 await caso('manual: herança antes da transferência, repetição sem escritas e COMMIT',async()=>{
  const s=await fixture();await contatos.executarAcaoContato(tx,s.e,s.u,{acao:'vincular-negociacao',id:s.k,fechamentoId:s.f});await heranca(s);await c.query('COMMIT');
  const antes=await foto(s);await contatos.executarAcaoContato(tx,s.e,s.u,{acao:'vincular-negociacao',id:s.k,fechamentoId:s.f});assert.deepEqual(await foto(s),antes);
 });
 await caso('recusas: outra negociação, outro cliente, outra empresa e contato sem cliente',async()=>{
  const s=await fixture();await conv.herdarAcoesDoContato(tx,s.f);await c.query('COMMIT');
  const antes=await foto(s);
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:s.k,fechamentoId:randomUUID()}),e=>e.code==='MARKETING_CONTATO_CONVERTIDO'&&e.httpStatus===409);
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,randomUUID(),s.u,{id:s.k,fechamentoId:s.f}),e=>e.code==='MARKETING_NAO_ENCONTRADO'&&e.httpStatus===404);
  assert.deepEqual(await foto(s),antes);
  await c.query('BEGIN');const outro=await cliente(c,s.e,'Outro cliente sintético',null),livre=await id("INSERT INTO marketing_contatos(empresa_id,cliente_id,nome,email,canal_atendimento,status,chave_idempotencia,vinculo_cliente) VALUES($1,$2,'Outro','outro@teste.test','TELEFONE','NOVO',$3,'MANUAL') RETURNING id",[s.e,outro,randomUUID()]);
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:livre,fechamentoId:s.f}),e=>e.code==='MARKETING_NAO_ENCONTRADO'&&e.httpStatus===404);
  const sem=await id("INSERT INTO marketing_contatos(empresa_id,nome,email,canal_atendimento,status,chave_idempotencia,vinculo_cliente) VALUES($1,'Sem cliente','sem@teste.test','TELEFONE','NOVO',$2,'SEM_CLIENTE') RETURNING id",[s.e,randomUUID()]);
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:sem,fechamentoId:s.f}),e=>e.code==='MARKETING_CONTATO_SEM_CLIENTE'&&e.httpStatus===409);
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:livre,fechamentoId:randomUUID()}),e=>e.code==='MARKETING_NAO_ENCONTRADO'&&e.httpStatus===404);
  const e2=await empresa(c,'Outra empresa sintética'),cli2=await cliente(c,e2,'Cliente de outra empresa',null),base2=await comercial(c,e2);
  await travarConfiguracaoAgenda(tx,e2,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});const f2=await fechamento(c,e2,base2,cli2,{data:'2027-10-04'});
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:livre,fechamentoId:f2}),e=>e.code==='MARKETING_NAO_ENCONTRADO'&&e.httpStatus===404);
  const k2=await id("INSERT INTO marketing_contatos(empresa_id,cliente_id,nome,email,canal_atendimento,status,chave_idempotencia,vinculo_cliente) VALUES($1,$2,'Segundo','segundo@teste.test','TELEFONE','NOVO',$3,'MANUAL') RETURNING id",[s.e,s.cli,randomUUID()]);
  await c.query('SAVEPOINT exclusividade');
  await assert.rejects(()=>vinculo.vincularContatoNegociacao(tx,s.e,s.u,{id:k2,fechamentoId:s.f}),e=>e.code==='MARKETING_NEGOCIACAO_JA_VINCULADA'&&e.httpStatus===409);
  await c.query('ROLLBACK TO SAVEPOINT exclusividade');await c.query('ROLLBACK');assert.deepEqual(await foto(s),antes);
 });
 for(const falha of ['atribuicao','historico'])await caso(`atomicidade: falha injetada em ${falha} desfaz vínculo/ação/responsável/atribuição/histórico`,async()=>{
  const s=await fixture();await c.query('COMMIT');const antes=await foto(s);let atingiu=false;
  const monitor={async query(sql,params){if(falha==='atribuicao'?/^\s*INSERT INTO marketing_atribuicoes/.test(sql):/^\s*INSERT INTO eventos_historico_cliente/.test(sql)){atingiu=true;throw Error('FALHA_SINTETICA_'+falha);}return tx.query(sql,params);}};
  await c.query('BEGIN');await travarConfiguracaoAgenda(tx,s.e,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});await assert.rejects(()=>conv.herdarAcoesDoContato(monitor,s.f),new RegExp('FALHA_SINTETICA_'+falha));await c.query('ROLLBACK');assert.ok(atingiu);assert.deepEqual(await foto(s),antes);
 });
}finally{await encerrarDescartavel(c);fs.writeFileSync(path.join(pasta,'resultado.json'),JSON.stringify({data:new Date().toISOString(),runtime:process.version,resultados},null,2));}
if(resultados.some(x=>!x.ok))process.exitCode=1;
