import {validarAmbienteFesta} from './ambiente';
import {camposBuffet,escolhasEfetivas,escolhasBuffet,type EscolhaBuffet} from './buffet';
import {cancelarContratacaoDaFesta} from '../contratos/services/cancelamento.service';
import {perfis,nomePerfil} from './perfis';
import {z} from 'zod';
import {politicaOperacao} from './politica';
import {createHash,randomUUID} from 'node:crypto';
import {db,withTransaction} from '../db/postgres';
import type {DbExecutor} from '../db/contracts';
import {consultarSessao,type SessaoAdmin} from '../autenticacao/service';
import {registrarAuditoria} from '../clientes/repositories/auditoria.repository';
import {consultarPainelFinanceiro} from '../pagamentos/services/financeiro-consulta.service';
import {exigir,FestaError,estadoDerivado,excedentes,type Capacidade} from './domain';
import {criarSchema,comandoSchema,capacidadeSchema,areaSchema,type Comando} from './schema';
import {formalizacaoCompleta,formalizacaoElegivelSql,contrato,filhos,contagens,type Festa,type Registro,type Contrato} from './repository';
export type Contexto={token:string;requestId:string;userAgent:string|null};
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function ambienteFesta(tx:DbExecutor=db()){await validarAmbienteFesta(tx);}
async function sessao(tx:DbExecutor,ctx:Contexto,lock=false){await ambienteFesta(tx);return consultarSessao(ctx.token,tx,lock);}
async function pode(tx:DbExecutor,s:SessaoAdmin,cap:Capacidade){return (await tx.query('SELECT id FROM festa_usuario_capacidades WHERE usuario_id=$1 AND capacidade=$2 AND revogado_em IS NULL',[s.usuario_id,cap])).rows.length>0;}
async function autorizar(tx:DbExecutor,s:SessaoAdmin,cap:Capacidade){exigir(await pode(tx,s,cap),`Capacidade necessária: ${cap}.`,403);}
async function auditoria(tx:DbExecutor,s:SessaoAdmin,ctx:Contexto,id:string,acao:string,antes:Record<string,unknown>|null,depois:Record<string,unknown>,motivo:string){
 await registrarAuditoria({atorTipo:'USUARIO',usuarioId:s.usuario_id,acao,entidadeTipo:'FESTA',entidadeId:id,dadosAntes:antes,dadosDepois:depois,justificativa:motivo,origem:'FESTA',requestId:ctx.requestId,userAgent:ctx.userAgent},tx);
}
async function evento(tx:DbExecutor,s:SessaoAdmin,ctx:Contexto,f:Festa,c:Contrato,key:string,input:unknown,antes:Record<string,unknown>|null,depois:Record<string,unknown>,tipo:string,motivo:string,entity=f.id,ocorridoEm:unknown=new Date()){
 await tx.query(`INSERT INTO festa_eventos(festa_id,tipo,entidade_id,usuario_id,identidade_snapshot,request_id,chave_idempotencia,payload_hash,versao_contratual_id,dados_antes,dados_depois,motivo,ocorrido_em) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[f.id,tipo,entity,s.usuario_id,{id:s.usuario_id,nome:s.nome,cargo:s.cargo,papel:s.papel},ctx.requestId,key,hash(input),c.versao_id,antes,depois,motivo,ocorridoEm]);
 await auditoria(tx,s,ctx,entity,tipo,antes,depois,motivo);
}
async function repeticao(tx:DbExecutor,key:string,input:unknown,s:SessaoAdmin,festaId?:string){
 const e=(await tx.query<Registro>('SELECT * FROM festa_eventos WHERE chave_idempotencia=$1',[key])).rows[0];
 if(e){exigir(e.payload_hash===hash(input)&&e.usuario_id===s.usuario_id&&(!festaId||e.festa_id===festaId),'Chave já utilizada com outro comando.');return e.dados_depois as Registro;}return null;
}
export async function criarFesta(raw:unknown,ctx:Contexto){
 const input=criarSchema.parse(raw);
 return withTransaction(async tx=>{
  await ambienteFesta(tx);const c=await contrato(tx,input.contratoId,true);exigir(c,'Contratação não encontrada.');
  const s=await sessao(tx,ctx,true);await autorizar(tx,s,'FESTA_CRIAR');
  const replay=await repeticao(tx,input.chave,input,s);if(replay){exigir(!(await tx.query('SELECT id FROM festas WHERE id=$1 AND invalidada_em IS NOT NULL',[replay.id])).rows.length,'A Festa desta tentativa foi removida. Inicie uma nova criação.');return replay;}
  exigir(c.versao_id===input.versaoId,'A versão vigente mudou. Atualize a tela.');
  exigir(await formalizacaoCompleta(tx,c.versao_id),'Formalização exige versão concluída, assinatura Kidmais e aceite do cliente.');
  const existing=(await tx.query<Festa>('SELECT * FROM festas WHERE contrato_id=$1 AND invalidada_em IS NULL',[c.id])).rows[0];if(existing)return existing;
  const f=(await tx.query<Festa>(`INSERT INTO festas(contrato_id,versao_contratual_criacao_id,chave_criacao,payload_hash,criado_por) VALUES($1,$2,$3,$4,$5) RETURNING *`,[c.id,c.versao_id,input.chave,hash(input),s.usuario_id])).rows[0];
  await evento(tx,s,ctx,f,c,input.chave,input,null,f,'FESTA_CRIADA','Criação explícita');return f;
 });
}
export async function consultarFestas(ctx:Contexto,id?:string,clienteId?:string){
 return withTransaction(async tx=>{
 const s=await sessao(tx,ctx);await autorizar(tx,s,'FESTA_CONSULTAR');
 const caps=(await tx.query<{capacidade:Capacidade}>('SELECT capacidade FROM festa_usuario_capacidades WHERE usuario_id=$1 AND revogado_em IS NULL',[s.usuario_id])).rows.map(r=>r.capacidade);
 const areas=(await tx.query<Registro>('SELECT * FROM festa_areas ORDER BY nome')).rows;
 const usuarios=(await tx.query<Registro>('SELECT id,nome,papel FROM usuarios_administrativos WHERE ativo ORDER BY nome')).rows;
 if(!id){const festas=(await tx.query<Festa>(`SELECT f.*,(SELECT a.data_nascimento::text FROM aniversariantes a WHERE a.id=fe.aniversariante_id) nascimento_crm,(SELECT detalhe FROM eventos_historico_cliente h WHERE h.entidade_tipo='CONTRATO' AND h.entidade_id=f.contrato_id AND h.tipo_evento='CONTRATO_CANCELADO' ORDER BY criado_em DESC LIMIT 1) motivo_cancelamento,co.cancelado_em,co.status contrato_status,v.numero_versao,v.snapshot,fe.cliente_id,fe.aniversariante_id,(SELECT count(*)::int FROM festa_pendencias p WHERE p.festa_id=f.id AND p.estado NOT IN ('RESOLVIDA','NAO_SE_APLICA')) pendencias_abertas,(SELECT descricao FROM festa_pendencias p WHERE p.festa_id=f.id AND p.estado NOT IN ('RESOLVIDA','NAO_SE_APLICA') ORDER BY (p.prioridade='CRITICA') DESC,p.criado_em LIMIT 1) pendencia_resumo,(SELECT count(*)::int FROM festa_tarefas t WHERE t.festa_id=f.id AND t.estado NOT IN ('CONCLUIDA','NAO_SE_APLICA')) tarefas_importantes FROM festas f JOIN contratos co ON co.id=f.contrato_id JOIN fechamentos fe ON fe.id=co.fechamento_id JOIN contrato_fluxos cf ON cf.contrato_id=f.contrato_id JOIN contrato_versoes v ON v.id=cf.versao_vigente_id WHERE f.invalidada_em IS NULL AND ($1::uuid IS NULL OR fe.cliente_id=$1) ORDER BY f.criado_em DESC`,[clienteId??null])).rows;
 const elegiveis=(await tx.query<Registro>(`SELECT c.id,cf.versao_vigente_id,v.numero_versao,v.snapshot,(SELECT a.data_nascimento::text FROM fechamentos fe JOIN aniversariantes a ON a.id=fe.aniversariante_id WHERE fe.id=c.fechamento_id) nascimento_crm FROM contratos c JOIN contrato_fluxos cf ON cf.contrato_id=c.id JOIN contrato_versoes v ON v.id=cf.versao_vigente_id JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE ${formalizacaoElegivelSql} AND NOT EXISTS(SELECT 1 FROM festas f WHERE f.contrato_id=c.id AND f.invalidada_em IS NULL) AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM fechamentos fe WHERE fe.id=c.fechamento_id AND fe.cliente_id=$1)) ORDER BY c.criado_em DESC`,[clienteId??null])).rows;return {festas:festas.map(f=>({...f,estado:estadoDerivado(f.snapshot,f.contrato_status==='CANCELADO',!!f.invalidada_em)})),elegiveis,capacidades:caps,areas,usuarios};}
 const f=(await tx.query<Festa>('SELECT * FROM festas WHERE id=$1',[id])).rows[0];exigir(f,'Festa não encontrada.',404);const c=await contrato(tx,f.contrato_id);const itens=await filhos(tx,id);const counts=await contagens(tx,f);
 const temPagamento=(await tx.query('SELECT p.id FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=$1',[c.id])).rows.length>0;
 const financeiro=temPagamento?await consultarPainelFinanceiro(c.id) as {posicao:Record<string,string>;pendencias:Registro[]}:null;
 const externas=financeiro?.pendencias??[];
 const versoes=(await tx.query<Registro>('SELECT v.id,v.numero_versao,v.status,e.estado FROM contrato_versoes v LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE v.contrato_id=$1 ORDER BY numero_versao',[c.id])).rows;
 const solicitacoes=itens.solicitacoes.map(r=>({...r,formalizacao:r.contrato_versao_destino_id?versoes.find(v=>v.id===r.contrato_versao_destino_id)??null:null,tratamento_externo:r.pendencia_financeira_id?externas.find(p=>p.id===r.pendencia_financeira_id)??null:null}));
 const cancelamento=(await tx.query<Registro>("SELECT usuario_id,detalhe motivo,metadata->>'canceladoEm' cancelado_em FROM eventos_historico_cliente WHERE entidade_tipo='CONTRATO' AND entidade_id=$1 AND tipo_evento='CONTRATO_CANCELADO' ORDER BY criado_em DESC LIMIT 1",[c.id])).rows[0]??null;
 const contratacaoAnterior=f.versao_contratual_criacao_id!==c.versao_id?(await tx.query<Registro>('SELECT snapshot FROM contrato_versoes WHERE id=$1',[f.versao_contratual_criacao_id])).rows[0]?.snapshot:null;
 const referencia=counts.atual;const buffet=await consultarBuffet(tx,c,id);const nascimentoCrm=(await tx.query<{nascimento:string|null}>('SELECT a.data_nascimento::text nascimento FROM fechamentos fe JOIN aniversariantes a ON a.id=fe.aniversariante_id WHERE fe.id=$1',[c.fechamento_id])).rows[0]?.nascimento??null;
 return {buffet,nascimentoCrm,financeiroPendente:externas.some(p=>['PENDENTE','EM_TRATAMENTO'].includes(String(p.situacao))),festa:{...f,estado:estadoDerivado(c.snapshot,c.status==='CANCELADO',!!f.invalidada_em)},contrato:c,cancelamento,tarefasExigiveis:c.status!=='CANCELADO'&&!f.invalidada_em,contratacaoAnterior,itens:{...itens,solicitacoes},contagens:counts,excedentes:referencia?excedentes(Number(referencia.total_presentes),c.snapshot.evento.convidados):null,financeiro:financeiro?.posicao??null,contratoAtualizado:f.versao_contratual_criacao_id!==c.versao_id,pendenciasExternas:externas,versoes,capacidades:caps,areas,usuarios};
 });
}
export async function consultarCapacidades(ctx:Contexto){return withTransaction(async tx=>{const s=await sessao(tx,ctx);exigir(s.papel==='REPRESENTANTE_AUTORIZADO','Somente representante autorizado administra capacidades.',403);return {usuarios:(await tx.query<Registro>('SELECT id,nome,papel,ativo FROM usuarios_administrativos ORDER BY nome')).rows,concessoes:(await tx.query<Registro>('SELECT * FROM festa_usuario_capacidades ORDER BY concedido_em DESC')).rows,usuarioId:s.usuario_id};});}
async function alterarCapacidade(tx:DbExecutor,s:SessaoAdmin,i:z.infer<typeof capacidadeSchema>,ctx:Contexto){exigir(s.papel==='REPRESENTANTE_AUTORIZADO','Somente representante autorizado administra capacidades.',403);
 exigir(!i.conceder||i.usuarioId!==s.usuario_id||i.confirmarAutoconcessao,'Confirme explicitamente a concessão à sua própria conta.',403);
 exigir((await tx.query('SELECT id FROM usuarios_administrativos WHERE id=$1 AND ativo FOR UPDATE',[i.usuarioId])).rows.length,'Usuário inativo ou inexistente.');
 const anterior=(await tx.query<Registro>('SELECT * FROM festa_usuario_capacidades WHERE usuario_id=$1 AND capacidade=$2 AND revogado_em IS NULL FOR UPDATE',[i.usuarioId,i.capacidade])).rows[0];
 if(i.conceder&&anterior)return anterior;if(!i.conceder&&!anterior)return {semAlteracao:true};
 const depois=i.conceder?(await tx.query<Registro>('INSERT INTO festa_usuario_capacidades(usuario_id,capacidade,concedido_por,motivo) VALUES($1,$2,$3,$4) RETURNING *',[i.usuarioId,i.capacidade,s.usuario_id,i.motivo])).rows[0]:(await tx.query<Registro>('UPDATE festa_usuario_capacidades SET revogado_por=$2,revogado_em=now(),motivo_revogacao=$3 WHERE id=$1 RETURNING *',[anterior.id,s.usuario_id,i.motivo])).rows[0];
 await auditoria(tx,s,ctx,depois.id,i.conceder?'FESTA_CAPACIDADE_CONCEDIDA':'FESTA_CAPACIDADE_REVOGADA',anterior??null,depois,i.motivo);return depois;
 }
export async function administrarCapacidade(raw:unknown,ctx:Contexto){const i=capacidadeSchema.parse(raw);return withTransaction(async tx=>alterarCapacidade(tx,await sessao(tx,ctx,true),i,ctx));}
export async function aplicarPerfil(raw:unknown,ctx:Contexto){const i=z.object({usuarioId:z.string().uuid().transform(v=>v.toLowerCase()),perfil:z.enum(['GESTAO','EQUIPE']),confirmarProprioAcesso:z.boolean().default(false)}).strict().parse(raw);return withTransaction(async tx=>{
 const s=await sessao(tx,ctx,true);exigir(s.papel==='REPRESENTANTE_AUTORIZADO','Somente representante autorizado administra capacidades.',403);exigir(i.usuarioId!==s.usuario_id||i.confirmarProprioAcesso,'Confirme a alteração do seu próprio acesso.',403);
 exigir((await tx.query('SELECT id FROM usuarios_administrativos WHERE id=$1 AND ativo FOR UPDATE',[i.usuarioId])).rows.length,'Usuário inativo ou inexistente.');
 const atuais=(await tx.query<{capacidade:Capacidade}>('SELECT capacidade FROM festa_usuario_capacidades WHERE usuario_id=$1 AND revogado_em IS NULL',[i.usuarioId])).rows.map(r=>r.capacidade);if(atuais.length===perfis[i.perfil].length&&perfis[i.perfil].every(c=>atuais.includes(c)))return {perfil:i.perfil,semAlteracao:true};
 for(const capacidade of perfis.GESTAO)await alterarCapacidade(tx,s,{usuarioId:i.usuarioId,capacidade,conceder:perfis[i.perfil].includes(capacidade),confirmarAutoconcessao:i.confirmarProprioAcesso,motivo:'Perfil de Festa: '+(i.perfil==='GESTAO'?'Gestão':'Equipe')},ctx);
 await auditoria(tx,s,ctx,i.usuarioId,'FESTA_PERFIL_APLICADO',null,{perfil:i.perfil,proprioAcesso:i.usuarioId===s.usuario_id},'Alteração de perfil confirmada');return {perfil:i.perfil};
 });}
export async function consultarPerfis(ctx:Contexto){const r=await consultarCapacidades(ctx);return {usuarioId:r.usuarioId,usuarios:r.usuarios.filter(u=>u.ativo).map(u=>({id:u.id,nome:u.nome,perfil:nomePerfil(r.concessoes.filter(c=>c.usuario_id===u.id&&!c.revogado_em).map(c=>String(c.capacidade)))}))};}
export async function administrarArea(raw:unknown,ctx:Contexto){const i=areaSchema.parse(raw);return withTransaction(async tx=>{const s=await sessao(tx,ctx,true);await autorizar(tx,s,'FESTA_CONFIGURAR_AREAS');const antes=i.id?(await tx.query<Registro>('SELECT * FROM festa_areas WHERE id=$1 FOR UPDATE',[i.id])).rows[0]:null;if(i.id)exigir(antes,'Área não encontrada.');const r=i.id?(await tx.query<Registro>('UPDATE festa_areas SET nome=$2,ativo=$3,revisao=revisao+1 WHERE id=$1 RETURNING *',[i.id,i.nome,i.ativo])).rows[0]:(await tx.query<Registro>('INSERT INTO festa_areas(nome,ativo,criado_por) VALUES($1,$2,$3) RETURNING *',[i.nome,i.ativo,s.usuario_id])).rows[0];await auditoria(tx,s,ctx,r.id,'FESTA_AREA_ATUALIZADA',antes??null,r,i.motivo);return r;});}
async function validarPolitica(tx:DbExecutor,s:SessaoAdmin,i:Comando,antes:Registro|null){const p=politicaOperacao(i,antes);if(p.corrigir)await autorizar(tx,s,'FESTA_CORRIGIR');if(p.motivoObrigatorio)exigir(i.motivo.trim().length>=3,'Informe motivo explícito com pelo menos 3 caracteres.',400);}
async function capacidadeComando(tx:DbExecutor,s:SessaoAdmin,i:Comando){
 const sensivel=['invalidar','cancelar_contratacao','cancelar_solicitacao','encaminhar_solicitacao'].includes(i.acao)||i.acao==='contagem'&&!!i.corrigeId;
 await autorizar(tx,s,sensivel?'FESTA_CORRIGIR':'FESTA_OPERAR');
}
export async function comandarFesta(id:string,raw:unknown,ctx:Contexto){const i=comandoSchema.parse(raw);return withTransaction(async tx=>{
 await ambienteFesta(tx);const pre=(await tx.query<Festa>('SELECT * FROM festas WHERE id=$1',[id])).rows[0];exigir(pre,'Festa não encontrada.',404);
 const c=await contrato(tx,pre.contrato_id,true);const s=await sessao(tx,ctx,true);const f=(await tx.query<Festa>('SELECT * FROM festas WHERE id=$1 FOR UPDATE',[id])).rows[0];
 await capacidadeComando(tx,s,i);const replay=await repeticao(tx,i.chave,i,s,id);if(replay)return replay;
 exigir(f.revisao===i.revisao&&c.versao_id===i.versaoId,'Festa ou versão contratual atualizada por outra operação. Atualize a tela.');
 exigir(!f.invalidada_em,'Esta Festa foi removida e permanece somente para consulta.');
 exigir(c.status!=='CANCELADO','Contratação cancelada: Festa disponível somente para consulta.');
 if(!['tarefa','pendencia'].includes(i.acao))await validarPolitica(tx,s,i,null);
 let antes:Registro|null=f;let result:Registro=f;let entity=id;
 if(i.acao==='invalidar'){
  const registros=await filhos(tx,id);exigir(Object.entries(registros).every(([k,rows])=>k==='eventos'?rows.every(r=>r.tipo==='FESTA_CRIADA'):rows.length===0),'Esta Festa já possui atividades registradas e não pode ser removida por engano.');
  result=(await tx.query<Festa>('UPDATE festas SET invalidada_em=clock_timestamp(),invalidada_por=$2,motivo_invalidacao=$3,revisao=revisao+1,atualizado_em=clock_timestamp() WHERE id=$1 RETURNING *',[id,s.usuario_id,i.motivo])).rows[0];
 }else if(i.acao==='cancelar_contratacao'){
  await cancelarContratacaoDaFesta(tx,c.id,s,i.motivo,i.chave,ctx);
  result={id,cancelada:true};
 }else if(i.acao==='tarefa'||i.acao==='pendencia'){
  const table=i.acao==='tarefa'?'festa_tarefas':'festa_pendencias';antes=i.id?(await tx.query<Registro>(`SELECT * FROM ${table} WHERE festa_id=$1 AND id=$2 FOR UPDATE`,[id,i.id])).rows[0]:null;if(i.id)exigir(antes,'Registro não pertence à Festa.');await validarPolitica(tx,s,i,antes);
  if(i.areaId)exigir((await tx.query('SELECT id FROM festa_areas WHERE id=$1 AND ativo',[i.areaId])).rows.length,'Área inativa ou inexistente.');
  if(i.responsavelId)exigir((await tx.query('SELECT id FROM usuarios_administrativos WHERE id=$1 AND ativo',[i.responsavelId])).rows.length,'Responsável inativo ou inexistente.');
  const common={descricao:i.descricao,categoria:i.categoria,estado:i.estado,prioridade:i.prioridade,area_id:i.areaId,responsavel_id:i.responsavelId,prazo:i.prazo};
  const values:Record<string,unknown>=i.acao==='tarefa'?{...common,titulo:i.titulo,...(!i.id?{versao_contratual_id:c.versao_id}:{})}:{...common,natureza:i.natureza};
  result=await salvarFilho(tx,table,id,i.id,values,s);entity=result.id;
 }else if(i.acao==='observacao'){
  antes=null;result={id:randomUUID(),descricao:i.descricao};entity=result.id;
 }else if(i.acao==='buffet'){
  const ficha=await consultarBuffet(tx,c,id);const fields=Object.keys(i.escolhas) as EscolhaBuffet[];
  exigir(fields.length>0,'Preencha uma escolha.',400);
  exigir(fields.every(k=>ficha.campos.includes(k)),'Este item exige alteração da contratação. Use Editar contratação.',400);
  antes=(await tx.query<Registro>('SELECT festa_id id,* FROM festa_buffet WHERE festa_id=$1 FOR UPDATE',[id])).rows[0]??null;
  const values=escolhasBuffet.map(k=>fields.includes(k)?i.escolhas[k]??null:antes?.[k]??null);
  result=(await tx.query<Registro>(`INSERT INTO festa_buffet(festa_id,salgados,doces,bolo,bebidas,lembrancinha,empratado,bombom,versao_contratual_id,atualizado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(festa_id) DO UPDATE SET salgados=excluded.salgados,doces=excluded.doces,bolo=excluded.bolo,bebidas=excluded.bebidas,lembrancinha=excluded.lembrancinha,empratado=excluded.empratado,bombom=excluded.bombom,versao_contratual_id=excluded.versao_contratual_id,atualizado_por=excluded.atualizado_por,atualizado_em=now() RETURNING festa_id id,*`,[id,...values,c.versao_id,s.usuario_id])).rows[0];
 }else if(i.acao==='contagem'){

  antes=i.corrigeId?(await tx.query<Registro>('SELECT * FROM festa_contagens_convidados WHERE festa_id=$1 AND id=$2 FOR UPDATE',[id,i.corrigeId])).rows[0]:null;
  if(i.corrigeId){exigir(antes,'Contagem não pertence à Festa.');exigir(!(await tx.query('SELECT id FROM festa_contagens_convidados WHERE corrige_contagem_id=$1',[i.corrigeId])).rows.length,'Corrija a última contagem da cadeia, não uma versão anterior.');}
  result=(await tx.query<Registro>(`INSERT INTO festa_contagens_convidados(festa_id,total_presentes,observado_em,corrige_contagem_id,motivo,versao_contratual_id,convidados_contratados,criado_por,chave_idempotencia) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,i.total,antes?.observado_em??i.observadoEm,i.corrigeId??null,i.motivo,c.versao_id,c.snapshot.evento.convidados,s.usuario_id,i.chave])).rows[0];entity=result.id;
 }else if(i.acao==='solicitacao'){
  exigir(i.tipo!=='ALTERACAO_OPERACIONAL'||(!i.necessitaContrato&&!i.necessitaFinanceiro),'Mudança de direito/custo deve seguir fluxo contratual.');
  exigir(i.tipo==='ALTERACAO_OPERACIONAL'||i.necessitaContrato,'Hora extra/adicional/alteração contratual exige encaminhamento contratual.');
  result=(await tx.query<Registro>(`INSERT INTO festa_solicitacoes(festa_id,tipo,descricao,necessita_contrato,necessita_financeiro,versao_contratual_id,criado_por,conteudo_solicitado) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,i.tipo,i.descricao,i.necessitaContrato,i.necessitaFinanceiro,c.versao_id,s.usuario_id,i.conteudoSolicitado])).rows[0];antes=null;entity=result.id;
 }else{
  antes=(await tx.query<Registro>('SELECT * FROM festa_solicitacoes WHERE festa_id=$1 AND id=$2 FOR UPDATE',[id,i.id])).rows[0];exigir(antes,'Solicitação não pertence à Festa.');entity=antes.id;
  exigir(!antes.cancelado_em,'Solicitação cancelada.');
  let fields:Record<string,unknown>={};
  if(i.acao==='cancelar_solicitacao'){fields={cancelado_por:s.usuario_id,cancelado_em:new Date(),motivo_cancelamento:i.motivo};}
  if(i.acao==='encaminhar_solicitacao'){exigir(!i.versaoDestinoId||antes.necessita_contrato,'Solicitação não exige contrato.');exigir(!i.pendenciaFinanceiraId||antes.necessita_financeiro,'Solicitação não exige financeiro.');fields={contrato_versao_destino_id:i.versaoDestinoId,pendencia_financeira_id:i.pendenciaFinanceiraId};}
  result=await salvarFilho(tx,'festa_solicitacoes',id,i.id,fields,s);
 }
 const updated=i.acao==='invalidar'?result as Festa:(await tx.query<Festa>('UPDATE festas SET revisao=revisao+1,atualizado_em=now() WHERE id=$1 RETURNING *',[id])).rows[0];
 const resposta={...result,festaRevisao:updated.revisao};
 await evento(tx,s,ctx,f,c,i.chave,i,antes,resposta,`FESTA_${i.acao.toUpperCase()}`,i.motivo,entity,i.acao==='contagem'?result.observado_em:new Date());return resposta;
 });}
async function salvarFilho(tx:DbExecutor,table:string,festaId:string,id:string|undefined,values:Record<string,unknown>,s:SessaoAdmin):Promise<Registro>{
 // Table/column names originate exclusively from the command branches above.
 const keys=Object.keys(values),params=Object.values(values);
 if(id)return (await tx.query<Registro>(`UPDATE ${table} SET ${keys.map((k,n)=>`${k}=$${n+3}`).join(',')},revisao=revisao+1 WHERE festa_id=$1 AND id=$2 RETURNING *`,[festaId,id,...params])).rows[0];
 return (await tx.query<Registro>(`INSERT INTO ${table}(festa_id,criado_por,${keys.join(',')}) VALUES($1,$2,${keys.map((_,n)=>'$'+(n+3)).join(',')}) RETURNING *`,[festaId,s.usuario_id,...params])).rows[0];
}
export {FestaError,randomUUID};

async function consultarBuffet(tx:DbExecutor,c:Contrato,id:string){
 const snapshot=c.snapshot as unknown as {evento:{pacote:{codigo:string}};contratacao:{buffet:Partial<Record<EscolhaBuffet,string|null>>;adicionais:{adicionalId:string;quantidade:number}[]}};
 const ids=(snapshot.contratacao.adicionais??[]).filter(a=>a.quantidade>0).map(a=>a.adicionalId);
 const codigos=(await tx.query<{codigo:string}>('SELECT codigo FROM adicionais WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.codigo);
 const operacional=(await tx.query<Partial<Record<EscolhaBuffet,string|null>>>('SELECT * FROM festa_buffet WHERE festa_id=$1',[id])).rows[0]??null;
 return {campos:camposBuffet(snapshot.evento.pacote.codigo,codigos),valores:escolhasEfetivas(snapshot.contratacao.buffet??{},operacional)};
}
