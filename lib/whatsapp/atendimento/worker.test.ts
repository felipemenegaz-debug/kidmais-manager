import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as core from './core.ts';
import * as transporte from './transporte.ts';
import * as arquivos from './arquivos.ts';
import type { Conversa, Mensagem } from './service.ts';

const agora = new Date();
const conversa: Conversa = {id:'c',empresa_id:'e',ambiente:'staging',contato:'5561999999999',estado:'IA',responsavel_id:null,nao_contatar:false,versao:3,ultima_entrada_em:agora.toISOString(),interesse:{data:null,convidados:null}};
const mensagem: Mensagem = {id:'m',conversa_id:'c',empresa_id:'e',ambiente:'staging',direcao:'SAIDA',origem_id:'entrada',autor_usuario_id:null,texto:'Resposta aprovada',estado:'PENDENTE',versao_conversa:3,criada_em:agora.toISOString()};
const modoRegras={ativo:false}; let limpezas=0; const correlacoes:string[]=[];
type Cfg = {ativo:boolean;nome:string;perguntas:{id:string;pergunta:string;resposta:string}[];limites:{respostasPor24h:number}};
function carregar(query: (sql: string, args?: unknown[]) => Promise<{rows: unknown[]}>, ativo=true, permitido=true, limite=20, cfg?: (travar:boolean)=>Cfg|null) {
  return carregarComponente('lib/whatsapp/atendimento/worker.ts', {
    '../../db/postgres.ts':{db:()=>({query}),withTransaction:async(fn:(tx:unknown)=>unknown)=>fn({query})},
    './configuracao.ts':{entendimentoSoRegras:()=>modoRegras.ativo,ambienteAtendimento:()=> 'staging',empresaPiloto:()=> 'e',atendimentoAtivo:()=>ativo,contatoPermitido:()=>permitido,origemMidia:()=>null},
    './arquivos.ts':arquivos,
    './core.ts':core,
    './service.ts':{registroDaPausa:(texto:string,em:string)=>({motivo:'PARAR_A_CONFIRMAR',motivos:['PARAR_A_CONFIRMAR'],em,coletado:{data:null,turno:null,convidados:null,pacote:null,unidade:null,tema:null},enviados:[],pendentes:[],ultimaMensagem:texto.slice(0,500)}),configuracao:async(_tx:unknown,_e:string,travar=false)=>cfg?cfg(travar):({ativo:true,nome:'Kidmais',perguntas:[],limites:{respostasPor24h:limite}}),recuperarTrabalhosInterrompidos:async()=>{},limparStatusExpirados:async()=>{limpezas++;},correlacionarStatus:async(_tx:unknown,_e:string,_a:string,id:string)=>{correlacoes.push(id);},tem078:async()=>false},
    './modelo.ts':{interpretarMensagem:async()=>{throw Error('modelo real proibido no teste');}},
    // Funções puras reais (montagem do conteúdo); a rede continua proibida.
    './transporte.ts':{...transporte,enviarMensagem:async()=>{throw Error('rede real proibida no teste');}},
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
  // Saída parada na fila além do prazo não sai mais (automática ou humana), mesmo com a janela aberta.
  const velha=new Date(agora.getTime()-16*60000).toISOString();
  assert.equal(valida({...mensagem,criada_em:velha},conversa,agora),false);
  assert.equal(valida({...manual,criada_em:velha},humana,agora),false);
  assert.equal(valida({...mensagem,criada_em:new Date(agora.getTime()-14*60000).toISOString()},conversa,agora),true);
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
test('orçamento esgotado ou modelo indisponível: equipe assume e o contato recebe só o texto fixo de encaminhamento',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Qual o horário de vocês?'};
  let envios=0; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('ATENDIMENTO_MODELO_INDISPONIVEL');},enviar:async()=>{envios++;return 'id';}}),'ENCAMINHADA');
  assert.equal(envios,0);
  assert.deepEqual(comandos.find(c=>c.sql.includes("SET estado=$2 WHERE id=$1 AND estado='PROCESSANDO'"))?.args,['m','FALHOU']);
  assert.deepEqual(comandos.find(c=>c.sql.includes("SET estado='AGUARDANDO_HUMANO',versao=$2"))?.args,['c',4]);
  const fixa=comandos.find(c=>c.sql.includes("'SAIDA',$5,'PENDENTE',$6"));
  assert.deepEqual(fixa?.args,['c','e','staging','m',core.MENSAGEM_ENCAMINHAMENTO,4],'só o texto fixo, na nova versão da conversa');
});
test('falha do modelo depois que um atendente assumiu não cria mensagem automática',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Quanto custa?'};
  let leituras=0; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[++leituras===1?conversa:{...conversa,estado:'HUMANO',responsavel_id:'u',versao:4}]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('timeout');},enviar:async()=>'id'}),'ENCAMINHADA');
  assert.deepEqual(comandos.find(c=>c.sql.includes("WHERE id=$1 AND estado='PROCESSANDO'"))?.args,['m','CANCELADA']);
  assert.equal(comandos.some(c=>c.sql.includes('INSERT INTO whatsapp_atendimento_mensagens')),false);
});
test('limite de respostas em 24 h encaminha à equipe sem chamar o modelo',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Mais uma pergunta'};
  let modelo=0; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes('SELECT count(*) AS n')) return {rows:[{n:'3'}]};
    return {rows:[]};
  },true,true,3);
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{modelo++;return {intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null};},enviar:async()=>'id'}),'ENCAMINHADA');
  assert.equal(modelo,0);
  const contagem=comandos.find(c=>c.sql.includes('SELECT count(*) AS n'))!;
  assert.match(contagem.sql,/direcao='SAIDA' AND autor_usuario_id IS NULL AND estado<>'CANCELADA' AND criada_em > clock_timestamp\(\)-interval '24 hours'/);
  assert.deepEqual(comandos.find(c=>c.sql.includes("WHERE id=$1 AND estado='PROCESSANDO'"))?.args,['m','PROCESSADA']);
  assert.equal(comandos.find(c=>c.sql.includes("'SAIDA',$5,'PENDENTE',$6"))?.args?.[4],core.MENSAGEM_ENCAMINHAMENTO);
});
test('ordem: a resposta considera a entrada mais recente pelo horário do evento, mesmo que tenha chegado antes',async()=>{
  // "Oi" chegou por último (versão atual da conversa), mas o evento "Para 40 pessoas" é mais recente.
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Oi',criada_em:new Date(agora.getTime()-60000).toISOString()};
  const comandos:{sql:string;args?:unknown[]}[]=[]; let pedido='';
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes('SELECT texto FROM')) return {rows:[{texto:'Para 40 pessoas'},{texto:'Oi'}]};
    return {rows:[]};
  });
  await worker.processarAtendimento({interpretar:async(_e:string,texto:string)=>{pedido=texto;return {intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null};},enviar:async()=>'id'} as never);
  const historico=comandos.find(c=>c.sql.includes('SELECT texto FROM'))!;
  assert.doesNotMatch(historico.sql,/criada_em<=/,'não corta entradas mais recentes que chegaram antes');
  assert.match(historico.sql,/ORDER BY criada_em DESC,id DESC LIMIT 8/);
  assert.deepEqual(JSON.parse(pedido).mensagens,['Oi','Para 40 pessoas']);
  assert.equal(JSON.parse(pedido).mensagemAtual,'Para 40 pessoas');
});
test('recusa do provedor termina FALHOU; timeout continua INCERTO; nenhum reenvio',async()=>{
  const casos=[['ATENDIMENTO_ENVIO_RECUSADO',true],['ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO',true],['ATENDIMENTO_RESULTADO_INCERTO',false]] as const;
  for (const [erro,naoEnviada] of casos) {
    let envios=0; const comandos:{sql:string;args?:unknown[]}[]=[];
    const worker=carregar(async(sql,args)=>{
      comandos.push({sql,args});
      if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
      if(sql.includes('SELECT m.*')) return {rows:[mensagem]};
      if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
      return {rows:[]};
    });
    assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;throw Error(erro);}}),'ENCAMINHADA');
    assert.equal(envios,1);
    assert.deepEqual(comandos.find(c=>c.sql.includes("THEN 'INCERTO'"))?.args,['m',naoEnviada],erro);
  }
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
test('entrada antiga que chega depois de uma mais recente já tratada vira só histórico: sem modelo e sem nova resposta',async()=>{
  const atrasada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Oi',criada_em:new Date(agora.getTime()-60000).toISOString()};
  let modelo=0; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[atrasada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes("criada_em>$3 AND estado IN ('PROCESSADA','FALHOU')")) return {rows:[{'?column?':1}]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{modelo++;return {intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null};},enviar:async()=>'id'}),'PROCESSADA');
  assert.equal(modelo,0);
  assert.deepEqual(comandos.find(c=>c.sql.includes("criada_em>$3 AND estado IN"))?.args,['c','e',atrasada.criada_em]);
  assert.equal(comandos.some(c=>c.sql.includes('INSERT INTO whatsapp_atendimento_mensagens')),false);
});
test('outro worker com tarefa ativa na mesma conversa não encerra o lote como fila vazia',async()=>{
  let reservas=0;
  const worker=carregar(async(sql)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:reservas++<2?[mensagem]:[]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes("WHERE conversa_id=$1 AND estado IN ('PROCESSANDO','ENVIANDO')")) return {rows:[{id:'outra'}]};
    return {rows:[]};
  });
  assert.deepEqual(await worker.processarLote({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{throw Error('envio proibido');}}),{estado:'SEM_TAREFA',tarefas:2});
});
test('histórico enviado ao modelo fica na sessão atual (24 h antes da última entrada)',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Onde fica?'};
  const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  await worker.processarAtendimento({interpretar:async()=>({intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null}),enviar:async()=>'id'});
  const historico=comandos.find(c=>c.sql.includes('SELECT texto FROM'))!;
  assert.match(historico.sql,/criada_em > \$3::timestamptz - interval '24 hours'/);
  assert.deepEqual(historico.args,['c','e',conversa.ultima_entrada_em]);
});

// Resposta publicada revogada (removida ou corrigida) não pode sair com o texto antigo.
const FAQ_ANTIGA='Endereço antigo revogado.', FAQ_NOVA='Endereço corrigido e aprovado.';
const comFaq=(resposta:string|null):Cfg=>({ativo:true,nome:'Kidmais',perguntas:resposta?[{id:'endereco',pergunta:'Onde fica?',resposta}]:[],limites:{respostasPor24h:20}});
for (const [caso,vigente,esperado] of [['corrigida',comFaq(FAQ_NOVA),FAQ_NOVA],['removida',comFaq(null),null]] as const) {
  test(`resposta publicada ${caso} durante a chamada ao modelo: a saída usa a configuração vigente, travada`,async()=>{
    const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'Onde fica?'};
    const comandos:{sql:string;args?:unknown[]}[]=[]; const leituras:boolean[]=[];
    const worker=carregar(async(sql,args)=>{
      comandos.push({sql,args});
      if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
      if(sql.includes('SELECT m.*')) return {rows:[entrada]};
      if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
      return {rows:[]};
    },true,true,20,travar=>{leituras.push(travar);return travar?vigente:comFaq(FAQ_ANTIGA);});
    assert.equal(await worker.processarAtendimento({interpretar:async()=>({intencao:'DUVIDA' as const,perguntaId:'endereco',data:null,convidados:null}),enviar:async()=>'id'}),'PROCESSADA');
    assert.ok(leituras.includes(true),'a gravação relê a configuração com trava');
    const saida=comandos.find(c=>c.sql.includes("'SAIDA',$5,'PENDENTE',$6"));
    assert.notEqual(saida?.args?.[4],FAQ_ANTIGA,'texto revogado não é gravado');
    if (esperado) assert.equal(saida?.args?.[4],esperado);
    else assert.doesNotMatch(String(saida?.args?.[4]),/Endereço/,'sem a resposta removida: mensagem padrão de encaminhamento');
  });
}
test('saída automática pendente gerada antes de a configuração mudar é cancelada sem chamar o provedor',async()=>{
  const pendente={...mensagem,texto:FAQ_ANTIGA};
  let envios=0; const comandos:{sql:string;args?:unknown[]}[]=[]; const leituras:boolean[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[pendente]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes('c.atualizada_em > m.criada_em')) return {rows:[{'?column?':1}]};
    return {rows:[]};
  },true,true,20,travar=>{leituras.push(travar);return comFaq(null);});
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}}),'CANCELADA');
  assert.equal(envios,0,'texto revogado não chega ao provedor');
  assert.ok(leituras.includes(true));
  assert.deepEqual(comandos.find(c=>c.sql.includes('c.atualizada_em > m.criada_em'))?.args,['m','e','staging']);
  assert.deepEqual(comandos.filter(c=>c.sql.includes('SET estado=$2,iniciada_em')).map(c=>c.args?.[1]),['PROCESSANDO','CANCELADA'],'reservada e depois cancelada antes do envio');
  // A IA conduzia e a resposta seria enviada: a conversa vai para a equipe (nova versão invalida trabalho automático).
  assert.deepEqual(comandos.filter(c=>c.sql.includes("SET estado='AGUARDANDO_HUMANO',versao=versao+1")).map(c=>c.args),[['c']]);
});
test('mensagem humana e encaminhamento fixo não dependem das respostas publicadas: a revogação não os cancela',async()=>{
  for (const m of [{...mensagem,origem_id:null,autor_usuario_id:'u'},{...mensagem,texto:core.MENSAGEM_ENCAMINHAMENTO}]) {
    let envios=0; const comandos:string[]=[];
    const conv=m.autor_usuario_id?{...conversa,estado:'HUMANO' as const,responsavel_id:'u'}:{...conversa,estado:'AGUARDANDO_HUMANO' as const};
    const worker=carregar(async(sql)=>{
      comandos.push(sql);
      if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
      if(sql.includes('SELECT m.*')) return {rows:[m]};
      if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conv]};
      if(sql.includes('FROM usuarios_administrativos')) return {rows:[{id:'u'}]};
      if(sql.includes('c.atualizada_em > m.criada_em')) return {rows:[{'?column?':1}]};
      return {rows:[]};
    });
    assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}}),'SUBMETIDA');
    assert.equal(envios,1);
    assert.equal(comandos.some(sql=>sql.includes('c.atualizada_em > m.criada_em')),false,'nem consulta a revogação');
  }
});

test('saída revogada com a conversa já com a equipe: estado e responsável humanos são preservados',async()=>{
  for (const conv of [{...conversa,estado:'AGUARDANDO_HUMANO' as const},{...conversa,estado:'HUMANO' as const,responsavel_id:'u'},{...conversa,estado:'ENCERRADA' as const}]) {
    let envios=0; const comandos:string[]=[];
    const worker=carregar(async(sql)=>{
      comandos.push(sql);
      if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
      if(sql.includes('SELECT m.*')) return {rows:[{...mensagem,texto:FAQ_ANTIGA}]};
      if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conv]};
      if(sql.includes('c.atualizada_em > m.criada_em')) return {rows:[{'?column?':1}]};
      return {rows:[]};
    });
    assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}}),'CANCELADA',conv.estado);
    assert.equal(envios,0);
    assert.equal(comandos.some(sql=>sql.includes('UPDATE whatsapp_atendimento_conversas')),false,`${conv.estado}: conversa intocada`);
  }
});
test('saída inválida por outro motivo (entrada nova pendente) não é escalada pela revogação',async()=>{
  const comandos:string[]=[];
  const worker=carregar(async(sql)=>{
    comandos.push(sql);
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[{...mensagem,texto:FAQ_ANTIGA}]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[{...conversa,versao:4}]};
    if(sql.includes('c.atualizada_em > m.criada_em')) return {rows:[{'?column?':1}]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>'id'}),'CANCELADA');
  assert.equal(comandos.some(sql=>sql.includes('UPDATE whatsapp_atendimento_conversas')),false,'a entrada nova segue para a IA');
});
test('configuração alterada depois da marcação ENVIANDO não retém o envio já iniciado (comportamento documentado)',async()=>{
  // A trava só cobre até o COMMIT que marca ENVIANDO; o POST ocorre depois. Uma alteração nesse intervalo não é
  // consultada de novo: a mensagem sai com o texto lido e termina SUBMETIDA.
  let alterada=false, envios=0; const comandos:string[]=[];
  const worker=carregar(async(sql)=>{
    comandos.push(sql);
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[{...mensagem,texto:FAQ_ANTIGA}]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes('c.atualizada_em > m.criada_em')) return {rows:alterada?[{'?column?':1}]:[]};
    return {rows:[]};
  });
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{alterada=true;envios++;return 'gs-1';}}),'SUBMETIDA');
  assert.equal(envios,1);
  assert.equal(comandos.filter(sql=>sql.includes('c.atualizada_em > m.criada_em')).length,1,'revogação conferida uma vez, antes do POST');
  assert(comandos.some(sql=>sql.includes("SET estado='SUBMETIDA'")));
});

// 077: foto/vídeo do atendente saem pelo mesmo caminho (mesmas travas); o conteúdo vem da própria linha.
const midia = {...mensagem,origem_id:null,autor_usuario_id:'u',texto:'Salgados da casa',midia_tipo:'IMAGEM' as const,midia_url:'https://cdn.exemplo.test/salgados.jpg'};
function workerMidia(conv: Conversa, m: Mensagem = midia) {
  return carregar(async(sql)=>{
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[m]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conv]};
    if(sql.includes('FROM usuarios_administrativos')) return {rows:[{id:'u'}]};
    return {rows:[]};
  });
}
test('077: foto do atendente vai ao transporte como conteúdo IMAGEM (URL e legenda da linha), uma única vez',async()=>{
  const enviados: transporte.ConteudoSaida[]=[];
  const r=await workerMidia({...conversa,estado:'HUMANO',responsavel_id:'u'}).processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async(_c:string,conteudo:transporte.ConteudoSaida)=>{enviados.push(conteudo);return 'gs-midia';}} as never);
  assert.equal(r,'SUBMETIDA');
  assert.deepEqual(enviados,[{tipo:'IMAGEM',url:'https://cdn.exemplo.test/salgados.jpg',legenda:'Salgados da casa'}]);
});
test('077: PARAR, janela de 24 h vencida e conversa fora do atendente cancelam a foto antes do provedor',async()=>{
  const vencida=new Date(agora.getTime()-25*60*60*1000).toISOString();
  for (const conv of [{...conversa,estado:'HUMANO' as const,responsavel_id:'u',nao_contatar:true},{...conversa,estado:'HUMANO' as const,responsavel_id:'u',ultima_entrada_em:vencida},{...conversa,estado:'HUMANO' as const,responsavel_id:'outro'},{...conversa,estado:'IA' as const}]) {
    let envios=0;
    const r=await workerMidia(conv).processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{envios++;return 'id';}});
    assert.equal(r,'CANCELADA',JSON.stringify({nao_contatar:conv.nao_contatar,estado:conv.estado,responsavel:conv.responsavel_id}));
    assert.equal(envios,0);
  }
});

// Revisão final (M4): validade explícita das entradas pendentes (15 min); vencida vai à equipe sem resposta automática.
test('entrada pendente além de 15 min vence; saída usa o próprio prazo; o limite é exclusivo',async()=>{
  const {entradaVencida,PRAZO_ENTRADA_MS}=carregar(async()=>({rows:[]})) as unknown as {entradaVencida(m:{direcao:string;criada_em:string},agora?:Date):boolean;PRAZO_ENTRADA_MS:number};
  assert.equal(PRAZO_ENTRADA_MS,15*60000);
  const em=(min:number)=>new Date(agora.getTime()-min*60000).toISOString();
  assert.equal(entradaVencida({direcao:'ENTRADA',criada_em:em(14)},agora),false);
  assert.equal(entradaVencida({direcao:'ENTRADA',criada_em:em(15)},agora),false);
  assert.equal(entradaVencida({direcao:'ENTRADA',criada_em:em(16)},agora),true);
  assert.equal(entradaVencida({direcao:'SAIDA',criada_em:em(60)},agora),false,'saída tem o próprio prazo (mensagemAindaValida)');
});
test('entrada vencida na reserva: equipe sem resposta, sem modelo, Wall-e nem provedor; nenhuma saída criada',async()=>{
  const vencida={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'quanto custa?',criada_em:new Date(Date.now()-16*60000).toISOString()};
  const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[vencida]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  });
  const r=await worker.processarAtendimento({interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{throw Error('envio proibido');}});
  assert.equal(r,'VENCIDA');
  assert.ok(comandos.some(c=>/SET estado='PROCESSADA' WHERE id=\$1 AND estado IN \('PENDENTE','PROCESSANDO'\)/.test(c.sql)&&c.args?.[0]==='m'),'entrada PROCESSADA');
  assert.ok(comandos.some(c=>/SET estado='AGUARDANDO_HUMANO',versao=versao\+1/.test(c.sql)&&/estado='IA'/.test(c.sql)),'conversa para a equipe, versão nova');
  assert.ok(comandos.some(c=>/SET estado='CANCELADA'[\s\S]*direcao='SAIDA' AND estado='PENDENTE' AND autor_usuario_id IS NULL/.test(c.sql)),'só saídas automáticas na fila são canceladas');
  assert.ok(!comandos.some(c=>/INSERT INTO whatsapp_atendimento_mensagens/.test(c.sql)),'nenhuma saída criada (nem o texto fixo)');
  assert.ok(!comandos.some(c=>/SET estado=\$2,iniciada_em/.test(c.sql)),'não vira PROCESSANDO');
});
// Revisão final (M3): automação global desligada esvazia a fila para a equipe, sem modelo nem envio.
test('automação global desligada: fila vai para a equipe sem modelo nem envio; com o atendimento desligado não consulta o banco',async()=>{
  type Lote={processarLote(d:unknown,o?:unknown):Promise<{estado:string;tarefas:number}>};
  const proibido={interpretar:async()=>{throw Error('IA proibida');},enviar:async()=>{throw Error('envio proibido');}};
  const desligado=carregar(async()=>{throw Error('banco proibido');},false) as unknown as Lote;
  assert.deepEqual(await desligado.processarLote(proibido,{semAutomacao:true}),{estado:'DESLIGADO',tarefas:0});
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'oi',criada_em:agora.toISOString()};
  const automatica={...mensagem,id:'s1'}; // saída automática na fila, conversa com a IA
  const humana={...mensagem,id:'s2',autor_usuario_id:'u'};
  const fila=[entrada,automatica]; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes('SELECT m.*')) { assert.match(sql,/m\.direcao='ENTRADA' OR m\.autor_usuario_id IS NULL/,'saída do atendente fica de fora'); return {rows:fila.length?[fila.shift()]:[]}; }
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    return {rows:[]};
  }) as unknown as Lote;
  const r=await worker.processarLote(proibido,{semAutomacao:true});
  assert.deepEqual(r,{estado:'DESLIGADO',tarefas:2});
  assert.ok(comandos.some(c=>/SET estado='PROCESSADA' WHERE id=\$1/.test(c.sql)&&c.args?.[0]==='m'),'entrada encaminhada');
  assert.ok(comandos.some(c=>/SET estado='CANCELADA' WHERE id=\$1 AND estado='PENDENTE'/.test(c.sql)&&c.args?.[0]==='s1'),'saída automática cancelada');
  assert.ok(!comandos.some(c=>c.args?.includes(humana.id)),'saída do atendente não é tocada');
  assert.ok(!comandos.some(c=>/INSERT INTO whatsapp_atendimento_mensagens/.test(c.sql)),'nada criado');
});
test('composition root: a chave global da IA chega ao processador como semAutomacao (o Core não lê a chave)',()=>{
  const raiz=readFileSync('app/api/admin/inteligencia/whatsapp/modelo.ts','utf8');
  assert.match(raiz,/semAutomacao: !inteligenciaAtiva\(process\.env\)/);
  assert.doesNotMatch(raiz,/if \(!inteligenciaAtiva\(process\.env\)\) return \{ estado: 'DESLIGADO'/,'não devolve DESLIGADO deixando a fila esperando');
  assert.doesNotMatch(readFileSync('lib/whatsapp/atendimento/worker.ts','utf8'),/INTELIGENCIA_ENABLED|process\.env/);
});

// Proteção final: modo regras impede o modelo em TODOS os caminhos do atendimento. Neste stub a 078 está ausente
// (tem078=false): a fase B é o caminho exercido — o mesmo de "Wall-e desligado na tela".
test('modo regras: a fase B nunca chama o modelo (porta presente ou nula), encaminha com o texto fixo; PARAR segue sem modelo',async()=>{
  const cenarios:[string,boolean,boolean][]=[['regras com porta passada',true,true],['regras com porta nula',true,false],['modo modelo com porta nula',false,false]];
  for (const [rotulo,regras,comPorta] of cenarios) {
    modoRegras.ativo=regras;
    try {
      const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'quanto custa a festa?'};
      let modelo=0; const comandos:{sql:string;args?:unknown[]}[]=[];
      const worker=carregar(async(sql,args)=>{
        comandos.push({sql,args});
        if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
        if(sql.includes('SELECT m.*')) return {rows:[entrada]};
        if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
        if(sql.includes('SELECT texto FROM')) return {rows:[{texto:'quanto custa a festa?'}]};
        return {rows:[]};
      });
      const interpretar=comPorta?async()=>{modelo++;return {intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null};}:null;
      assert.equal(await worker.processarAtendimento({interpretar,enviar:async()=>{throw Error('envio proibido');}} as never),'ENCAMINHADA',rotulo);
      assert.equal(modelo,0,`${rotulo}: modelo não chamado`);
      assert.equal(comandos.find(c=>c.sql.includes("'SAIDA',$5,'PENDENTE',$6"))?.args?.[4],core.MENSAGEM_ENCAMINHAMENTO,`${rotulo}: só o texto fixo`);
    } finally { modoRegras.ativo=false; }
  }
  // PARAR em modo regras: comando direto, sem modelo; a conversa encerra e nada é respondido.
  modoRegras.ativo=true;
  try {
    const parar={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'não quero receber mais nada de vocês'};
    let modelo=0; const comandos:{sql:string;args?:unknown[]}[]=[];
    const worker=carregar(async(sql,args)=>{
      comandos.push({sql,args});
      if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
      if(sql.includes('SELECT m.*')) return {rows:[parar]};
      if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
      if(sql.includes('SELECT texto FROM')) return {rows:[{texto:parar.texto}]};
      return {rows:[]};
    });
    assert.equal(await worker.processarAtendimento({interpretar:async()=>{modelo++;throw Error('modelo');},enviar:async()=>{throw Error('envio proibido');}}),'PROCESSADA');
    assert.equal(modelo,0,'PARAR: modelo não chamado');
    assert.ok(comandos.some(c=>/SET interesse=\$2::jsonb,estado=\$3,nao_contatar=nao_contatar OR \$4/.test(c.sql)&&c.args?.[2]==='ENCERRADA'&&c.args?.[3]===true),'PARAR encerra e bloqueia');
    assert.ok(!comandos.some(c=>c.sql.includes("'SAIDA',$5,'PENDENTE',$6")),'PARAR: nenhuma resposta');
  } finally { modoRegras.ativo=false; }
});
test('modo regras é conferido a cada uso: o worker lê a variável do canal (não a chave da IA) e a composition root não monta o modelo',()=>{
  const worker=readFileSync('lib/whatsapp/atendimento/worker.ts','utf8');
  assert.match(worker,/if \(!comando && \(entendimentoSoRegras\(\) \|\| !deps\.interpretar\)\) return await encaminharSemModelo/);
  const porta=readFileSync('lib/whatsapp/atendimento/walle/porta.ts','utf8');
  assert.match(porta,/const modelo = entender && !entendimentoSoRegras\(\) \? entender : null;/);
  const raiz=readFileSync('app/api/admin/inteligencia/whatsapp/modelo.ts','utf8');
  assert.match(raiz,/interpretar: comModelo \? interpretarMensagem : null, entender: comModelo \? entenderComModelo : null/);
  assert.match(raiz,/processarLote\(\{interpretar:portas\.interpretar,enviar:enviarMensagem,wallE:criarPortaWallE\(portas\.entender/);
});

// Correção da pausa: a pausa reconhecida pelas regras vem antes do limite diário; nada sai, nem o texto fixo.
test('pausa antes do limite diário esgotado: nenhuma saída, conversa à equipe, sem modelo',async()=>{
  const entrada={...mensagem,direcao:'ENTRADA',origem_id:null,texto:'por enquanto não precisa me mandar mais nada, depois eu chamo vocês'};
  let modelo=0; const comandos:{sql:string;args?:unknown[]}[]=[];
  const worker=carregar(async(sql,args)=>{
    comandos.push({sql,args});
    if(sql.includes("SELECT id FROM empresas")) return {rows:[{id:'e'}]};
    if(sql.includes('SELECT m.*')) return {rows:[entrada]};
    if(sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return {rows:[conversa]};
    if(sql.includes('SELECT texto FROM')) return {rows:[{texto:entrada.texto}]};
    if(sql.includes('SELECT count(*) AS n')) return {rows:[{n:'3'}]};
    return {rows:[]};
  },true,true,3);
  assert.equal(await worker.processarAtendimento({interpretar:async()=>{modelo++;return {intencao:'OUTRO' as const,perguntaId:null,data:null,convidados:null};},enviar:async()=>{throw Error('envio proibido');}}),'PROCESSADA');
  assert.equal(modelo,0,'sem modelo');
  assert.ok(!comandos.some(c=>c.sql.includes('INSERT INTO whatsapp_atendimento_mensagens')),'nenhuma saída criada (nem o texto fixo)');
  assert.ok(!comandos.some(c=>c.sql.includes('SELECT count(*) AS n')),'a pausa é tratada antes de contar o limite');
  assert.ok(comandos.some(c=>/SET estado='AGUARDANDO_HUMANO',versao=versao\+1/.test(c.sql)),'conversa à equipe');
});
