import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisoesBase, referenciasBase, snapshotBase } from './fixtures.ts';
import { avaliarIntegracao, decisoesSchema, hashResumo, montarSnapshotVersao, reais, sugestaoInicial, type DecisoesIntegracao } from './modelo.ts';

const HOJE = '2026-10-02';

const avaliar = (d: DecisoesIntegracao, s = snapshotBase(), r = referenciasBase()) => avaliarIntegracao({ snapshot: s, decisoes: d, referencias: r, hoje: HOJE });

test('parcialmente pago: reconcilia em centavos e separa recebido do saldo a receber', () => {
  const a = avaliar(decisoesBase());
  assert.deepEqual(a.bloqueios, []);
  const f = a.resumo.financeiro;
  if (f.situacao !== 'PARCIALMENTE_PAGO') throw new Error(`situação inesperada: ${f.situacao}`);
  assert.equal(f.recebidoCentavos, 255000);
  assert.equal(f.saldoCentavos, 595000);
  assert.equal(f.recebidoCentavos + f.saldoCentavos, f.contratadoCentavos);
  assert.deepEqual(f.recebimentos, [{ numero: 1, valorCentavos: 255000, data: '2026-08-03', forma: 'PIX' }]);
  assert.deepEqual(f.aReceber.map((p) => [p.numero, p.situacao]), [[2, 'A_RECEBER']]);
  assert.equal(a.resumo.agenda.ocupa, true);
  assert.match(a.resumo.agenda.descricao, /14\/11\/2026, das 14:00 às 18:00 \(Unidade Centro\)/);
});

test('não pago e totalmente pago: situação derivada precisa bater com a declarada', () => {
  const naoPago = avaliar(decisoesBase({ financeiro: { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: null }] } }));
  assert.deepEqual(naoPago.bloqueios, []);
  const pago = avaliar(decisoesBase({ financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-08-01', recebimento: { data: '2026-08-01', forma: 'TRANSFERENCIA' } }] } }));
  assert.deepEqual(pago.bloqueios, []);
  if (pago.resumo.financeiro.situacao === 'NAO_CONFERIDO') throw new Error('inesperado');
  assert.equal(pago.resumo.financeiro.saldoCentavos, 0);
  const incoerente = avaliar(decisoesBase({ financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-08-01', recebimento: null }] } }));
  assert.match(incoerente.bloqueios.join(' '), /situação informada é "totalmente pago"/);
});

test('divergência de valores: soma das parcelas diferente do contratado impede a confirmação', () => {
  const a = avaliar(decisoesBase({ financeiro: { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 849999, vencimento: '2026-11-14', recebimento: null }] } }));
  assert.match(a.bloqueios.join(' '), /As parcelas somam R\$ 8\.499,99, mas o valor contratado é R\$ 8\.500,00/);
});

test('recebimento só com data efetiva passada; parcela vencida a receber aparece como vencida', () => {
  const futuro = avaliar(decisoesBase({ financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: { data: '2026-10-03', forma: 'PIX' } }] } }));
  assert.match(futuro.bloqueios.join(' '), /recebimento com data futura/);
  const vencida = avaliar(decisoesBase({ financeiro: { situacao: 'PARCIALMENTE_PAGO', parcelas: [
    { valorCentavos: 255000, vencimento: '2026-08-01', recebimento: { data: '2026-08-01', forma: 'DINHEIRO' } },
    { valorCentavos: 300000, vencimento: '2026-09-01', recebimento: null },
    { valorCentavos: 295000, vencimento: '2026-11-01', recebimento: null },
  ] } }));
  assert.deepEqual(vencida.bloqueios, []);
  if (vencida.resumo.financeiro.situacao === 'NAO_CONFERIDO') throw new Error('inesperado');
  assert.deepEqual(vencida.resumo.financeiro.aReceber.map((p) => p.situacao), ['VENCIDA', 'A_RECEBER']);
  assert.match(vencida.avisos.join(' '), /parcelas vencidas/);
  const inexistente = avaliar(decisoesBase({ financeiro: { situacao: 'NAO_PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-02-30', recebimento: null }] } }));
  assert.match(inexistente.bloqueios.join(' '), /vencimento inexistente/);
});

test('pagamento não conferido: nenhuma parcela, recebimento ou dívida — pendência visível', () => {
  const a = avaliar(decisoesBase({ financeiro: { situacao: 'NAO_CONFERIDO' } }));
  assert.deepEqual(a.bloqueios, []);
  assert.deepEqual(a.resumo.financeiro, { situacao: 'NAO_CONFERIDO', contratadoCentavos: 850000, pendencia: 'Conferir pagamentos do contrato importado.' });
  assert.match(a.avisos.join(' '), /nada entra em Contas a receber nem no Fluxo de caixa/);
});

test('"à vista", "entrada" ou "30%" no documento não viram recebimento: a sugestão nunca marca parcela como paga', () => {
  const s = sugestaoInicial(snapshotBase());
  assert.equal(s.condicaoDocumento, 'Entrada de 30% e saldo à vista no dia');
  assert.deepEqual(s.parcelasPrevistas, [{ valorCentavos: 255000, vencimento: '2026-08-01' }, { valorCentavos: 595000, vencimento: '2026-11-14' }]);
  assert.ok(s.parcelasPrevistas.every((p) => !('recebimento' in p)));
  assert.deepEqual(s.evento, { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 });
  // Término ausente no documento: completado pela duração (sugestão, comparada como complemento).
  const semFim = snapshotBase();
  semFim.evento.horario = { inicio: '14:00', fim: null };
  assert.equal(sugestaoInicial(semFim).evento.horarioFim, '18:00');
  const a = avaliar(decisoesBase(), semFim);
  assert.equal(a.resumo.campos.find((c) => c.campo === 'horarioFim')?.origem, 'COMPLEMENTO');
});

test('correção de leitura exige motivo e fica marcada como diferente do documento', () => {
  const semMotivo = avaliar(decisoesBase({ evento: { data: '2026-11-15', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 } }));
  assert.match(semMotivo.bloqueios.join(' '), /Data da festa: difere do documento \(14\/11\/2026\)/);
  const comMotivo = avaliar(decisoesBase({ evento: { data: '2026-11-15', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, motivos: { data: 'OCR leu 14; o contrato diz 15 na cláusula 2.' } }));
  assert.deepEqual(comMotivo.bloqueios, []);
  const campo = comMotivo.resumo.campos.find((c) => c.campo === 'data')!;
  assert.deepEqual([campo.origem, campo.documento, campo.efetivo], ['CORRECAO_LEITURA', '14/11/2026', '15/11/2026']);
  assert.equal(comMotivo.resumo.campos.find((c) => c.campo === 'convidados')!.origem, 'DOCUMENTO');
});

test('evento passado vai ao Histórico sem ocupar agenda; cancelado e não comprovado não integram', () => {
  const passado = avaliar(decisoesBase({
    evento: { data: '2025-05-10', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 }, motivos: { data: 'Data correta conforme aditivo anexo.' },
    financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2025-05-01', recebimento: { data: '2025-05-01', forma: 'PIX' } }] },
  }));
  assert.deepEqual(passado.bloqueios, []);
  assert.equal(passado.resumo.agenda.ocupa, false);
  assert.match(passado.resumo.agenda.descricao, /vai ao Histórico, sem ocupar agenda/);
  assert.match(avaliar(decisoesBase({ situacaoContrato: 'CANCELADO' })).bloqueios.join(' '), /Contrato cancelado não vira festa/);
  assert.match(avaliar(decisoesBase({ situacaoContrato: 'NAO_COMPROVADA' })).bloqueios.join(' '), /Confirme se o contrato está vigente/);
});

test('unidade, pacote de referência, preço âncora e cliente ativo são exigidos', () => {
  const r = referenciasBase();
  assert.match(avaliar(decisoesBase({ estabelecimentoId: null }), snapshotBase(), r).bloqueios.join(' '), /Escolha a unidade/);
  assert.match(avaliar(decisoesBase(), snapshotBase(), { ...r, pacote: null }).bloqueios.join(' '), /pacote do sistema/);
  assert.match(avaliar(decisoesBase(), snapshotBase(), { ...r, precoReferencia: null }).bloqueios.join(' '), /linha de preço/);
  assert.match(avaliar(decisoesBase(), snapshotBase(), { ...r, cliente: { ...r.cliente, status: 'MESCLADO' } }).bloqueios.join(' '), /não está ativo/);
  // Sem unidades cadastradas: a empresa é a unidade única.
  assert.deepEqual(avaliar(decisoesBase({ estabelecimentoId: null }), snapshotBase(), { ...r, estabelecimentos: [] }).bloqueios, []);
  assert.match(avaliar(decisoesBase({ evento: { data: '2026-11-14', horarioInicio: '18:00', horarioFim: '14:00', convidados: 80 }, motivos: { horarioInicio: 'conferido no original', horarioFim: 'conferido no original' } })).bloqueios.join(' '), /término deve ser depois do início/);
});

test('o hash do resumo amarra decisões e resumo; snapshot da versão preserva o contrato histórico intacto', () => {
  const d = decisoesBase();
  const a = avaliar(d);
  const h = hashResumo('imp', d, a.resumo);
  assert.equal(h, hashResumo('imp', decisoesBase(), avaliar(decisoesBase()).resumo));
  assert.notEqual(h, hashResumo('imp', decisoesBase({ outroContratoConfirmado: true }), a.resumo));
  const s = snapshotBase();
  const v = montarSnapshotVersao({
    importacaoId: 'imp', documento: { id: 'doc', sha256: 'a'.repeat(64) }, fechamentoId: 'f', snapshot: s, decisoes: d, resumo: a.resumo,
    cliente: { id: 'c', nomeCompleto: 'Ana Souza', cpf: null, telefone: null, whatsapp: null, email: null }, aniversarianteId: 'a1',
    pacote: referenciasBase().pacote!, unidade: { id: 'u', nome: 'Unidade Centro' }, conferente: { usuarioId: 'op', papel: 'ADMINISTRATIVO' },
  });
  assert.deepEqual(v.historico.contratoHistorico, snapshotBase(), 'o snapshot extraído vai inteiro, sem recálculo nem catálogo');
  assert.equal(v.comercial.valorFinalContrato, 8500);
  assert.equal(v.evento.pacote.nome, 'Festa Completa 2019', 'nome do pacote como no documento; o do sistema é só referência');
  assert.deepEqual(v.evento.pacote.referenciaSistema, { id: referenciasBase().pacote!.id, codigo: 'COMPLETA', nome: 'Festa Completa' });
  assert.equal(v.origem.aceite, 'CONTRATO_ASSINADO_EM_PAPEL');
  assert.ok(!JSON.stringify(v).includes('undefined'));
  assert.equal(reais(123456789), 'R$ 1.234.567,89');
});

test('esquema recusa campos extras, valores em reais e mais de 60 parcelas', () => {
  assert.throws(() => decisoesSchema.parse({ ...decisoesBase(), tenantId: 'x' }));
  assert.throws(() => decisoesSchema.parse({ ...decisoesBase(), valorContratadoCentavos: 8500.5 }));
  assert.throws(() => decisoesSchema.parse({ ...decisoesBase(), financeiro: { situacao: 'NAO_PAGO', parcelas: Array.from({ length: 61 }, () => ({ valorCentavos: 1, vencimento: '2026-11-14', recebimento: null })) } }));
  assert.throws(() => decisoesSchema.parse({ ...decisoesBase(), financeiro: { situacao: 'PAGO', parcelas: [{ valorCentavos: 850000, vencimento: '2026-11-14', recebimento: { data: '2026-08-01', forma: 'CHEQUE' } }] } }));
});
