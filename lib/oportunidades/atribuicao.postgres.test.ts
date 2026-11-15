import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {conectarDescartavel,encerrarDescartavel} from '../comercial/postgres-descartavel.ts';
import {empresa,cliente,comercial,fechamento,vincular,SENHA_FALSA,carregarComBanco,executor} from '../marketing/harness-postgres.ts';
import {travarConfiguracaoAgenda} from '../agenda/trava-configuracao.ts';
import type {PainelMarketing} from '../marketing/metricas.ts';
for(const recorrente of [false,true]) test(`P2-R2-1: campanha do cliente ${recorrente?'recorrente':'novo'}`,async(t)=>{
 if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel'){t.skip('opt-in ausente');return;}
 const c=await conectarDescartavel();try{
 await c.query('BEGIN');const e=await empresa(c,'Campanha sintética'),tx=executor(c);
 const u=(await c.query<{id:string}>("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'B',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id",[randomUUID()+'@teste.test',SENHA_FALSA])).rows[0].id;
 const p=await vincular(c,e,u,'REPRESENTANTE_AUTORIZADO'),cache=new Map();
 const load=<T,>(f:string)=>carregarComBanco(f,c,()=>p.sessao,{},cache) as T;
 const contatos=load<{executarAcaoContato(tx:unknown,e:string,u:string,a:unknown):Promise<{id:string}>}>('lib/marketing/contatos.ts');
 const cli=await cliente(c,e,'Cliente sintético','11988880987'),base=await comercial(c,e);
 await travarConfiguracaoAgenda(tx,e,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
 if(recorrente)await fechamento(c,e,base,cli,{data:'2025-01-01',status:'CONFIRMADO',atualizadoHaDias:600});
 const campanha=(await c.query<{id:string}>("INSERT INTO marketing_campanhas(empresa_id,codigo,nome,canal,origem_codigo,inicio,utm_source,utm_medium,criada_por,atualizada_por) VALUES($1,$2,'Campanha retorno','INSTAGRAM','INSTAGRAM',current_date,'instagram','social',$3,$3) RETURNING id",[e,'teste-'+randomUUID(),u])).rows[0].id;
 const k=(await contatos.executarAcaoContato(tx,e,u,{acao:'registrar',nome:'Contato campanha',telefone:'11988880987',clienteId:cli,canal:'TELEFONE',chave:randomUUID(),origemCodigo:'INSTAGRAM',campanhaId:campanha})).id;
 // Fotografia de origem conhecida do contato, usando o escritor comum append-only.
 const atr=load<{registrarOrigemManual(tx:unknown,e:string,u:string,a:unknown):Promise<unknown>}>('lib/marketing/atribuicao.ts');
 const atual=(await c.query('SELECT id FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo=\'CONTATO\' AND alvo_id=$2 AND vigente',[e,k])).rows[0];
 await atr.registrarOrigemManual(tx,e,u,{alvoTipo:'CONTATO',alvoId:k,origemCodigo:'INSTAGRAM',campanhaId:campanha,corrigeId:atual.id,motivo:'Campanha sintética'});
 const antes=(await c.query('SELECT * FROM marketing_atribuicoes WHERE empresa_id=$1 ORDER BY id',[e])).rows;
 const acao=(await c.query<{id:string}>("INSERT INTO oportunidades_acoes(empresa_id,contato_id,responsavel_id,tipo,data,criada_por) VALUES($1,$2,$3,'Ligar',current_date,$3) RETURNING id",[e,k,u])).rows[0].id;
 const f=await fechamento(c,e,base,cli,{data:'2027-10-03'});
 const conv=load<{herdarAcoesDoContato(tx:unknown,f:string):Promise<void>}>('lib/oportunidades/conversao.ts');await conv.herdarAcoesDoContato(tx,f);
 const origem=(await c.query('SELECT origem_codigo,campanha_id FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo=\'FECHAMENTO\' AND alvo_id=$2 AND vigente',[e,f])).rows[0];
 assert.deepEqual(origem,{origem_codigo:'INSTAGRAM',campanha_id:campanha});
 assert.deepEqual((await c.query('SELECT status,fechamento_id FROM marketing_contatos WHERE id=$1',[k])).rows[0],{status:'CONVERTIDO',fechamento_id:f});
 assert.deepEqual((await c.query('SELECT fechamento_id,responsavel_id FROM oportunidades_acoes WHERE id=$1',[acao])).rows[0],{fechamento_id:f,responsavel_id:u});
 assert.equal((await c.query('SELECT usuario_responsavel_id FROM fechamentos WHERE id=$1',[f])).rows[0].usuario_responsavel_id,u);
 const foto=(await c.query('SELECT * FROM marketing_atribuicoes WHERE empresa_id=$1 ORDER BY id',[e])).rows;
 for(let i=0;i<2;i++)await contatos.executarAcaoContato(tx,e,u,{acao:'vincular-negociacao',id:k,fechamentoId:f});
 assert.deepEqual((await c.query('SELECT * FROM marketing_atribuicoes WHERE empresa_id=$1 ORDER BY id',[e])).rows,foto,'repetir não altera nem duplica atribuição');
 for(const linha of antes)assert.deepEqual(foto.find(x=>x.id===linha.id),linha,'linhas anteriores preservadas');
 const hoje=(await c.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia")).rows[0].dia;
 const met=load<{painelMarketing(tx:unknown,e:string,f:unknown):Promise<PainelMarketing>}>('lib/marketing/metricas.ts');const painel=await met.painelMarketing(tx,e,{de:hoje,ate:hoje,unidadeId:null});assert.equal(painel.linhas.find(l=>l.campanhaId===campanha)?.negociacoes,1);
 await c.query('ROLLBACK');}finally{await encerrarDescartavel(c);}
});

