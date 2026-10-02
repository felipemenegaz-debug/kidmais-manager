import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as core from './core.ts';
import type { Conversa, Mensagem } from './service.ts';

const agora = new Date();
const conversa: Conversa = {id:'c',empresa_id:'e',ambiente:'staging',contato:'5561999999999',estado:'IA',responsavel_id:null,nao_contatar:false,versao:3,ultima_entrada_em:agora.toISOString(),interesse:{data:null,convidados:null}};
const mensagem: Mensagem = {id:'m',conversa_id:'c',empresa_id:'e',ambiente:'staging',direcao:'SAIDA',origem_id:'entrada',autor_usuario_id:null,texto:'Resposta aprovada',estado:'PENDENTE',versao_conversa:3,criada_em:agora.toISOString()};
let limpezas=0; const correlacoes:string[]=[];
type Cfg = {ativo:boolean;nome:string;perguntas:{id:string;pergunta:string;resposta:string}[];limites:{respostasPor24h:number}};
function carregar(query: (sql: string, args?: unknown[]) => Promise<{rows: unknown[]}>, ativo=true, permitido=true, limite=20, cfg?: (travar:boolean)=>Cfg|null) {
  return carregarComponente('lib/whatsapp/atendimento/worker.ts', {
    '../../db/postgres.ts':{db:()=>({query}),withTransaction:async(fn:(tx:unknown)=>unknown)=>fn({query})},
    './configuracao.ts':{ambienteAtendimento:()=> 'staging',empresaPiloto:()=> 'e',atendimentoAtivo:()=>ativo,contatoPermitido:()=>permitido},
    './core.ts':core,
    './service.ts':{configuracao:async(_tx:unknown,_e:string,travar=false)=>cfg?cfg(travar):({ativo:true,nome:'Kidmais',perguntas:[],limites:{respostasPor24h:limite}}),recuperarTrabalhosInterrompidos:async()=>{},limparStatusExpirados:async()=>{limpezas++;},correlacionarStatus:async(_tx:unknown,_e:string,_a:string,id:string)=>{correlacoes.push(id);}},
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
