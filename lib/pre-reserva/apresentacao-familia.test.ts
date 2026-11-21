import assert from 'node:assert/strict';
import test from 'node:test';
import {
  avaliarOferta, destinoDoAceiteConfere, montarPixDoAceite, apresentarSituacao, retratoDoRecebedor,
  type AceiteDoPedido, type SituacaoDoSinal,
} from './apresentacao-familia.ts';
import { crc16 } from '../pagamentos/pix/brcode.ts';
import { POLITICA_PRE_RESERVA } from './politica.ts';
import { TERMOS_PRE_RESERVA, TEXTO_CONFERENCIA_PIX, VERSAO_TERMOS_PRE_RESERVA } from './termos.ts';

const recebedor = { nome: 'Buffet Teste', cidade: 'Sao Paulo', chave: 'pix@example.test' };
const base = {
  status: 'AGUARDANDO_CONTRATO', temGarantia: false, habilitada: true, orcamentoOnline: true, escritaPermitida: true, recebedor,
  sinalConfigurado: 10000, precoCentavos: 6000, agora: new Date('2026-11-21T12:00:00Z'), inicioEvento: '2026-11-22T12:00:00Z',
};

test('oferta exige pedido elegível, piloto, orçamento online, Pix, piso, 24 horas e ausência de garantia anterior', () => {
  assert.deepEqual(avaliarOferta(base), { motivo: null, sinalCentavos: 6000, recebedor });
  for (const [dados, motivo] of [
    [{ status: 'RECUSADO' }, 'PEDIDO_INELEGIVEL'],
    [{ temGarantia: true }, 'GARANTIA_EXISTENTE'],
    [{ habilitada: false }, 'PILOTO_DESLIGADO'],
    [{ orcamentoOnline: false }, 'ORCAMENTO_ONLINE_INDISPONIVEL'],
    [{ escritaPermitida: false }, 'ACESSO_COMERCIAL_RESTRITO'],
    [{ recebedor: null }, 'PRE_RESERVA_SEM_PIX'],
    [{ precoCentavos: 999 }, 'SINAL_INDISPONIVEL'],
    [{ sinalConfigurado: 50001 }, 'SINAL_INDISPONIVEL'],
    [{ inicioEvento: '2026-11-22T11:59:59.999Z' }, 'MENOS_DE_24_HORAS'],
    [{ inicioEvento: '' }, 'HORARIO_INDISPONIVEL'],
  ] as const) assert.deepEqual(avaliarOferta({ ...base, ...dados }), { motivo });
});

test('termos versionados descrevem o sinal opcional e a política vigente', () => {
  assert.ok(VERSAO_TERMOS_PRE_RESERVA);
  assert.equal(TEXTO_CONFERENCIA_PIX, 'A equipe confere o Pix no horário de atendimento, e o horário só fica garantido depois da conferência.');
  for (const trecho of [TEXTO_CONFERENCIA_PIX, 'opcional', 'valor do sinal mostrado na oferta', 'outras pessoas podem reservar',
    POLITICA_PRE_RESERVA.validadeHoras + ' horas ou até o início da festa', 'menos de 24 horas', 'Pix é devolvido por inteiro',
    'crédito', 'desistir da garantia', 'vencer antes de formalizar', POLITICA_PRE_RESERVA.prazoDevolucao])
    assert.ok(TERMOS_PRE_RESERVA.includes(trecho), trecho);
});

const aceite: AceiteDoPedido = {
  sequencia: 1, sinalCentavos: 6000, precoCentavos: '6000', estabelecimentoId: null, salaoId: null,
  inicioEvento: base.inicioEvento, fimEvento: '2026-11-22T14:00:00Z', aceitoEm: base.agora,
  recebedor: retratoDoRecebedor(recebedor), chave: recebedor.chave,
  termosVersao: VERSAO_TERMOS_PRE_RESERVA, termosAceitos: TERMOS_PRE_RESERVA,
};

test('Pix do aceite usa retrato, valor e identificação próprios; chave só no BR Code e na sua representação em QR', () => {
  const p = montarPixDoAceite('01234567-89ab-4cde-8f01-23456789abcd', aceite);
  assert.ok(p);
  assert.deepEqual(Object.keys(p), ['copiaECola', 'qrSvg', 'valorCentavos']);
  assert.equal(p.valorCentavos, 6000);
  assert.match(p.copiaECola, /pix@example\.test.*540560\.00.*5912Buffet Teste6009Sao Paulo/);
  assert.equal(p.copiaECola.slice(-4), crc16(p.copiaECola.slice(0, -4)));
  assert.match(p.qrSvg, /^<svg\b/);
  assert.equal(montarPixDoAceite('pedido', { ...aceite, recebedor: 'Retrato antigo' }), null);
});

test('apresentação separa conferência, garantia e dinheiro e seleciona os campos públicos', () => {
  const pendente = apresentarSituacao(base.status, aceite, []);
  assert.equal(pendente.aguardandoConferencia, true);
  assert.equal(pendente.mensagemConferencia, TEXTO_CONFERENCIA_PIX);
  assert.equal(pendente.garantia, null);
  assert.deepEqual(pendente.aceite?.recebedor, { nome: recebedor.nome, cidade: recebedor.cidade });
  const sinais = ['A_DEVOLVER', 'EM_DEVOLUCAO', 'DEVOLVIDO', 'CREDITO_CONTRATO'].map((dinheiro, i): SituacaoDoSinal => ({
    garantia: i === 3 ? 'FORMALIZACAO' : 'SEM_GARANTIA', garantiaAte: i === 3 ? base.agora : null,
    dinheiro, valorCentavos: '6000', devolverDesde: i === 3 ? null : base.agora, aceiteSequencia: 1, motivoSemGarantia: null,
  }));
  const atual = apresentarSituacao('CONFIRMADO', aceite, sinais);
  assert.deepEqual(apresentarSituacao(base.status, aceite, sinais.slice(0, 1)).garantia, { situacao: 'SEM_GARANTIA', ate: null });
  assert.equal(atual.aguardandoConferencia, false);
  assert.deepEqual(atual.garantia, { situacao: 'FORMALIZACAO', ate: base.agora });
  assert.deepEqual(atual.dinheiro.map(s => s.situacao), sinais.map(s => s.dinheiro));
  assert.doesNotMatch(JSON.stringify(atual), /chave|pix@example|endToEnd|devolvidoPor/i);
});

test('mudança de destino deixa de apresentar o aceite como pendente, preservando a devolução', () => {
  assert.ok(destinoDoAceiteConfere(aceite, aceite, false));
  for (const destino of [
    { inicioEvento: '2026-11-23T12:00:00Z' }, { fimEvento: '2026-11-22T15:00:00Z' }, { estabelecimentoId: 'outra-unidade' },
  ]) assert.equal(destinoDoAceiteConfere({ ...aceite, ...destino }, aceite, false), false);
  const aceitePorSalao = { ...aceite, salaoId: 'salao-1' };
  assert.ok(destinoDoAceiteConfere(aceite, aceitePorSalao, true));
  assert.equal(destinoDoAceiteConfere({ ...aceite, salaoId: 'salao-2' }, aceitePorSalao, true), false);
  assert.equal(destinoDoAceiteConfere(aceite, aceitePorSalao, false), false);

  const divergente: SituacaoDoSinal = {
    garantia: 'SEM_GARANTIA', garantiaAte: null, dinheiro: 'A_DEVOLVER', devolverDesde: base.agora,
    valorCentavos: '5000', aceiteSequencia: aceite.sequencia, motivoSemGarantia: 'VALOR_DIVERGENTE',
  };
  assert.equal(apresentarSituacao(base.status, aceite, [divergente]).aguardandoConferencia, true);
  const mudanca = apresentarSituacao(base.status, aceite, [divergente], true);
  assert.equal(mudanca.aceite, null);
  assert.equal(mudanca.novoAceiteNecessario, true);
  assert.equal(mudanca.aguardandoConferencia, false);
  assert.equal(mudanca.dinheiro[0].valorCentavos, 5000);
});
