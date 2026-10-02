import assert from 'node:assert/strict';
import test from 'node:test';
import { comandoDireto, configuracaoSchema, dataDeInteresse, dataValida, entradaGupshup, hojeOperacao, interpretacaoSchema, janelaAberta, responder } from './core.ts';
const config = {ativo:true,nome:'Empresa sintética',perguntas:[{id:'endereco',pergunta:'Onde fica?',resposta:'Endereço aprovado pelo responsável.'}]};
const plano = {intencao:'DUVIDA' as const,perguntaId:'endereco',data:null,convidados:null};
test('FAQ só responde com fonte publicada; id desconhecido encaminha para humano',()=>{
  assert.equal(responder(config,plano,{data:null,convidados:null}).texto,config.perguntas[0].resposta);
  assert.equal(responder(config,{...plano,perguntaId:'inventado'},{data:null,convidados:null}).humano,true);
  assert.equal(interpretacaoSchema.safeParse({...plano,texto:'Preço inventado'}).success,false);
  assert.equal(configuracaoSchema.safeParse({...config,perguntas:[config.perguntas[0],config.perguntas[0]]}).success,false);
});
test('qualificação pede campos ausentes, rejeita data inválida e não reserva',()=>{
  const p={...plano,intencao:'INTERESSE' as const};
  assert.match(responder(config,p,{data:null,convidados:null}).texto!,/ano/);
  assert.match(responder(config,p,{data:'2026-10-18',convidados:null}).texto!,/Quantas/);
  assert.equal(dataValida('2026-02-30'),false);assert.equal(dataValida('2028-02-29'),true);
  assert.match(responder(config,{...p,data:'2026-02-30'},{data:'2026-02-30',convidados:50}).texto!,/não existe/);
  const pronta=responder(config,p,{data:'2026-10-18',convidados:50});assert.equal(pronta.humano,true);assert.match(pronta.texto!,/não está reservada/);
});
test('opt out e atendente dispensam modelo; janela expira exatamente em 24h',()=>{
  assert.equal(comandoDireto('PARAR')?.intencao,'PARAR');assert.equal(comandoDireto('Quero um atendente')?.intencao,'HUMANO');
  assert.equal(responder(config,{...plano,intencao:'PARAR'},{data:null,convidados:null}).texto,null);
  const em=new Date('2026-10-01T12:00:00Z');assert.equal(janelaAberta(em,new Date('2026-10-02T11:59:59Z')),true);assert.equal(janelaAberta(em,new Date('2026-10-02T12:00:00Z')),false);assert.equal(janelaAberta(em,new Date('2026-10-01T11:00:00Z')),false);
});
test('entrada valida app, limites e mídia sem visitar URLs',()=>{
  const evento={app:'KidmaisManager',version:2,type:'message',timestamp:1789550000000,payload:{id:'sintetico',type:'text',source:'5511999990000',payload:{text:'Olá'}}};
  assert.equal(entradaGupshup(evento)?.texto,'Olá');assert.equal(entradaGupshup({...evento,app:'Outra empresa'}),null);
  assert.equal(entradaGupshup({...evento,payload:{...evento.payload,payload:{text:'x'.repeat(4001)}}})?.texto,null);
  assert.equal(entradaGupshup({...evento,payload:{...evento.payload,payload:{text:'x'.repeat(4001)}}})?.id,'sintetico');
  assert.equal(entradaGupshup({...evento,payload:{...evento.payload,type:'image',payload:{url:'https://example.invalid'}}})?.texto,null);
});
test('data passada não é registrada como interesse; hoje usa o fuso da operação',()=>{
  const p={...plano,intencao:'INTERESSE' as const};
  assert.match(responder(config,{...p,data:'2026-09-30'},{data:null,convidados:null},'2026-10-01').texto!,/já passou/);
  assert.match(responder(config,{...p,data:'2026-10-01'},{data:'2026-10-01',convidados:null},'2026-10-01').texto!,/Quantas/);
  assert.equal(dataDeInteresse('2026-09-30','2026-10-01'),null);assert.equal(dataDeInteresse('2026-02-30','2026-01-01'),null);assert.equal(dataDeInteresse('2027-11-14','2026-10-01'),'2027-11-14');
  assert.equal(hojeOperacao(new Date('2026-10-02T02:30:00Z')),'2026-10-01');
});
test('lista de contatos permitidos: staging exige lista; produção sem lista atende todos; entrada inválida fecha',async()=>{
  const { contatoPermitido } = await import('./configuracao.ts');
  const env=(ambiente:string,lista?:string)=>({KIDMAIS_DEPLOY_ENV:ambiente,...(lista===undefined?{}:{WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS:lista})}) as unknown as NodeJS.ProcessEnv;
  assert.equal(contatoPermitido('5561999990000',env('staging')),false);
  assert.equal(contatoPermitido('5561999990000',env('staging','5561999990000, 5561888880000')),true);
  assert.equal(contatoPermitido('5561777770000',env('staging','5561999990000')),false);
  assert.equal(contatoPermitido('5561999990000',env('staging','5561999990000,+55 61')),false);
  assert.equal(contatoPermitido('5561777770000',env('production')),true);
  assert.equal(contatoPermitido('5561777770000',env('production','5561999990000')),false);
});
