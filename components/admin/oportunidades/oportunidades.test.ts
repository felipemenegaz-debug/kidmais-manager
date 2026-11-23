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
