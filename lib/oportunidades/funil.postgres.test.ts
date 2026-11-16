import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {conectarDescartavel,encerrarDescartavel} from '../comercial/postgres-descartavel.ts';
import {empresa,cliente,comercial,fechamento,contratoAssinado,vincular,SENHA_FALSA,carregarComBanco,pedido,type Resposta,executor} from '../marketing/harness-postgres.ts';
import type {Oportunidade,Comando} from './modelo.ts';
import type {RelatorioFunil} from './consultas.ts';
import type {MensagemEmail} from '../acessos/email.ts';
import {travarConfiguracaoAgenda} from '../agenda/trava-configuracao.ts';

type Rota={GET:(r:unknown)=>Promise<Resposta>;POST:(r:unknown)=>Promise<Resposta>};
// Regressões da revisão Astra R1: dados reais no PostgreSQL autorizado, sem transporte externo.
for (const caso of ['contato recorrente','conversão sem responsável','conversão com responsável A'] as const) {
 test(`Astra R1: ${caso}`,{timeout:180000},async(t)=>{
  if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel'){t.skip('postgres-descartavel: opt-in ausente');return;}
  const c=await conectarDescartavel();
  try {
   await c.query('BEGIN');
   const e=await empresa(c,'Empresa R1 sintética'),tx=executor(c);
   const pessoa=async(nome:string,papel:'REPRESENTANTE_AUTORIZADO'|'ADMINISTRATIVO'='REPRESENTANTE_AUTORIZADO')=>{
    const u=(await c.query<{id:string}>("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,$2,$3,$4,true) RETURNING id::text",[randomUUID()+'@funil.test',nome,SENHA_FALSA,papel])).rows[0].id;
    return vincular(c,e,u,papel);
   };
   const a=await pessoa('A'),b=await pessoa('B'),leitor=await pessoa('Leitor','ADMINISTRATIVO');
   await c.query("INSERT INTO marketing_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo) VALUES($1,$2,'MARKETING_VISUALIZAR',$3,'Teste leitor')",[e,leitor.membership,a.usuario]);
   let sessao=a.sessao;
   const cache=new Map(),carregar=<T,>(p:string)=>carregarComBanco(p,c,()=>sessao,{},cache) as T;
   const rota=carregar<Rota>('app/api/admin/oportunidades/route.ts');
   type Dados={id:string;hoje:string;podeEditar:boolean;itens:Oportunidade[];contadores:{fechadas:number;perdidas:number}};
   const chamar=async(body?:unknown,responsavel?:string)=>{
    const r=await (body?rota.POST:rota.GET)(pedido('http://127.0.0.1:3000/api/admin/oportunidades'+(responsavel?'?responsavelId='+responsavel:''),body));
    return {status:r.status,j:await r.json()};
   };
   const ok=async(body?:unknown,responsavel?:string)=>{const r=await chamar(body,responsavel);assert.equal(r.status,200,JSON.stringify(r.j));return r.j.data as Dados;};
   const cli=await cliente(c,e,'Cliente recorrente sintético','11988880999'),base=await comercial(c,e);
   await travarConfiguracaoAgenda(tx,e,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
   const antigo=caso==='contato recorrente'?await fechamento(c,e,base,cli,{data:'2025-01-01',status:'CONFIRMADO',atualizadoHaDias:600}):null;
   if(antigo) await c.query("UPDATE fechamentos SET confirmada_em='2025-01-01' WHERE id=$1",[antigo]);
   const novo=async()=> (await ok({acao:'registrar',nome:'Contato recorrente sintético',telefone:'11988880999',canal:'TELEFONE',chave:randomUUID()})).id;
   const k=await novo(),hoje=(await ok()).hoje;
   if(caso==='contato recorrente') assert((await ok()).itens.some(i=>i.id===k),'histórico confirmado não oculta o contato sem vínculo');
   const acao=(await ok({acao:'agendar',alvo:{tipo:'CONTATO',id:k},esperada:null,proxima:{tipo:'Ligar',data:hoje,responsavelId:b.usuario}})).id;
   if(caso==='contato recorrente') {
    await ok({acao:'perder',alvo:{tipo:'CONTATO',id:k},esperada:acao,perda:{motivo:'Preço'}});
    assert.equal((await ok(undefined,b.usuario)).contadores.perdidas,1);
    assert.equal((await c.query('SELECT status FROM fechamentos WHERE id=$1',[antigo])).rows[0].status,'CONFIRMADO');
    // O caminho antigo de descarte também permite o retorno sem vínculo.
    const outro=await novo();
    const contatos=carregar<{executarAcaoContato(tx:unknown,e:string,u:string,v:unknown):Promise<unknown>}>('lib/marketing/contatos.ts');
    await contatos.executarAcaoContato(tx,e,a.usuario,{acao:'status',id:outro,status:'DESCARTADO',perda:{motivo:'Outro'}});
    const retorno=await novo(),proxima=(await ok({acao:'agendar',alvo:{tipo:'CONTATO',id:retorno},esperada:null,proxima:{tipo:'WhatsApp',data:hoje,responsavelId:b.usuario}})).id;
    const novaNegociacao=await fechamento(c,e,base,cli,{data:'2027-09-02'});
    const conversao=carregar<{herdarAcoesDoContato(tx:unknown,f:string):Promise<void>}>('lib/oportunidades/conversao.ts');
    await conversao.herdarAcoesDoContato(tx,novaNegociacao);
    assert.equal((await c.query('SELECT fechamento_id FROM marketing_contatos WHERE id=$1',[retorno])).rows[0].fechamento_id,novaNegociacao,'retorno convertido fica vinculado à negociação nova');
    assert.equal((await ok()).itens.find(i=>i.id===novaNegociacao)?.proxima?.id,proxima);
    assert(!(await ok()).itens.some(i=>i.id===retorno));
    assert.equal((await c.query('SELECT status FROM fechamentos WHERE id=$1',[antigo])).rows[0].status,'CONFIRMADO');
   } else {
    const outroContato=await novo(),outraAcao=(await ok({acao:'agendar',alvo:{tipo:'CONTATO',id:outroContato},esperada:null,proxima:{tipo:'WhatsApp',data:'2099-01-01',responsavelId:b.usuario}})).id;
    const f=await fechamento(c,e,base,cli,{data:'2027-09-01'});
    if(caso==='conversão com responsável A') await c.query('UPDATE fechamentos SET usuario_responsavel_id=$2 WHERE id=$1',[f,a.usuario]);
    const contatos=carregar<{executarAcaoContato(tx:unknown,e:string,u:string,v:unknown):Promise<unknown>}>('lib/marketing/contatos.ts');
    await contatos.executarAcaoContato(tx,e,a.usuario,{acao:'vincular-negociacao',id:k,fechamentoId:f});
    const dono=caso==='conversão sem responsável'?b.usuario:a.usuario;
    assert.equal((await c.query('SELECT usuario_responsavel_id FROM fechamentos WHERE id=$1',[f])).rows[0].usuario_responsavel_id,dono,'negociação define responsável após conversão');
    assert.equal((await c.query('SELECT responsavel_id FROM oportunidades_acoes WHERE id=$1',[acao])).rows[0].responsavel_id,dono,'ação transferida acompanha a negociação');
    const dados=await ok(undefined,dono),item=dados.itens.find(i=>i.id===f)!;
    assert(item);assert.equal(item.responsavelId,dono);assert.equal(item.proxima?.responsavelId,dono);assert.equal(item.proxima?.data,hoje,'Para hoje usa o mesmo cartão');
    assert(!dados.itens.some(i=>i.id===k),'vínculo explícito retira o contato');
    assert.equal((await ok()).itens.find(i=>i.id===outroContato)?.proxima?.id,outraAcao,'conversão não encerra outro contato sem vínculo do mesmo cliente');
    const outroDono=dono===b.usuario?a.usuario:b.usuario;
    assert(!(await ok(undefined,outroDono)).itens.some(i=>i.id===f));
    const evento=(await c.query("SELECT metadata FROM eventos_historico_cliente WHERE cliente_id=$1 AND tipo_evento='OPORTUNIDADE_ACAO_CONVERTIDA'",[cli])).rows[0].metadata;
    assert.equal(evento.responsavelAcaoAnterior,b.usuario);assert.equal(evento.responsavelNegociacaoAnterior,caso==='conversão sem responsável'?null:a.usuario);assert.equal(evento.responsavelId,dono);
    // Mesmo com uma ação antiga divergente, leitura e destinatário seguem o fechamento.
    await c.query('UPDATE oportunidades_acoes SET responsavel_id=$2 WHERE id=$1',[acao,outroDono]);
    assert.equal((await ok(undefined,dono)).itens.find(i=>i.id===f)?.responsavelId,dono);
    const resumo=carregar<{enviarResumosDiarios(d:unknown):Promise<{enviados:number;falhas:number}>}>('lib/oportunidades/resumo.ts'),enviados:MensagemEmail[]=[];
    const resultado=await resumo.enviarResumosDiarios({transacao:async<T,>(fn:(x:unknown)=>Promise<T>)=>fn(tx),env:{OPORTUNIDADES_RESUMO_EMAIL:'true'},enviar:async(m:MensagemEmail)=>{enviados.push(m);return {provedor:'arquivo',idExterno:null};}});
    assert.equal(resultado.falhas,0);assert.equal(enviados.length,1);assert(enviados[0].idempotencia?.includes(dono));
    assert(enviados[0].assunto.includes('Empresa R1 sintética'));assert(enviados[0].texto.startsWith('iA.Fest — Empresa R1 sintética'));
    await c.query("UPDATE fechamentos SET status='CONFIRMADO' WHERE id=$1",[f]);
    assert.equal((await ok(undefined,dono)).contadores.fechadas,1);assert.equal((await ok(undefined,outroDono)).contadores.fechadas,0);
    await c.query("UPDATE fechamentos SET status='RASCUNHO' WHERE id=$1",[f]);
    await ok({acao:'perder',alvo:{tipo:'FECHAMENTO',id:f},esperada:acao,perda:{motivo:'Outro'}});
    assert.equal((await ok(undefined,dono)).contadores.perdidas,1);assert.equal((await ok(undefined,outroDono)).contadores.perdidas,0);
   }
   sessao=leitor.sessao;assert.equal((await ok()).podeEditar,false);assert.equal((await chamar({acao:'perder',alvo:{tipo:'CONTATO',id:k},esperada:null,perda:{motivo:'Outro'}})).status,403);
   await c.query('ROLLBACK');
  } finally {await encerrarDescartavel(c);}
 });
}
test('funil real: ciclo, isolamento A/B, perdas, histórico, relatórios e assinatura', {timeout:180000},async(t)=>{
 if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel'){t.skip('postgres-descartavel: opt-in ausente');return;}
 const c=await conectarDescartavel();
 try{
  await c.query('BEGIN');
  const a=await empresa(c,'Funil A sintética'),b=await empresa(c,'Funil B sintética');
  const pessoa=async(e:string,papel:'REPRESENTANTE_AUTORIZADO'|'ADMINISTRATIVO'='REPRESENTANTE_AUTORIZADO')=>{
   const u=(await c.query<{id:string}>("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'Responsável sintético',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id::text",[randomUUID()+'@funil.test',SENHA_FALSA])).rows[0].id;
   return vincular(c,e,u,papel);
  };
  const pa=await pessoa(a),pb=await pessoa(b);let sessao=pa.sessao;
  const cache=new Map(),carregar=<T,>(p:string)=>carregarComBanco(p,c,()=>sessao,{},cache) as T;
  const rota=carregar<Rota>('app/api/admin/oportunidades/route.ts');
  const consultas=carregar<{relatorioFunil(tx:unknown,e:string,de:string,ate:string,u:null):Promise<RelatorioFunil>}>('lib/oportunidades/consultas.ts');
  async function chamar(body?:unknown){const r=await (body?rota.POST:rota.GET)(pedido('http://127.0.0.1:3000/api/admin/oportunidades',body));return {status:r.status,j:await r.json()};}
  async function ok(body?:unknown){const r=await chamar(body);assert.equal(r.status,200,JSON.stringify(r.j));return r.j.data as {id:string;itens:Oportunidade[];hoje:string;contadores:{perdidas:number;fechadas:number}};}
  const semAcesso=await pessoa(a,'ADMINISTRATIVO');sessao=semAcesso.sessao;assert.equal((await chamar()).status,403,'papel global não contorna permissão na empresa');sessao=pa.sessao;
  const novo=async(nome:string)=>(await ok({acao:'registrar',nome,telefone:'11988880001',canal:'TELEFONE',chave:randomUUID()})).id;
  const ca=await novo('Contato A sintético');sessao=pb.sessao;const cb=await novo('Contato B sintético');
  const dadosB=await ok();assert.equal(dadosB.itens.length,1);assert.equal(dadosB.itens[0].id,cb);assert(!JSON.stringify(dadosB).includes(ca));
  const hoje=dadosB.hoje;
  const agendar=(id:string,u:string,esperada:string|null=null):Comando=>({acao:'agendar',alvo:{tipo:'CONTATO',id},esperada,proxima:{tipo:'Ligar',data:hoje,responsavelId:u}});
  const ab=(await ok(agendar(cb,pb.usuario))).id;
  sessao=pa.sessao;
  assert.equal((await chamar(agendar(cb,pa.usuario))).status,404,'A não edita oportunidade B');
  assert.equal((await chamar(agendar(ca,pb.usuario))).status,404,'responsável B recusado');
  const aa=(await ok(agendar(ca,pa.usuario))).id;
  assert.equal((await chamar(agendar(ca,pa.usuario))).status,409,'concorrência otimista');
  assert.equal((await chamar({acao:'concluir',alvo:{tipo:'CONTATO',id:ca},esperada:aa})).status,400,'Feito exige próximo passo');
  const seguinte=(await ok({acao:'concluir',alvo:{tipo:'CONTATO',id:ca},esperada:aa,proxima:{tipo:'WhatsApp',data:hoje,responsavelId:pa.usuario}})).id;
  const concluidas=(await c.query("SELECT count(*)::int AS n FROM oportunidades_acoes WHERE empresa_id=$1 AND resultado='FEITA'",[a])).rows[0].n;assert.equal(concluidas,1);
  assert.equal((await chamar({acao:'perder',alvo:{tipo:'CONTATO',id:ca},esperada:seguinte,perda:{motivo:''}})).status,400);
  await ok({acao:'perder',alvo:{tipo:'CONTATO',id:ca},esperada:seguinte,perda:{motivo:'Preço',observacao:'Dado sintético'}});
  assert.equal((await ok()).contadores.perdidas,1);
  const perdasA=await consultas.relatorioFunil(executor(c),a,hoje,hoje,null);assert.equal(perdasA.perdas[0].motivo,'Preço');assert.equal(perdasA.perdas[0].quantidade,1);
  const perdasB=await consultas.relatorioFunil(executor(c),b,hoje,hoje,null);assert.equal(perdasB.perdas.length,0,'motivo não vaza para B');
  const resumo=carregar<{enviarResumosDiarios(d:unknown):Promise<{enviados:number;falhas:number}>}>('lib/oportunidades/resumo.ts');
  const enviados:MensagemEmail[]=[];
  const deps={transacao:async<T,>(fn:(tx:unknown)=>Promise<T>)=>fn(executor(c)),env:{OPORTUNIDADES_RESUMO_EMAIL:'true'},enviar:async(m:MensagemEmail)=>{enviados.push(m);return {provedor:'arquivo',idExterno:null};}};
  assert.equal((await resumo.enviarResumosDiarios(deps)).enviados,1);assert.equal(enviados.length,1);
  assert(enviados[0].texto.includes('Contato B sintético'));assert(!enviados[0].texto.includes('Contato A sintético'));
  assert.equal((await resumo.enviarResumosDiarios(deps)).enviados,0,'resumo é diário e idempotente');
  sessao=pb.sessao;const bDepois=await ok();assert.equal(bDepois.itens[0].proxima?.id,ab,'ação B preservada');assert.equal(bDepois.contadores.perdidas,0);
  assert.equal((await chamar({acao:'perder',alvo:{tipo:'CONTATO',id:ca},esperada:null,perda:{motivo:'Outro'}})).status,404);
  await c.query('SAVEPOINT fk');
  await assert.rejects(c.query("INSERT INTO oportunidades_acoes(empresa_id,contato_id,responsavel_id,tipo,data,criada_por) VALUES($1,$2,$3,'Ligar',current_date,$3)",[b,ca,pb.usuario]),/fora da empresa/);await c.query('ROLLBACK TO SAVEPOINT fk');
  sessao=pa.sessao;
  const cli=await cliente(c,a,'Negociação sintética','11988880004'),base=await comercial(c,a);
  await travarConfiguracaoAgenda(executor(c),a,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
  const f=await fechamento(c,a,base,cli,{data:'2027-06-01',atualizadoHaDias:15});
  let item=(await ok()).itens.find(i=>i.id===f)!;assert(item.sugerirPerda);assert.equal(item.etapa,'Proposta');
  await c.query("UPDATE fechamentos SET status='AGUARDANDO_CONTRATO' WHERE id=$1",[f]);
  await c.query("UPDATE fechamentos SET status='CONTRATO_ASSINADO' WHERE id=$1",[f]);
  await c.query("UPDATE fechamentos SET status='CONFIRMADO' WHERE id=$1",[f]);
  assert.equal((await ok()).contadores.fechadas,1);
  const rel=await consultas.relatorioFunil(executor(c),a,hoje,hoje,null);for(const l of rel.conversoes.slice(1)){assert.equal(l.base,1);assert.equal(l.convertidas,1);}
  const assinado=await fechamento(c,a,base,cli,{data:'2027-06-02',status:'AGUARDANDO_CONTRATO'});await contratoAssinado(c,assinado,4500,null);
  assert.equal((await chamar({acao:'perder',alvo:{tipo:'FECHAMENTO',id:assinado},esperada:null,perda:{motivo:'Outro'}})).status,409,'assinatura real bloqueia mesmo com fechamento em estado antigo');
  const n=(await c.query("SELECT count(*)::int AS n FROM eventos_historico_cliente WHERE cliente_id=(SELECT cliente_id FROM marketing_contatos WHERE id=$1) AND tipo_evento LIKE 'OPORTUNIDADE_%'",[ca])).rows[0].n;assert.equal(n,4,'2 mudanças + conclusão + perda');
  item=(await ok()).itens.find(i=>i.id===assinado)!;assert(item);
  const contatoTransferir=await novo('Contato que virou proposta');
  const acaoTransferir=(await ok(agendar(contatoTransferir,pa.usuario))).id;
  const clienteTransferir=(await c.query<{cliente_id:string}>('SELECT cliente_id FROM marketing_contatos WHERE id=$1',[contatoTransferir])).rows[0].cliente_id;
  await travarConfiguracaoAgenda(executor(c),a,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
  const novaNegociacao=await fechamento(c,a,base,clienteTransferir,{data:'2027-07-01'});
  const conversao=carregar<{herdarAcoesDoContato(tx:unknown,f:string):Promise<void>}>('lib/oportunidades/conversao.ts');
  await conversao.herdarAcoesDoContato(executor(c),novaNegociacao);
  const novoItem=(await ok()).itens.find(i=>i.id===novaNegociacao)!;assert.equal(novoItem.proxima?.id,acaoTransferir,'próximo passo acompanha a negociação');
  assert(!(await ok()).itens.some(i=>i.id===contatoTransferir),'contato convertido não duplica cartão');
  await c.query('SAVEPOINT unica');
  await assert.rejects(c.query("INSERT INTO oportunidades_acoes(empresa_id,fechamento_id,responsavel_id,tipo,data,criada_por) VALUES($1,$2,$3,'Ligar',current_date,$3)",[a,novaNegociacao,pa.usuario]),/duplicate key/);await c.query('ROLLBACK TO SAVEPOINT unica');
  await c.query(`INSERT INTO festa_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo)
   SELECT $1,$2,'FESTA_CORRIGIR',$3,'Fixture de cancelamento' WHERE NOT EXISTS(SELECT 1 FROM festa_membership_capacidades WHERE empresa_id=$1 AND membership_id=$2 AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL)`,[a,pa.membership,pa.usuario]);
  await travarConfiguracaoAgenda(executor(c),a,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
  const antesAssinatura=await fechamento(c,a,base,cli,{data:'2027-08-01',status:'AGUARDANDO_CONTRATO'});
  const contratoAberto=(await c.query<{id:string}>("INSERT INTO contratos(fechamento_id,status) VALUES($1,'AGUARDANDO_ASSINATURA') RETURNING id::text",[antesAssinatura])).rows[0].id;
  await ok({acao:'perder',alvo:{tipo:'FECHAMENTO',id:antesAssinatura},esperada:null,perda:{motivo:'Data ocupada'}});
  assert.equal((await c.query('SELECT status FROM contratos WHERE id=$1',[contratoAberto])).rows[0].status,'CANCELADO');
  assert.equal((await c.query('SELECT perda_motivo FROM fechamentos WHERE id=$1',[antesAssinatura])).rows[0].perda_motivo,'Data ocupada');
  await c.query('ROLLBACK');
 }finally{await encerrarDescartavel(c);}
});
// Bloco B item 9 (staging 15/11, erro 79F76F26/KD114): "Feito" e próximo passo numa negociação e o vínculo manual de um
// contato a uma negociação gravam em fechamentos. Fixture COMITADA e entrada em transação NOVA, sem trava herdada (como
// em staging): a 114 só deixa gravar se a própria entrada travar a configuração da agenda.
test('KD114: agendar/concluir na negociação e vincular contato sem trava herdada',{timeout:180000},async(t)=>{
 if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel'){t.skip('postgres-descartavel: opt-in ausente');return;}
 const c=await conectarDescartavel();
 try{
  await c.query('BEGIN');
  const e=await empresa(c,'Funil KD114 sintética');
  const u=(await c.query<{id:string}>("INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'Responsável KD114',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id::text",[randomUUID()+'@funil.test',SENHA_FALSA])).rows[0].id;
  const p=await vincular(c,e,u,'REPRESENTANTE_AUTORIZADO');
  const cli=await cliente(c,e,'Cliente KD114 sintético','11988880114'),base=await comercial(c,e);
  await travarConfiguracaoAgenda(executor(c),e,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
  const negociacao=await fechamento(c,e,base,cli,{data:'2027-10-01'}),destino=await fechamento(c,e,base,cli,{data:'2027-10-02'});
  await c.query('COMMIT');
  await c.query('BEGIN');
  const travas=async()=>(await c.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.objsubid=1
    AND ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended('kidmais:agenda-config:'||$1::text,0)`,[e])).rows[0].n;
  assert.equal(await travas(),0,'a entrada começa sem a configuração travada');
  const cache=new Map(),carregar=<T,>(arq:string)=>carregarComBanco(arq,c,()=>p.sessao,{},cache) as T;
  const rota=carregar<Rota>('app/api/admin/oportunidades/route.ts');
  const ok=async(body:unknown)=>{const r=await rota.POST(pedido('http://127.0.0.1:3000/api/admin/oportunidades',body)),j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j.data as {id:string;hoje:string};};
  const hoje=(await (await rota.GET(pedido('http://127.0.0.1:3000/api/admin/oportunidades'))).json()).data!.hoje as string;
  assert.equal(await travas(),0,'a leitura do Funil não trava a configuração');
  const primeira=(await ok({acao:'agendar',alvo:{tipo:'FECHAMENTO',id:negociacao},esperada:null,proxima:{tipo:'Ligar',data:hoje,responsavelId:u}})).id;
  // Astra P3: "Feito" em transação própria (o harness usa savepoints; na mesma transação herdaria a trava do agendar).
  await c.query('COMMIT');
  await c.query('BEGIN');
  assert.equal(await travas(),0,'o concluir começa sem a trava do agendar');
  const segunda=(await ok({acao:'concluir',alvo:{tipo:'FECHAMENTO',id:negociacao},esperada:primeira,proxima:{tipo:'WhatsApp',data:hoje,responsavelId:u}})).id;
  assert.equal((await c.query("SELECT resultado FROM oportunidades_acoes WHERE id=$1",[primeira])).rows[0].resultado,'FEITA');
  assert.equal((await c.query('SELECT fechamento_id::text FROM oportunidades_acoes WHERE id=$1 AND encerrada_em IS NULL',[segunda])).rows[0].fechamento_id,negociacao);
  assert.equal((await c.query('SELECT usuario_responsavel_id::text AS r FROM fechamentos WHERE id=$1',[negociacao])).rows[0].r,u);
  await c.query('ROLLBACK');
  // Vínculo manual numa transação nova, sem configuração travada.
  await c.query('BEGIN');
  const k=(await ok({acao:'registrar',nome:'Contato KD114 sintético',telefone:'11988880114',canal:'TELEFONE',chave:randomUUID()})).id;
  const acao=(await ok({acao:'agendar',alvo:{tipo:'CONTATO',id:k},esperada:null,proxima:{tipo:'Ligar',data:hoje,responsavelId:u}})).id;
  assert.equal(await travas(),0,'ações em contato não travam a configuração');
  await c.query('COMMIT');
  await c.query('BEGIN');
  assert.equal(await travas(),0);
  // Astra P3: o vínculo manual pelo POST real do Marketing (rotaMarketing → tenant em FOR UPDATE → serviço).
  const marketing=carregar<Rota>('app/api/admin/marketing/contatos/route.ts');
  const vinculo=await marketing.POST(pedido('http://127.0.0.1:3000/api/admin/marketing/contatos',{acao:'vincular-negociacao',id:k,fechamentoId:destino}));
  assert.equal(vinculo.status,200,JSON.stringify(await vinculo.json()));
  assert.equal((await c.query('SELECT fechamento_id::text FROM oportunidades_acoes WHERE id=$1',[acao])).rows[0].fechamento_id,destino,'ação transferida para a negociação');
  assert.equal((await c.query('SELECT usuario_responsavel_id::text AS r FROM fechamentos WHERE id=$1',[destino])).rows[0].r,u);
  await c.query('ROLLBACK');
 }finally{await c.query('ROLLBACK').catch(()=>{});await encerrarDescartavel(c);}
});
