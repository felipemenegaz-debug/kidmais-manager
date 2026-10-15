import assert from 'node:assert/strict';
import test from 'node:test';
import { ENTRADA_SENSIVEL_OMITIDA, REGISTRO_SENSIVEL, dadoSensivel, entradaFaseB, normalizarParaPrivacidade, ocultarDadosPessoais, textoDoModeloSeguro, trechoParaRegistro } from './core.ts';

/**
 * D1/D4/B1/B2 (rodada de correção de 12/10/2026). Frases da revisão independente de 8b2c55d (A1): as que a regra de
 * alergia do Wall-e reconhecia e a guarda anterior deixava ir ao modelo; contorno por caracteres invisíveis e largura
 * total; histórico; campos derivados; texto devolvido pelo modelo. Não é prova de cobertura completa (ver
 * privacidade-cobertura.test.ts, medida contra um corpus independente).
 */
test('A1: frases que a regra de alergia do Wall-e reconhece também bloqueiam o modelo', () => {
  for (const f of ['lá em casa ninguém come nada com amendoim', 'meu filho não pode comer ovo', 'tem opção sem leite? ele não toma leite de vaca', 'ela tem restrição alimentar',
    'tem salgado sem castanha?', 'ele é vegano, tem opção?', 'pode garantir que não tem traço de nozes?', 'ele toma insulina', 'ele é intolerante', 'não pode frutos do mar',
    'a pediatra proibiu leite', 'contaminação cruzada me preocupa', 'ela usa cadeira de rodas', 'só comemos kosher', 'ele faz quimioterapia'])
    assert.equal(dadoSensivel(f), true, f);
});
test('A1: normalização antes da análise — invisíveis e largura total não contornam a guarda nem a máscara', () => {
  assert.equal(dadoSensivel('meu filho tem alerg\u200Bia a ovo'), true, 'zero-width');
  assert.equal(dadoSensivel('ele tem ａｌｅｒｇｉａ'), true, 'largura total');
  assert.equal(dadoSensivel('ele tem aler\u00ADgia'), true, 'hífen invisível');
  assert.equal(normalizarParaPrivacidade('ａ\u200Bb\u2060c'), 'abc');
  assert.equal(ocultarDadosPessoais('cpf １２３.４５６.７８９-０９').includes('123'), false, 'dígitos de largura total viram dígitos e saem');
  assert.equal(ocultarDadosPessoais('cpf 123\u200B.456.789-09').includes('456'), false, 'invisível no meio do CPF');
});
// Falso positivo conhecido, herdado da regra de alergia do Wall-e: "vcs servem salgado de camarão?" (vai só às regras).
test('nada sensível nas frases comuns de festa (amostra; os falsos positivos ficam medidos no corpus)', () => {
  for (const f of ['quanto custa para 80 pessoas?', 'festa dia 14/11/2027', 'tem tema Frozen?', 'qual o endereço?', 'tea party', 'ele não gosta de brigadeiro'])
    assert.equal(dadoSensivel(f), false, f);
});
test('D4: entrada do histórico com dado sensível vira marcador; a atual também', () => {
  const corpo = JSON.parse(entradaFaseB(['oi', 'ele não pode comer ovo', 'meu cel 99999-0000'], 'a pediatra cortou o leite', null));
  assert.deepEqual(corpo.mensagens, ['oi', ENTRADA_SENSIVEL_OMITIDA, 'meu cel [telefone omitido]']);
  assert.equal(corpo.mensagemAtual, ENTRADA_SENSIVEL_OMITIDA);
});
test('B1: campo derivado (passagem.ultimaMensagem) nunca guarda cópia de dado sensível', () => {
  assert.equal(trechoParaRegistro('meu filho tem alergia a amendoim, o bolo tem?'), REGISTRO_SENSIVEL);
  assert.equal(trechoParaRegistro('ele não pode comer ovo'), REGISTRO_SENSIVEL);
  assert.equal(trechoParaRegistro('quero falar com alguém, meu cel 99999-0000'), 'quero falar com alguém, meu cel [telefone omitido]');
});
test('B2: texto devolvido pelo modelo (tema) só passa se não for sensível nem carregar marcador; nomes extras mascarados', () => {
  assert.equal(textoDoModeloSeguro('Frozen'), 'Frozen');
  assert.equal(textoDoModeloSeguro('alergia a ovo'), null);
  assert.equal(textoDoModeloSeguro('[nome omitido]'), null);
  assert.equal(textoDoModeloSeguro(null), null);
  for (const [f, nome] of [['sou Ana Souza', 'Ana'], ['chamo Ana', 'Ana'], ['o nome dele é Pedro', 'Pedro'], ['oi, aqui é a Ana, mãe do Pedro', 'Pedro']] as const)
    assert.equal(ocultarDadosPessoais(f).includes(nome), false, f);
  // Limite conhecido e registrado: nome solto ou em minúsculas não é reconhecível por regra.
  for (const f of ['festa da Ana dia 14', 'Pedro faz 5 anos', 'meu filho pedro faz 5']) assert.equal(ocultarDadosPessoais(f), f, `limite: ${f}`);
});
