import assert from 'node:assert/strict';
import test from 'node:test';
import { REGISTRO_SENSIVEL, ENTRADA_SENSIVEL_OMITIDA, trechoParaRegistro } from './core.ts';
import { LIMITE_PERGUNTA, agrupadorSemFonte, agruparSemFonte, chaveDoGrupo, estadoDoGrupo, perguntaComDadoPessoal, perguntaSugerida } from './sem-fonte-texto.ts';

// Dados sintéticos. Nenhum é de pessoa real.
const TELEFONES = ['11987654321', '(11) 98765-4321', '+55 11 98765 4321', '98765-4321', '3456-7890'];
const EMAILS = ['fulana.teste@exemplo.com.br', 'contato arroba exemplo ponto com'];
const CPFS = ['123.456.789-09', '12345678909', '123 456 789 09'];
const SO_DIGITOS = (t: string) => t.replace(/\D/g, '');

test('sem fonte: o texto pré-preenchido nunca mostra telefone, e-mail ou CPF (com e sem a máscara gravada)', () => {
  for (const tel of TELEFONES) for (const email of EMAILS) for (const cpf of CPFS) {
    const bruto = `Vocês têm wi-fi no salão? Meu zap é ${tel}, e-mail ${email} e CPF ${cpf}`;
    // A passagem grava trechoParaRegistro; a sugestão também precisa aguentar texto bruto (nunca confia no gravado).
    for (const origem of [bruto, trechoParaRegistro(bruto)]) {
      const s = perguntaSugerida(origem);
      assert.ok(s, `sugestão para: ${origem}`);
      assert.ok(!SO_DIGITOS(s).includes(SO_DIGITOS(tel).slice(-8)), `telefone visível: ${s}`);
      assert.ok(!SO_DIGITOS(s).includes(SO_DIGITOS(cpf)), `CPF visível: ${s}`);
      assert.ok(!/@|arroba/i.test(s), `e-mail visível: ${s}`);
      assert.ok(!s.toLowerCase().includes('fulana'), `e-mail visível: ${s}`);
      assert.match(s, /^Vocês têm wi-fi no salão\?/);
      // O texto com marcador precisa ser reescrito antes de salvar (o servidor recusa).
      assert.equal(perguntaComDadoPessoal(s), true);
    }
  }
});

test('sem fonte: mensagem com dado sensível não vira sugestão (nem o marcador gravado)', () => {
  for (const t of ['Meu filho tem alergia a amendoim, tem opção?', 'Tem cardápio sem glúten para celíaco?', REGISTRO_SENSIVEL, ENTRADA_SENSIVEL_OMITIDA, trechoParaRegistro('Ela é autista, tem sala calma?'), '', '  ', null, undefined, 'ok']) {
    assert.equal(perguntaSugerida(t), null, String(t));
  }
});

test('sem fonte: uma linha, até 250 caracteres, corte em palavra e máscara depois do corte', () => {
  const longo = `Vocês ${'emprestam mesas extras '.repeat(20)}para o pátio?`;
  const s = perguntaSugerida(longo)!;
  assert.ok(s.length <= LIMITE_PERGUNTA);
  assert.ok(!s.endsWith(' '));
  assert.ok(/(?:extras|mesas|emprestam)$/.test(s), s);
  assert.equal(perguntaSugerida('Tem\n\n  estacionamento\tcoberto?'), 'Tem estacionamento coberto?');
  // Um telefone no limite do corte não pode sobrar pela metade.
  const naBorda = `${'a'.repeat(236)} 11987654321 fim`;
  assert.ok(!/\d{4}/.test(perguntaSugerida(naBorda)!), perguntaSugerida(naBorda)!);
  // Astra r1 (P3): o marcador é indivisível; o corte recua para antes do colchete (nunca termina em "[telefone").
  assert.equal(perguntaSugerida(`${'a'.repeat(236)} [telefone omitido] fim`), 'a'.repeat(236));
  assert.equal(perguntaSugerida(`${'a'.repeat(236)} 11987654321 fim`), 'a'.repeat(236));
  assert.equal(perguntaSugerida(`${'a b '.repeat(60)}[e-mail omitido] fim`), 'a b '.repeat(60).trim());
});

test('sem fonte: validação do texto publicado (Onda 2)', () => {
  assert.equal(perguntaComDadoPessoal('Vocês têm wi-fi no salão?'), false);
  assert.equal(perguntaComDadoPessoal('Tem estacionamento para 20 carros?'), false);
  assert.equal(perguntaComDadoPessoal('A festa pode ir até as 23h?'), false);
  assert.equal(perguntaComDadoPessoal('Tem wi-fi? [telefone omitido]'), true);
  assert.equal(perguntaComDadoPessoal('Tem wi-fi? [nome omitido]'), true);
  assert.equal(perguntaComDadoPessoal('Tem wi-fi? me liga 11987654321'), true);
  assert.equal(perguntaComDadoPessoal('Meu e-mail é a@b.com, tem wi-fi?'), true);
  assert.equal(perguntaComDadoPessoal('CPF 123.456.789-09 tem wi-fi?'), true);
  assert.equal(perguntaComDadoPessoal('Tem wi-fi?​ 1198765​4321'), true);
});

test('sem fonte: agrupamento por texto normalizado, publicadas por último, sensíveis só contados', () => {
  const r = agruparSemFonte([
    { ultimaMensagem: 'Vocês têm WI-FI?', em: '2027-01-19T10:00:00.000Z' },
    { ultimaMensagem: 'voces tem wi fi', em: '2027-01-18T10:00:00.000Z' },
    { ultimaMensagem: 'Tem estacionamento?', em: '2027-01-17T10:00:00.000Z' },
    { ultimaMensagem: 'Pode levar pula-pula?', em: '2027-01-16T10:00:00.000Z' },
    { ultimaMensagem: REGISTRO_SENSIVEL, em: '2027-01-15T10:00:00.000Z' },
    { ultimaMensagem: 'Tem opção sem lactose?', em: '2027-01-15T09:00:00.000Z' },
    { ultimaMensagem: 42, em: '2027-01-14T10:00:00.000Z' },
  ], ['Tem estacionamento?']);
  // Astra r1 (P3): só o que tem dado sensível (o marcador e a lactose) é contado; o número 42 é descarte, não sensível.
  assert.equal(r.omitidasSensiveis, 2);
  assert.deepEqual(r.grupos.map((g) => [g.texto, g.ocorrencias, g.jaPublicada]), [
    ['Vocês têm WI-FI?', 2, false], ['Pode levar pula-pula?', 1, false], ['Tem estacionamento?', 1, true],
  ]);
  assert.equal(r.grupos[0].ultimaEm, '2027-01-19T10:00:00.000Z');
  assert.match(r.grupos[0].id, /^[0-9a-f]{8}$/);
  assert.notEqual(r.grupos[0].id, r.grupos[1].id);
  assert.equal(chaveDoGrupo('  Vocês   têm, WI-FI?! '), 'voces tem wi fi');
  assert.equal(agruparSemFonte(Array.from({ length: 30 }, (_, i) => ({ ultimaMensagem: `Pergunta número ${i}?`, em: '2027-01-01T00:00:00.000Z' })), [], 20).grupos.length, 20);
});

test('sem fonte: apresentação com nome em qualquer caixa não vira sugestão e é recusada no salvar (Astra r1, P1)', () => {
  for (const t of ['me chamo ana silva, tem wifi?', 'Oi, meu nome é joão pedro. Tem fraldário?', 'sou a mãe do pedro, tem estacionamento?', 'aqui é o carlos, tem wi-fi?', 'Sou pai da maria, pode levar bolo?', 'o nome dela é bia, tem pula-pula?']) {
    assert.equal(perguntaSugerida(t), null, t);
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
  // Papel sem apresentação continua válido; o marcador logo depois do gatilho já está mascarado (só pede revisão).
  for (const t of ['O pai do aniversariante paga?', 'A mãe da criança pode ficar no salão?', 'Tem wi-fi no salão?']) assert.equal(perguntaComDadoPessoal(t), false, t);
  assert.equal(perguntaSugerida('Me chamo [nome omitido], tem wifi?'), 'Me chamo [nome omitido], tem wifi?');
  const r = agruparSemFonte([{ ultimaMensagem: 'me chamo ana silva, tem wifi?', em: '2027-01-19T10:00:00.000Z' }], []);
  assert.deepEqual([r.grupos.length, r.omitidasSensiveis], [0, 1]);
});

test('sem fonte: dado sensível e marcadores sensíveis são recusados no texto publicado (Astra r1, P1)', () => {
  for (const t of ['Meu filho tem diabetes, tem wifi?', 'Tem cardápio sem glúten?', 'Vocês recebem criança autista?', REGISTRO_SENSIVEL, ENTRADA_SENSIVEL_OMITIDA, `Tem wi-fi? ${REGISTRO_SENSIVEL}`]) {
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
});

test('sem fonte: a janela inteira é agrupada em lotes antes do limite de grupos (Astra r1, P2)', () => {
  const a = agrupadorSemFonte([], 2);
  const lote = (n: number, texto: string, dia: number) => Array.from({ length: n }, (_, i) => ({ ultimaMensagem: texto, em: `2027-01-${String(dia).padStart(2, '0')}T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }));
  a.adicionar(lote(500, 'Tem fraldário?', 19));
  a.adicionar([...lote(1, 'Tem fraldário?', 18), ...lote(3, 'Tem pula-pula?', 2), ...lote(2, REGISTRO_SENSIVEL, 1)]);
  a.adicionar(lote(2, 'Tem cama elástica?', 1));
  const r = a.resultado();
  assert.deepEqual(r.grupos.map((g) => [g.texto, g.ocorrencias]), [['Tem fraldário?', 501], ['Tem pula-pula?', 3]]);
  assert.equal(r.omitidasSensiveis, 2);
});

test('sem fonte: selo distingue rascunho no formulário de resposta publicada e acompanha o salvar (Astra r1, P3)', () => {
  // Logo depois de "Criar resposta": só no formulário → rascunho, nunca "já tem resposta".
  assert.equal(estadoDoGrupo('Tem wi-fi?', [], ['Tem wi-fi?']), 'rascunho');
  assert.equal(estadoDoGrupo('Tem wi-fi?', ['tem wi fi'], ['Tem wi-fi?']), 'publicada');
  // Removida do formulário (e depois salva): volta o botão.
  assert.equal(estadoDoGrupo('Tem wi-fi?', ['Tem wi-fi?'], []), 'criar');
  assert.equal(estadoDoGrupo('Tem wi-fi?', [], []), 'criar');
});
