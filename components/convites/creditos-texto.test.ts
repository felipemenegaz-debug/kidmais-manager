import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avisoSemGeracao, comUnidade, creditosDisponiveisDaEmpresa, geracaoDoConviteEmCurso, textoReserva } from './creditos-texto.ts';

const servico = readFileSync(new URL('../../lib/convites/service.ts', import.meta.url), 'utf8');
const motor = (disponivel: number, reservado = 0, consumoAtivo = true) => ({ motor: 'CREDITOS' as const, disponivel, reservado, consumoAtivo });
const aviso = (disponiveis: number, creditos: Parameters<typeof avisoSemGeracao>[0]['creditos'], extra = {}) => avisoSemGeracao({ disponiveis, creditos, ...extra });

test('unidade concorda com a quantidade', () => {
  assert.equal(comUnidade(1, 'crédito', 'créditos'), 'crédito');
  assert.equal(comUnidade(0, 'crédito', 'créditos'), 'créditos');
  assert.equal(comUnidade(9, 'crédito', 'créditos'), 'créditos');
});

test('o valor da empresa é dito como disponível, nunca como total', () => {
  assert.equal(creditosDisponiveisDaEmpresa(1), 'crédito disponível da empresa');
  assert.equal(creditosDisponiveisDaEmpresa(0), 'créditos disponíveis da empresa');
  assert.equal(creditosDisponiveisDaEmpresa(9), 'créditos disponíveis da empresa');
});

test('reserva concorda com a quantidade e some quando não há', () => {
  assert.equal(textoReserva(0), '');
  assert.equal(textoReserva(1), ' (1 reservado em geração)');
  assert.equal(textoReserva(2), ' (2 reservados em geração)');
});

test('sem aviso enquanto ainda há geração disponível, mesmo em manutenção', () => {
  assert.equal(aviso(1, motor(9)), null);
  assert.equal(aviso(1, motor(9, 0, false)), null);
});

test('limite do convite com crédito disponível: a gestão ajusta, sem ordem a quem não pode', () => {
  const texto = aviso(0, motor(7)) ?? '';
  assert.match(texto, /limite de gerações/);
  assert.match(texto, /A gestão da conta pode aumentar/);
  assert.match(texto, /Edição pelo cliente/);
  assert.match(aviso(0, motor(7), { avulso: true }) ?? '', /Limite deste convite/);
  assert.doesNotMatch(texto, /aumente/);
});

test('saldo todo bloqueado (disponível 0, sem reserva) não afirma que a empresa não tem créditos', () => {
  const texto = aviso(0, motor(0)) ?? '';
  assert.match(texto, /sem créditos disponíveis/);
  assert.doesNotMatch(texto, /sem créditos\b(?! disponíveis)/);
});

test('reserva sem afirmar que explica todo o indisponível: saldo 10, reservado 1, bloqueado 9 chega aqui como disponível 0', () => {
  const texto = aviso(0, motor(10 - 1 - 9, 1)) ?? '';
  assert.equal(texto, 'A empresa não tem créditos disponíveis agora. Há créditos reservados. Veja o saldo em IA e créditos.');
  assert.doesNotMatch(texto, /restante/);
});

test('cada sinal de geração em curso conta sozinho', () => {
  const parado = { busy: false, acompanhando: '', geracaoIncerta: false, geracaoEmAndamento: null };
  assert.equal(geracaoDoConviteEmCurso(parado), false);
  assert.equal(geracaoDoConviteEmCurso({ ...parado, geracaoIncerta: undefined, geracaoEmAndamento: undefined }), false);
  assert.equal(geracaoDoConviteEmCurso({ ...parado, busy: true }), true);
  assert.equal(geracaoDoConviteEmCurso({ ...parado, acompanhando: 'g1' }), true);
  assert.equal(geracaoDoConviteEmCurso({ ...parado, geracaoIncerta: true }), true);
  assert.equal(geracaoDoConviteEmCurso({ ...parado, geracaoEmAndamento: 'g1' }), true);
});

test('o aviso some durante a geração e volta ao encerrar, se continuar sem saldo', () => {
  const durante = geracaoDoConviteEmCurso({ busy: false, acompanhando: 'g1', geracaoEmAndamento: 'g1' });
  assert.equal(aviso(0, motor(0, 1), { geracaoEmCurso: durante }), null);
  const depois = geracaoDoConviteEmCurso({ busy: false, acompanhando: '', geracaoEmAndamento: null });
  assert.match(aviso(0, motor(0), { geracaoEmCurso: depois }) ?? '', /sem créditos disponíveis/);
});

test('manutenção prevalece sobre limite e saldo, com o mesmo texto do servidor', () => {
  const texto = aviso(0, motor(7, 0, false)) ?? '';
  assert.ok(servico.includes(`MENSAGEM_CREDITOS_MANUTENCAO = '${texto}'`));
  assert.equal(aviso(0, motor(0, 0, false)), texto);
});

test('geração deste convite em curso, inclusive incerta, e laboratório local não mostram aviso', () => {
  assert.equal(aviso(0, motor(0, 1), { geracaoEmCurso: true }), null);
  assert.equal(aviso(0, motor(0), { geracaoEmCurso: true }), null);
  assert.equal(aviso(0, motor(0), { laboratorio: true }), null);
});

test('motor legado: limite do convite esgotado aponta onde a gestão ajusta; franquia usada oferece seguir sem IA', () => {
  const limite = aviso(0, { motor: 'LEGADO' }, { cotas: { festa: 6, festaUsado: 6 } }) ?? '';
  assert.match(limite, /limite de gerações/);
  assert.match(limite, /Edição pelo cliente/);
  assert.match(aviso(0, { motor: 'LEGADO' }, { avulso: true, cotas: { festa: 3, festaUsado: 3 } }) ?? '', /Limite deste convite/);
  const franquia = aviso(0, { motor: 'LEGADO' }, { cotas: { festa: 6, festaUsado: 2 } }) ?? '';
  assert.match(franquia, /franquia mensal/);
  assert.match(franquia, /envie uma imagem sua/);
  assert.equal(aviso(0, { motor: 'LEGADO' }), franquia);
});

test('cliente da festa recebe o motivo e a saída, sem saldo nem limites do buffet', () => {
  const texto = aviso(0, null, { cliente: true, cotas: { festa: 6, festaUsado: 6 } }) ?? '';
  assert.equal(texto, 'As gerações com IA deste convite acabaram. Peça mais ao buffet ou envie uma imagem sua.');
  assert.equal(aviso(0, motor(7), { cliente: true }), texto);
  assert.doesNotMatch(texto, /franquia|crédito|limite/);
});

test('com geração disponível ou em curso, legado e cliente continuam sem aviso; buffet sem motor informado também', () => {
  assert.equal(aviso(1, { motor: 'LEGADO' }), null);
  assert.equal(aviso(1, null, { cliente: true }), null);
  assert.equal(aviso(0, { motor: 'LEGADO' }, { geracaoEmCurso: true }), null);
  assert.equal(aviso(0, null, { cliente: true, geracaoEmCurso: true }), null);
  assert.equal(aviso(0, null), null);
  assert.equal(aviso(0, undefined), null);
});
