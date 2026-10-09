import assert from 'node:assert/strict';
import test from 'node:test';
import { comandoSchema, conteudoSchema, disponiveis, inicioConteudo, rascunhoSchema, respostaSchema, validarCredito } from './domain.ts';
const saldo = { empresa: 60, empresaUsado: 0, festa: 3, festaUsado: 0, cliente: 2, clienteUsado: 0 };
test('cliente nunca recebe a carteira inteira: prevalece a menor cota', () => {
  assert.equal(disponiveis(saldo, true), 2); assert.equal(disponiveis(saldo, false), 3);
  assert.equal(disponiveis({ ...saldo, empresaUsado: 59 }, true), 1);
  assert.equal(disponiveis({ ...saldo, festaUsado: 2 }, true), 1);
});
test('limite do cliente não impede buffet de usar o saldo restante da festa', () => {
  const c = { ...saldo, clienteUsado: 2, festaUsado: 2 };
  assert.throws(() => validarCredito(c, true), /Seu limite/);
  assert.doesNotThrow(() => validarCredito(c, false));
});
test('festa e empresa esgotadas bloqueiam ambos os atores, inclusive cotas reduzidas', () => {
  for (const c of [{ ...saldo, festaUsado: 3 }, { ...saldo, empresaUsado: 60 }, { ...saldo, empresa: 0, empresaUsado: 8 }]) {
    for (const cliente of [true, false]) { assert.equal(disponiveis(c, cliente), 0); assert.throws(() => validarCredito(c, cliente)); }
  }
});
test('cotas inválidas falham fechadas', () => {
  for (const n of [-1, NaN, Infinity, 0.5]) assert.throws(() => validarCredito({ ...saldo, empresa: n }, true));
});
test('rascunho pode estar incompleto; publicação exige dados e datas reais', () => {
  const c = inicioConteudo({ aniversariante: { nome: 'Ana', idadeNoEvento: 5 }, evento: { data: '2026-12-20', horarioInicio: '18:00:00' }, contratante: { cpf: 'DADO_NAO_PUBLICO' } });
  assert.equal(rascunhoSchema.safeParse(c).success, true);
  assert.equal(conteudoSchema.safeParse(c).success, false);
  assert.equal(JSON.stringify(c).includes('DADO_NAO_PUBLICO'), false);
  const valido = { ...c, local: 'Buffet', endereco: 'Rua Exemplo, 10' };
  assert.equal(conteudoSchema.safeParse(valido).success, true);
  assert.equal(conteudoSchema.safeParse({ ...valido, data: '2026-02-30' }).success, false);
  assert.equal(conteudoSchema.safeParse({ ...valido, horario: '25:00' }).success, false);
});
test('cliente não escolhe custo, modelo, empresa nem envia referência remota', () => {
  const gerar = { acao: 'gerar', chave: '11111111-1111-4111-8111-111111111111', prompt: 'Festa no jardim', referencias: [] };
  assert.equal(comandoSchema.safeParse(gerar).success, true);
  for (const extra of [{ empresaId: 'outra' }, { custo: 0 }, { modelo: 'caro' }]) assert.equal(comandoSchema.safeParse({ ...gerar, ...extra }).success, false);
  assert.equal(comandoSchema.safeParse({ ...gerar, referencias: ['https://intranet/segredo'] }).success, false);
});
test('presença exige alguém e protege limites de contagem', () => {
  const r = { chave: '11111111-1111-4111-8111-111111111111', nome: 'Família Ana', presenca: true, adultos: 0, criancas: 0 };
  assert.equal(respostaSchema.safeParse(r).success, false);
  assert.equal(respostaSchema.safeParse({ ...r, presenca: false }).success, true);
  assert.equal(respostaSchema.safeParse({ ...r, adultos: 1 }).success, true);
  assert.equal(respostaSchema.safeParse({ ...r, adultos: 200 }).success, false);
});
