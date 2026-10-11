import assert from 'node:assert/strict';
import test from 'node:test';
import { pedidoDeParar, trechoDeOptOutAmplo } from './opt-out.ts';
import { ENTRADA_SAUDE_OMITIDA, comandoDireto, conferirEmpresaAtiva, configuracaoSchema, dadoDeSaude, entradaFaseB, ocultarDadosPessoais, trechoParaRegistro, dataDeInteresse, dataValida, entradaGupshup, hojeOperacao, interpretacaoSchema, janelaAberta, responder } from './core.ts';
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

test('D1: máscara cobre CPF/CNPJ com espaços e barras, telefone sem DDD e com o 9 separado, CEP, endereço, nascimento e nomes em frases de identificação', () => {
  const casos: [string, string][] = [
    ['meu cpf é 123 456 789 09', '123 456 789 09'], ['CPF 123-456-789-09', '123-456-789-09'], ['cnpj 12.345.678/0001-95', '12.345.678/0001-95'],
    ['meu cel 99999-0000', '99999-0000'], ['liga 9 9999 0000', '9 9999 0000'], ['(61) 9 9999-0000', '9999-0000'], ['+55 (61) 99999-0000', '99999-0000'],
    ['fixo 3333-4444', '3333-4444'], ['joao arroba gmail ponto com', 'gmail'], ['CEP 70000-000', '70000-000'], ['cep: 70000000', '70000000'],
    ['moro na Rua das Flores, 123', 'Flores'], ['SQN 308 bloco A apto 101', '308'], ['ela nasceu em 12/03/2019', '12/03/2019'],
    ['Meu nome é Ana Paula Souza', 'Ana Paula'], ['minha filha Laura faz 5 anos', 'Laura'], ['o aniversariante é Pedro', 'Pedro'],
  ];
  for (const [texto, dado] of casos) assert.equal(ocultarDadosPessoais(texto).includes(dado), false, texto);
  // O que a classificação precisa continua: data e quantidade da festa, preço, tema, pergunta de endereço, frase comum.
  for (const fica of ['festa dia 14/11/2027 para 150 convidados', 'quanto custa o pacote Essencial para 80 pessoas em 2027?', 'qual a avenida de vocês?',
    'festa da Frozen no sábado', 'R$ 5.200,00 à vista?', 'tem horário das 1400-1800?', 'a festa do meu filho foi péssima, salgado frio']) assert.equal(ocultarDadosPessoais(fica), fica, fica);
});
test('D1: dado de saúde é reconhecido (nunca vai ao modelo); D2: o trecho gravado na passagem é minimizado', () => {
  for (const s of ['meu filho tem alergia a amendoim', 'tem opção sem glúten?', 'ela é autista', 'ele tem APLV', 'intolerância à lactose', 'toma remédio às 15h', 'estou grávida'])
    assert.equal(dadoDeSaude(s), true, s);
  for (const s of ['tea party', 'o bolo é de chocolate', 'quanto custa?', 'festa da Frozen']) assert.equal(dadoDeSaude(s), false, s);
  assert.equal(trechoParaRegistro('meu cpf é 123.456.789-09 e quero falar com alguém'), 'meu cpf é [documento omitido] e quero falar com alguém');
  assert.equal(trechoParaRegistro('x'.repeat(900)).length, 500);
});
test('D4: o histórico da fase B passa pelas mesmas proteções, entrada por entrada (antes do JSON)', () => {
  const corpo = JSON.parse(entradaFaseB(['oi, meu cpf\n12345678909', 'ele tem alergia a leite', 'y'.repeat(900)], 'quero 14/11/2027, meu cel 99999-0000', { data: null, convidados: 40 }));
  assert.deepEqual(corpo.mensagens[0], 'oi, meu cpf\n[documento omitido]', 'CPF grudado no "\\n" também sai (antes escapava no JSON)');
  assert.equal(corpo.mensagens[1], ENTRADA_SAUDE_OMITIDA);
  assert.equal(corpo.mensagens[2].length, 500);
  assert.equal(corpo.mensagemAtual, 'quero 14/11/2027, meu cel [telefone omitido]');
  assert.deepEqual(corpo.interesseAnterior, { data: null, convidados: 40 });
  assert.deepEqual(Object.keys(corpo), ['mensagens', 'mensagemAtual', 'interesseAnterior'], 'nada além disso: sem nome de perfil, contato ou cadastro');
});

test('empresa ativa × piloto: sem o campo ou indefinido = SEM_063; piloto = PILOTO; nulo/vazio = SEM_ESCOLHA (decidido pelos vínculos); outra = divergência', () => {
  const piloto = '11111111-1111-4111-8111-111111111111';
  assert.equal(conferirEmpresaAtiva({ usuario_id: 'u' }, piloto), 'SEM_063');
  assert.equal(conferirEmpresaAtiva({ usuario_id: 'u', empresa_ativa_id: undefined }, piloto), 'SEM_063');
  assert.equal(conferirEmpresaAtiva({ empresa_ativa_id: piloto.toUpperCase() }, piloto), 'PILOTO');
  assert.equal(conferirEmpresaAtiva({ empresa_ativa_id: null }, piloto), 'SEM_ESCOLHA');
  assert.equal(conferirEmpresaAtiva({ empresa_ativa_id: '' }, piloto), 'SEM_ESCOLHA');
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: '22222222-2222-4222-8222-222222222222' }, piloto), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
  assert.throws(() => conferirEmpresaAtiva({ empresa_ativa_id: 42 }, piloto), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
});

test('PARAR e pedido de pessoa por frase natural; bloqueio só para pedido inequívoco (bloquear é definitivo)',()=>{
  for (const t of ['para de me mandar mensagem por favor','Pare de me enviar mensagens!!','parem de mandar msg','não me mande mais nada','nao quero mais receber mensagens de vcs','não quero mais contato','me tira da lista','remove meu número pfv','quero me descadastrar','chega de mensagem 😡','pare 🙏','pode parar','sair'])
    assert.equal(comandoDireto(t)?.intencao,'PARAR',t);
  for (const t of ['tem vaga para dia 14?','festa para 60 pessoas','pode parar de mandar a tabela, já recebi','tem lugar pra parar o carro?','que horas temos que sair?','quero cancelar a festa','não quero mais o premium','não quero receber a tabela de novo','para de tarde tem vaga?','a festa não pode parar'])
    assert.notEqual(comandoDireto(t)?.intencao,'PARAR',t);
  for (const t of ['ta, me passa pra alguem entao','quero falar com alguém','alguem de carne e osso pode me responder?','tem alguem ai?','pode me ligar?','me passa pro responsável','quero falar com a gerente','chama um vendedor pfv'])
    assert.equal(comandoDireto(t)?.intencao,'HUMANO',t);
  for (const t of ['quanto custa pra 60 pessoas?','alguém da minha família é alérgico']) assert.equal(comandoDireto(t),null,t);
});

test('opt-out: inequívoco bloqueia; com outro pedido vira pessoa (sem bloqueio); "cancelar a festa", "parar o carro" e "não mande esse PDF" não são opt-out',()=>{
  for (const t of ['Bom dia. Não autorizo o envio de mensagens para este número. Solicito que não entrem mais em contato.','ah deixa, ja fechei em outro lugar. pode tirar meu numero da lista de vcs pfv','ok, vou pensar. mas por favor nao me mandem mais promoção nem mensagem nenhuma, ta?','chega de mensagem, já falei q não quero festa nenhuma, não me chamem mais','esquece que eu existo, nunca mais me chamem'])
    assert.equal(comandoDireto(t)?.intencao,'PARAR',t);
  for (const t of ['para de me mandar mensagem e me passa pra um atendente','não quero mais receber promoções, mas quanto custa o premium?','para de mandar msg automática, quero falar com uma pessoa'])
    assert.equal(comandoDireto(t)?.intencao,'HUMANO',t);
  for (const t of ['preciso cancelar a festa q eu marquei pro dia 30 de janeiro, como faço?','tem onde parar o carro ai ou é so na rua? kkk','não mande esse PDF de novo','nao me mande o pdf, me mande o link','que horas a gnt tem q sair do salão?','chega né véi, to desde sexta tentando uma resposta','se eu remover o bolo do pacote vcs abatem do valor?','pode bloquear o dia vinte e dois de novembro pra mim?','não autorizo o uso de fotos da festa'])
    assert.notEqual(comandoDireto(t)?.intencao,'PARAR',t);
  assert.deepEqual(pedidoDeParar('para de me mandar mensagem e me passa pra um atendente'), { tipo: 'AMBIGUO', trecho: 'para de me mandar mensagem e me passa pra um atendente' });
  // Pedido formal por substantivo (rodada 4): bloqueia como o verbal; "cancelamento da festa" e "bloqueio da data" não.
  for (const t of ['Boa tarde. Solicito, por gentileza, a exclusão do meu número da lista de contatos de vocês. Não tenho mais interesse. Att.','Solicito a exclusão.','solicito exclusao do meu contato','peço a remoção do meu telefone da lista de vocês','Favor providenciar o cancelamento do meu cadastro.','gostaria de ser removida da lista','quero ser descadastrado','exclusão, por favor','Prezados, solicito o bloqueio deste número para envios. Grato.'])
    assert.equal(comandoDireto(t)?.intencao,'PARAR',t);
  for (const t of ['preciso do cancelamento da festa do dia 12','qual a multa no cancelamento do contrato?','quero o bloqueio da data até sexta','a exclusão do bolo do pacote abaixa o preço?','como funciona a remoção da decoração no fim?'])
    assert.notEqual(comandoDireto(t)?.intencao,'PARAR',t);
  assert.equal(pedidoDeParar('solicito a exclusão do meu número, mas antes me diz quanto ta o premium')?.tipo, 'AMBIGUO');
  assert.equal(trechoDeOptOutAmplo('a exclusão do meu número da lista de contatos'), true);
  // Rodada 5: adjetivo no pedido formal, negação e substantivo de assunto não são "outro pedido".
  for (const t of ['Peço, por gentileza, a remoção definitiva do meu contato da lista de divulgação de vocês.', 'chega de zap de vcs pfv, nao me manda mais nada',
    'Venho requerer o descadastramento deste telefone de todas as comunicações do buffet.', 'pode me tirar da lista? nao tenho interesse', 'tem como me descadastrar?'])
    assert.equal(pedidoDeParar(t)?.tipo, 'INEQUIVOCO', t);
  for (const t of ['me manda a tabela de preços e depois pode me tirar da lista de contatos', 'Cancela a festa do Enzo do dia 21/11 e não quero mais receber nada de vocês.',
    'quero falar com uma atendente de verdade e depois parem de me mandar promoção',
    'Não quero mais receber essas mensagens de vcs. Só me confirma se o próximo sábado ainda tá livre que aí eu decido'])
    assert.equal(pedidoDeParar(t)?.tipo, 'AMBIGUO', t);
  assert.equal(trechoDeOptOutAmplo('me deixem em paz e esqueçam este número'), true);
  for (const t of ['cancelar a festa','parar o carro','não mande esse PDF']) assert.equal(trechoDeOptOutAmplo(t), false, t);
});

test('rodada 15 — pedido de parar com infinitivo pessoal/subjuntivo ("pedir pra vocês não me mandarem mais nada") bloqueia; contraexemplos não', () => {
  for (const t of ['oi então eu queria pedir pra vocês não me mandarem mais nada tá bom porque eu já fiz a festa em outro lugar obrigada',
    'gostaria que vocês não me mandassem mais nada, obrigada', 'peço pra não me procurarem mais', 'queria pedir pra vcs nao me mandarem mais nada pq ja resolvi',
    'ok pode não me mandar mais nada, já fechei', 'por favor não me liguem mais nem mandem mensagem', 'peço por gentileza que não me enviem mais nada',
    'prefiro que nunca mais me procurem, obrigado', 'pra não me ligarem mais, já resolvi tudo'])
    assert.equal(pedidoDeParar(t)?.tipo, 'INEQUIVOCO', t);
  // Só por um tempo ou com outro pedido: equipe em silêncio, sem bloqueio definitivo.
  for (const t of ['pode não me mandar mais nada por enquanto, to viajando', 'queria pedir pra não me mandarem mais nada, mas antes me fala o endereço'])
    assert.equal(pedidoDeParar(t)?.tipo, 'AMBIGUO', t);
  // Material, item de fora e outro assunto não são parar.
  for (const t of ['não mande mais PDF, mas responda o preço', 'não me mandem mais o pdf, já tenho', 'queria pedir pra vocês não me mandarem nada de bolo pronto, a gente leva',
    'não precisa mandar mais nada sobre o bolo', 'cancela a festa do dia 30', 'pedi pra não me mandarem o cardápio de novo'])
    assert.equal(pedidoDeParar(t), null, t);
});

test('rodada 16 — "baixa" do número na lista de envios bloqueia; material pedido e depois "não me manda mais nada" é ambíguo (equipe, sem o PDF)', () => {
  for (const t of ['Favor providenciar a baixa do meu número na lista de envios de vocês.', 'solicito a baixa do meu contato', 'peço baixa do meu cadastro na lista de vocês',
    'quero dar baixa no meu número da lista de promoções', 'depois disso não me manda mais nada'])
    assert.equal(pedidoDeParar(t)?.tipo, 'INEQUIVOCO', t);
  for (const t of ['me manda só o pdf com os preços e depois disso não me manda mais nada', 'manda a tabela e daí pra frente não me manda mais nada', 'me passa o endereço e a partir de agora nunca mais me procura'])
    assert.equal(pedidoDeParar(t)?.tipo, 'AMBIGUO', t);
  // "Baixa" sem objeto de contato, reclamação de silêncio e o cadastro DA FESTA não são parar ("bloqueio do meu cadastro da
  // festa" bloqueava até a rodada 15).
  for (const t of ['a baixa do boleto ja caiu?', 'vcs dão baixa no pagamento quando?', 'teve baixa no valor?', 'pedi o orçamento e não me mandam mais nada, cadê?',
    'fiz a reserva e depois disso ninguém me manda nada', 'me manda o pdf e depois me manda o endereço', 'bloqueio do meu cadastro da festa', 'bloqueio no meu cadastro da festa'])
    assert.equal(pedidoDeParar(t), null, t);
});
