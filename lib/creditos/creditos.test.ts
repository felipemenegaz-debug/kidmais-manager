import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { alocar, avisoSaldo, decidirPagamento, exibir, fimDoMesBrasilia, lerReferenciaExterna, opcaoDevolucao, ordenarParaConsumo, proporcionalCentavos, referenciaExterna,
    vencimentoEmDias, type LidoNoProvedor } from './dominio.ts';
import { CATALOGO_DEMO, fotografiaOferta, termosSha256, validarCatalogo, type Catalogo } from './catalogo.ts';
import { catalogoVisivel, contaProvedor, flagsCreditos, vendaAberta, walleDisponivel } from './config.ts';
import { AsaasFalhou, criarClienteAsaas } from '../assinatura/asaas.ts';
import { extrairEvento } from '../assinatura/sincronizacao.ts';

/**
 * Regras financeiras puras dos créditos (090), flags e travas de produção, catálogo, cliente Asaas da cobrança avulsa (fetch
 * falso, sem rede), extração do webhook e argumentos dos CLIs. Os efeitos no banco ficam em creditos-090.postgres.test.ts.
 */
const DIA = 86_400_000;
const agora = Date.parse('2026-10-22T15:00:00.000Z');
const pedido = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('alocação: menor vencimento primeiro, franquia/cortesia antes do pago no empate, vencidos fora, insuficiente = null', () => {
    const lotes = [
        { id: 'c', origem: 'COMPRA' as const, disponivel: 5, venceEm: agora + 30 * DIA },
        { id: 'f', origem: 'FRANQUIA' as const, disponivel: 2, venceEm: agora + 30 * DIA },
        { id: 'l', origem: 'LEGADO' as const, disponivel: 1, venceEm: agora + 5 * DIA },
        { id: 'x', origem: 'CORTESIA' as const, disponivel: 9, venceEm: agora - 1 },
    ];
    assert.deepEqual(ordenarParaConsumo(lotes).map((l) => l.id), ['x', 'l', 'f', 'c']);
    assert.deepEqual(alocar(lotes, 4, agora), [{ loteId: 'l', quantidade: 1 }, { loteId: 'f', quantidade: 2 }, { loteId: 'c', quantidade: 1 }]);
    assert.equal(alocar(lotes, 9, agora), null, 'vencido não conta');
    assert.deepEqual(alocar(lotes, 8, agora)?.reduce((s, a) => s + a.quantidade, 0), 8);
    assert.throws(() => alocar(lotes, 0, agora), /quantidade inválida/);
    assert.throws(() => alocar(lotes, 1.5, agora), /quantidade inválida/);
});

test('proporcional em centavos: inteiro, metade para cima, sem ponto flutuante e seguro acima de 2^53 no produto', () => {
    assert.equal(proporcionalCentavos(5900, 7, 10), 4130);
    assert.equal(proporcionalCentavos(15900, 27, 30), 14310);
    assert.equal(proporcionalCentavos(100, 1, 3), 33);
    assert.equal(proporcionalCentavos(200, 1, 3), 67);
    assert.equal(proporcionalCentavos(84900, 50_000_000, 50_000_000), 84900, 'tudo = valor pago exato');
    assert.equal(proporcionalCentavos(10_000_000, 999_999_999_999, 1_000_000_000_000), 10_000_000);
    assert.throws(() => proporcionalCentavos(100, 4, 3), /valores inválidos/);
    assert.throws(() => proporcionalCentavos(100.5, 1, 3), /valores inválidos/);
});

test('devolução de pacote: garantia de 7 dias integral mesmo com uso; depois proporcional do não usado; recusas tipadas', () => {
    const base = { quantidade: 10, disponivel: 7, reservado: 1, bloqueado: 0, consumido: 2, expirado: 0, cancelado: 0, liberadoEm: agora - 2 * DIA, venceEm: agora + 300 * DIA };
    const g = opcaoDevolucao(base, 5900, agora, false);
    assert.ok(g.disponivel && g.calculo.tipo === 'ARREPENDIMENTO_7_DIAS' && g.calculo.valorCentavos === 5900 && g.calculo.quantidadeCancelada === 7);
    assert.ok(g.disponivel && g.calculo.prazo === '2026-10-22', 'arrependimento: início imediato');
    const depois = { ...base, liberadoEm: agora - 8 * DIA };
    assert.deepEqual(opcaoDevolucao(depois, 5900, agora, false), { disponivel: false, motivo: 'GERACAO_EM_ANDAMENTO' });
    const p = opcaoDevolucao({ ...depois, reservado: 0, disponivel: 8 }, 5900, agora, false);
    assert.ok(p.disponivel && p.calculo.tipo === 'SALDO_NAO_UTILIZADO' && p.calculo.valorCentavos === 4720 && p.calculo.prazo === '2026-10-29');
    assert.deepEqual(opcaoDevolucao({ ...depois, reservado: 0, disponivel: 0, consumido: 10 }, 5900, agora, false), { disponivel: false, motivo: 'SEM_SALDO_PAGO' });
    assert.deepEqual(opcaoDevolucao({ ...depois, venceEm: agora - 1 }, 5900, agora, false), { disponivel: false, motivo: 'LOTE_VENCIDO' });
    assert.deepEqual(opcaoDevolucao(base, 5900, agora, true), { disponivel: false, motivo: 'DEVOLUCAO_JA_REGISTRADA' });
    assert.deepEqual(opcaoDevolucao({ ...base, bloqueado: 3, disponivel: 4 }, 5900, agora, false), { disponivel: false, motivo: 'LOTE_BLOQUEADO' });
    // Fronteira exata da garantia: 7 dias completos depois da liberação, a garantia acabou.
    assert.equal((opcaoDevolucao({ ...base, reservado: 0, liberadoEm: agora - 7 * DIA }, 5900, agora, false) as { calculo?: { tipo: string } }).calculo?.tipo, 'SALDO_NAO_UTILIZADO');
    assert.equal((opcaoDevolucao({ ...base, liberadoEm: agora - 7 * DIA + 1 }, 5900, agora, false) as { calculo?: { tipo: string } }).calculo?.tipo, 'ARREPENDIMENTO_7_DIAS');
});

test('pagamento lido no provedor: só CONFIRMED/RECEIVED com vínculo, valor e forma conferidos credita; o resto aguarda ou revisa', () => {
    const ref = referenciaExterna('sandbox', pedido);
    const esperado = { pagamentoId: 'pay_1', valorCentavos: 5900, clienteId: 'cus_1', referencia: ref, forma: 'PIX' as const };
    const lido = (x: Partial<LidoNoProvedor> = {}): LidoNoProvedor => ({ id: 'pay_1', status: 'RECEIVED', valorCentavos: 5900, clienteId: 'cus_1', externalReference: ref, billingType: 'PIX', deleted: false, ...x });
    assert.deepEqual(decidirPagamento(lido(), esperado), { acao: 'CREDITAR' });
    assert.deepEqual(decidirPagamento(lido({ status: 'CONFIRMED' }), esperado), { acao: 'CREDITAR' });
    for (const status of ['PENDING', 'AUTHORIZED', 'AWAITING_RISK_ANALYSIS', 'DESCONHECIDO']) assert.deepEqual(decidirPagamento(lido({ status }), esperado), { acao: 'AGUARDAR' }, status);
    assert.deepEqual(decidirPagamento(lido({ status: 'OVERDUE' }), esperado), { acao: 'VENCIDO' });
    assert.deepEqual(decidirPagamento(lido({ valorCentavos: 5800 }), esperado), { acao: 'REVISAO', motivo: 'VALOR_DIVERGENTE' });
    assert.deepEqual(decidirPagamento(lido({ valorCentavos: null }), esperado), { acao: 'REVISAO', motivo: 'VALOR_DIVERGENTE' });
    assert.deepEqual(decidirPagamento(lido({ billingType: 'BOLETO' }), esperado), { acao: 'REVISAO', motivo: 'FORMA_DIVERGENTE' });
    assert.deepEqual(decidirPagamento(lido({ externalReference: referenciaExterna('producao', pedido) }), esperado), { acao: 'REVISAO', motivo: 'REFERENCIA_DIVERGENTE' }, 'sandbox nunca casa com produção');
    assert.deepEqual(decidirPagamento(lido({ clienteId: 'cus_2' }), esperado), { acao: 'REVISAO', motivo: 'CLIENTE_DIVERGENTE' });
    assert.deepEqual(decidirPagamento(lido({ id: 'pay_2' }), esperado), { acao: 'REVISAO', motivo: 'ID_DIVERGENTE' });
    assert.deepEqual(decidirPagamento(lido({ status: 'RECEIVED_IN_CASH' }), esperado), { acao: 'REVISAO', motivo: 'RECEBIDO_FORA_DO_PROVEDOR' });
    assert.deepEqual(decidirPagamento(lido({ status: 'REFUNDED' }), esperado), { acao: 'ESTORNO' });
    assert.deepEqual(decidirPagamento(lido({ status: 'CHARGEBACK_REQUESTED' }), esperado), { acao: 'DISPUTA' });
    assert.deepEqual(decidirPagamento(lido({ status: 'PENDING', deleted: true }), esperado), { acao: 'CANCELADO' });
    assert.deepEqual(decidirPagamento(null, esperado), { acao: 'REVISAO', motivo: 'COBRANCA_NAO_ENCONTRADA' });
});

test('referência externa: correlação sem dado pessoal; leitura estrita', () => {
    assert.equal(referenciaExterna('sandbox', pedido), `km:sandbox:creditos:${pedido}`);
    assert.deepEqual(lerReferenciaExterna(`km:producao:creditos:${pedido}`), { ambiente: 'producao', pedidoId: pedido });
    for (const v of [null, '', pedido, `km:staging:creditos:${pedido}`, `km:sandbox:creditos:${pedido} `, `km:sandbox:assinatura:${pedido}`]) assert.equal(lerReferenciaExterna(v), null);
    assert.throws(() => referenciaExterna('sandbox', 'joao@exemplo.test'), /pedido inválido/);
});

test('datas de São Paulo: fim do mês (dezembro → janeiro) e validade em dias até o fim do dia local', () => {
    assert.equal(new Date(fimDoMesBrasilia(Date.parse('2026-12-31T23:30:00.000Z'))).toISOString(), '2027-01-01T03:00:00.000Z', '31/12 20:30 SP ainda é dezembro');
    assert.equal(new Date(fimDoMesBrasilia(Date.parse('2027-01-01T03:00:00.000Z'))).toISOString(), '2027-02-01T03:00:00.000Z');
    assert.equal(new Date(vencimentoEmDias(agora, 365)).toISOString(), '2027-10-23T03:00:00.000Z');
});

test('exibição e aviso de saldo: Wall-e em créditos inteiros (para baixo), 20% e zerado', () => {
    assert.equal(exibir('WALLE', 1999), 1);
    assert.equal(exibir('CONVITES', 7), 7);
    assert.equal(avisoSaldo(1, 10), 'BAIXO');
    assert.equal(avisoSaldo(2, 10), null);
    assert.equal(avisoSaldo(0, 10), 'ZERADO');
    assert.equal(avisoSaldo(0, 0), null, 'nunca teve saldo: sem aviso de compra');
});

test('flags: tudo desligado por padrão; só o texto "true" liga; produção nunca vende catálogo sem aprovação registrada', () => {
    assert.deepEqual(flagsCreditos({}), { catalogo: false, compra: false, consumoConvites: false, consumoWalle: false, estorno: false });
    assert.deepEqual(flagsCreditos({ CREDITOS_COMPRA_ATIVA: 'TRUE', CREDITOS_CATALOGO_ATIVO: '1', CREDITOS_ESTORNO_ATIVO: ' true ' }), { catalogo: false, compra: false, consumoConvites: false, consumoWalle: false, estorno: true });
    assert.equal(flagsCreditos({ ASSINATURA_ESTORNO_ATIVO: 'true' }).estorno, false, 'nunca reutiliza a flag da assinatura');
    const ligado = { CREDITOS_CATALOGO_ATIVO: 'true', CREDITOS_COMPRA_ATIVA: 'true' };
    assert.deepEqual(vendaAberta(CATALOGO_DEMO, {}), { ok: false, motivo: 'CATALOGO_DESLIGADO' });
    assert.deepEqual(vendaAberta(CATALOGO_DEMO, { CREDITOS_CATALOGO_ATIVO: 'true' }), { ok: false, motivo: 'COMPRA_DESLIGADA' });
    assert.deepEqual(vendaAberta(CATALOGO_DEMO, { ...ligado, KIDMAIS_DEPLOY_ENV: 'staging' }), { ok: true });
    assert.deepEqual(vendaAberta(CATALOGO_DEMO, { ...ligado, KIDMAIS_DEPLOY_ENV: 'production', CREDITOS_CATALOGO_APROVADO: CATALOGO_DEMO.versao }), { ok: false, motivo: 'CATALOGO_NAO_APROVADO_PRODUCAO' });
    const aprovado: Catalogo = { ...CATALOGO_DEMO, versao: 'APROVADO-TESTE-1', proposta: false, aprovacao: { decisao: 'teste', em: '2026-10-22' } };
    assert.deepEqual(catalogoVisivel(aprovado, { ...ligado, KIDMAIS_DEPLOY_ENV: 'production' }), { ok: false, motivo: 'APROVACAO_DIVERGENTE' });
    assert.deepEqual(vendaAberta(aprovado, { ...ligado, KIDMAIS_DEPLOY_ENV: 'production', CREDITOS_CATALOGO_APROVADO: 'APROVADO-TESTE-1' }), { ok: true });
    assert.equal(contaProvedor({}), 'padrao');
    assert.equal(contaProvedor({ CREDITOS_ASAAS_CONTA: 'Conta Real!' }), 'invalida');
});

test('Wall-e só disponível com o consumo novo E os gates do atendimento (saldo nunca reativa o atendimento)', () => {
    const gates = { WHATSAPP_ATENDIMENTO_ENABLED: 'true', WHATSAPP_ATENDIMENTO_RECEPTOR: 'staging', KIDMAIS_DEPLOY_ENV: 'staging', WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: 'modelo',
        WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: 'R6-teste-local', WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: '5511900000000' };
    assert.equal(walleDisponivel({ ...gates }), false, 'sem a flag de consumo');
    assert.equal(walleDisponivel({ CREDITOS_WALLE_CONSUMO_ATIVO: 'true' }), false, 'sem os gates');
    assert.equal(walleDisponivel({ ...gates, CREDITOS_WALLE_CONSUMO_ATIVO: 'true', WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: '' }), false, 'sem R6');
    assert.equal(walleDisponivel({ ...gates, CREDITOS_WALLE_CONSUMO_ATIVO: 'true' }), true);
});

test('catálogo: demonstração válida, proposta e sem aprovação; inconsistências recusadas; fotografia sem dados pessoais', () => {
    assert.equal(validarCatalogo(CATALOGO_DEMO), true);
    assert.equal(CATALOGO_DEMO.proposta, true);
    assert.equal(CATALOGO_DEMO.aprovacao, null);
    assert.match(termosSha256(CATALOGO_DEMO), /^[0-9a-f]{64}$/);
    const ofertas = CATALOGO_DEMO.ofertas;
    const mudar = (i: number, x: object): Catalogo => ({ ...CATALOGO_DEMO, ofertas: ofertas.map((o, j) => (j === i ? { ...o, ...x } : o)) });
    assert.throws(() => validarCatalogo(mudar(0, { precoCentavos: 59.9 })), /valor inválido/);
    assert.throws(() => validarCatalogo(mudar(3, { quantidade: 5_000_001 })), /unidade Wall-e/);
    assert.throws(() => validarCatalogo(mudar(1, { codigo: ofertas[0].codigo })), /código de oferta/);
    const foto = fotografiaOferta(CATALOGO_DEMO, ofertas[0]);
    assert.deepEqual(Object.keys(foto).sort(), ['catalogo', 'codigo', 'nome', 'precoCentavos', 'proposta', 'quantidade', 'quantidadeExibida', 'recurso', 'termos', 'validadeDias']);
});

test('Asaas, cobrança avulsa (fetch falso): POST sem assinatura, resposta conferida, referência obrigatória, listagem paginada completa', async () => {
    const chamadas: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];
    let respostaPost: Record<string, unknown> = {};
    let paginas: Record<string, unknown>[] = [];
    const fetch = async (url: string, init: RequestInit) => {
        chamadas.push({ url, metodo: String(init.method), corpo: init.body ? JSON.parse(String(init.body)) : null });
        if (init.method === 'POST') return new Response(JSON.stringify(respostaPost), { status: 200 });
        return new Response(JSON.stringify(paginas.shift()), { status: 200 });
    };
    const c = criarClienteAsaas({ ambiente: 'sandbox', baseUrl: 'https://api-sandbox.asaas.com/v3', apiKey: '$aact_hmlg_sintetica', webhookToken: 'x'.repeat(40) }, { fetch });
    const ref = referenciaExterna('sandbox', pedido);
    respostaPost = { id: 'pay_1', status: 'PENDING', dueDate: '2026-10-25', value: 59, externalReference: ref, customer: 'cus_1', billingType: 'PIX', invoiceUrl: 'https://sandbox.asaas.com/i/abc' };
    const r = await c.criarCobrancaAvulsa({ cliente: 'cus_1', forma: 'PIX', valorCentavos: 5900, vencimento: '2026-10-25', descricao: 'Kidmais', referencia: ref });
    assert.equal(r.id, 'pay_1');
    assert.deepEqual(chamadas[0], { url: 'https://api-sandbox.asaas.com/v3/payments', metodo: 'POST',
        corpo: { customer: 'cus_1', billingType: 'PIX', value: 59, dueDate: '2026-10-25', description: 'Kidmais', externalReference: ref } });
    respostaPost = { ...respostaPost, value: 58 };
    await assert.rejects(c.criarCobrancaAvulsa({ cliente: 'cus_1', forma: 'PIX', valorCentavos: 5900, vencimento: '2026-10-25', descricao: 'Kidmais', referencia: ref }),
        (e: unknown) => e instanceof AsaasFalhou && e.motivo === 'RESPOSTA_INVALIDA');
    respostaPost = { ...respostaPost, value: 59, subscription: 'sub_1' };
    await assert.rejects(c.criarCobrancaAvulsa({ cliente: 'cus_1', forma: 'PIX', valorCentavos: 5900, vencimento: '2026-10-25', descricao: 'Kidmais', referencia: ref }),
        (e: unknown) => e instanceof AsaasFalhou, 'resposta de assinatura não é avulsa');
    const antes = chamadas.length;
    await assert.rejects(c.criarCobrancaAvulsa({ cliente: 'cus_1', forma: 'PIX', valorCentavos: 5900, vencimento: '2026-10-25', descricao: 'x', referencia: 'empresa@exemplo.test' }), /Cobrança avulsa inválida/);
    await assert.rejects(c.criarCobrancaAvulsa({ cliente: 'cus_1', forma: 'PIX', valorCentavos: 59.5, vencimento: '2026-10-25', descricao: 'x', referencia: ref }), /Cobrança avulsa inválida/);
    assert.equal(chamadas.length, antes, 'recusas antes de qualquer chamada');
    const item = (id: string, externalReference: string) => ({ id, status: 'PENDING', dueDate: '2026-10-25', value: 59, externalReference });
    paginas = [{ data: [item('a', ref), item('b', 'outra')], hasMore: true }, { data: [item('c', ref)], hasMore: false }];
    assert.deepEqual((await c.listarCobrancasPorReferencia(ref)).map((x) => x.id), ['a', 'c']);
    paginas = Array.from({ length: 5 }, () => ({ data: [], hasMore: true }));
    await assert.rejects(c.listarCobrancasPorReferencia(ref), (e: unknown) => e instanceof AsaasFalhou && e.motivo === 'LISTA_INCOMPLETA', 'lista truncada nunca é "não existe"');
});

test('webhook: referência de créditos guardada como veio; outras referências não-UUID descartadas; nada além de identificadores', () => {
    const base = { id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', customer: 'cus_1', value: 59, externalReference: `km:sandbox:creditos:${pedido}`, description: 'nome da pessoa' } };
    const e = extrairEvento(base)!;
    assert.deepEqual([e.referenciaExterna, e.cobrancaId, e.assinaturaId], [`km:sandbox:creditos:${pedido}`, 'pay_1', null]);
    assert.equal(extrairEvento({ ...base, payment: { ...base.payment, externalReference: 'joao@exemplo.test' } })!.referenciaExterna, null);
    assert.equal(extrairEvento({ ...base, payment: { ...base.payment, externalReference: `km:staging:creditos:${pedido}` } })!.referenciaExterna, null);
    assert.equal(JSON.stringify(e).includes('nome da pessoa'), false);
});

test('CLIs de manutenção e de corte: argumentos estritos, aplicação só explícita e com registro da autorização', () => {
    const req = createRequire(import.meta.url);
    const man = req('../../scripts/creditos-manutencao.cjs') as { argumentos: (a: string[]) => unknown };
    const corte = req('../../scripts/creditos-corte-legado.cjs') as { argumentos: (a: string[]) => unknown };
    assert.deepEqual(man.argumentos([]), { aplicar: false, enviar: false });
    assert.throws(() => man.argumentos(['--enviar-emails']), /exige --aplicar/);
    assert.throws(() => man.argumentos(['--forcar']), /desconhecido/);
    assert.deepEqual(corte.argumentos(['--empresa', pedido]), { empresa: pedido, aplicar: false, autorizacao: null });
    assert.throws(() => corte.argumentos(['--empresa', pedido, '--aplicar']), /exige --autorizacao/);
    assert.throws(() => corte.argumentos(['--empresa', pedido, '--aplicar', '--autorizacao', 'x;rm -rf /']), /exige --autorizacao/);
    assert.throws(() => corte.argumentos(['--empresa', 'todas']), /--empresa <uuid>/);
    assert.deepEqual(corte.argumentos(['--empresa', pedido, '--aplicar', '--autorizacao', 'Felipe 22/10 corte piloto']), { empresa: pedido, aplicar: true, autorizacao: 'Felipe 22/10 corte piloto' });
});
