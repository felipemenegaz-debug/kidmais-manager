import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entenderPorRegras, perguntasSemFonte } from './entendimento.ts';
import type { Catalogos } from './tipos.ts';

/**
 * Correspondência da FAQ (fatia própria, 27/11/2026): casamento da mensagem do cliente com as perguntas aprovadas.
 * Pares do Astra r2 da fatia 7 e da r1 (holdout negativo em scripts/walle-avaliacao/sem-fonte-holdout.test.mjs).
 * Tudo sintético e em memória: nenhum banco, modelo ou provedor.
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
const casa = (cat: Catalogos, texto: string) => entenderPorRegras(texto, cat).intencoes.some((i) => i.perguntaId === 'faq');
const semFonte = (cat: Catalogos, texto: string) => perguntasSemFonte(texto, cat).length > 0;

test('FAQ: grafia de wi-fi casa na pergunta inteira, nos dois sentidos, e a pergunta não fica sem fonte', () => {
  for (const [faq, texto] of [
    ['Tem wi-fi?', 'Tem wifi?'], ['Tem wifi?', 'Tem wi-fi?'], ['Tem wi-fi?', 'Tem wi-fi?'], ['Tem wi fi?', 'tem wifi'],
    ['Tem wi-fi?', 'Vocês têm wi-fi?'], ['Tem wi-fi?', 'Boa tarde! Tem wifi?'], ['Tem wi-fi?', 'Oi, tem wifi?'], ['Tem wi-fi?', 'Tem wifi? E o estacionamento?'],
  ]) {
    assert.equal(casa(comFaq(faq, 'Sim.'), texto), true, `${faq} × ${texto}`);
    assert.equal(semFonte(comFaq(faq, 'Sim.'), texto.split('?')[0] + '?'), false, `${faq} × ${texto}: sem fonte`);
  }
});

test('FAQ: o interrogativo diferencia a pergunta inteira ("Onde tem wifi?" não é "Tem wifi?")', () => {
  for (const texto of ['Onde tem wifi?', 'Qual a senha do wifi?', 'Quando tem wifi?', 'Como funciona o wifi?', 'Tem wifi ai?']) {
    assert.equal(casa(comFaq('Tem wifi?', 'Sim.'), texto), false, texto);
  }
  // Pergunta cadastrada sem palavra de conteúdo nunca casa pela igualdade.
  assert.equal(casa(comFaq('Tem?', 'Sim.'), 'Tem?'), false);
});

test('FAQ: a grafia nova não alimenta a heurística de prefixos', () => {
  assert.equal(casa(comFaq('Tem wi-fi interno?'), 'Tem wifi internacional?'), false);
  assert.equal(casa(comFaq('Tem wifi interno?'), 'Tem wi-fi internacional?'), false);
  assert.equal(semFonte(comFaq('Tem wi-fi interno?'), 'Tem wifi internacional?'), true);
});

test('FAQ: composta com hífen só casa inteira (guarda-roupa × guarda-volumes)', () => {
  const volumes = comFaq('Tem guarda-volumes infantil?');
  for (const texto of ['Tem guarda-roupa infantil?', 'tem guarda roupa infantil?', 'Tem guarda-roupa?']) {
    assert.equal(casa(volumes, texto), false, texto);
    assert.equal(semFonte(volumes, texto), true, `${texto}: deveria ir para a equipe`);
  }
  // A mesma composta continua casando, com hífen ou espaço.
  assert.equal(casa(volumes, 'Tem guarda volumes infantil?'), true);
  assert.equal(casa(volumes, 'Onde fica o guarda-volumes infantil?'), true);
  // Pela resposta também: a composta da resposta não empresta o "guarda".
  assert.equal(casa(comFaq('Onde deixo as mochilas?', 'O guarda-volumes infantil fica na entrada.'), 'Tem guarda-roupa infantil?'), false);
  // Compostas já cobertas pela base continuam: pula-pula e ar-condicionado.
  assert.equal(casa(comFaq('Pode levar pula-pula?'), 'posso levar pula pula?'), true);
  assert.equal(casa(comFaq('Pode levar pula-pula?'), 'posso levar pula-pula próprio?'), true);
  assert.equal(casa(comFaq('Tem ar-condicionado?'), 'o salão tem ar condicionado?'), true);
  // As partes da composta não casam soltas pelo radical: "pular" não é "pula-pula".
  assert.equal(casa(comFaq('Pode levar pula-pula?'), 'Pode pular na piscina?'), false);
});

test('FAQ: junção sem espaço não cria acerto (valet × vale transporte)', () => {
  assert.equal(casa(comFaq('Aceitam vale transporte?'), 'Tem valet?'), false);
  assert.equal(casa(comFaq('Aceitam vale-transporte?'), 'Tem valet?'), false);
});

test('FAQ: assunto sem fonte só é coberto por palavra inteira na pergunta frequente ("wifimax" não é wi-fi)', () => {
  const estacionamento = comFaq('Tem estacionamento?', 'Temos wifimax.');
  assert.equal(semFonte(estacionamento, 'Tem wi-fi e estacionamento?'), true);
  assert.equal(semFonte(estacionamento, 'Tem wifi?'), true);
  // Plural e grafias reconhecidas continuam cobrindo.
  assert.equal(semFonte(comFaq('Tem elevadores?', 'Sim, dois.'), 'tem elevador?'), false);
  assert.equal(semFonte(comFaq('Tem wifi?', 'Sim.'), 'Tem wi fi?'), false);
  // Assunto dentro de outra palavra da resposta não cobre.
  assert.equal(semFonte(comFaq('Tem estacionamento?', 'Temos manobristasx.'), 'Tem manobrista?'), true);
});
