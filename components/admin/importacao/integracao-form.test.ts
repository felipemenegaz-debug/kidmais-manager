import { cadastroBase } from '../../../lib/contratos/integracao-importados/fixtures.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decisoesSchema, financeiroSchema } from '../../../lib/contratos/integracao-importados/modelo.ts';
import {
  ajustarSalao, camposCorrigidos, centavosDeTexto, conferenciaParcelas, decisoesDoForm, errosFesta, errosPagamentos, financeiroDoFormulario, formInicial, novaParcela, pedeSalao,
  type FormIntegracao, type Sugestao,
} from './integracao-form.ts';

const HOJE = '2026-10-02';
const sugestao: Sugestao = {
  evento: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 },
  valorContratadoCentavos: 850000,
  condicaoDocumento: 'Entrada de 30% e o restante à vista',
  parcelasPrevistas: [{ valorCentavos: 255000, vencimento: '2026-08-01' }, { valorCentavos: 595000, vencimento: null }],
};
const UNIDADE = '22222222-2222-4222-8222-222222222222';
const PACOTE = '33333333-3333-4333-8333-333333333333';

function preenchido(mudar: Partial<FormIntegracao> = {}): FormIntegracao {
  const f = formInicial({ sugestao, estabelecimentos: [{ id: UNIDADE }] });
  return { ...f, cadastro: cadastroBase(), aniversariante: 'Lia', situacaoContrato: 'VIGENTE', pacoteReferenciaId: PACOTE, situacaoFinanceira: 'PARCIALMENTE_PAGO',
    parcelas: [novaParcela({ valor: '2.550,00', vencimento: '2026-08-01', recebida: true, recebidaEm: '2026-08-03', forma: 'PIX' }), novaParcela({ valor: '5.950,00', vencimento: '2026-11-14' })],
    conferenciaDeclarada: true, ...mudar };
}

test('valor em reais digitado vira centavos; formatos ambíguos ou inválidos são recusados', () => {
  assert.equal(centavosDeTexto('8.500,00'), 850000);
  assert.equal(centavosDeTexto('R$ 8.500'), 850000);
  assert.equal(centavosDeTexto('8500,5'), 850050);
  assert.equal(centavosDeTexto('0,01'), 1);
  for (const ruim of ['8500.00', '8,500.00', '', '0', '-10', '1,234', 'abc']) assert.equal(centavosDeTexto(ruim), null, ruim);
});

test('formulário inicial: situações em branco, nenhuma parcela recebida, unidade única pré-selecionada', () => {
  const f = formInicial({ sugestao, estabelecimentos: [{ id: UNIDADE }] });
  assert.equal(f.situacaoContrato, '');
  assert.equal(f.situacaoFinanceira, '');
  assert.equal(f.estabelecimentoId, UNIDADE);
  assert.equal(f.valorContratado, '8.500,00');
  assert.deepEqual(f.parcelas.map((p) => [p.valor, p.vencimento, p.recebida]), [['2.550,00', '2026-08-01', false], ['5.950,00', '', false]]);
  assert.equal(formInicial({ sugestao, estabelecimentos: [{ id: 'a' }, { id: 'b' }] }).estabelecimentoId, '');
});

test('correção de leitura: campo diferente do documento exige motivo; ausente no documento não exige', () => {
  assert.deepEqual(camposCorrigidos(preenchido(), sugestao), []);
  const f = preenchido({ data: '2026-11-15', convidados: '90' });
  assert.deepEqual(camposCorrigidos(f, sugestao), ['data', 'convidados']);
  assert.match(errosFesta(f, sugestao, 1).join(' '), /Explique cada valor diferente do documento/);
  assert.deepEqual(errosFesta({ ...f, motivos: { data: 'Contrato diz dia 15', convidados: 'Aditivo de 10 convidados' } }, sugestao, 1), []);
  const semDoc = { ...sugestao, evento: { ...sugestao.evento, horarioFim: null } };
  assert.deepEqual(camposCorrigidos(preenchido({ horarioFim: '19:00' }), semDoc), []);
});

test('pagamentos: soma, data futura de recebimento e forma obrigatória são conferidos antes de enviar', () => {
  assert.deepEqual(errosPagamentos(preenchido(), sugestao, HOJE), []);
  assert.match(errosPagamentos(preenchido({ parcelas: [novaParcela({ valor: '8.000,00', vencimento: '2026-11-14' })] }), sugestao, HOJE).join(' '), /somam R\$ 8\.000,00; o contratado é R\$ 8\.500,00/);
  const futura = preenchido({ parcelas: [novaParcela({ valor: '8.500,00', vencimento: '2026-11-14', recebida: true, recebidaEm: '2026-10-03', forma: 'PIX' })] });
  assert.match(errosPagamentos(futura, sugestao, HOJE).join(' '), /não pode ser futura/);
  const semForma = preenchido({ parcelas: [novaParcela({ valor: '8.500,00', vencimento: '2026-11-14', recebida: true, recebidaEm: '2026-09-01' })] });
  assert.match(errosPagamentos(semForma, sugestao, HOJE).join(' '), /informe a forma/);
  assert.deepEqual(errosPagamentos(preenchido({ situacaoFinanceira: 'NAO_CONFERIDO', parcelas: [] }), sugestao, HOJE), []);
  const c = conferenciaParcelas(preenchido());
  assert.deepEqual([c.total, c.soma, c.recebido, c.saldo, c.indicada], [850000, 850000, 255000, 595000, 'PARCIALMENTE_PAGO']);
});

test('payload da tela é aceito pelo esquema do servidor e não carrega empresa, usuário nem valores calculados', () => {
  const d = decisoesDoForm(preenchido({ data: '2026-11-15', motivos: { data: 'Contrato diz dia 15', convidados: 'não alterado' } }), sugestao);
  const lido = decisoesSchema.parse(d);
  assert.ok(!('telefone' in d.cadastro), 'telefone fixo não é exibido nem enviado: o valor do CRM é preservado');
  assert.equal(lido.cadastro?.telefone, undefined);
  assert.equal(lido.cadastro?.whatsapp, '');
  assert.deepEqual(lido.motivos, { data: 'Contrato diz dia 15' }, 'motivo só de campo corrigido');
  assert.equal(lido.valorContratadoCentavos, 850000);
  assert.deepEqual(lido.financeiro, { situacao: 'PARCIALMENTE_PAGO', parcelas: [
    { valorCentavos: 255000, vencimento: '2026-08-01', recebimento: { data: '2026-08-03', forma: 'PIX' } },
    { valorCentavos: 595000, vencimento: '2026-11-14', recebimento: null },
  ] });
  assert.ok(!/empresa|usuario|tenant|saldo|recebido/i.test(Object.keys(d).join(',')));
  assert.deepEqual(financeiroSchema.parse(financeiroDoFormulario(preenchido({ situacaoFinanceira: 'NAO_CONFERIDO' }))), { situacao: 'NAO_CONFERIDO' });
});

// S-E restante (importação V3): salão escolhido só quando a unidade usa salão e a festa é futura (D1: nada automático).
const SALAO = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const escopos = [
  { estabelecimentoId: null, porSalao: false, saloes: [] },
  { estabelecimentoId: UNIDADE, porSalao: true, saloes: [{ id: SALAO, nome: 'Salão A', ordem: 1 }] },
];

test('V3 na tela: pede salão só em unidade por salão com festa futura; sem salão o envio é bloqueado', () => {
  assert.equal(pedeSalao(preenchido(), escopos, HOJE), true);
  assert.equal(pedeSalao(preenchido({ data: '2026-09-01' }), escopos, HOJE), false, 'festa passada não ocupa salão');
  assert.equal(pedeSalao(preenchido({ estabelecimentoId: '' }), escopos, HOJE), false);
  assert.equal(pedeSalao(preenchido(), undefined, HOJE), false, 'servidor antigo sem a lista de salões');
  assert.ok(errosFesta(preenchido(), sugestao, 1, true).includes('Escolha o salão da festa.'));
  assert.ok(!errosFesta(preenchido({ salaoId: SALAO }), sugestao, 1, true).includes('Escolha o salão da festa.'));
});

test('V3 na tela: trocar a unidade ou sair do caso V3 zera o salão; o payload só leva salaoId quando há salão', () => {
  const comSalao = preenchido({ salaoId: SALAO });
  assert.equal(ajustarSalao(comSalao, { ...comSalao, estabelecimentoId: 'outra' }, escopos, HOJE).salaoId, '');
  assert.equal(ajustarSalao(comSalao, { ...comSalao, data: '2026-09-01' }, escopos, HOJE).salaoId, '');
  assert.equal(ajustarSalao(comSalao, { ...comSalao, convidados: '90' }, escopos, HOJE).salaoId, SALAO);
  assert.equal(decisoesDoForm(comSalao, sugestao).salaoId, SALAO);
  assert.equal('salaoId' in decisoesDoForm(preenchido(), sugestao), false, 'V1: a chave nem vai (hash de antes)');
  assert.equal(decisoesSchema.safeParse(decisoesDoForm(comSalao, sugestao)).success, true);
});
