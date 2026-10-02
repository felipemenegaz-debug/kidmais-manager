import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as core from './core.ts';
import type { Conversa, Mensagem } from './service.ts';

const agora = new Date();
const conversa: Conversa = {id:'c',empresa_id:'e',ambiente:'staging',contato:'5561999999999',estado:'IA',responsavel_id:null,nao_contatar:false,versao:3,ultima_entrada_em:agora.toISOString(),interesse:{data:null,convidados:null}};
const mensagem: Mensagem = {id:'m',conversa_id:'c',empresa_id:'e',ambiente:'staging',direcao:'SAIDA',origem_id:'entrada',autor_usuario_id:null,texto:'Resposta aprovada',estado:'PENDENTE',versao_conversa:3,criada_em:agora.toISOString()};
let limpezas=0; const correlacoes:string[]=[];
function carregar(query: (sql: string, args?: unknown[]) => Promise<{rows: unknown[]}>, ativo=true, permitido=true) {
  return carregarComponente('lib/whatsapp/atendimento/worker.ts', {
    '../../db/postgres.ts':{db:()=>({query}),withTransaction:async(fn:(tx:unknown)=>unknown)=>fn({query})},
    './configuracao.ts':{ambienteAtendimento:()=> 'staging',empresaPiloto:()=> 'e',atendimentoAtivo:()=>ativo,contatoPermitido:()=>permitido},
    './core.ts':core,
    './service.ts':{configuracao:async()=>({ativo:true,nome:'Kidmais',perguntas:[]}),recuperarTrabalhosInterrompidos:async()=>{},limparStatusExpirados:async()=>{limpezas++;},correlacionarStatus:async(_tx:unknown,_e:string,_a:string,id:string)=>{correlacoes.push(id);}},
    './modelo.ts':{interpretarMensagem:async()=>{throw Error('modelo real proibido no teste');}},
    './transporte.ts':{enviarMensagem:async()=>{throw Error('rede real proibida no teste');}},
  }).modulo as {
    mensagemAindaValida(m:Mensagem,c:Conversa,agora?:Date):boolean;
    processarAtendimento(deps: {interpretar:()=>Promise<core.Interpretacao>;enviar:()=>Promise<string>}):Promise<string>;
    processarLote(deps: {interpretar:()=>Promise<core.Interpretacao>;enviar:()=>Promise<string>},opcoes?:{maxTarefas?:number;prazoMs?:number;relogio?:()=>number}):Promise<{estado:string;tarefas:number}>;
  };
}
test('tomada humana e revisão posterior invalidam resposta automática; novos eventos preservam mensagem do responsável',async()=>{
  const {mensagemAindaValida:valida}=carregar(async()=>({rows:[]}));
  assert.equal(valida(mensagem,conversa,agora),true);
  assert.equal(valida(mensagem,{...conversa,versao:4},agora),false);
  assert.equal(valida(mensagem,{...conversa,estado:'HUMANO',responsavel_id:'u'},agora),false);
  const manual={...mensagem,origem_id:null,autor_usuario_id:'u'};
  const humana={...conversa,estado:'HUMANO' as const,responsavel_id:'u',versao:8};
  assert.equal(valida(manual,humana,agora),true);
  assert.equal(valida({...manual,criada_em:new Date(agora.getTime()-24*3600000).toISOString()},humana,agora),false);
  assert.equal(valida(manual,{...humana,responsavel_id:'outro'},agora),false);
  assert.equal(valida(manual,{...humana,nao_contatar:true},agora),false);
  assert.equal(valida(manual,{...humana,ultima_entrada_em:new Date(agora.getTime()-24*3600000).toISOString()},agora),false);
});
test('automação desligada não consulta banco, modelo ou provedor',async()=>{
  const worker=carregar(async()=>{throw Error('banco proibido');},false);
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{throw Error('envio proibido');}}),'DESLIGADO');
});
test('assumir conversa entre reserva da tarefa e envio cancela resposta sem chamar provedor',async()=>{
  let leituras=0,envios=0; const estados:unknown[]=[];
  const worker=carregar(async(sql,args)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[mensagem]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[++leituras===1?conversa:{...conversa,estado:'HUMANO',responsavel_id:'u',versao:4}]};
    if(sql.includes("SET estado=$2")) estados.push(args?.[1]);
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}}),'CANCELADA');
  assert.equal(envios,0); assert.deepEqual(estados,['PROCESSANDO','CANCELADA']);
});
test('timeout do provedor marca entrega incerta e não tenta enviar novamente',async()=>{
  let envios=0; const comandos:string[]=[];
  const worker=carregar(async(sql)=>{
    comandos.push(sql);
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[mensagem]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;throw Error('timeout');}}),'ENCAMINHADA');
  assert.equal(envios,1); assert(comandos.some(sql=>sql.includes("THEN 'INCERTO'"))); assert(comandos.some(sql=>sql.includes("estado='AGUARDANDO_HUMANO'")));
});
test('orçamento esgotado ou modelo indisponível encaminha para humano sem resposta automática',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Qual o horário de vocês?'};
  let envios=0; const comandos:string[]=[];
  const worker=carregar(async(sql)=>{
    comandos.push(sql);
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('ATENDIMENTO_MODELO_INDISPONIVEL');},enviar:async()=>{envios++;return 'id';}}),'ENCAMINHADA');
  assert.equal(envios,0);
  assert(comandos.some(sql=>sql.includes("ELSE 'FALHOU'"))); assert(comandos.some(sql=>sql.includes("estado='AGUARDANDO_HUMANO'")));
  assert(!comandos.some(sql=>sql.includes("'SAIDA',$5,'PENDENTE'")),'nenhuma resposta automática é criada');
});

test('lote esvazia a fila numa chamada: entrada e saída da mesma resposta sem esperar o próximo ciclo',async()=>{
  const fila=[{...mensagem,id:'entrada',direcao:'ENTRADA',origem_id:null,texto:'Onde fica?'},{...mensagem,id:'saida'}];
  let envios=0; limpezas=0; correlacoes.length=0;
  const worker=carregar(async(sql)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) { const proxima=fila.shift(); return {rows:proxima?[proxima]:[]}; }
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  const deps={interpretar:async()=>({intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null}),enviar:async()=>{envios++;return 'provedor-1';}};
  assert.deepEqual(await worker.processarLote(deps),{estado:'SEM_TAREFA',tarefas:2});
  assert.equal(envios,1); assert.equal(limpezas,1); assert.deepEqual(correlacoes,['provedor-1']);
});
test('lote para no limite de tarefas ou de tempo e devolve LIMITE para o worker chamar de novo',async()=>{
  const worker=carregar(async(sql)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[{...mensagem,versao_conversa:99}]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  const deps={interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{throw Error('envio proibido');}};
  // Mensagens obsoletas são canceladas sem modelo nem envio e não encerram o lote.
  assert.deepEqual(await worker.processarLote(deps,{maxTarefas:3}),{estado:'LIMITE',tarefas:3});
  let t=0; assert.deepEqual(await worker.processarLote(deps,{prazoMs:10,relogio:()=>(t+=6)}),{estado:'LIMITE',tarefas:1});
  assert.deepEqual(await carregar(async()=>{throw Error('banco proibido');},false).processarLote(deps),{estado:'DESLIGADO',tarefas:0});
});
test('destino fora da lista permitida é cancelado antes do provedor',async()=>{
  let envios=0;
  const worker=carregar(async(sql)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[mensagem]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  },true,false);
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}}),'CANCELADA');
  assert.equal(envios,0);
});
