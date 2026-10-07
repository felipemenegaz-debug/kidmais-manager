import test from 'node:test';
import assert from 'node:assert/strict';
import { cobrancaEmAberto, estadoDoProvedor, somarCiclo, transicaoPermitida, type EstadoLocal } from './provedor-estado.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

const AGORA = Date.parse('2026-10-20T15:00:00.000Z');
const teste: EstadoLocal = { situacao: 'TESTE', ciclo: 'MENSAL', periodoAtualFim: null, emAtrasoDesde: null, canceladaEm: null, encerradaEm: null };
const sub = (status = 'ACTIVE', cycle = 'MONTHLY', extra: Partial<AssinaturaProvedor> = {}): AssinaturaProvedor => ({ id: 'sub_1', status, deleted: false, cycle, customer: 'cus_1', externalReference: 'e1', ...extra });
const pay = (id: string, status: string, dueDate: string, extra: Partial<CobrancaProvedor> = {}): CobrancaProvedor => ({ id, status, dueDate, paymentDate: null, invoiceUrl: `https://sandbox.asaas.com/i/${id}`, deleted: false, ...extra });

test('ciclos: mês seguinte à meia-noite de Brasília, último dia quando o mês é curto; ano seguinte', () => {
    assert.equal(new Date(somarCiclo('2026-10-07', 'MENSAL')).toISOString(), '2026-11-07T03:00:00.000Z');
    assert.equal(new Date(somarCiclo('2026-12-15', 'MENSAL')).toISOString(), '2027-01-15T03:00:00.000Z');
    assert.equal(new Date(somarCiclo('2027-01-31', 'MENSAL')).toISOString(), '2027-02-28T03:00:00.000Z');
    assert.equal(new Date(somarCiclo('2028-02-29', 'ANUAL')).toISOString(), '2029-02-28T03:00:00.000Z');
});

test('pago (CONFIRMED, RECEIVED, RECEIVED_IN_CASH): TESTE → ATIVA até vencimento + ciclo', () => {
    for (const status of ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']) {
        const r = estadoDoProvedor(teste, sub(), [pay('p1', status, '2026-10-07')], AGORA);
        assert.deepEqual([r.situacao, r.periodoAtualFim, r.ciclo, r.mudou], ['ATIVA', '2026-11-07T03:00:00.000Z', 'MENSAL', true], status);
    }
    const anual = estadoDoProvedor(teste, sub('ACTIVE', 'YEARLY'), [pay('p1', 'RECEIVED', '2026-10-07')], AGORA);
    assert.deepEqual([anual.situacao, anual.ciclo, anual.periodoAtualFim], ['ATIVA', 'ANUAL', '2027-10-07T03:00:00.000Z']);
});

test('não pago: pendente, estornado ou chargeback não libera; teste continua teste', () => {
    for (const status of ['PENDING', 'REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED', 'AWAITING_RISK_ANALYSIS', 'OVERDUE']) {
        const r = estadoDoProvedor(teste, sub(), [pay('p1', status, '2026-10-07')], AGORA);
        assert.deepEqual([r.situacao, r.mudou, r.recusa], ['TESTE', false, null], status);
    }
    // Cobrança paga mas removida no provedor também não conta.
    assert.equal(estadoDoProvedor(teste, sub(), [pay('p1', 'RECEIVED', '2026-10-07', { deleted: true })], AGORA).situacao, 'TESTE');
});

test('estorno de uma renovação não estende o período (o já liberado não encolhe por aqui)', () => {
    const ativa: EstadoLocal = { ...teste, situacao: 'ATIVA', periodoAtualFim: '2026-11-07T03:00:00.000Z' };
    const r = estadoDoProvedor(ativa, sub(), [pay('p1', 'RECEIVED', '2026-10-07'), pay('p2', 'REFUNDED', '2026-11-07')], AGORA);
    assert.deepEqual([r.situacao, r.periodoAtualFim, r.mudou], ['ATIVA', '2026-11-07T03:00:00.000Z', false]);
});

test('atraso: OVERDUE vencida sem pagamento posterior e período terminado → EM_ATRASO desde o vencimento mais antigo; pagamento regulariza', () => {
    const ativa: EstadoLocal = { ...teste, situacao: 'ATIVA', periodoAtualFim: '2026-10-07T03:00:00.000Z' };
    const pagamentos = [pay('p1', 'RECEIVED', '2026-09-07'), pay('p2', 'OVERDUE', '2026-10-07'), pay('p3', 'OVERDUE', '2026-10-15')];
    const atraso = estadoDoProvedor(ativa, sub(), pagamentos, AGORA);
    assert.deepEqual([atraso.situacao, atraso.emAtrasoDesde, atraso.periodoAtualFim], ['EM_ATRASO', '2026-10-07T03:00:00.000Z', '2026-10-07T03:00:00.000Z']);
    // Novo evento de atraso não reinicia o prazo de regularização.
    const deNovo = estadoDoProvedor({ ...ativa, situacao: 'EM_ATRASO', emAtrasoDesde: '2026-10-07T03:00:00.000Z' }, sub(), pagamentos, AGORA);
    assert.deepEqual([deNovo.situacao, deNovo.mudou], ['EM_ATRASO', false]);
    // Pagou as pendentes: volta a ATIVA, atraso limpo, período pela última paga.
    const pago = estadoDoProvedor({ ...ativa, situacao: 'EM_ATRASO', emAtrasoDesde: '2026-10-07T03:00:00.000Z' }, sub(),
        [pay('p1', 'RECEIVED', '2026-09-07'), pay('p2', 'RECEIVED', '2026-10-07'), pay('p3', 'CONFIRMED', '2026-10-15')], AGORA);
    assert.deepEqual([pago.situacao, pago.emAtrasoDesde, pago.periodoAtualFim], ['ATIVA', null, '2026-11-15T03:00:00.000Z']);
    // OVERDUE anterior a uma cobrança paga não é atraso.
    const antiga = estadoDoProvedor(ativa, sub(), [pay('p1', 'OVERDUE', '2026-09-07'), pay('p2', 'RECEIVED', '2026-10-07')], AGORA);
    assert.deepEqual([antiga.situacao, antiga.emAtrasoDesde], ['ATIVA', null]);
    // Pagou durante o teste e a cobrança seguinte já venceu: TESTE → ATIVA (período vencido) e, na próxima, EM_ATRASO.
    const doTeste = estadoDoProvedor(teste, sub(), pagamentos, AGORA);
    assert.deepEqual([doTeste.situacao, doTeste.periodoAtualFim], ['ATIVA', '2026-10-07T03:00:00.000Z']);
    assert.equal(estadoDoProvedor(doTeste, sub(), pagamentos, AGORA).situacao, 'EM_ATRASO');
    // Atraso durante o teste não é transição válida: continua TESTE (o teste vence sozinho).
    assert.equal(estadoDoProvedor(teste, sub(), [pay('p1', 'OVERDUE', '2026-10-07')], AGORA).situacao, 'TESTE');
});

test('cancelada/inativa/removida: CANCELADA_FIM_PERIODO no período pago, ENCERRADA depois; TESTE sem pagamento fica TESTE', () => {
    const ativa: EstadoLocal = { ...teste, situacao: 'ATIVA', periodoAtualFim: '2026-11-07T03:00:00.000Z' };
    for (const s of [null, sub('INACTIVE'), sub('EXPIRED'), sub('ACTIVE', 'MONTHLY', { deleted: true })]) {
        const r = estadoDoProvedor(ativa, s, [pay('p1', 'RECEIVED', '2026-10-07')], AGORA);
        assert.deepEqual([r.situacao, r.canceladaEm, r.periodoAtualFim], ['CANCELADA_FIM_PERIODO', new Date(AGORA).toISOString(), '2026-11-07T03:00:00.000Z']);
    }
    assert.equal(estadoDoProvedor(ativa, null, [], AGORA).provedorSituacao, 'DELETED');
    const cancelada: EstadoLocal = { ...ativa, situacao: 'CANCELADA_FIM_PERIODO', canceladaEm: '2026-10-20T15:00:00.000Z' };
    const depois = estadoDoProvedor(cancelada, null, [], Date.parse('2026-11-08T00:00:00.000Z'));
    assert.deepEqual([depois.situacao, depois.encerradaEm], ['ENCERRADA', '2026-11-07T03:00:00.000Z']);
    assert.deepEqual([estadoDoProvedor(teste, null, [], AGORA).situacao, estadoDoProvedor(teste, null, [], AGORA).mudou], ['TESTE', false]);
    const encerrada: EstadoLocal = { ...depois };
    assert.equal(estadoDoProvedor(encerrada, null, [], AGORA).mudou, false);
});

test('fora de ordem: o resultado depende só do estado atual do provedor, nunca da ordem dos eventos', () => {
    // "Cancelado" chega depois de "pago": a reconsulta diz removida + pago → cancelada no período (não volta ao teste).
    const pago = estadoDoProvedor(teste, sub(), [pay('p1', 'RECEIVED', '2026-10-07')], AGORA);
    const aposCancelado = estadoDoProvedor(pago, null, [], AGORA);
    assert.equal(aposCancelado.situacao, 'CANCELADA_FIM_PERIODO');
    // Evento "pago" antigo reentregue depois: a reconsulta ainda diz removida → nada muda.
    const reentregue = estadoDoProvedor(aposCancelado, null, [], AGORA);
    assert.deepEqual([reentregue.situacao, reentregue.mudou], ['CANCELADA_FIM_PERIODO', false]);
    // "Criada" chega depois de "confirmada": a reconsulta mostra a paga → ATIVA, e repetir não muda nada.
    const ativa = estadoDoProvedor(teste, sub(), [pay('p1', 'CONFIRMED', '2026-10-07')], AGORA);
    const repetido = estadoDoProvedor(ativa, sub(), [pay('p1', 'CONFIRMED', '2026-10-07')], AGORA);
    assert.deepEqual([repetido.situacao, repetido.mudou], ['ATIVA', false]);
});

test('nova assinatura de quem cancelou ou encerrou só reativa com cobrança paga', () => {
    const encerrada: EstadoLocal = { situacao: 'ENCERRADA', ciclo: 'MENSAL', periodoAtualFim: '2026-08-07T03:00:00.000Z', emAtrasoDesde: null, canceladaEm: '2026-07-20T00:00:00.000Z', encerradaEm: '2026-08-07T03:00:00.000Z' };
    assert.deepEqual([estadoDoProvedor(encerrada, sub(), [pay('n1', 'PENDING', '2026-10-20')], AGORA).situacao], ['ENCERRADA']);
    const paga = estadoDoProvedor(encerrada, sub(), [pay('n1', 'RECEIVED', '2026-10-20')], AGORA);
    assert.deepEqual([paga.situacao, paga.encerradaEm, paga.canceladaEm, paga.periodoAtualFim], ['ATIVA', null, null, '2026-11-20T03:00:00.000Z']);
});

test('tabela de transições da 068 e cobrança em aberto (página a continuar)', () => {
    assert.equal(transicaoPermitida('TESTE', 'EM_ATRASO'), false);
    assert.equal(transicaoPermitida('TESTE', 'CANCELADA_FIM_PERIODO'), false);
    assert.equal(transicaoPermitida('ENCERRADA', 'CANCELADA_FIM_PERIODO'), false);
    assert.equal(transicaoPermitida('CANCELADA_FIM_PERIODO', 'ATIVA'), true);
    const aberta = cobrancaEmAberto([pay('a', 'RECEIVED', '2026-09-07'), pay('b', 'PENDING', '2026-11-07'), pay('c', 'OVERDUE', '2026-10-07'), pay('d', 'PENDING', '2026-08-01', { deleted: true })]);
    assert.equal(aberta?.id, 'c');
    assert.equal(cobrancaEmAberto([pay('x', 'PENDING', '2026-10-07', { invoiceUrl: null })]), null);
});
