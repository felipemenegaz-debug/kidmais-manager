import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entenderPorRegras, perguntasSemFonte } from './entendimento.ts';
import type { Catalogos } from './tipos.ts';

/**
 * Correspondência da FAQ "só igualdade" (decisão de Felipe, 27/11/2026): a pergunta frequente só é escolhida quando a
 * pergunta inteira do cliente é IGUAL à cadastrada depois da normalização (caixa, acentos, pontuação e espaços; quebra de
 * linha é espaço). Única equivalência: a lista fechada de grafias do wi-fi (wi-fi, wifi, wi fi). Pergunta parecida que
 * não casa não é defeito: segue como pergunta sem fonte, passagem segura para a equipe.
 * Inclui os 9 exemplos do Astra r1 (orquestracao/loop/walle-faq-correspondencia-20261127/r1-astra.json) e os holdouts
 * negativos da r1. Tudo sintético e em memória: nenhum banco, modelo ou provedor.
 */
const base: Catalogos = {
  pacotes: [{ codigo: 'ESSENCIAL', nome: 'Essencial' }],
  unidades: [{ id: 'u1', nome: 'Asa Sul' }],
  unidadesAgenda: [],
  turnos: [{ codigo: 'TURNO_1', nome: 'Almoço', inicio: '11:00', fim: '15:00' }],
  perguntas: [],
  hoje: '2026-11-27',
};
const comFaq = (pergunta: string, resposta = 'Resposta aprovada sintética.'): Catalogos => ({ ...base, perguntas: [{ id: 'faq', pergunta, resposta }] });
const comFaqs = (...faqs: Array<[string, string]>): Catalogos => ({ ...base, perguntas: faqs.map(([pergunta, resposta], i) => ({ id: `faq${i}`, pergunta, resposta })) });
const ids = (cat: Catalogos, texto: string) => entenderPorRegras(texto, cat).intencoes.filter((i) => i.perguntaId).map((i) => i.perguntaId);
const semFonte = (cat: Catalogos, texto: string) => perguntasSemFonte(texto, cat).length > 0;
/** Casa? Sem fonte? E nunca as duas coisas ao mesmo tempo (FAQ escolhida e pergunta sem fonte). */
function par(cat: Catalogos, texto: string) {
  const casou = ids(cat, texto).length > 0;
  const sem = semFonte(cat, texto);
  assert.ok(!(casou && sem), `${texto}: FAQ escolhida e, ao mesmo tempo, sem fonte`);
  return { casou, sem };
}
/** Casa e a pergunta não fica sem fonte. */
const casaInteira = (cat: Catalogos, texto: string) => assert.deepEqual(par(cat, texto), { casou: true, sem: false }, texto);
/** Não casa e a pergunta vai para a equipe como sem fonte (passagem segura). */
const vaiParaEquipe = (cat: Catalogos, texto: string) => assert.deepEqual(par(cat, texto), { casou: false, sem: true }, texto);

test('FAQ igualdade: caixa, acentos, pontuação e espaços não contam', () => {
  const som = comFaq('Vocês têm som próprio?');
  for (const texto of ['Vocês têm som próprio?', 'voces tem som proprio', 'VOCÊS TÊM SOM PRÓPRIO???', '  vocês   têm som próprio ?', 'Vocês têm som próprio!', 'Vocês,  têm som próprio?', 'Vocês\ntêm som próprio?']) {
    casaInteira(som, texto);
  }
});

test('FAQ igualdade: só a lista fechada de grafias do wi-fi, nos dois sentidos', () => {
  for (const [faq, texto] of [['Tem wi-fi?', 'Tem wifi?'], ['Tem wifi?', 'Tem wi-fi?'], ['Tem wi fi?', 'tem wifi'], ['Tem Wi-Fi?', 'tem WIFI'], ['Tem wifi?', 'Tem wi fi?']]) {
    casaInteira(comFaq(faq, 'Sim.'), texto);
  }
  // Astra r1 #2: a barra (e qualquer outro separador) não amplia a lista.
  vaiParaEquipe(comFaq('Tem wi-fi?', 'Sim.'), 'Tem wi/fi?');
  vaiParaEquipe(comFaq('Tem wifi?', 'Sim.'), 'Tem wi_fi?');
  vaiParaEquipe(comFaq('Tem wifi?', 'Sim.'), 'Tem wi.fi?'.replace('.', '·'));
});

test('FAQ igualdade: nada de prefixo, saudação, complemento, sinônimo ou plural', () => {
  const wifi = comFaq('Tem wifi?', 'Sim.');
  for (const texto of ['Vocês têm wi-fi?', 'Oi, tem wifi?', 'Tem wifi aí?', 'Onde tem wifi?', 'Qual a senha do wifi?', 'Tem wifi quem me atendeu?']) {
    vaiParaEquipe(wifi, texto);
  }
  // Saudação separada por "!" ou "." é outra frase: a pergunta igual continua casando.
  casaInteira(wifi, 'Boa tarde! Tem wifi?');
  casaInteira(wifi, 'Oi. Tem wifi?');
  // Plural e singular (Astra r1 #8): não casa e não some.
  vaiParaEquipe(comFaq('Tem elevador?', 'Sim.'), 'Tem elevadores?');
  vaiParaEquipe(comFaq('Tem elevadores?', 'Sim, dois.'), 'Tem elevador?');
  // Paráfrase do estacionamento não casa (sem sinônimo).
  assert.equal(par(comFaq('Tem estacionamento?', 'Sim.'), 'Onde paro o carro?').casou, false);
});

test('FAQ igualdade: pergunta sem conteúdo nunca casa ("Tem?", Astra r1 #3 "Por que?")', () => {
  assert.equal(par(comFaq('Tem?', 'Sim.'), 'Tem?').casou, false);
  assert.equal(par(comFaq('Por que?', 'Sim.'), 'Por que?').casou, false);
  assert.equal(par(comFaq('Por que', 'Sim.'), 'por que').casou, false);
  casaInteira(comFaq('Tem som?', 'Sim.'), 'Tem som?');
});

test('FAQ igualdade: Astra r1 #1 — quebra de linha não corta a pergunta e não esconde o resto', () => {
  const wifi = comFaq('Tem wi-fi?', 'Sim.');
  vaiParaEquipe(wifi, 'Onde\ntem wifi?');
  // "Oi\ntem wifi?" é uma frase só ("oi tem wifi"): não casa, e o pedaço "tem wifi" fica sem fonte (não some).
  vaiParaEquipe(wifi, 'Oi\ntem wifi?');
  // Pergunta igual quebrada em linhas: casa, e nenhum pedaço dela fica sem fonte.
  casaInteira(comFaq('Tem som e manobrista?', 'Sim.'), 'Tem som\ne manobrista?');
});

test('FAQ igualdade: compostas só como escritas (Astra r1 #4, #5 e #6; holdout guarda-roupa × guarda-volumes)', () => {
  vaiParaEquipe(comFaq('Tem guarda-roupa?'), 'Tem guarda-roupa-sapatos?');
  casaInteira(comFaq('Tem guarda-chuva-infantil?'), 'Tem guarda chuva infantil?');
  assert.equal(par(comFaq('Tem guarda-chuva-infantil?'), 'Posso levar guarda chuva infantil?').casou, false);
  assert.equal(par(comFaq('Tem guarda-roupa infantil?'), 'Tem guardavolumes infantil?').casou, false);
  assert.equal(par(comFaq('Tem meia-lua infantil?'), 'Tem meia luz infantil?').casou, false);
  casaInteira(comFaq('Tem meia-lua infantil?'), 'Tem meia lua infantil?');
  // Forma junta não é a separada ("guardaroupa" ≠ "guarda roupa"): fora da lista fechada.
  assert.equal(par(comFaq('Tem guarda-roupa infantil?'), 'Tem guardaroupa infantil?').casou, false);
  assert.equal(par(comFaq('Tem guarda-volumes no estacionamento?', 'Sim.'), 'Tem guarda-roupa no estacionamento?').casou, false);
  const volumes = comFaq('Tem guarda-volumes infantil?');
  for (const texto of ['Tem guarda-roupa infantil?', 'tem guarda roupa infantil?', 'Tem guarda-roupa?']) vaiParaEquipe(volumes, texto);
  casaInteira(volumes, 'Tem guarda volumes infantil?');
});

test('FAQ igualdade: holdout valet × vale transporte', () => {
  vaiParaEquipe(comFaq('Aceitam vale transporte?'), 'Tem valet?');
  vaiParaEquipe(comFaq('Aceitam vale-transporte?'), 'Tem valet?');
  casaInteira(comFaq('Aceitam vale-transporte?'), 'aceitam vale transporte?');
});

test('FAQ igualdade: Astra r1 #7 — assunto sem fonte só sai com a pergunta igual, nunca pela resposta', () => {
  vaiParaEquipe(comFaq('Tem estacionamento?', 'Temos wi-fi.'), 'Tem wifi e manobrista no estacionamento?');
  vaiParaEquipe(comFaq('Tem estacionamento?', 'Temos wi-fi e manobrista.'), 'Tem wifi e manobrista no estacionamento?');
  casaInteira(comFaq('Tem wifi e manobrista no estacionamento?', 'Sim.'), 'Tem wi-fi e manobrista no estacionamento?');
  // Declarado fora de pergunta, por frase: "Preciso de wifi." fica sem fonte mesmo com outra frase igual a uma FAQ.
  const declarado = (cat: Catalogos, texto: string) => (entenderPorRegras(texto, cat).semFonte ?? []).length > 0;
  assert.equal(declarado(comFaq('Tem som?', 'Sim.'), 'Preciso de wifi. Obrigado.'), true);
  assert.equal(declarado(comFaq('Tem wifi?', 'Sim.'), 'Preciso de wifi. Obrigado.'), true);
  assert.equal(declarado(comFaq('Tem wifi?', 'Sim.'), 'Tem wifi. Obrigado.'), false);
  assert.equal(declarado(comFaq('Tem wifi?', 'Sim.'), 'Tem wifi. Preciso de wifi.'), true);
});

test('FAQ igualdade: várias perguntas — cada uma casa sozinha, na ordem da mensagem (Astra r1 #9)', () => {
  const cat = comFaqs(['Tem wifi?', 'Sim.'], ['Tem som?', 'Sim.']);
  assert.deepEqual(ids(cat, 'Tem som? Tem wifi?'), ['faq1', 'faq0']);
  assert.deepEqual(ids(cat, 'Tem wifi? Tem som?'), ['faq0', 'faq1']);
  assert.equal(semFonte(cat, 'Tem som? Tem wifi?'), false);
  // Uma igual e outra parecida: a igual casa, a parecida fica sem fonte (não some, não herda a FAQ).
  assert.deepEqual(ids(cat, 'Tem som? Tem wifi aí?'), ['faq1']);
  assert.equal(semFonte(cat, 'Tem som? Tem wifi aí?'), true);
  // Vírgula não separa perguntas.
  assert.deepEqual(ids(cat, 'Tem som, tem wifi?'), []);
});
