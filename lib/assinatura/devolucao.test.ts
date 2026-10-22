import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estornoAutomaticoLigado, pagamentoDoPeriodo } from './devolucao.ts';
import { mensagemConfirmacao, type PedidoResumo } from './devolucao-registro.ts';
import type { CobrancaProvedor } from './asaas.ts';

const cobranca = (id: string, status: string, dueDate: string, extra: Partial<CobrancaProvedor> = {}): CobrancaProvedor =>
    ({ id, status, dueDate, paymentDate: dueDate, invoiceUrl: null, deleted: false, valorCentavos: 397_000, billingType: 'PIX', ...extra });

test('flag do estorno automático: desligada por padrão; só "true" liga', () => {
    assert.equal(estornoAutomaticoLigado({}), false);
    for (const v of ['1', 'TRUE', 'ligado', 'sim', ''])
        assert.equal(estornoAutomaticoLigado({ ASSINATURA_ESTORNO_ATIVO: v }), false, v);
    assert.equal(estornoAutomaticoLigado({ ASSINATURA_ESTORNO_ATIVO: 'true' }), true);
});

test('cobrança do período: a última paga; ativação = a mais tardia entre provedor e confirmação local da oferta', () => {
    const lista = [
        cobranca('pay_1', 'RECEIVED', '2026-11-10'),
        cobranca('pay_2', 'PENDING', '2027-11-10'),
        cobranca('pay_0', 'REFUNDED', '2025-11-10'),
        cobranca('pay_x', 'RECEIVED', '2026-12-10', { deleted: true }),
    ];
    const r = pagamentoDoPeriodo({ confirmacoes: [] }, lista);
    assert.deepEqual(r, { base: { id: 'pay_1', valorCentavos: 397_000, vencimento: '2026-11-10', dataAtivacao: '2026-11-10', formaPagamento: 'PIX' }, pagasNaAssinatura: 1 });
    // Cartão: confirmedDate antes de paymentDate; a liberação local (fuso de Brasília) depois → vale a local.
    const cartao = [cobranca('pay_c', 'CONFIRMED', '2026-11-10', { paymentDate: null, confirmedDate: '2026-11-10', billingType: 'CREDIT_CARD' })];
    assert.equal(pagamentoDoPeriodo({ confirmacoes: [{ pagamentoId: 'pay_c', confirmadaEm: '2026-11-12T02:30:00.000Z' }] }, cartao)?.base.dataAtivacao, '2026-11-11');
    assert.equal(pagamentoDoPeriodo({ confirmacoes: [{ pagamentoId: 'outro', confirmadaEm: '2026-12-01T12:00:00.000Z' }] }, cartao)?.base.dataAtivacao, '2026-11-10');
    // Duas pagas (renovação): a última sustenta o período e não é a primeira ativação.
    assert.equal(pagamentoDoPeriodo({ confirmacoes: [] }, [...lista, cobranca('pay_3', 'RECEIVED_IN_CASH', '2027-11-10')])?.pagasNaAssinatura, 2);
    assert.equal(pagamentoDoPeriodo({ confirmacoes: [] }, [cobranca('p', 'PENDING', '2026-11-10')]), null);
});

const pedido = (mudar: Partial<PedidoResumo> = {}): PedidoResumo => ({
    id: '00000000-0000-4000-8000-000000000001', protocolo: 'KM-20261021-ABCDEFGH', tipo: 'ENCERRAMENTO_ANUAL_PROPORCIONAL', solicitadoEm: '2026-10-21T18:00:00.000Z',
    valorDevolucaoCentavos: 288_233, prazoProcessamento: '2026-10-28', acessoPagoEncerradoEm: '2026-10-21T18:00:00.000Z', cancelamentoProvedor: 'CONFIRMADO',
    estorno: 'AGUARDANDO_MANUAL', email: 'PENDENTE', ...mudar,
});

test('e-mail de confirmação: protocolo, valor, prazo e somente leitura; sem id do provedor; HTML escapado; idempotente pelo pedido', () => {
    const m = mensagemConfirmacao({ para: 'gestao@example.test', empresa: 'Buffet <Teste>', pedido: pedido(), periodoFim: null, estornoAutomatico: false });
    assert.equal(m.assunto, 'Kidmais Manager — protocolo KM-20261021-ABCDEFGH');
    assert.match(m.texto, /KM-20261021-ABCDEFGH/);
    assert.match(m.texto, /R\$\s?2\.882,33/);
    assert.match(m.texto, /28\/10\/2026 \(5 dias úteis\)/);
    assert.match(m.texto, /somente leitura por 60 dias/);
    assert.match(m.texto, /boleto/);
    assert.match(m.html, /Buffet &lt;Teste&gt;/);
    assert.equal(m.idempotencia, 'encerramento:00000000-0000-4000-8000-000000000001');
    assert.doesNotMatch(m.texto, /pay_|sub_|cus_/);
    const arrependimento = mensagemConfirmacao({ para: 'g@example.test', empresa: 'B', pedido: pedido({ tipo: 'ARREPENDIMENTO_7_DIAS', valorDevolucaoCentavos: 397_000 }), periodoFim: null, estornoAutomatico: true });
    assert.match(arrependimento.texto, /iniciada de imediato, sem desconto de taxas/);
    assert.doesNotMatch(arrependimento.texto, /boleto/);
    const cancelamento = mensagemConfirmacao({ para: 'g@example.test', empresa: 'B', pedido: pedido({ tipo: 'CANCELAMENTO_FIM_PERIODO', valorDevolucaoCentavos: null }), periodoFim: '2026-11-21T03:00:00.000Z', estornoAutomatico: false });
    assert.match(cancelamento.texto, /não será renovada.*21\/11\/2026/s);
    assert.doesNotMatch(cancelamento.texto, /Valor a devolver/);
});

test('089 (texto): aditiva, com guarda própria; o down recusa com dados; nenhuma tabela existente é alterada', () => {
    const up = readFileSync('database/migrations/20261021_089_assinatura_encerramentos.sql', 'utf8');
    const down = readFileSync('database/rollback/20261021_089_assinatura_encerramentos_down.sql', 'utf8');
    assert.match(up, /^BEGIN;$/m);
    assert.match(up, /^COMMIT;$/m);
    assert.doesNotMatch(up, /ALTER TABLE|DROP |UPDATE empresa_assinaturas|INSERT INTO/i);
    assert.match(up, /CREATE TABLE assinatura_encerramentos/);
    assert.match(up, /BEFORE INSERT OR UPDATE OR DELETE ON assinatura_encerramentos/);
    assert.match(down, /089 rollback recusado: há pedidos/);
    assert.doesNotMatch(down, /empresa_assinaturas/);
});

test('P2-1: na assinatura com devolução, cobrança devolvida ou com vencimento ≤ ao dela não sustenta período; outra assinatura e posterior sustentam', async () => {
    const { cobrancaDevolvidaOuAnterior } = await import('./devolucao-registro.ts');
    const d = { ids: new Set(['pay_2']), limites: new Map([['sub_1', '2027-11-10']]) };
    assert.equal(cobrancaDevolvidaOuAnterior(d, 'sub_1', { id: 'pay_2', dueDate: '2027-11-10' }), true);
    assert.equal(cobrancaDevolvidaOuAnterior(d, 'sub_1', { id: 'pay_1', dueDate: '2026-11-10' }), true, '1º ano não reabre');
    assert.equal(cobrancaDevolvidaOuAnterior(d, 'sub_1', { id: 'pay_3', dueDate: '2028-11-10' }), false, 'pagamento novo reativa');
    assert.equal(cobrancaDevolvidaOuAnterior(d, 'sub_2', { id: 'pay_9', dueDate: '2027-11-10' }), false, 'recontratação (outra assinatura)');
    assert.equal(cobrancaDevolvidaOuAnterior({ ids: new Set(), limites: new Map() }, 'sub_1', { id: 'pay_1', dueDate: '2026-11-10' }), false);
});

test('P2-3: aviso interno só com protocolo, tipo, valor, prazo e situação; urgente no arrependimento e na renovação não removida', async () => {
    const { mensagemAvisoInterno, canalDaPlataforma } = await import('./devolucao-registro.ts');
    assert.equal(canalDaPlataforma({}), null);
    assert.equal(canalDaPlataforma({ SITE_ATENDIMENTO_EMAIL: ' contato@demerzellabs.com.br ' }), 'contato@demerzellabs.com.br');
    assert.equal(canalDaPlataforma({ SITE_ATENDIMENTO_EMAIL: 'a definir' }), null);
    const m = mensagemAvisoInterno({ para: 'contato@exemplo.test', pedido: pedido(), detalhes: { formaPagamento: 'PIX', prazoArrependimento: false } });
    assert.equal(m.assunto, 'Kidmais Manager — pedido KM-20261021-ABCDEFGH (Encerramento antecipado do plano anual (devolução proporcional))');
    assert.match(m.texto, /R\$\s?2\.882,33\. Meio de pagamento: PIX/);
    assert.match(m.texto, /iniciar até 28\/10\/2026/);
    assert.equal(m.idempotencia, 'encerramento-interno:00000000-0000-4000-8000-000000000001');
    const a = mensagemAvisoInterno({ para: 'x@exemplo.test', pedido: pedido({ tipo: 'ARREPENDIMENTO_7_DIAS' }), detalhes: { formaPagamento: 'CREDIT_CARD', prazoArrependimento: true } });
    assert.match(a.assunto, /^\[AÇÃO HOJE\]/); assert.match(a.texto, /IMEDIATO/);
    const r = mensagemAvisoInterno({ para: 'x@exemplo.test', pedido: pedido({ tipo: 'CANCELAMENTO_FIM_PERIODO', valorDevolucaoCentavos: null, cancelamentoProvedor: 'SEM_CONFIRMACAO' }), detalhes: { formaPagamento: null, prazoArrependimento: false } });
    assert.match(r.assunto, /^\[AÇÃO HOJE\]/); assert.match(r.texto, /Renovação no provedor: SEM_CONFIRMACAO/);
    for (const x of [m, a, r]) assert.doesNotMatch(x.texto, /@|pay_|sub_|cus_|Buffet/);
});
