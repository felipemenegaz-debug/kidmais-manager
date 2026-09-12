/* eslint-disable @typescript-eslint/no-require-imports */
// Executa somente em clone restaurado do checkpoint; nunca insere fixtures no banco local.
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Client}=require('pg');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const paths={up:'database/migrations/20260909_014_revisao_operacional.sql',pre:'database/checks/20260909_014_precheck.sql',post:'database/checks/20260909_014_postcheck.sql',down:'database/rollback/20260909_014_revisao_operacional_down.sql'};
const sql=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,fs.readFileSync(p,'utf8')]));
async function fingerprint(c,columns){const result={};for(const [t,cols]of Object.entries(columns)){const rows=(await c.query(`SELECT to_jsonb(t)::text AS row FROM (SELECT ${cols.map(x=>'"'+x+'"').join(',')} FROM public."${t}") t ORDER BY to_jsonb(t)::text`)).rows;result[t]={count:rows.length,sha256:sha(JSON.stringify(rows))};}return result;}
async function catalog(c){return {columns:(await c.query("SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,constraints:(await c.query("SELECT conrelid::regclass::text AS tabela,conname,pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2")).rows,triggers:(await c.query("SELECT tgrelid::regclass::text AS tabela,pg_get_triggerdef(oid) AS definicao FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows,indexes:(await c.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2")).rows,functions:(await c.query("SELECT proname,pg_get_functiondef(oid) definicao FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1,2")).rows};}
async function main(){
 const {dest}=JSON.parse(fs.readFileSync('.tmp/checkpoint-014.json'));assert.match(dest,/^\.backups\/pre-014-\d+$/);
 const source=new URL(process.env.DATABASE_URL),name='kidmais_014_test_'+Date.now();assert.equal(source.pathname,'/kidmais_manager');
 const admin=new Client({connectionString:source.toString()});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);await admin.end();
 const restored=cp.spawnSync('C:/Program Files/PostgreSQL/18/bin/pg_restore.exe',['-h',source.hostname,'-p',source.port||'5432','-U',decodeURIComponent(source.username),'-d',name,'--exit-on-error',dest+'/banco.dump'],{env:{...process.env,PGPASSWORD:decodeURIComponent(source.password)},encoding:'utf8'});assert.equal(restored.status,0,'Restauração do checkpoint falhou');
 source.pathname='/'+name;const c=new Client({connectionString:source.toString()});await c.connect();const results=[];const ok=s=>{results.push(s);console.log('OK',s);};
 try{
 const before=await catalog(c),cols={};for(const x of before.columns)(cols[x.table_name]??=[]).push(x.column_name);
 assert.deepEqual(await fingerprint(c,cols),JSON.parse(fs.readFileSync(dest+'/dados.json')));ok('dump restaurado idêntico às 38 tabelas do checkpoint');
 await c.query(sql.pre);await c.query(sql.up);await c.query(sql.post);ok('UP e postcheck');
 const expected=[...sql.up.matchAll(/(?:\bCONSTRAINT\s+(?!TRIGGER)|CREATE\s+(?:UNIQUE\s+)?INDEX\s+|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+)(\w+)/g)].map(m=>m[1]);const physical=new Set((await c.query("SELECT conname name FROM pg_constraint WHERE connamespace='public'::regnamespace UNION SELECT indexname FROM pg_indexes WHERE schemaname='public' UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).rows.map(r=>r.name));for(const n of expected)assert(physical.has(n),n);ok('catálogo: '+expected.length+' objetos nomeados');
 assert.deepEqual(await fingerprint(c,cols),JSON.parse(fs.readFileSync(dest+'/dados.json')));ok('38 projeções antigas intactas; sem backfill');
 await c.query(sql.down);assert.deepEqual(await catalog(c),before);ok('DOWN vazio restaura catálogo completo, índices e funções');
 await c.query(sql.pre);await c.query(sql.up);await c.query(sql.post);ok('novo UP');
 const u=(await c.query('SELECT id,nome,cargo,papel FROM usuarios_administrativos LIMIT 1')).rows[0];
 const base=(await c.query("SELECT v.*,c.fechamento_id FROM contrato_versoes v JOIN contratos c ON c.id=v.contrato_id JOIN fechamentos f ON f.id=c.fechamento_id WHERE v.status='ASSINADA' AND NOT EXISTS(SELECT 1 FROM contrato_versoes pending WHERE pending.contrato_id=c.id AND pending.status='ATIVA') ORDER BY v.numero_versao DESC LIMIT 1")).rows[0];assert(base);
 const op=['cliente_id','responsavel_adicional_id','aniversariante_id','idade_aniversariante_evento','tema_festa','data_evento','horario_inicio','horario_fim','configuracao_agenda_id','pacote_id','tabela_preco_id','preco_pacote_id','regra_desconto_pacote_id','categoria_horario','categoria_preco_aplicada','convidados','convidados_faturados','valor_pacote_base','desconto_percentual','valor_desconto_pacote','valor_pacote_aplicado','valor_adicionais','valor_tabela','valor_negociado','valor_aprovado','motivo_negociacao','observacoes_negociacao','forma_pagamento_pretendida','condicao_pagamento','alteracoes_pacote','observacoes_cliente','observacoes_equipe','usuario_responsavel_id','buffet_status','buffet_salgados','buffet_bebidas','buffet_doces','buffet_bolo','buffet_outros'];
 const proj=a=>`jsonb_build_object(${op.map(k=>`'${k}',${a}.${k}`).join(',')})`;
 const items=`COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM fechamento_adicionais a WHERE a.fechamento_id=f.id),'[]'::jsonb)`;
 const common=`'schemaVersao',1,'operacao',${proj('f')},'adicionais',${items}`;
 const content=`encode(sha256(convert_to(jsonb_build_object(${common})::text,'UTF8')),'hex')`;
 const baseHash=`encode(sha256(convert_to(jsonb_build_object(${common},'versaoBaseId',$3::uuid,'snapshotBaseHash',$4::text)::text,'UTF8')),'hex')`;
 const vid=crypto.randomUUID(),rid=crypto.randomUUID();
 await c.query('BEGIN');
 await c.query("UPDATE fechamentos SET status='AGUARDANDO_PAGAMENTO' WHERE id=$1",[base.fechamento_id]);
 await c.query("INSERT INTO contrato_versoes(id,contrato_id,numero_versao,snapshot,snapshot_hash,motivo_nova_versao) VALUES($1,$2,$3,$4,$5,'Fixture estrutural 014')",[vid,base.contrato_id,(await c.query('SELECT max(numero_versao)+1 n FROM contrato_versoes WHERE contrato_id=$1',[base.contrato_id])).rows[0].n,base.snapshot,base.snapshot_hash]);
 await c.query("INSERT INTO contrato_edicoes(contrato_versao_id,contrato_id,origem_versao_id,tipo,estado,dados_fonte,alteracoes,criado_por_usuario_id,atualizado_por_usuario_id) VALUES($1,$2,$3,'NOVA_VERSAO','EM_ELABORACAO','{\"schemaVersao\":1}','{}',$4,$4)",[vid,base.contrato_id,base.id,u.id]);
 await c.query('INSERT INTO contrato_fluxos(contrato_id,versao_vigente_id,versao_em_preparacao_id) VALUES($1,$2,$3) ON CONFLICT(contrato_id) DO UPDATE SET versao_em_preparacao_id=EXCLUDED.versao_em_preparacao_id',[base.contrato_id,base.id,vid]);
 await c.query(`INSERT INTO fechamento_revisoes(id,fechamento_id,contrato_id,contrato_versao_id,versao_base_id,motivo,chave_criacao,fonte_base_hash,conteudo_hash,criado_por_usuario_id,atualizado_por_usuario_id,${op.join(',')}) SELECT $1,f.id,$2,$5,$3,'Fixture estrutural',$6,${baseHash},${content},$7,$7,${op.map(k=>'f.'+k).join(',')} FROM fechamentos f WHERE f.id=$8`,[rid,base.contrato_id,base.id,base.snapshot_hash,vid,crypto.randomUUID(),u.id,base.fechamento_id]);
 await c.query(`INSERT INTO fechamento_revisao_adicionais(fechamento_revisao_id,adicional_id,preco_adicional_id,nome_aplicado,unidade_cobranca_aplicada,quantidade,valor_unitario_aplicado,valor_total,observacoes) SELECT $1,adicional_id,preco_adicional_id,nome_aplicado,unidade_cobranca_aplicada,quantidade,valor_unitario_aplicado,valor_total,observacoes FROM fechamento_adicionais WHERE fechamento_id=$2`,[rid,base.fechamento_id]);
 await c.query('COMMIT');ok('preparação/filhos/V2/fluxo sintéticos coerentes');
 async function rejects(label,action,codes=['23514','23503','23505','23502']){await c.query('BEGIN');try{await action();await c.query('SET CONSTRAINTS ALL IMMEDIATE');assert.fail('Operação indevida aceita: '+label);}catch(e){assert(codes.includes(e.code),label+': '+e.message);}finally{await c.query('ROLLBACK');}ok(label);}
 for(const [field,value]of [['estado',"'INVALIDO'"],['revisao','0'],['horario_fim','horario_inicio'],['convidados','0'],['valor_tabela','-1'],['desconto_percentual','101'],['cliente_id','NULL'],['pacote_id',"'00000000-0000-0000-0000-000000000001'"],['conteudo_hash',"repeat('0',64)"],['hold_destino_adquirido_em','clock_timestamp()']])await rejects('recusa '+field,()=>c.query(`UPDATE fechamento_revisoes SET ${field}=${value} WHERE id=$1`,[rid]));
 await rejects('base vigente não pode mudar',()=>c.query("UPDATE fechamentos SET tema_festa='corrupção' WHERE id=$1",[base.fechamento_id]));
 await rejects('preparação não pode ser excluída',()=>c.query('DELETE FROM fechamento_revisoes WHERE id=$1',[rid]));
 await rejects('congelamento sem prova exata',()=>c.query("UPDATE fechamento_revisoes SET estado='CONGELADA' WHERE id=$1",[rid]));
 await rejects('versão de outra contratação',()=>c.query('UPDATE fechamento_revisoes SET contrato_versao_id=gen_random_uuid() WHERE id=$1',[rid]));
 assert.equal((await c.query("SELECT count(*)::int n FROM kidmais_ocupacoes_operacionais('2000-01-01','2100-01-01') WHERE fechamento_id=$1",[base.fechamento_id])).rows[0].n,0);ok('AGUARDANDO_PAGAMENTO + revisão não ocupa agenda');
 await rejects('DOWN depois de uso recusado',()=>c.query(sql.down.replace(/^BEGIN;\n/m,'').replace(/^COMMIT;\s*$/m,'')));
 const after=await catalog(c);fs.writeFileSync(dest+'/014-catalogo-isolado.json',JSON.stringify(after,null,2));fs.writeFileSync(dest+'/014-teste-isolado.json',JSON.stringify({banco:name,results,sha256Migration:sha(sql.up),paths,fixture:{rid,vid,baseId:base.id,fechamentoId:base.fechamento_id,usuarioId:u.id},columns:cols},null,2));console.log(JSON.stringify({banco:name,total:results.length,checkpoint:dest}));
 }finally{await c.query('ROLLBACK');await c.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.code,e.message,e.where||'');process.exitCode=1;});
module.exports={fingerprint,catalog,paths};
