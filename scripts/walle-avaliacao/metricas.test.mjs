// Validação da RÉGUA (rodadas 20 e 21): cada métrica nova é testada com respostas deliberadamente ERRADAS (precisa alertar) e
// CORRETAS (não pode alertar), inclusive com fonte ou dado herdado do contexto da conversa. Zero alertas num holdout não
// prova cobertura; estes casos provam que o detector enxerga o erro e não acusa o acerto.
//   node --test scripts/walle-avaliacao/metricas.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIAS_CRITICAS, alteracaoFestaContratada, numeroTrocado, calcularMetricas, dataDivergente, enderecoDivergente, unidadesDosEnderecos, mesIgnorado, mesSemDiaCitado, dadoExtraidoErrado, fonteErrada, irrelevante, menuIndevido, perguntaDesnecessaria, perguntaForaDoFluxo, repeticaoDesnecessaria, semSuporte } from './metricas.mjs';

const clausula = (n) => ({ tipo: 'CONTRATO_MODELO', modelo: 'FESTA_COMPLETA_V4', versao: 4, clausula: n, sha256: 'x' });
const texto = (t, fontes = []) => ({ texto: t, anexo: null, fontes });
const anexo = (id, finalidade) => ({ texto: null, anexo: id, fontes: [{ tipo: 'PRONTA', id, versao: 1, finalidade }] });
/** Linha como a simulação grava (só os campos que as métricas leem). */
function linha({ id = 'x', texto: t, decisao = 'RESPONDER', esperado = 'RESPONDER', intencoes = [], saidas = [], pendente = [], pendentePara = null, opcional = false, contextoAntes = null, contextoDepois = null, entidades = null, conversa = null, ordem = null, citado = {}, consultas = [], consultasDetalhe = [] }) {
  return { id, texto: t, conversa, ordem, consultas, consultasDetalhe, contextoDepois, esperado: { decisao: esperado, intencoes, entidades: citado }, decisao, motivos: [], bloqueada: false, estadoDepois: 'IA', pendente, pendentePara, opcional, contextoAntes,
    saidas, resposta: saidas.map((s) => (s.anexo ? `[anexo ${s.anexo}]` : s.texto)).join(' | '), intencoes, entidades: entidades ?? { data: null, convidados: null, turno: null, pacotes: [], unidade: null, tema: null }, semFonte: [], falha: null, ms: { entender: 0, total: 0 }, modelo: [] };
}

test('FONTE_ERRADA: alerta a cláusula de outro assunto; não acusa a cláusula certa nem a continuação sem assunto', () => {
  // Errado: atraso de parcela respondido com horários e desistência (o defeito real do holdout 18, f72).
  assert.match(fonteErrada(linha({ texto: 'e se atrasar o pagamento de uma parcela, tem multa?', saidas: [texto('Cláusula 8 …', [clausula(8)]), texto('Cláusula 9 …', [clausula(9)])] })), /8 \(HORARIOS\).*9 \(CANCELAMENTO\)/);
  // Rodada 31 (falso positivo h31 aa41): "a parcela ficar vencendo" é atraso — a cláusula 7 é a certa; a de horários não.
  assert.equal(fonteErrada(linha({ texto: 'mudou alguma coisa na regra de atraso? o que acontece se a parcela ficar vencendo uns dias?', saidas: [texto('Cláusula 7 …', [clausula(7)])] })), null);
  assert.match(fonteErrada(linha({ texto: 'o que acontece se a parcela ficar vencendo uns dias?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), /8 \(HORARIOS\)/);
  // Errado: cortesia de algo grátis respondida com a cortesia de crianças.
  assert.match(fonteErrada(linha({ texto: 'vcs me dão o confete de cortesia?', saidas: [texto('Cláusula 4 …', [clausula(4)])] })), /4 \(CONVIDADOS\)/);
  // Certo: a cláusula do assunto; duas perguntas, duas cláusulas certas.
  assert.equal(fonteErrada(linha({ texto: 'e se atrasar uma parcela tem multa?', saidas: [texto('Cláusula 7 …', [clausula(7)])] })), null);
  assert.equal(fonteErrada(linha({ texto: 'se levar cerveja tem taxa? e se passar do horário?', saidas: [texto('…', [clausula(11), clausula(8)])] })), null);
  // Herdado: "e quanto é?" depois de falar de horário não nomeia assunto — a régua não acusa (nem confirma) a cláusula 8.
  assert.equal(fonteErrada(linha({ texto: 'e quanto é?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), null);
  // Herdado, mas errado: a conversa falava de bebida e a mensagem pergunta do confete; responder a 11 é fonte errada.
  assert.match(fonteErrada(linha({ texto: 'e o confete, pode?', saidas: [texto('Cláusula 11 …', [clausula(11)])] })), /11 \(BEBIDAS\)/);
});

test('SEM_SUPORTE: alerta fato sem a fonte que o sustenta; não acusa o mesmo fato com a fonte, inclusive calculado com dado herdado', () => {
  assert.equal(semSuporte(linha({ texto: 'quanto fica?', saidas: [texto('Fica R$ 7.000,00.')] })), 'valor sem fonte');
  assert.equal(semSuporte(linha({ texto: 'tem vaga dia 5?', saidas: [texto('Está disponível.')] })), 'data livre sem consultar a agenda');
  assert.equal(semSuporte(linha({ texto: 'tem pastel?', saidas: [texto('Pastel: sim, faz parte do buffet.')] })), 'item do buffet sem o catálogo');
  assert.equal(semSuporte(linha({ texto: 'quanto tempo dura?', saidas: [texto('O Premium tem 5 horas de festa.')] })), 'duração sem o cadastro do pacote');
  assert.equal(semSuporte(linha({ texto: 'tem multa?', saidas: [texto('Cláusula 9: “…”')] })), 'cláusula sem o modelo de contrato');
  // Certos: os mesmos fatos com as fontes; "e pra 80?" calculado com data e pacote herdados tem a tabela como fonte.
  assert.equal(semSuporte(linha({ texto: 'e pra 80?', saidas: [texto('Completa em 14/11/2026 … 80 convidados: R$ 8.000,00 …', [{ tipo: 'TABELA_PRECO', id: 't', codigo: 'T' }, { tipo: 'PACOTE', codigo: 'COMPLETA', id: 'c' }])] })), null);
  assert.equal(semSuporte(linha({ texto: 'e no outro horário?', saidas: [texto('Consultei a agenda agora: … está disponível.', [{ tipo: 'AGENDA', data: '2026-11-14', escopo: 'EMPRESA', unidade: null, consultadoEm: 'x' }])] })), null);
  assert.equal(semSuporte(linha({ texto: 'tem coxinha?', saidas: [texto('Coxinha: sim, faz parte do buffet do Completa.', [{ tipo: 'CATALOGO_BUFFET', pacote: 'COMPLETA' }])] })), null);
});

test('IRRELEVANTE: alerta tabela, pacotes, pergunta frequente e "parte não cadastrada" sem pedido; não acusa o que foi pedido, nem na continuação', () => {
  assert.match(irrelevante(linha({ texto: 'onde fica?', intencoes: ['LOCALIZACAO'], saidas: [texto('Segue a nossa tabela de preços.'), anexo('p-tabela', 'PRECOS')] })), /tabela de preços/);
  assert.match(irrelevante(linha({ texto: 'tem coxinha em todos?', intencoes: ['CARDAPIO'], saidas: [texto('Nossos pacotes:\n• …', [{ tipo: 'PACOTE', codigo: 'C', id: 'c' }])] })), /lista de pacotes/);
  assert.match(irrelevante(linha({ texto: 'abre uma exceção?', intencoes: ['NEGOCIACAO'], saidas: [texto('De terça a domingo, das 9h às 18h.', [{ tipo: 'CONFIGURACAO', perguntaId: 'h' }])] })), /pergunta frequente/);
  assert.match(irrelevante(linha({ texto: 'tenho alergia a amendoim', intencoes: ['ALERGIA'], saidas: [texto('Uma parte da sua mensagem eu não tenho cadastrada para responder por aqui.')] })), /parte não cadastrada/);
  // Certos: tabela pedida; continuação "e pra 80?" rotulada com o assunto herdado (PRECOS) e com a tabela já anexada antes.
  assert.equal(irrelevante(linha({ texto: 'me manda a tabela', intencoes: ['PRECOS'], saidas: [texto('Segue a nossa tabela de preços.'), anexo('p-tabela', 'PRECOS')] })), null);
  assert.equal(irrelevante(linha({ texto: 'e pra 80?', intencoes: ['PRECOS'], saidas: [texto('Completa … R$ 8.000,00', [{ tipo: 'TABELA_PRECO', id: 't', codigo: 'T' }])] })), null);
});

test('PERGUNTA DESNECESSÁRIA: alerta dado que não serve ao pedido ou já dito (na mensagem ou herdado); não acusa a pergunta que falta', () => {
  // Errado: endereço pedindo o pacote (holdout 19, u57).
  assert.match(perguntaDesnecessaria(linha({ texto: 'onde fica o buffet de vocês?', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['LOCALIZACAO'], pendente: ['unidade', 'pacote'], pendentePara: 'LOCALIZACAO' })), /pacote não serve/);
  // Errado: festa realizada virando orçamento (holdout 19, u29).
  assert.match(perguntaDesnecessaria(linha({ texto: 'fizemos a festa em setembro, quanto ficou?', decisao: 'PERGUNTAR', esperado: 'EQUIPE', intencoes: ['CONTRATO_PROPRIO'], pendente: ['data', 'turno'], pendentePara: 'PRECOS' })), /data não serve.*turno não serve/);
  // Errado: pede de novo a data que a conversa já tinha (herdada) e o pacote dito na própria mensagem.
  assert.match(perguntaDesnecessaria(linha({ texto: 'e pra 80 no completa?', decisao: 'PERGUNTAR', esperado: 'RESPONDER', intencoes: ['PRECOS'], pendente: ['data', 'pacote'], pendentePara: 'PRECOS',
    contextoAntes: { data: '2026-11-14', turno: 'TURNO_2', convidados: 70, pacote: null, unidade: null, tema: null }, entidades: { data: null, convidados: 80, turno: null, pacotes: ['COMPLETA'], unidade: null, tema: null } })), /data já foi dito; pacote já foi dito/);
  // Rodada 28: indecisão entre temas depois de um tema dito desfaz o tema (pedir a confirmação é o fluxo); o mesmo tema
  // pedido de novo sem indecisão continua sendo "já foi dito".
  const temaAntes = { data: null, turno: null, convidados: null, pacote: null, unidade: null, tema: 'homem aranha' };
  assert.equal(perguntaDesnecessaria(linha({ texto: 'ainda to entre homem aranha e sonic kkkk', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['DECORACAO'], pendente: ['tema'], pendentePara: 'DECORACAO', contextoAntes: temaAntes })), null);
  assert.match(perguntaDesnecessaria(linha({ texto: 'e a decoração?', decisao: 'PERGUNTAR', esperado: 'RESPONDER', intencoes: ['DECORACAO'], pendente: ['tema'], pendentePara: 'DECORACAO', contextoAntes: temaAntes })), /tema já foi dito/);
  // Certos: o que falta de fato; outra data para comparar com a da conversa; convite opcional; endereço pedindo a unidade.
  assert.equal(perguntaDesnecessaria(linha({ texto: 'quero um orçamento', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['data', 'turno'], pendentePara: 'PRECOS', contextoAntes: { data: null, turno: null, convidados: null, pacote: null, unidade: null, tema: null } })), null);
  assert.equal(perguntaDesnecessaria(linha({ texto: 'e num domingo fica mais barato?', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['data'], pendentePara: 'PRECOS',
    contextoAntes: { data: '2026-11-14', turno: 'TURNO_2', convidados: 70, pacote: 'COMPLETA', unidade: null, tema: null }, saidas: [texto('O valor é calculado pela tabela para cada data e período: me diga qual data (dia e mês) você quer comparar.')] })), null);
  assert.equal(perguntaDesnecessaria(linha({ texto: 'quantas pessoas cabem no essencial?', decisao: 'RESPONDER', esperado: 'RESPONDER', intencoes: ['PACOTES'], pendente: ['data', 'turno'], pendentePara: 'PACOTES', opcional: true })), null);
  assert.equal(perguntaDesnecessaria(linha({ texto: 'qual o endereço?', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['LOCALIZACAO'], pendente: ['unidade'], pendentePara: 'LOCALIZACAO' })), null);
  // Retomada (por desenho): pergunta pendente de um assunto anterior volta uma vez depois de responder o assunto novo.
  assert.equal(perguntaDesnecessaria(linha({ texto: 'e tem estacionamento?', decisao: 'PERGUNTAR', esperado: 'RESPONDER', intencoes: ['DUVIDA_FAQ'], pendente: ['data'], pendentePara: 'PRECOS', saidas: [texto('Estacionamento no local.', [{ tipo: 'CONFIGURACAO', perguntaId: 'e' }])] })), null);
});

test('calcularMetricas reúne as métricas novas: críticas por categoria e listas não críticas', () => {
  const linhas = [
    linha({ id: 'a', texto: 'se atrasar a parcela tem multa?', intencoes: ['CONTRATO'], saidas: [texto('Cláusula 8', [clausula(8)])] }),
    linha({ id: 'b', texto: 'quanto fica?', intencoes: ['PRECOS'], saidas: [texto('R$ 7.000,00')] }),
    linha({ id: 'c', texto: 'onde fica o buffet?', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['LOCALIZACAO'], pendente: ['unidade', 'pacote'], pendentePara: 'LOCALIZACAO' }),
    linha({ id: 'd', texto: 'qual o endereço?', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['LOCALIZACAO'], pendente: ['unidade'], pendentePara: 'LOCALIZACAO' }),
  ];
  const m = calcularMetricas(linhas);
  const falhas = (chave) => m.criticas.find((c) => c.chave === chave).falhas.map((f) => f.id);
  assert.deepEqual(falhas('FONTE_ERRADA'), ['a']);
  assert.deepEqual(falhas('SEM_SUPORTE'), ['b']);
  assert.deepEqual(m.perguntasDesnecessarias.map((x) => x.id), ['c']);
});

// ---------------------------------------------------------------- rodada 21
const MENU = 'Posso ajudar com preços, datas disponíveis, pacotes, buffet, decoração, endereço e condições do contrato. Para falar com uma pessoa, escreva “atendente”.';
const anotei = (tema) => texto(`Anotei o tema “${tema}”. Se tiver fotos de referência, pode mandar por aqui que a equipe recebe.`);

test('DADO EXTRAÍDO ERRADO: alerta tema com a pergunta seguinte, tema que não está na mensagem, data e convidados trocados; não acusa o dado certo', () => {
  // Errados: o defeito do holdout 20 (j56), a festa no lugar do tema (cp24), tema inventado, data e convidados trocados.
  assert.match(dadoExtraidoErrado(linha({ texto: 'vou fazer o niver do Davi com tema dinossauro 🦖 qual a diferença entre os pacotes?', citado: { tema: 'dinossauro' }, saidas: [anotei('dinossauro qual a diferença entre')] })), /não é tema/);
  assert.match(dadoExtraidoErrado(linha({ texto: 'dá pra trocar o tema da festa da Lara pra Wandinha?', citado: { tema: 'Wandinha' }, saidas: [anotei('festa da Lara')] })), /não é tema/);
  assert.match(dadoExtraidoErrado(linha({ texto: 'queria tema moana', citado: { tema: 'moana' }, saidas: [anotei('Frozen')] })), /não está na mensagem/);
  assert.match(dadoExtraidoErrado(linha({ texto: 'dia 21/11 a noite pra 80', citado: { data: '2026-11-21', convidados: 80 }, saidas: [texto('Anotei: 12/11/2026, segundo horário (17h às 21h), 80 convidados.')] })), /data 12\/11\/2026/);
  assert.match(dadoExtraidoErrado(linha({ texto: 'quanto fica o completa pra 80?', citado: { convidados: 80 }, saidas: [texto('Completa em 21/11/2026, segundo horário (17h às 21h), 60 convidados: R$ 6.000,00.')] })), /60 convidados \(citados: 80\)/);
  // Certos: o tema citado; outro nome citado na própria mensagem (o rótulo escolheu "Halloween", a mensagem também diz
  // "bruxinha"); número dito na mensagem ("de 80 pra 60"); data e convidados iguais aos citados.
  assert.equal(dadoExtraidoErrado(linha({ texto: 'tema dinossauro 🦖 qual a diferença entre os pacotes?', citado: { tema: 'dinossauro' }, saidas: [anotei('dinossauro')] })), null);
  assert.equal(dadoExtraidoErrado(linha({ texto: 'festa de Halloween, decoração de bruxinha', citado: { tema: 'Halloween' }, saidas: [anotei('bruxinha')] })), null);
  assert.equal(dadoExtraidoErrado(linha({ texto: 'diminuiu de 80 pra 60, quanto fica?', citado: { convidados: 80 }, saidas: [texto('Completa em 21/11/2026, segundo horário (17h às 21h), 60 convidados: R$ 6.000,00.')] })), null);
  assert.equal(dadoExtraidoErrado(linha({ texto: 'dia 21/11 a noite pra 80', citado: { data: '2026-11-21', convidados: 80 }, saidas: [texto('Anotei: 21/11/2026, segundo horário (17h às 21h), 80 convidados.')] })), null);
});

test('MENU INDEVIDO: alerta o menu junto de outra resposta, no lugar de uma resposta ou com pergunta pendente; não acusa o menu para mensagem sem assunto', () => {
  // Errado: o defeito do holdout 20 (j77), "à tarde" com o menu antes dos períodos.
  assert.equal(menuIndevido(linha({ texto: 'à tarde', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['turno'], saidas: [texto(MENU + '\n\nSobre “à tarde”: os períodos são primeiro horário (11h às 15h) e segundo horário (17h às 21h). Qual você prefere?')] })), 'menu junto de outra resposta');
  assert.match(menuIndevido(linha({ texto: 'quanto custa?', intencoes: ['PRECOS'], saidas: [texto(MENU)] })), /menu no lugar de RESPONDER \(PRECOS\)/);
  assert.equal(menuIndevido(linha({ texto: 'hmm', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', pendente: ['data'], saidas: [texto(MENU)] })), 'menu junto de pergunta pendente');
  // Rodada 22: agradecimento coloquial respondido com o menu (holdout 21, a01).
  assert.equal(menuIndevido(linha({ texto: 'Oiiiii boa noiteee 😊 obrigadaaa pelas informações, vcs são demais 🥰', intencoes: ['SAUDACAO'], saidas: [texto(MENU)] })), 'menu no lugar do agradecimento');
  assert.equal(menuIndevido(linha({ texto: 'brigadão!', saidas: [texto(MENU)] })), 'menu no lugar do agradecimento');
  // Certos: o menu sozinho para "???" (sem assunto) e para a saudação; os períodos sem menu.
  assert.equal(menuIndevido(linha({ texto: '???', intencoes: ['FORA_DO_ESCOPO'], saidas: [texto(MENU)] })), null);
  assert.equal(menuIndevido(linha({ texto: 'oi', intencoes: ['SAUDACAO'], saidas: [texto(MENU)] })), null);
  assert.equal(menuIndevido(linha({ texto: 'brigadão!', saidas: [texto('Por nada! Se precisar de mais alguma informação, é só falar.')] })), null);
  assert.equal(menuIndevido(linha({ texto: 'à tarde', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['turno'], saidas: [texto('Sobre “à tarde”: os períodos são primeiro horário (11h às 15h) e segundo horário (17h às 21h). Qual você prefere?')] })), null);
});

test('PERGUNTA FORA DO FLUXO: alerta pergunta que não é do fluxo ou do caso errado; não acusa a pergunta do fluxo, a pergunta citada nem o pedido dos dados', () => {
  // Errados: o defeito do holdout 20 (j34), contrato para assinar com "qual ponto?"; pergunta oferecendo outro assunto;
  // "Como posso ajudar?" quando a mensagem já tinha assunto (sem saudação).
  assert.match(perguntaForaDoFluxo(linha({ texto: 'bora fechar! me manda o contrato pra eu assinar', intencoes: ['CONTRATAR'], saidas: [texto('Posso explicar as condições gerais do contrato: cancelamento e remarcação. Qual ponto você quer saber?')] })), /Qual ponto/);
  assert.match(perguntaForaDoFluxo(linha({ texto: 'qual o endereço?', intencoes: ['LOCALIZACAO'], saidas: [texto('Rua Sintética, 1. Quer que eu envie também o cardápio?')] })), /cardápio\?/);
  assert.match(perguntaForaDoFluxo(linha({ texto: 'quanto custa?', intencoes: ['PRECOS'], saidas: [texto('Como posso ajudar?')] })), /Como posso ajudar/);
  // Certos: o ponto do contrato quando o contrato é o assunto; os períodos para "à tarde"; a saudação; pedido dos dados
  // sem "?"; pergunta dentro da cláusula citada.
  assert.equal(perguntaForaDoFluxo(linha({ texto: 'quais as condições do contrato?', intencoes: ['CONTRATO'], saidas: [texto('Posso explicar as condições gerais do contrato. Qual ponto você quer saber?')] })), null);
  assert.equal(perguntaForaDoFluxo(linha({ texto: 'à tarde', intencoes: ['PRECOS'], saidas: [texto('Sobre “à tarde”: os períodos são primeiro horário (11h às 15h) e segundo horário (17h às 21h). Qual você prefere?')] })), null);
  assert.equal(perguntaForaDoFluxo(linha({ texto: 'oi', intencoes: ['SAUDACAO'], saidas: [texto('Olá! Como posso ajudar?')] })), null);
  assert.equal(perguntaForaDoFluxo(linha({ texto: 'quero um orçamento', intencoes: ['PRECOS'], saidas: [texto('Para continuar, me diga a data da festa (dia, mês e ano).')] })), null);
  assert.equal(perguntaForaDoFluxo(linha({ texto: 'tem multa?', intencoes: ['CONTRATO'], saidas: [texto('Cláusula 9: “Quem desiste? Paga 20%.”', [clausula(9)])] })), null);
});

test('REPETIÇÃO DESNECESSÁRIA (conversa completa): alerta o valor repetido no pedido de gerente e o convite repetido; não acusa o assunto pedido de novo, a pergunta pendente nem outra conversa', () => {
  const valor = 'Completa em 21/11/2026, segundo horário (17h às 21h), 80 convidados: R$ 8.000,00, pela tabela “Tabela sintética”.';
  const convite = 'Se quiser, me conte a data da festa (dia, mês e ano) e o período que eu anoto.';
  const pede = 'Para continuar, me diga a data da festa (dia, mês e ano).';
  const pacotes = 'O pacote:\n• Premium: de 80 a 150 convidados; 5 horas de festa.';
  const conversa = [
    linha({ id: 'c1', conversa: 'A', ordem: 1, texto: 'quanto fica o completa pra 80 dia 21/11 a noite?', intencoes: ['PRECOS'], saidas: [texto(valor)] }),
    // Errado: só pediu o gerente e o valor voltou inteiro.
    linha({ id: 'c2', conversa: 'A', ordem: 2, texto: 'quero falar com o gerente', decisao: 'EQUIPE', esperado: 'EQUIPE', intencoes: ['HUMANO'], saidas: [texto(valor), texto('Vou passar sua conversa para a equipe.')] }),
    linha({ id: 'c3', conversa: 'A', ordem: 3, texto: 'e o premium?', intencoes: ['PACOTES'], saidas: [texto(pacotes), texto(convite)] }),
    // Errado: o mesmo convite opcional de novo.
    linha({ id: 'c4', conversa: 'A', ordem: 4, texto: 'quantas horas ele tem?', intencoes: ['PACOTES'], saidas: [texto('O Premium tem 5 horas de festa.'), texto(convite)] }),
    linha({ id: 'c5', conversa: 'A', ordem: 5, texto: 'me fala do premium', intencoes: ['PACOTES'], saidas: [texto(pacotes)] }),
    // Certo: o pacote pedido de novo ("me manda o premium de novo").
    linha({ id: 'c6', conversa: 'A', ordem: 6, texto: 'me manda o premium de novo', intencoes: ['PACOTES'], saidas: [texto(pacotes)] }),
    linha({ id: 'c7', conversa: 'A', ordem: 7, texto: 'quero orçamento', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['data'], saidas: [texto(pede)] }),
    // Certo: a pergunta pendente volta quando o dado não veio.
    linha({ id: 'c8', conversa: 'A', ordem: 8, texto: 'hmm sei lá', decisao: 'PERGUNTAR', esperado: 'PERGUNTAR', intencoes: ['PRECOS'], pendente: ['data'], saidas: [texto(pede)] }),
    // Certo: outra conversa com o mesmo valor não é repetição.
    linha({ id: 'd1', conversa: 'B', ordem: 1, texto: 'quero falar com o gerente', decisao: 'EQUIPE', esperado: 'EQUIPE', intencoes: ['HUMANO'], saidas: [texto(valor)] }),
  ];
  const alertas = Object.fromEntries(conversa.map((l) => [l.id, repeticaoDesnecessaria(l, conversa)]));
  assert.match(alertas.c2, /Completa em 21\/11/);
  assert.match(alertas.c4, /Se quiser, me conte/);
  for (const id of ['c1', 'c3', 'c5', 'c6', 'c7', 'c8', 'd1']) assert.equal(alertas[id], null, id);
  // calcularMetricas junta as quatro listas não críticas da rodada 21.
  const m = calcularMetricas([...conversa,
    linha({ id: 'e1', texto: 'tema dinossauro qual a diferença?', citado: { tema: 'dinossauro' }, intencoes: ['DECORACAO'], saidas: [anotei('dinossauro qual a diferença')] }),
    linha({ id: 'e2', texto: 'quanto custa?', intencoes: ['PRECOS'], saidas: [texto(MENU)] }),
    linha({ id: 'e3', texto: 'manda o contrato pra assinar', intencoes: ['CONTRATAR'], saidas: [texto('Qual ponto você quer saber?')] }),
  ]);
  assert.deepEqual(m.repeticoes.map((x) => x.id), ['c2', 'c4']);
  assert.deepEqual(m.dadosExtraidosErrados.map((x) => x.id), ['e1']);
  assert.deepEqual(m.menusIndevidos.map((x) => x.id), ['e2']);
  assert.deepEqual(m.perguntasForaDoFluxo.map((x) => x.id), ['e3']);
});

// ---------------------------------------------------------------- rodada 23
test('PROTEÇÃO ANTES DAS FONTES: alergia, reclamação ou festa contratada com consulta comercial é falha crítica; sem consulta, ou só a de segurança, não', () => {
  const falhas = (linhas) => calcularMetricas(linhas).criticas.find((c) => c.chave === 'PROTECAO_CONSULTA').falhas.map((f) => `${f.id}: ${f.motivo}`);
  const passou = (id, texto, intencoes, consultas) => linha({ id, texto, decisao: 'EQUIPE', esperado: 'EQUIPE', intencoes, consultas, saidas: [texto2('Vou passar sua conversa para a equipe.')] });
  const texto2 = (t) => ({ texto: t, anexo: null, fontes: [] });
  // Errados: o13 do holdout 22 (festa contratada + alergia consultou a agenda); reclamação com tabela; alergia com cardápio.
  assert.deepEqual(falhas([
    passou('o13', 'fechamos a festa pro dia 20/11 e ele é alérgico a ovo', ['ALERGIA', 'CONTRATO_PROPRIO'], ['disponibilidade']),
    passou('r1', 'a festa foi um desastre. quanto fica outra?', ['RECLAMACAO', 'PRECOS'], ['prontasAutorizadas', 'preco']),
    passou('a1', 'alérgico a leite, o que tem no buffet?', ['ALERGIA', 'CARDAPIO'], ['composicao']),
  ]), ['o13: consultou disponibilidade', 'r1: consultou prontasAutorizadas, preco', 'a1: consultou composicao']);
  // Certos: nenhuma consulta; só a consulta de segurança do contrato próprio; mensagem sem proteção pode consultar.
  assert.deepEqual(falhas([
    passou('c1', 'meu filho é alérgico a leite', ['ALERGIA'], []),
    passou('c2', 'me manda o contrato da minha festa', ['CONTRATO_PROPRIO'], ['linkContratoProprio']),
    linha({ id: 'c3', texto: 'quanto fica o completa?', intencoes: ['PRECOS'], consultas: ['prontasAutorizadas', 'preco'] }),
  ]), []);
});

// ---------------------------------------------------------------- rodada 24
test('FONTE ERRADA (rodada 24): o pedido de pix com a cláusula de horários é falha ("segundo horário" é o período); a cláusula pedida não', () => {
  const pix = 'quero reservar o dia 19/12 no segundo horário, qual o pix pro sinal?';
  // Errados: o caso l10 do holdout 23 (antes passava: "horário" do período contava como pergunta de horários).
  assert.match(fonteErrada(linha({ texto: pix, saidas: [texto('Cláusula 8 …', [clausula(8)])] })), /sem assunto de contrato/);
  assert.match(fonteErrada(linha({ texto: 'me manda a chave pix', saidas: [texto('Cláusula 7 …', [clausula(7)])] })), /sem assunto de contrato/);
  assert.match(fonteErrada(linha({ texto: 'no primeiro horário, dá pra levar cerveja?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), /8 \(HORARIOS\)/);
  // Certos: horários perguntados junto do período; o pix sem cláusula; a continuação curta e a pergunta de condição.
  assert.equal(fonteErrada(linha({ texto: 'no segundo horário, se passar do horário cobra?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), null);
  assert.equal(fonteErrada(linha({ texto: pix, saidas: [texto('Pagamentos e cobranças de uma festa são conferidos pela equipe.')] })), null);
  assert.equal(fonteErrada(linha({ texto: 'e quanto é?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), null);
  assert.equal(fonteErrada(linha({ texto: 'tem multa?', saidas: [texto('Cláusula 9 …', [clausula(9)])] })), null);
});

test('SEM SUPORTE (rodada 24): dado bancário inventado é falha; o encaminhamento do pagamento não', () => {
  for (const r of ['A chave pix é 12.345.678/0001-90.', 'Pix: buffet@exemplo.test, agência 1234, conta 56789-0', 'Segue o QR code para o sinal.'])
    assert.equal(semSuporte(linha({ texto: 'qual o pix?', saidas: [texto(r)] })), 'dado bancário sem fonte', r);
  assert.equal(semSuporte(linha({ texto: 'qual o pix?', saidas: [texto('Pagamentos e cobranças de uma festa são conferidos pela equipe.')] })), null);
  assert.equal(semSuporte(linha({ texto: 'tem estacionamento?', saidas: [texto('Estacionamento no local, entrada pela rua 2.', [{ tipo: 'CONFIGURACAO', perguntaId: 'e' }])] })), null);
});

// ---------------------------------------------------------------- rodada 25
test('DATA DIVERGENTE: a data citada com mês explícito precisa ser a usada no cálculo/agenda; dado herdado e consulta certa não alertam', () => {
  const preco = (data) => ({ fonte: 'preco', args: ['COMPLETA', data, 'TURNO_2', 70] });
  const agenda = (data) => ({ fonte: 'disponibilidade', args: [data, null] });
  const falhas = (linhas) => calcularMetricas(linhas).criticas.find((c) => c.chave === 'DATA_DIVERGENTE').falhas.map((f) => `${f.id}: ${f.motivo}`);
  // Errados: i54 do holdout 24 ("dezembro, dia 12" calculado em 12/10); agenda em outra data; data numérica.
  assert.deepEqual(falhas([
    linha({ id: 'i54', texto: 'dezembro, dia 12', citado: { data: '2026-12-12' }, consultasDetalhe: [preco('2026-10-12')] }),
    linha({ id: 'a1', texto: 'tem vaga em dezembro no dia 19?', citado: { data: '2026-12-19' }, consultasDetalhe: [agenda('2026-10-19')] }),
    linha({ id: 'a2', texto: 'quanto fica dia 12/12?', citado: { data: '2026-12-12' }, consultasDetalhe: [preco('2026-11-12')] }),
  ]), ['i54: consultou 2026-10-12 (citada: 2026-12-12)', 'a1: consultou 2026-10-19 (citada: 2026-12-19)', 'a2: consultou 2026-11-12 (citada: 2026-12-12)']);
  // Certos: a data citada consultada (também comparando com outra); sem consulta; "dia 19" sem mês (herdado) não é cobrado.
  assert.deepEqual(falhas([
    linha({ id: 'c1', texto: 'dezembro, dia 12', citado: { data: '2026-12-12' }, consultasDetalhe: [preco('2026-12-12')] }),
    linha({ id: 'c2', texto: 'e se for 19/12?', citado: { data: '2026-12-19' }, consultasDetalhe: [preco('2026-12-12'), preco('2026-12-19')] }),
    linha({ id: 'c3', texto: 'dezembro, dia 12', citado: { data: '2026-12-12' }, consultasDetalhe: [] }),
    linha({ id: 'c4', texto: 'e no dia 19?', citado: { data: '2026-10-19' }, consultasDetalhe: [preco('2026-12-19')] }),
  ]), []);
  assert.equal(dataDivergente(linha({ texto: 'dezembro, dia 12', citado: { data: '2026-12-12' }, consultasDetalhe: [agenda('2026-12-12')] })), null);
});

test('FONTE ERRADA (rodada 25): "sem juros" (parcelamento) com a cláusula de inadimplência é falha; juros de atraso não', () => {
  // Errado: o i18 do holdout 24 (antes "juros" bastava para a régua aceitar a cláusula 7).
  assert.match(fonteErrada(linha({ texto: 'consegue parcelar em 12x sem juros?', saidas: [texto('Cláusula 7 …', [clausula(7)])] })), /sem assunto de contrato|7 \(INADIMPLENCIA\)/);
  // Certos: juros por atraso, parcela atrasada, juros de mora.
  for (const t of ['se atrasar uma parcela tem juros?', 'qual o juros por atraso?', 'boleto vencido cobra juros?'])
    assert.equal(fonteErrada(linha({ texto: t, saidas: [texto('Cláusula 7 …', [clausula(7)])] })), null, t);
});

// ---------------------------------------------------------------- rodada 26
test('FONTE ERRADA (rodada 26): perguntas condicionais — a cláusula precisa ser do assunto perguntado; "se eu…" não libera nenhuma', () => {
  // [pergunta, cláusulas certas, cláusulas deliberadamente incompatíveis]; [] = a resposta certa não cita cláusula.
  const casos = [
    // Pagamento: juros do parcelamento (sem cláusula) × juros por atraso (cláusula 7).
    ['tem juros se eu parcelar?', [], [7, 9]],
    ['se eu parcelar no cartão em 10x tem acréscimo?', [], [7]],
    // "taxa" liberaria a cláusula sem assunto: o parcelamento é que decide.
    ['se eu parcelar em 6x tem alguma taxa?', [], [7]],
    ['se eu atrasar a parcela tem juros?', [7], [9, 8]],
    ['se eu pagar depois do vencimento tem multa?', [7], [9]],
    // Horários.
    ['se eu passar do horário cobra?', [8], [7, 11]],
    ['e se a festa terminar meia hora depois do horário?', [8], [9]],
    // Cancelamento.
    ['se eu cancelar tem multa?', [9], [8, 7]],
    ['se eu desistir da festa perco o que paguei?', [9], [7]],
    // Itens extras.
    ['se eu quiser mais balões quanto é?', [17], [3, 8]],
    ['se eu levar cerveja pode?', [11], [14]],
    ['se eu levar confete tem taxa?', [14], [11]],
    ['se vierem mais convidados cobra a mais?', [3], [17]],
    ['se eu levar meu próprio bolo pode?', [], [11, 17]],
  ];
  for (const [t, certas, erradas] of casos) {
    const resp = (ns) => linha({ texto: t, saidas: [texto(ns.map((n) => `Cláusula ${n} …`).join('\n') || 'A equipe confirma essa parte.', ns.map(clausula))] });
    assert.equal(fonteErrada(resp(certas)), null, `certa: ${t}`);
    for (const n of erradas) assert.ok(fonteErrada(resp([n])), `incompatível ${n}: ${t}`);
  }
  // Continuação numa conversa ("e se for 15 minutos?") herda o assunto; a mesma frase avulsa não libera cláusula.
  assert.equal(fonteErrada(linha({ texto: 'e quanto é?', conversa: 'c1', ordem: 2, saidas: [texto('Cláusula 8 …', [clausula(8)])] })), null);
  assert.ok(fonteErrada(linha({ texto: 'e se eu quiser?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })));
});

test('régua (rodada 26): confirmar a data completa da contratação é do fluxo, não pergunta desnecessária nem fora do fluxo', () => {
  const r = 'Antes de seguir com a contratação, confirme a data: sábado, 14/11/2026. Está certa? Se for outra, me diga o dia, o mês e o ano.';
  const l = linha({ texto: 'fechado! pode garantir', decisao: 'PERGUNTAR', esperado: 'EQUIPE', intencoes: ['CONTRATAR'], saidas: [texto(r)], pendente: ['data'], pendentePara: 'CONTRATAR', contextoAntes: { data: '2026-11-14' } });
  assert.equal(perguntaDesnecessaria(l), null);
  assert.equal(perguntaForaDoFluxo(l), null);
  // Contraexemplos: pedir de novo a data já dita, e "Está certa?" fora da contratação.
  assert.match(perguntaDesnecessaria(linha({ texto: 'quanto fica?', decisao: 'PERGUNTAR', intencoes: ['PRECOS'], saidas: [texto('Para continuar, me diga a data da festa.')], pendente: ['data'], pendentePara: 'PRECOS', contextoAntes: { data: '2026-11-14' } })), /data já foi dito/);
  assert.ok(perguntaForaDoFluxo(linha({ texto: 'qual o endereço?', intencoes: ['LOCALIZACAO'], saidas: [texto('Asa Sul. Está certa?')] })));
});

// ---------------------------------------------------------------- rodada 27
test('MÊS NOVO IGNORADO: mês novo sem dia depois de uma data de outro mês não pode consultar o mês antigo', () => {
  const preco = (data) => ({ fonte: 'preco', args: ['PREMIUM', data, 'TURNO_1', 100] });
  const agenda = (data) => ({ fonte: 'disponibilidade', args: [data, null] });
  const falhas = (linhas) => calcularMetricas(linhas).criticas.find((c) => c.chave === 'MES_NOVO_IGNORADO').falhas.map((f) => `${f.id}: ${f.motivo}`);
  // Errados: c73 do holdout 26 (calculou 19/12 de novo) e a agenda no mês antigo.
  assert.deepEqual(falhas([
    linha({ id: 'c73', texto: 'e em janeiro quanto ficaria pra mesma quantidade?', contextoAntes: { data: '2026-12-19' }, consultasDetalhe: [preco('2026-12-19')] }),
    linha({ id: 'a1', texto: 'e em dezembro, tem vaga?', contextoAntes: { data: '2026-11-21' }, consultasDetalhe: [agenda('2026-11-21')] }),
  ]), ['c73: consultou 2026-12-19 (mês citado: 01)', 'a1: consultou 2026-11-21 (mês citado: 12)']);
  // Certos: pediu o dia (sem consulta); consultou no mês novo; mesmo mês; mês com dia (DATA_DIVERGENTE cobre); sem data antes.
  assert.deepEqual(falhas([
    linha({ id: 'c1', texto: 'e em janeiro quanto ficaria?', contextoAntes: { data: '2026-12-19' }, consultasDetalhe: [] }),
    linha({ id: 'c2', texto: 'e em janeiro quanto ficaria?', contextoAntes: { data: '2026-12-19' }, consultasDetalhe: [preco('2027-01-09')] }),
    linha({ id: 'c3', texto: 'e em dezembro mesmo, no outro horário?', contextoAntes: { data: '2026-12-19' }, consultasDetalhe: [preco('2026-12-19')] }),
    linha({ id: 'c4', texto: 'e em janeiro, dia 9?', contextoAntes: { data: '2026-12-19' }, consultasDetalhe: [preco('2026-12-19')] }),
    linha({ id: 'c5', texto: 'e em janeiro?', contextoAntes: null, consultasDetalhe: [] }),
  ]), []);
  assert.equal(mesSemDiaCitado('janeiro dia 9'), null);
  assert.equal(mesSemDiaCitado('festa de 5 anos em março'), 3);
  assert.equal(mesSemDiaCitado('12/12'), null);
  assert.equal(mesIgnorado(linha({ texto: 'em março, umas 70 pessoas', contextoAntes: { data: '2026-11-21' }, consultasDetalhe: [preco('2026-11-21')] })), 'consultou 2026-11-21 (mês citado: 03)');
});

test('ALTERAÇÃO EM FESTA CONTRATADA: troca de tema ou data da festa contratada não altera o contexto comercial', () => {
  const falhas = (linhas) => calcularMetricas(linhas).criticas.find((c) => c.chave === 'ALTERACAO_FESTA_CONTRATADA').falhas.map((f) => `${f.id}: ${f.motivo}`);
  const base = { texto: 'a festa da Alice já tá fechada mas ela quer trocar o tema pra Wandinha', esperado: 'EQUIPE', intencoes: ['CONTRATO_PROPRIO'], decisao: 'EQUIPE' };
  // Errados: c31 do holdout 26 (tema anotado) e a data da festa contratada indo para a conversa.
  assert.deepEqual(falhas([
    linha({ ...base, id: 'c31', contextoAntes: { tema: null }, contextoDepois: { tema: 'Wandinha' }, saidas: [texto('Anotei o tema “Wandinha”.')] }),
    linha({ ...base, id: 'd1', texto: 'a festa do Theo tá marcada pro dia 15/11, quero mudar pra 22/11', contextoAntes: {}, contextoDepois: { data: '2026-11-22' }, saidas: [texto('A equipe vê com você.')] }),
    linha({ ...base, id: 'd2', contextoAntes: {}, contextoDepois: {}, saidas: [texto('Anotei: tema Wandinha.')] }),
  ]), ['c31: alterou o contexto comercial: tema', 'd1: alterou o contexto comercial: data', 'd2: anotou como dado comercial']);
  // Certos: contexto igual, sem "Anotei"; contraexemplo sem festa contratada (decoração) não é cobrado.
  assert.deepEqual(falhas([
    linha({ ...base, id: 'e1', contextoAntes: { tema: 'Frozen' }, contextoDepois: { tema: 'Frozen' }, saidas: [texto('Vou passar sua conversa para a equipe, que cuida das festas já contratadas.')] }),
    linha({ id: 'e2', texto: 'quero trocar o tema pra Frozen', intencoes: ['DECORACAO'], contextoAntes: { tema: 'Moana' }, contextoDepois: { tema: 'Frozen' }, saidas: [texto('Anotei o tema “Frozen”.')] }),
  ]), []);
  assert.equal(alteracaoFestaContratada(linha({ ...base, contextoAntes: { tema: 'X' }, contextoDepois: { tema: 'X' }, saidas: [texto('A equipe responde.')] })), null);
});

// ---------------------------------------------------------------- pendências do holdout 27
test('IRRELEVANTE (pendência aa30): a frase da cláusula de sinal sem sinal pedido é conteúdo irrelevante; com sinal ou entrada de pagamento, não', () => {
  const sinal = texto('O modelo de contrato vigente não tem uma cláusula de sinal. As condições de pagamento de cada festa ficam no Resumo da Contratação.');
  assert.match(irrelevante(linha({ texto: 'a gente pode levar uns balões a mais pra enfeitar a entrada?', intencoes: ['FORA_DO_ESCOPO'], saidas: [sinal] })), /cláusula de sinal sem sinal pedido/);
  for (const t of ['quanto é o sinal?', 'qual o valor da entrada pra reservar?', 'dou uma entrada de 2 mil e o resto parcelado?'])
    assert.equal(irrelevante(linha({ texto: t, intencoes: ['CONTRATO'], saidas: [sinal] })), null, t);
});

test('FONTE ERRADA (pendência aa06/aa05): "caso o boleto vença" é atraso; "meia horinha a mais" é horários', () => {
  assert.equal(fonteErrada(linha({ texto: 'Caso o boleto vença e eu não consiga pagar no dia, há cobrança de multa?', saidas: [texto('Cláusula 7 …', [clausula(7)])] })), null);
  assert.ok(fonteErrada(linha({ texto: 'Caso o boleto vença e eu não consiga pagar no dia, há cobrança de multa?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })));
  assert.equal(fonteErrada(linha({ texto: 'da pra ficar meia horinha a mais no final da festa?', saidas: [texto('Cláusula 8 …', [clausula(8)])] })), null);
  assert.ok(fonteErrada(linha({ texto: 'da pra ficar meia horinha a mais no final da festa?', saidas: [texto('Cláusula 9 …', [clausula(9)])] })));
});

test('ENDERECO_DIVERGENTE (rodada 30): alerta o endereço de outra unidade; não acusa a unidade pedida, as duas pedidas nem a resposta sem endereço', () => {
  const end = (nome, slug) => texto(`${nome}: endereço sintético.\nhttps://maps.example.test/${slug}`, [{ tipo: 'PRONTA', id: `p-${slug}`, versao: 1, finalidade: 'LOCALIZACAO' }]);
  // Errado: o defeito real do holdout 30 (aa63) — pediu Águas Claras, recebeu a Asa Sul.
  assert.match(enderecoDivergente(linha({ texto: 'Ia fazer na Asa Sul mas mudei de ideia, vai ser em Águas Claras. Qual o endereço de lá?', intencoes: ['LOCALIZACAO'], citado: { unidade: 'AGUAS_CLARAS' }, saidas: [end('Asa Sul', 'asa-sul')] })), /ASA_SUL.*pedida: AGUAS_CLARAS/);
  // Só o link de mapa (sem o nome no texto) também identifica a unidade.
  assert.deepEqual(unidadesDosEnderecos(linha({ texto: 'onde fica?', saidas: [texto('Segue: https://maps.example.test/asa-sul')] })), ['ASA_SUL']);
  assert.match(enderecoDivergente(linha({ texto: 'e o endereço de águas claras?', citado: { unidade: 'AGUAS_CLARAS' }, saidas: [texto('Segue: https://maps.example.test/asa-sul')] })), /pedida: AGUAS_CLARAS/);
  // Certos: a unidade pedida; as duas enviadas com a pedida entre elas; nenhuma unidade pedida; resposta sem endereço.
  assert.equal(enderecoDivergente(linha({ texto: 'qual o endereço de águas claras?', citado: { unidade: 'AGUAS_CLARAS' }, saidas: [end('Águas Claras', 'aguas-claras')] })), null);
  assert.equal(enderecoDivergente(linha({ texto: 'endereço das duas?', citado: { unidade: 'AGUAS_CLARAS' }, saidas: [end('Asa Sul', 'asa-sul'), end('Águas Claras', 'aguas-claras')] })), null);
  assert.equal(enderecoDivergente(linha({ texto: 'onde fica?', citado: {}, saidas: [end('Asa Sul', 'asa-sul')] })), null);
  assert.equal(enderecoDivergente(linha({ texto: 'tem estacionamento em águas claras?', citado: { unidade: 'AGUAS_CLARAS' }, saidas: [texto('Resposta sintética: estacionamento no local.')] })), null);
});

test('PARAR_MISTO (rodada 32): pausa sem a marca persistente é falha; com a marca ou em resultado antigo (sem o campo), não', () => {
  const cat = CATEGORIAS_CRITICAS.find((c) => c.chave === 'PARAR_MISTO');
  const l = { ...linha({ texto: 'por enquanto não precisa me mandar mais nada', esperado: 'PARAR_MISTO', intencoes: ['PARAR'], decisao: 'EQUIPE' }), motivos: ['PARAR_A_CONFIRMAR'] };
  assert.equal(cat.falha({ ...l, semAutomatico: false }, []), 'pausa sem a marca persistente');
  assert.equal(cat.falha({ ...l, semAutomatico: true }, []), null);
  assert.equal(cat.falha(l, []), null);
});

test('NUMERO_TROCADO (rodada 33): valor, preço por hora ou data lido como convidados é falha; número dito como pessoas ou herdado não', () => {
  const ent = (convidados) => ({ data: null, convidados, turno: null, pacotes: [], unidade: null, tema: null });
  // Errado: o defeito real do h33 (aa38) — preço por hora virou convidados e disparou a capacidade.
  assert.match(numeroTrocado(linha({ texto: 'agora a prorrogação caiu pra 400 por hora né? aplica isso no meu orçamento', entidades: ent(400), saidas: [texto('Para 400 convidados, nenhum pacote cadastrado comporta.')] })), /400 \(valor/);
  assert.match(numeroTrocado(linha({ texto: 'a taxa de 180 da bebida vale pra festa toda?', entidades: ent(180) })), /180 \(valor/);
  assert.match(numeroTrocado(linha({ texto: 'quanto fica o completa? tenho 6 mil reais', saidas: [texto('Completa para 6 convidados…')], entidades: ent(6) })), /valor/);
  assert.match(numeroTrocado(linha({ texto: 'tem vaga no sábado dia 21 de novembro?', contextoDepois: { convidados: 21 } })), /21 \(data/);
  // Certos: o número é de pessoas (também quando outro número é valor), herdado da conversa, ou nenhum convidado lido.
  assert.equal(numeroTrocado(linha({ texto: 'prorrogação a 700 por hora pra 80 pessoas, quanto dá?', entidades: ent(80) })), null);
  assert.equal(numeroTrocado(linha({ texto: 'e se a gente pagar 400 reais a mais, cabem 400 pessoas?', entidades: ent(400) })), null);
  assert.equal(numeroTrocado(linha({ texto: 'e a prorrogação, quanto é por hora?', entidades: ent(80), contextoDepois: { convidados: 80 }, saidas: [texto('Completa, 80 convidados: R$ 8.000,00')] })), null);
  assert.equal(numeroTrocado(linha({ texto: 'quanto fica o essencial pra 50 no dia 7/11?', entidades: ent(50) })), null);
  // "Custa pra 90 pessoas": a palavra de valor vem antes, mas o número é dito como pessoas.
  assert.equal(numeroTrocado(linha({ texto: 'quanto custa pra 90 pessoas o completa?', entidades: ent(90) })), null);
  assert.equal(numeroTrocado(linha({ texto: 'a prorrogação caiu pra 400 por hora?', entidades: ent(null) })), null);
});

test('SEM SUPORTE (rodada 34): horário de entrada dos convidados sem os períodos cadastrados é falha; com a fonte, não', () => {
  const frase = 'A entrada dos convidados é no início do período contratado: primeiro horário a partir das 11h e segundo horário a partir das 17h.';
  assert.equal(semSuporte(linha({ texto: 'que horas os convidados entram?', saidas: [texto(frase)] })), 'horário de entrada sem os períodos cadastrados');
  assert.equal(semSuporte(linha({ texto: 'que horas os convidados entram?', saidas: [texto(frase, [{ tipo: 'PERIODOS_AGENDA' }])] })), null);
});

test('COMERCIAL (rodada 35, erro da régua no h35 aa54): horário de entrada rotulado como DISPONIBILIDADE é servido pelos períodos cadastrados; sem essa fonte, continua falha', () => {
  const l = (fontes) => ({ ...linha({ texto: 'nesse do almoço os convidados entram a partir de que horas?', intencoes: ['DISPONIBILIDADE'], saidas: [texto('No primeiro horário (11h às 15h), a entrada dos convidados é a partir das 11h, no início do período contratado.', fontes)] }) });
  const falhas = (x) => calcularMetricas([x]).comercial.falhas.map((f) => f.motivo);
  assert.deepEqual(falhas(l([{ tipo: 'PERIODOS_AGENDA' }])), []);
  assert.deepEqual(falhas(l([])), ['sem fonte para DISPONIBILIDADE']);
  // Pergunta de data livre (não de entrada) continua exigindo a agenda.
  const d = { ...linha({ texto: 'tem data livre dia 7/11?', intencoes: ['DISPONIBILIDADE'], saidas: [texto('A entrada é às 11h.', [{ tipo: 'PERIODOS_AGENDA' }])] }) };
  assert.deepEqual(falhas(d), ['sem fonte para DISPONIBILIDADE']);
});
