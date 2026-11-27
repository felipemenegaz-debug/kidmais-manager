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
  // Papel sem apresentação continua válido.
  for (const t of ['O pai do aniversariante paga?', 'A mãe da criança pode ficar no salão?', 'Tem wi-fi no salão?', 'Vocês fazem festa para menino e menina?']) assert.equal(perguntaComDadoPessoal(t), false, t);
});

test('sem fonte: gatilho de apresentação omite a mensagem inteira, também com marcador ou sobrenome (Astra r2, P1)', () => {
  // Sem exceção para o marcador: "[ana silva]" não é marcador e o fim do nome é ambíguo ("[nome omitido] silva").
  const casos = ['Me chamo [nome omitido], tem wifi?', 'me chamo [ana silva], tem wifi?', 'me chamo [nome omitido] silva, tem wifi?',
    trechoParaRegistro('me chamo Ana silva, tem wifi?'), 'meu filho se chama pedro silva, tem wifi?', 'minha filha se chama ana', 'Meu filho Pedro faz 5 anos, tem wifi?',
    'o aniversariante é o joão, tem wifi?', 'chamo ana, tem fraldário?', 'ele se chama pedro, tem wifi?', 'O nome da minha filha é Bia, tem wifi?'];
  for (const t of casos) {
    assert.equal(perguntaSugerida(t), null, t);
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
  const r = agruparSemFonte(casos.map((ultimaMensagem) => ({ ultimaMensagem, em: '2027-01-19T10:00:00.000Z' })), []);
  assert.deepEqual([r.grupos.length, r.omitidasSensiveis], [0, casos.length]);
});

test('sem fonte: dado sensível com espaço duplo, quebra de linha ou pontuação no meio (Astra r2, P1)', () => {
  const casos = ['Meu filho tem pressão  alta, tem wifi?', 'Tem lugar para quem tem pressão\nalta?', 'pressão\t alta: tem cadeira?', 'cardápio sem   glúten?'];
  for (const t of casos) {
    assert.equal(perguntaSugerida(t), null, t);
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
  const r = agruparSemFonte(casos.map((ultimaMensagem) => ({ ultimaMensagem, em: '2027-01-19T10:00:00.000Z' })), []);
  assert.deepEqual([r.grupos.length, r.omitidasSensiveis], [0, casos.length]);
});

test('sem fonte: o corte por palavra nunca parte um marcador (Astra r2, P3)', () => {
  assert.equal(perguntaSugerida(`${'a'.repeat(220)} [telefone omitido],${'b'.repeat(40)}`), 'a'.repeat(220));
  assert.equal(perguntaSugerida(`${'a'.repeat(200)} tem [telefone omitido] e ${'b'.repeat(60)}`), `${'a'.repeat(200)} tem [telefone omitido] e`);
});

test('sem fonte: apresentação em minúsculas fica fora da lista e entra na contagem', () => {
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
  const g = { id: 'g1', texto: 'Tem wi-fi?' };
  // Desenho novo: a resposta criada pela lista começa VAZIA e ligada ao grupo → rascunho, nunca "já tem resposta".
  assert.equal(estadoDoGrupo(g, [], [{ id: 'f1', pergunta: '' }], { f1: 'g1' }), 'rascunho');
  assert.equal(estadoDoGrupo(g, [], [{ id: 'f1', pergunta: 'Vocês têm internet sem fio?' }], { f1: 'g1' }), 'rascunho');
  // Salva com o mesmo id e o mesmo texto (que a pessoa escreveu) → publicada; texto alterado depois de salvar → rascunho.
  assert.equal(estadoDoGrupo(g, [{ id: 'f1', pergunta: 'Vocês têm internet sem fio?' }], [{ id: 'f1', pergunta: 'Vocês têm internet sem fio?' }], { f1: 'g1' }), 'publicada');
  assert.equal(estadoDoGrupo(g, [{ id: 'f1', pergunta: 'Vocês têm internet sem fio?' }], [{ id: 'f1', pergunta: 'Tem internet?' }], { f1: 'g1' }), 'rascunho');
  // Sem vínculo (tela recarregada): pergunta salva com o mesmo texto do grupo.
  assert.equal(estadoDoGrupo(g, [{ id: 'f2', pergunta: 'tem wi fi' }], [{ id: 'f2', pergunta: 'tem wi fi' }]), 'publicada');
  assert.equal(estadoDoGrupo(g, [], [{ id: 'f2', pergunta: 'Tem wi-fi?' }]), 'rascunho');
  // Removida do formulário (e depois salva): volta o botão.
  assert.equal(estadoDoGrupo(g, [{ id: 'f1', pergunta: 'Vocês têm internet sem fio?' }], [], { f1: 'g1' }), 'criar');
  assert.equal(estadoDoGrupo(g, [], []), 'criar');
});

test('sem fonte: achados do Astra r3 que o desenho novo ainda fecha na regra (P1 saúde/parentes, P2 "sou obrigado", P3 marcador)', () => {
  for (const t of ['Tem cadeira para pressão[alta]?', 'Minha irmã ana silva quer saber se tem wifi?', 'meu pai pode entrar?']) {
    assert.equal(perguntaSugerida(t), null, t);
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
  for (const t of ['Sou obrigado a levar o bolo?', 'O aniversariante paga?']) {
    assert.equal(perguntaSugerida(t), t, t);
    assert.equal(perguntaComDadoPessoal(t), false, t);
  }
  // Marcador já partido pelo limite de 500 do registro: o texto curto não termina com "[telefone".
  const registrado = trechoParaRegistro(`Tem wifi?${' '.repeat(481)}3456-7890`);
  assert.equal(perguntaSugerida(registrado), 'Tem wifi?');
});

test('sem fonte: achados do Astra r4', () => {
  // P2: "chamar" sem sujeito pessoal é pergunta geral: aparece na lista e o salvar aceita.
  for (const t of ['Como chamo a equipe durante a festa?', 'Como se chama o salão?', 'Qual salão se chama Jardim?', 'Ela chama o garçom ou eu peço no balcão?']) {
    assert.equal(perguntaSugerida(t), t, t);
    assert.equal(perguntaComDadoPessoal(t), false, t);
  }
  // A apresentação continua omitida: "me chamo", "ele/ela se chama", parente "se chama", "chamo"/"chama-se" abrindo a mensagem.
  for (const t of ['me chamo ana silva, tem wifi?', 'meu filho se chama pedro', 'Ela se chama Bia, tem wifi?', 'Oi, chamo ana, tem fraldário?', 'Chama-se Pedro o aniversariante, tem wifi?', 'Bom dia! Eu chamo Carla, tem wifi?']) {
    assert.equal(perguntaSugerida(t), null, t);
    assert.equal(perguntaComDadoPessoal(t), true, t);
  }
  // P3: o selo compara como o schema do salvar (espaços das pontas tirados).
  const g = { id: 'g1', texto: 'Tem fraldário?' };
  assert.equal(estadoDoGrupo(g, [{ id: 'faq_1', pergunta: 'Tem fraldário?' }], [{ id: 'faq_1', pergunta: 'Tem fraldário? ' }], { faq_1: 'g1' }), 'publicada');
  assert.equal(estadoDoGrupo(g, [{ id: 'faq_1', pergunta: 'Tem fraldário?' }], [{ id: 'faq_1', pergunta: 'Tem fraldário? Sim' }], { faq_1: 'g1' }), 'rascunho');
  // P3: hash de 32 bits coincidente não junta dois grupos; o sufixo segue a ordem das chaves, não a frequência.
  const a = 'Tem lugar para 219 crianças no almoço?', b = 'Posso reservar para 17 professores à noite?';
  const r1 = agruparSemFonte([{ ultimaMensagem: a, em: '2027-01-19T10:00:00.000Z' }, { ultimaMensagem: b, em: '2027-01-19T09:00:00.000Z' }], []);
  const r2 = agruparSemFonte([{ ultimaMensagem: b, em: '2027-01-19T10:00:00.000Z' }, { ultimaMensagem: b, em: '2027-01-19T09:00:00.000Z' }, { ultimaMensagem: a, em: '2027-01-19T08:00:00.000Z' }], []);
  const ids = (r: typeof r1) => Object.fromEntries(r.grupos.map((x) => [x.texto, x.id]));
  assert.equal(new Set(r1.grupos.map((x) => x.id)).size, 2);
  assert.deepEqual(ids(r1), ids(r2));
  assert.equal(agruparSemFonte([{ ultimaMensagem: a, em: '2027-01-19T10:00:00.000Z' }], []).grupos[0].id.length, 8, 'sem colisão o id fica igual');
  // Segundo grupo mantém o botão quando o primeiro ganha resposta.
  const [ga, gb] = r1.grupos;
  assert.equal(estadoDoGrupo(gb, [], [{ id: 'faq_a', pergunta: '' }], { faq_a: ga.id }), 'criar');
});
