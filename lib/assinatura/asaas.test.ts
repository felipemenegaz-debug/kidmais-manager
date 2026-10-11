import test from 'node:test';
import assert from 'node:assert/strict';
import { ASAAS_PRODUCAO_URL, ASAAS_SANDBOX_URL, AsaasFalhou, ambienteAsaas, clienteAsaasDoAmbiente, configuracaoAsaas, criarClienteAsaas, urlDeFaturaValida, type ConfiguracaoAsaas } from './asaas.ts';

/** Cliente Asaas com fetch FALSO: nenhuma chamada de rede acontece neste arquivo. */
const CHAVE = '$aact_hmlg_000000000000000000000000000000chave_de_teste';
const TOKEN = 'token-webhook-de-teste-com-32-caracteres!';
const env = { ASAAS_AMBIENTE: 'sandbox', ASAAS_API_KEY: CHAVE, ASAAS_WEBHOOK_TOKEN: TOKEN };
const config = (configuracaoAsaas(env) as { ligado: true; config: ConfiguracaoAsaas }).config;

type Chamada = { url: string; init: RequestInit };
function fetchFalso(respostas: Array<(c: Chamada) => Response | Promise<Response>>) {
    const chamadas: Chamada[] = [];
    let i = 0;
    const f = async (url: string, init: RequestInit) => {
        const c = { url, init };
        chamadas.push(c);
        const r = respostas[Math.min(i++, respostas.length - 1)];
        return r(c);
    };
    return { f, chamadas };
}
const json = (corpo: unknown, status = 200) => () => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

test('configuração: sandbox fora de produção; chave com prefixo de sandbox; token 32–255; motivo explícito sem expor valores', () => {
    assert.deepEqual(configuracaoAsaas({}), { ligado: false, motivo: 'AMBIENTE_AUSENTE' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_AMBIENTE: 'producao' }), { ligado: false, motivo: 'AMBIENTE_DIVERGENTE' }, 'produção fora do serviço de produção');
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_AMBIENTE: 'producao', KIDMAIS_DEPLOY_ENV: 'staging' }), { ligado: false, motivo: 'AMBIENTE_DIVERGENTE' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_AMBIENTE: 'production' }), { ligado: false, motivo: 'AMBIENTE_NAO_SUPORTADO' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_API_KEY: '' }), { ligado: false, motivo: 'CHAVE_AUSENTE' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_API_KEY: '$aact_prod_000000000000000000' }), { ligado: false, motivo: 'CHAVE_FORA_DO_SANDBOX' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_WEBHOOK_TOKEN: 'curto' }), { ligado: false, motivo: 'TOKEN_WEBHOOK_INVALIDO' });
    assert.deepEqual(configuracaoAsaas({ ...env, ASAAS_WEBHOOK_TOKEN: 'x'.repeat(256) }), { ligado: false, motivo: 'TOKEN_WEBHOOK_INVALIDO' });
    assert.equal(configuracaoAsaas(env).ligado, true);
    assert.equal(config.baseUrl, ASAAS_SANDBOX_URL);
    assert.equal(clienteAsaasDoAmbiente({ ...env, ASAAS_API_KEY: '$aact_prod_x' }).cliente, null);
    assert.throws(() => criarClienteAsaas({ ...config, apiKey: '$aact_prod_000' }), /mesmo ambiente/);
    assert.throws(() => criarClienteAsaas({ ...config, baseUrl: 'https://api.asaas.com/v3' }), /mesmo ambiente/);
    assert.throws(() => criarClienteAsaas({ ...config, ambiente: 'outro' as never }), /mesmo ambiente/);
});

test('produção: só no serviço de produção, só com chave de produção e URL de produção; sandbox recusado lá', () => {
    const CHAVE_PROD = '$aact_prod_000000000000000000000000000000chave_de_teste';
    const prod = { ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: CHAVE_PROD, ASAAS_WEBHOOK_TOKEN: TOKEN, KIDMAIS_DEPLOY_ENV: 'production' };
    const estado = configuracaoAsaas(prod);
    assert.equal(estado.ligado, true);
    const c = (estado as { ligado: true; config: ConfiguracaoAsaas }).config;
    assert.deepEqual({ ambiente: c.ambiente, baseUrl: c.baseUrl }, { ambiente: 'producao', baseUrl: ASAAS_PRODUCAO_URL });
    assert.ok(criarClienteAsaas(c));
    assert.deepEqual(configuracaoAsaas({ ...prod, ASAAS_API_KEY: CHAVE }), { ligado: false, motivo: 'CHAVE_FORA_DA_PRODUCAO' }, 'chave de sandbox em produção');
    assert.deepEqual(configuracaoAsaas({ ...env, KIDMAIS_DEPLOY_ENV: 'production' }), { ligado: false, motivo: 'AMBIENTE_DIVERGENTE' }, 'sandbox no serviço de produção');
    assert.deepEqual(configuracaoAsaas({ ...prod, KIDMAIS_DEPLOY_ENV: ' production ' }).ligado, true);
    assert.throws(() => criarClienteAsaas({ ...c, baseUrl: ASAAS_SANDBOX_URL }), /mesmo ambiente/);
    assert.throws(() => criarClienteAsaas({ ...c, apiKey: CHAVE }), /mesmo ambiente/);
    assert.equal(ambienteAsaas(prod), 'producao');
    assert.equal(ambienteAsaas(env), 'sandbox');
    for (const [e, motivo] of [[{}, 'AMBIENTE_AUSENTE'], [{ ASAAS_AMBIENTE: 'prod' }, 'AMBIENTE_NAO_SUPORTADO'], [{ ASAAS_AMBIENTE: 'producao' }, 'AMBIENTE_DIVERGENTE']] as const)
        assert.deepEqual(ambienteAsaas(e), { motivo });
});

test('produção: a configuração inválida nunca vaza a chave nas mensagens', () => {
    const CHAVE_PROD = '$aact_prod_segredo_que_nao_pode_aparecer_000000';
    const estado = configuracaoAsaas({ ASAAS_AMBIENTE: 'producao', ASAAS_API_KEY: CHAVE_PROD, ASAAS_WEBHOOK_TOKEN: 'curto', KIDMAIS_DEPLOY_ENV: 'production' });
    assert.equal(JSON.stringify(estado).includes('segredo'), false);
    try { criarClienteAsaas({ ambiente: 'producao', baseUrl: ASAAS_SANDBOX_URL, apiKey: CHAVE_PROD, webhookToken: TOKEN }); assert.fail('aceitou'); }
    catch (e) { assert.equal(String((e as Error).message).includes('segredo'), false); }
});

test('cabeçalhos, URL base fixa do sandbox e cliente criado com notificationDisabled e referência externa', async () => {
    const { f, chamadas } = fetchFalso([json({ object: 'list', hasMore: false, data: [] }), json({ id: 'cus_000001', externalReference: 'emp-1' })]);
    const c = criarClienteAsaas(config, { fetch: f });
    assert.equal(await c.buscarClientePorReferencia('5f1d7c1e-0000-4000-8000-000000000001'), null);
    const criado = await c.criarCliente({ nome: 'Buffet Teste', cpfCnpj: '11222333000181', referencia: '5f1d7c1e-0000-4000-8000-000000000001' });
    assert.equal(criado.id, 'cus_000001');
    assert.equal(chamadas[0].url, `${ASAAS_SANDBOX_URL}/customers?externalReference=5f1d7c1e-0000-4000-8000-000000000001&limit=10`);
    assert.equal(chamadas[1].url, `${ASAAS_SANDBOX_URL}/customers`);
    const h = chamadas[1].init.headers as Record<string, string>;
    assert.equal(h.access_token, CHAVE);
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h['User-Agent'], 'kidmais-manager');
    assert.equal(chamadas[1].init.method, 'POST');
    const corpo = JSON.parse(String(chamadas[1].init.body));
    assert.deepEqual(corpo, { name: 'Buffet Teste', cpfCnpj: '11222333000181', externalReference: '5f1d7c1e-0000-4000-8000-000000000001', notificationDisabled: true });
    assert.ok(!('email' in corpo) && !('mobilePhone' in corpo), 'nenhum contato é enviado ao provedor');
});

test('assinatura: billingType UNDEFINED, valor em reais a partir de centavos, ciclo MONTHLY/YEARLY; 404 = removida', async () => {
    const { f, chamadas } = fetchFalso([
        json({ id: 'sub_000001', status: 'ACTIVE', deleted: false, cycle: 'YEARLY', customer: 'cus_000001', externalReference: 'e1' }),
        () => new Response('{"errors":[{"description":"nao encontrado"}]}', { status: 404 }),
        json({ deleted: true, id: 'sub_000001' }),
        json({ object: 'list', hasMore: false, data: [{ id: 'pay_1', status: 'PENDING', dueDate: '2026-10-07', invoiceUrl: 'https://sandbox.asaas.com/i/pay_1' }, { id: 'pay_2', status: 'PENDING', dueDate: '2026-11-07', invoiceUrl: 'https://evil.example/i/pay_2' }] }),
    ]);
    const c = criarClienteAsaas(config, { fetch: f });
    const s = await c.criarAssinatura({ cliente: 'cus_000001', valorCentavos: 123456, ciclo: 'ANUAL', vencimento: '2026-10-07', referencia: 'e1', descricao: 'Kidmais' });
    assert.equal(s.id, 'sub_000001');
    assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { customer: 'cus_000001', billingType: 'UNDEFINED', value: 1234.56, nextDueDate: '2026-10-07', cycle: 'YEARLY', description: 'Kidmais', externalReference: 'e1' });
    assert.equal(await c.obterAssinatura('sub_000001'), null);
    assert.deepEqual(await c.removerAssinatura('sub_000001'), { removida: true });
    assert.equal(chamadas[2].init.method, 'DELETE');
    const pagamentos = await c.listarCobrancasDaAssinatura('sub_000001');
    assert.equal(chamadas[3].url, `${ASAAS_SANDBOX_URL}/subscriptions/sub_000001/payments?offset=0&limit=100`);
    assert.equal(pagamentos[0].invoiceUrl, 'https://sandbox.asaas.com/i/pay_1');
    assert.equal(pagamentos[1].invoiceUrl, null, 'página de pagamento fora do domínio do provedor é descartada');
    assert.equal(urlDeFaturaValida('https://www.asaas.com/i/x'), true);
    assert.equal(urlDeFaturaValida('http://www.asaas.com/i/x'), false);
    assert.equal(urlDeFaturaValida('https://asaas.com.evil.example/i/x'), false);
    await assert.rejects(c.obterAssinatura('../customers'), AsaasFalhou, 'id fora do formato nunca vira caminho');
});

test('tempo-limite: chamada que não responde é abortada e vira AsaasFalhou (TEMPO_ESGOTADO)', async () => {
    const f = (_url: string, init: RequestInit) => new Promise<Response>((_, rejeitar) => {
        init.signal?.addEventListener('abort', () => rejeitar(new DOMException('abortado', 'AbortError')));
    });
    const c = criarClienteAsaas(config, { fetch: f, tempoLimiteMs: 30 });
    const inicio = Date.now();
    await assert.rejects(c.obterAssinatura('sub_000001'), (e: unknown) => e instanceof AsaasFalhou && /TEMPO_ESGOTADO/.test(e.message));
    assert.ok(Date.now() - inicio < 2000);
});

test('erros e logs nunca levam a chave, o corpo da resposta ou dados do pagador', async () => {
    const saidas: string[] = [];
    const originais = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(originais) as (keyof typeof originais)[])
        console[k] = (...a: unknown[]) => { saidas.push(a.map(String).join(' ')); };
    try {
        const c = criarClienteAsaas(config, { fetch: async () => new Response(`{"errors":"cpfCnpj 11222333000181 ${CHAVE}"}`, { status: 400 }) });
        const erro = await c.criarCliente({ nome: 'Buffet', cpfCnpj: '11222333000181', referencia: 'e1' }).catch((e: Error) => e);
        assert.ok(erro instanceof AsaasFalhou);
        assert.equal(erro.status, 400);
        const texto = `${erro.message} ${erro.stack ?? ''} ${JSON.stringify(erro)}`;
        assert.ok(!texto.includes(CHAVE) && !texto.includes('aact') && !texto.includes('11222333000181'));
        const rede = criarClienteAsaas(config, { fetch: async () => { throw new Error(`falha ${CHAVE}`); } });
        const e2 = await rede.obterAssinatura('sub_1').catch((e: Error) => e);
        assert.ok(e2 instanceof AsaasFalhou && !e2.message.includes(CHAVE));
    }
    finally {
        Object.assign(console, originais);
    }
    assert.deepEqual(saidas, [], 'o cliente não escreve nada no console');
});
