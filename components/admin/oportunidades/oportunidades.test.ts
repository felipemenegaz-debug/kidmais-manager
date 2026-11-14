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
  '../marketing/comum':{EstadoCarga:()=>null,useMarketing:()=>({dados,dadosDe:'/api/admin/oportunidades',carregando:false,falha:null,recarregar:()=>{}})},
 });
 const arvore=c.render(),botoes=elementos(arvore).filter(e=>e.type==='button').map(texto);
 assert(texto(arvore).includes('Contato recorrente'));assert(texto(arvore).includes('Proposta sintética'));
 assert(botoes.includes('Atualizar'));
 for(const rotulo of ['Novo contato','Feito','Ação ou perda','Definir próxima ação']) assert.equal(botoes.includes(rotulo),podeEditar,rotulo);
});
