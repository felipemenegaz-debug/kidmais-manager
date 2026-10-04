import assert from 'node:assert/strict';
import test from 'node:test';
import { comandoDireto, conferirEmpresaAtiva, configuracaoSchema, ocultarDadosPessoais, dataDeInteresse, dataValida, entradaGupshup, hojeOperacao, interpretacaoSchema, janelaAberta, responder } from './core.ts';
const config = {ativo:true,nome:'Empresa sintética',perguntas:[{id:'endereco',pergunta:'Onde fica?',resposta:'Endereço aprovado pelo responsável.'}],limites:{respostasPor24h:20}};
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
test('data devolvida pelo modelo no formato do cliente é normalizada só na forma (caso "Dia 14/11/2027")',()=>{
  // Antes: o JSON Schema aceitava qualquer string e o validador exigia AAAA-MM-DD → RESPOSTA_INVALIDA e encaminhamento.
  const saida=(data:unknown)=>interpretacaoSchema.safeParse({intencao:'INTERESSE',perguntaId:null,data,convidados:null});
  for (const [entrada,esperada] of [['14/11/2027','2027-11-14'],['4/1/2028','2028-01-04'],['14.11.2027','2027-11-14'],['14-11-2027','2027-11-14'],['2027/11/14','2027-11-14'],[' 2027-11-14 ','2027-11-14'],['2027-11-14','2027-11-14']] as const) {
    const r=saida(entrada);assert.equal(r.success,true,entrada);assert.equal(r.success&&r.data.data,esperada,entrada);
  }
  const nula=saida(null);assert.equal(nula.success&&nula.data.data,null);
  // Sem suposição: ano abreviado, texto livre ou mês por extenso continuam recusados.
  for (const recusada of ['14/11/27','14/11','14 de novembro de 2027','amanhã','2027-11-14T00:00']) assert.equal(saida(recusada).success,false,recusada);
  // Forma convertida, validade preservada: data impossível chega ao responder, que pede outra.
  const impossivel=saida('30/02/2027');assert.equal(impossivel.success,true);
  assert.match(responder(config,{intencao:'INTERESSE',perguntaId:null,data:impossivel.success?impossivel.data.data:null,convidados:null},{data:null,convidados:null},'2026-10-04').texto!,/não existe/);
  // Fluxo da demonstração: data futura vira interesse e a próxima pergunta é a de convidados.
  const p={intencao:'INTERESSE' as const,perguntaId:null,data:'2027-11-14',convidados:null};
  assert.equal(dataDeInteresse(p.data,'2026-10-04'),'2027-11-14');
  assert.match(responder(config,p,{data:'2027-11-14',convidados:null},'2026-10-04').texto!,/Quantas/);
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
test('limites: configuração antiga recebe o padrão; fora da faixa é recusado', () => {
  const antiga = { ativo: config.ativo, nome: config.nome, perguntas: config.perguntas };
  const lida = configuracaoSchema.parse(antiga);
  assert.deepEqual(lida.limites, { respostasPor24h: 20 });
  assert.equal(configuracaoSchema.safeParse({ ...config, limites: { respostasPor24h: 0 } }).success, false);
  assert.equal(configuracaoSchema.safeParse({ ...config, limites: { respostasPor24h: 101 } }).success, false);
  assert.equal(configuracaoSchema.safeParse({ ...config, limites: { respostasPor24h: 5, outro: 1 } }).success, false);
  assert.equal(configuracaoSchema.parse({ ...config, limites: { respostasPor24h: 5 } }).limites.respostasPor24h, 5);
});
test('receptor único: só o ambiente nomeado grava e envia; ausente ou divergente fecha tudo', async () => {
  const { receptorDoNumero, recepcaoAtiva, atendimentoAtivo } = await import('./configuracao.ts');
  const env = (ambiente: string, receptor?: string) => ({ KIDMAIS_DEPLOY_ENV: ambiente, WHATSAPP_ATENDIMENTO_EMPRESA_ID: '00000000-0000-4000-8000-000000000001', WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED: 'true', WHATSAPP_ATENDIMENTO_ENABLED: 'true', ...(receptor === undefined ? {} : { WHATSAPP_ATENDIMENTO_RECEPTOR: receptor }) }) as unknown as NodeJS.ProcessEnv;
  assert.equal(receptorDoNumero(env('staging', 'staging')), true);
  assert.equal(recepcaoAtiva(env('staging', 'staging')), true); assert.equal(atendimentoAtivo(env('staging', 'staging')), true);
  // Produção com o receptor apontando para staging (janela de homologação): nada é gravado nem enviado.
  for (const e of [env('production', 'staging'), env('production'), env('staging', 'STAGING'), env('staging', ''), env('desconhecido', 'desconhecido')]) {
    assert.equal(receptorDoNumero(e), false); assert.equal(recepcaoAtiva(e), false); assert.equal(atendimentoAtivo(e), false);
  }
  assert.equal(recepcaoAtiva({ ...env('staging', 'staging'), WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED: 'false' }), false);
  // Empresa piloto ausente ou inválida: recepção desligada (só metadados), em vez de 503 em todo evento, inclusive OTP.
  assert.equal(recepcaoAtiva({ ...env('staging', 'staging'), WHATSAPP_ATENDIMENTO_EMPRESA_ID: undefined }), false);
  assert.equal(recepcaoAtiva({ ...env('staging', 'staging'), WHATSAPP_ATENDIMENTO_EMPRESA_ID: 'nao-uuid' }), false);
  assert.equal(atendimentoAtivo({ ...env('staging', 'staging'), WHATSAPP_ATENDIMENTO_ENABLED: '1' }), false);
});
test('entrada: timestamp em milissegundos (formato v2 do Gupshup) e origem sem "+"', () => {
  const evento = { app: 'KidmaisManager', version: 2, type: 'message', timestamp: 1718007189549, payload: { id: 'wamid.sintetico', type: 'text', source: '5561999990000', payload: { text: 'Olá' }, sender: { phone: '5561999990000', name: 'Nome do perfil' } } };
  const lida = entradaGupshup(evento)!;
  assert.equal(new Date(lida.timestamp).toISOString(), '2024-06-10T08:13:09.549Z');
  assert.equal(lida.source, '5561999990000');
  // Desde 04/10/2026 (pedido do Felipe) o nome de PERFIL é lido para a tela, num campo próprio e rotulado como não
  // verificado; ele nunca entra no texto da mensagem (que é o que vai ao modelo) — ver identificacao.test.ts e service.test.ts.
  assert.equal(lida.nomePerfil, 'Nome do perfil');
  assert.equal(lida.texto, 'Olá', 'o nome não se mistura ao texto');
});
test('minimização antes do modelo: CPF, e-mail e telefone saem; data e quantidade ficam', () => {
  const texto = 'Sou Ana, CPF 123.456.789-09, ana.silva@example.test, fone (61) 99999-0000 ou +55 61 3333-4444 ou 5561988887777. Festa em 14/11/2027 para 60 pessoas, ou 14 11 2027.';
  const limpo = ocultarDadosPessoais(texto);
  for (const dado of ['123.456.789-09', 'ana.silva@example.test', '99999-0000', '3333-4444', '5561988887777']) assert.equal(limpo.includes(dado), false, dado);
  for (const fica of ['14/11/2027', '60 pessoas', '14 11 2027', 'Ana']) assert.ok(limpo.includes(fica), fica);
  assert.equal(limpo.match(/\[telefone omitido\]/g)?.length, 3);
});

test('empresa ativa × piloto: sem o campo ou indefinido = compatível; nulo/vazio = seleção pendente; outra = divergência', () => {
  const piloto = '11111111-1111-4111-8111-111111111111';
  assert.doesNotThrow(() => conferirEmpresaAtiva({ usuario_id: 'u' }, piloto));
  assert.doesNotThrow(() => conferirEmpresaAtiva({ usuario_id: 'u', empresa_ativa_id: undefined }, piloto));
  assert.doesNotThrow(() => conferirEmpresaAtiva({ empresa_ativa_id: piloto.toUpperCase() }, piloto));
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: null }, piloto), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/);
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: '' }, piloto), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/);
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: '22222222-2222-4222-8222-222222222222' }, piloto), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: 42 }, piloto), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
});
