import test from 'node:test';
import assert from 'node:assert/strict';
import {carregarComponente,cssFalso,elementos,texto} from '../teste-componente.ts';

for(const podeEditar of [false,true]) test(`funil: edição ${podeEditar?'disponível para editor':'oculta para leitor'}`,()=>{
 const dados={podeEditar,hoje:'2026-11-14',usuarioId:'B',responsaveis:[{id:'B',nome:'Pessoa B'}],contadores:{fechadas:0,perdidas:0,fechadasSemData:0},itens:[
  {id:'contato',tipo:'CONTATO',nome:'Contato recorrente',etapa:'Novo contato',valor:null,responsavelId:'B',href:'/clientes/sintetico',proxima:{id:'acao',tipo:'Ligar',data:'2026-11-14'},sugerirPerda:false},
  {id:'negociacao',tipo:'FECHAMENTO',nome:'Proposta sintética',etapa:'Proposta',valor:'4500',responsavelId:'B',href:'/admin/fechamentos/sintetico/revisao',proxima:null,sugerirPerda:false},
 ]};
 const c=carregarComponente('components/admin/oportunidades/Oportunidades.tsx',{
  'next/link':{default:'a'},'./oportunidades.module.css':cssFalso,
  './MotivoPerda':{MotivoPerda:()=>null},
  '../marketing/comum':{EstadoCarga:()=>null,useMarketing:()=>({dados,dadosDe:'/api/admin/oportunidades',carregando:false,falha:null,recarregar:()=>{}})},
 });
 const arvore=c.render(),botoes=elementos(arvore).filter(e=>e.type==='button').map(texto);
 assert(texto(arvore).includes('Contato recorrente'));assert(texto(arvore).includes('Proposta sintética'));
 assert(botoes.includes('Atualizar'));
 for(const rotulo of ['Novo contato','Feito','Ação ou perda','Definir próxima ação']) assert.equal(botoes.includes(rotulo),podeEditar,rotulo);
});

// 23/11/2026: o foco da janela recarrega o Funil; a recarga em segundo plano não pode desativar as ações (o foco chega antes
// do clique e o primeiro clique de quem volta de outra janela se perdia). Primeira carga e troca de filtro seguem bloqueando.
for(const [cenario,estado,ativo] of [
 ['recarga em segundo plano',{carregando:true,dadosDe:'/api/admin/oportunidades'},true],
 ['dados de outra consulta (troca de filtro)',{carregando:true,dadosDe:'/api/admin/oportunidades?responsavelId=X'},false],
 ['falha na carga',{carregando:false,dadosDe:'/api/admin/oportunidades',falha:{mensagem:'x'}},false],
] as const) test(`funil: ações ${ativo?'ativas':'bloqueadas'} — ${cenario}`,()=>{
 const dados={podeEditar:true,hoje:'2026-11-23',usuarioId:'B',responsaveis:[{id:'B',nome:'Pessoa B'}],contadores:{fechadas:0,perdidas:0,fechadasSemData:0},itens:[
  {id:'contato',tipo:'CONTATO',nome:'Contato parado',etapa:'Novo contato',valor:null,responsavelId:null,href:'/clientes/sintetico',proxima:null,sugerirPerda:true},
 ]};
 const c=carregarComponente('components/admin/oportunidades/Oportunidades.tsx',{
  'next/link':{default:'a'},'./oportunidades.module.css':cssFalso,'./MotivoPerda':{MotivoPerda:()=>null},
  '../marketing/comum':{EstadoCarga:()=>null,useMarketing:()=>({dados,falha:null,recarregar:()=>{},...estado})},
 });
 const arvore=c.render();
 if('falha' in estado) { assert(!elementos(arvore).some(e=>e.type==='button'&&texto(e)==='Definir próxima ação')); return; }
 const botao=elementos(arvore).find(e=>e.type==='button'&&texto(e)==='Definir próxima ação');
 assert(botao);assert.equal(!botao.props.disabled,ativo);
});

test('motivo da perda: seis opções de escolha única, obrigatórias, sem lista nativa',()=>{
 const escolhas:string[]=[];
 const c=carregarComponente('components/admin/oportunidades/MotivoPerda.tsx',{'./MotivoPerda.module.css':cssFalso});
 const arvore=c.render('MotivoPerda',{nome:'motivo-teste',valor:'Preço',aoMudar:(m:string)=>escolhas.push(m)});
 const radios=elementos(arvore).filter(e=>e.type==='input');
 assert.equal(radios.length,6);assert(!elementos(arvore).some(e=>e.type==='select'));
 for(const r of radios){assert.equal(r.props.type,'radio');assert.equal(r.props.name,'motivo-teste');assert.equal(r.props.required,true);}
 assert.deepEqual(radios.filter(r=>r.props.checked).map(r=>r.props.value),['Preço']);
 (radios.find(r=>r.props.value==='Outro')!.props.onChange as ()=>void)();
 assert.deepEqual(escolhas,['Outro']);
});

// 24/11/2026: Novo contato registra "como conheceu" quando o pedido chega sem referência automática (telefone, indicação,
// conversa de WhatsApp atendida por pessoa). Sem as listas (leitor ou resposta sem elas), o modal é o de antes.
const ORIGENS=[{codigo:'INDICACAO',rotulo:'Indicação',ativa:true,ordem:1,personalizada:false},{codigo:'GOOGLE',rotulo:'Google',ativa:false,ordem:2,personalizada:false}];
function novoContato(props:Record<string,unknown>){
 const enviados:Array<{url:string;corpo:Record<string,unknown>}>=[];
 const h=carregarComponente('components/admin/oportunidades/Oportunidades.tsx',{
  'next/link':{default:'a'},'./oportunidades.module.css':cssFalso,'./MotivoPerda':{MotivoPerda:()=>null},
  '../marketing/comum':{EstadoCarga:()=>null,useMarketing:()=>({}),enviarMarketing:async(url:string,corpo:Record<string,unknown>)=>{enviados.push({url,corpo});return {};}},
 });
 const base={fechar:()=>{},salvo:()=>{},...props};
 const render=()=>h.render('NovoContato',base);
 const campo=(rotulo:string)=>elementos(render()).find(e=>e.type==='label'&&texto(e).startsWith(rotulo));
 const escolher=(rotulo:string,valor:string)=>{const sel=elementos(campo(rotulo)).find(e=>e.type==='select')!;(sel.props.onChange as (e:unknown)=>void)({target:{value:valor}});};
 const digitar=(rotulo:string,valor:string)=>{const inp=elementos(campo(rotulo)).find(e=>e.type==='input')!;(inp.props.onChange as (e:unknown)=>void)({target:{value:valor}});};
 const enviar=async()=>{const form=elementos(render()).find(e=>e.type==='form')!;await (form.props.onSubmit as (e:unknown)=>Promise<void>)({preventDefault(){}});};
 return {render,campo,escolher,digitar,enviar,enviados};
}
const semChave=(corpo:Record<string,unknown>)=>Object.fromEntries(Object.entries(corpo).filter(([k])=>k!=='chave'));

test('Novo contato com as listas: canal (Telefone padrão), como conheceu (só ativas) e campanha seguem para a ação registrar',async()=>{
 const t=novoContato({origens:ORIGENS,campanhas:[{id:'33333333-3333-4333-8333-333333333333',nome:'Dia das Crianças'}]});
 const opcoes=(rotulo:string)=>elementos(t.campo(rotulo)).filter(e=>e.type==='option').map(texto);
 assert.deepEqual(opcoes('Chegou por'),['Telefone','WhatsApp','Presencial','E-mail','Outro']);
 assert.equal(elementos(t.campo('Chegou por')).find(e=>e.type==='select')!.props.value,'TELEFONE');
 assert.deepEqual(opcoes('Como conheceu'),['Não sei / não perguntado','Indicação']);
 assert.deepEqual(opcoes('Campanha (opcional)'),['Nenhuma','Dia das Crianças']);
 t.digitar('Nome','Fulana');t.digitar('Telefone com DDD','(11) 99999-0000');
 t.escolher('Chegou por','WHATSAPP');t.escolher('Como conheceu','INDICACAO');t.escolher('Campanha (opcional)','33333333-3333-4333-8333-333333333333');
 await t.enviar();
 assert.equal(t.enviados.length,1);
 assert.equal(t.enviados[0].url,'/api/admin/oportunidades');assert.match(String(t.enviados[0].corpo.chave),/^[0-9a-f-]{36}$/);
 assert.deepEqual(semChave(t.enviados[0].corpo),{acao:'registrar',nome:'Fulana',telefone:'11999990000',canal:'WHATSAPP',mensagem:'',origemCodigo:'INDICACAO',campanhaId:'33333333-3333-4333-8333-333333333333'});
});

test('Novo contato sem escolher origem: corpo sem origem nem campanha (fica desconhecida); sem campanhas, sem o campo',async()=>{
 const t=novoContato({origens:ORIGENS,campanhas:[]});
 assert.equal(t.campo('Campanha'),undefined);
 t.digitar('Nome','Fulana');t.digitar('Telefone com DDD','11999990000');await t.enviar();
 assert.deepEqual(semChave(t.enviados[0].corpo),{acao:'registrar',nome:'Fulana',telefone:'11999990000',canal:'TELEFONE',mensagem:''});
});

test('Novo contato sem as listas (resposta sem Marketing de edição): modal como antes, sem campos de origem',async()=>{
 const t=novoContato({});
 assert.equal(t.campo('Como conheceu'),undefined);assert.equal(t.campo('Campanha'),undefined);
 assert.ok(t.campo('Chegou por'),'canal continua (Telefone padrão)');
 t.digitar('Nome','Fulana');t.digitar('Telefone com DDD','11999990000');await t.enviar();
 assert.deepEqual(semChave(t.enviados[0].corpo),{acao:'registrar',nome:'Fulana',telefone:'11999990000',canal:'TELEFONE',mensagem:''});
});

test('funil passa as listas da resposta ao Novo contato',()=>{
 const dados={podeEditar:true,hoje:'2026-11-24',usuarioId:'B',responsaveis:[],contadores:{fechadas:0,perdidas:0,fechadasSemData:0},itens:[],origens:ORIGENS,campanhas:[]};
 const c=carregarComponente('components/admin/oportunidades/Oportunidades.tsx',{
  'next/link':{default:'a'},'./oportunidades.module.css':cssFalso,'./MotivoPerda':{MotivoPerda:()=>null},
  '../marketing/comum':{EstadoCarga:()=>null,useMarketing:()=>({dados,dadosDe:'/api/admin/oportunidades',carregando:false,falha:null,recarregar:()=>{}})},
 });
 const botao=elementos(c.render()).find(e=>e.type==='button'&&texto(e)==='Novo contato')!;(botao.props.onClick as ()=>void)();
 const modal=elementos(c.render()).find(e=>e.type===c.modulo.NovoContato)!;
 assert.equal(modal.props.origens,ORIGENS);assert.deepEqual(modal.props.campanhas,[]);
});

// Rota do Funil: as listas só vão a quem pode registrar (campanhas sem arquivadas); o POST `registrar` usa o esquema e a
// função de domínio de Marketing sem filtrar campos (a validação de origem e campanha é a dela).
test('rota do funil: GET com origens/campanhas só para quem edita; POST registrar repassa origem e campanha ao domínio',async()=>{
 const {carregarModulo}=await import('../../../lib/acessos/teste-carregador.ts');
 const contatosReal=carregarModulo('lib/marketing/contatos.ts',{'db/postgres':{db:()=>{throw new Error('sem banco');}}});
 for(const caps of [['MARKETING_VISUALIZAR'],['MARKETING_VISUALIZAR','MARKETING_CAMPANHAS_EDITAR']]){
  const chamadas:{campanhas?:unknown;registrado?:unknown}={};
  const rota=carregarModulo('app/api/admin/oportunidades/route.ts',{
   'lib/http/admin-crm-api':{exigirApiAdminCrmDisponivel:async()=>({})},
   'lib/marketing/http':{lerCorpo:async(r:{corpo:unknown})=>r.corpo,parametroUuid:()=>null,rotaMarketing:async(_r:unknown,_g:unknown,_o:unknown,w:(ctx:unknown)=>unknown)=>w({tx:{},tenant:{empresaComprovada:'E',usuarioId:'U'},capacidades:caps})},
   'lib/marketing/contatos':{...contatosReal,executarAcaoContato:async(_tx:unknown,_e:string,_u:string,a:unknown)=>{chamadas.registrado=a;return {id:'K',repetido:false};}},
   'lib/marketing/utm':{hojeSaoPaulo:()=>'2026-11-24'},
   'lib/marketing/origens':{lerOrigens:async()=>ORIGENS},
   'lib/marketing/campanhas':{listarCampanhas:async(_tx:unknown,_e:string,f?:unknown)=>{chamadas.campanhas=f??null;return [{id:'C',nome:'Campanha',status:'ATIVA',codigo:'x'}];}},
   'lib/oportunidades/service':{exigirSchema:async()=>{},clienteDoAlvo:async()=>({}),executarOportunidade:async()=>({})},
   'lib/oportunidades/consultas':{listarOportunidades:async()=>[],responsaveis:async()=>[],contadoresMes:async()=>({})},
  }) as unknown as {GET:(r:unknown)=>Promise<Record<string,unknown>>;POST:(r:unknown)=>Promise<unknown>};
  const dados=await rota.GET({nextUrl:{searchParams:new URLSearchParams()}});
  const edita=caps.includes('MARKETING_CAMPANHAS_EDITAR');
  assert.equal(dados.podeEditar,edita);
  if(!edita){assert.equal('origens' in dados,false);assert.equal('campanhas' in dados,false);assert.equal(chamadas.campanhas,undefined);continue;}
  assert.equal(dados.origens,ORIGENS);assert.deepEqual(dados.campanhas,[{id:'C',nome:'Campanha'}]);assert.equal(chamadas.campanhas,null,'sem incluirArquivadas');
  const corpo={acao:'registrar',nome:'Fulana',telefone:'11999990000',canal:'WHATSAPP',mensagem:'',chave:'0d0c5a3e-1111-4111-8111-111111111111',origemCodigo:'INDICACAO',campanhaId:'33333333-3333-4333-8333-333333333333'};
  await rota.POST({corpo});
  assert.deepEqual(chamadas.registrado,corpo);
 }
});
