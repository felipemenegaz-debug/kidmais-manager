import assert from 'node:assert/strict';
import test from 'node:test';
import { chavesForaDaLista, LEITURAS_PERMITIDAS, provedorSomenteLeitura } from './recuperacao-provedor.ts';
import { ASAAS_SANDBOX_URL, criarClienteAsaas, PREFIXO_CHAVE_SANDBOX } from './asaas.ts';

/** B-14 (§3.1): lista fechada do provedor somente leitura. Sem rede: o cliente real é montado, mas nenhum método é chamado. */

test('do cliente Asaas real só passam as leituras da lista fechada', () => {
    const cliente = criarClienteAsaas({ ambiente: 'sandbox', baseUrl: ASAAS_SANDBOX_URL, apiKey: `${PREFIXO_CHAVE_SANDBOX}teste`, webhookToken: 'x'.repeat(32) });
    const p = provedorSomenteLeitura(cliente);
    assert.deepEqual(chavesForaDaLista(p), []);
    for (const escrita of ['removerAssinatura', 'criarCliente', 'criarAssinatura', 'criarCobrancaAvulsa', 'estornarCobranca',
        'atualizarValorAssinatura', 'atualizarValorCobranca', 'suspenderGeracao', 'buscarClientePorReferencia'])
        assert.equal((p as Record<string, unknown>)[escrita], undefined, escrita);
    for (const leitura of ['obterAssinatura', 'listarCobrancasDaAssinatura', 'obterCobranca', 'listarCobrancasPorReferencia', 'listarAssinaturasPorReferencia'])
        assert.equal(typeof (p as Record<string, unknown>)[leitura], 'function', leitura);
});

test('o objeto é congelado: um adaptador não consegue acrescentar escrita depois', () => {
    const p = provedorSomenteLeitura({ obterCobranca: async () => null, removerAssinatura: async () => ({ removida: true }) });
    assert.deepEqual(Object.keys(p), ['obterCobranca']);
    assert.throws(() => { (p as Record<string, unknown>).removerAssinatura = async () => ({ removida: true }); }, TypeError);
});

test('os métodos ficam ligados ao cliente de origem', async () => {
    const cliente = { prefixo: 'x', async obterCobranca(this: { prefixo: string }, id: string) { return `${this.prefixo}:${id}`; } };
    assert.equal(await (provedorSomenteLeitura(cliente).obterCobranca as unknown as (id: string) => Promise<string>)('pay_1'), 'x:pay_1');
});

test('chavesForaDaLista acusa qualquer chave estranha, mesmo inofensiva', () => {
    assert.deepEqual(chavesForaDaLista({ obterCobranca: 1, removerAssinatura: 1, zeta: 1 }), ['removerAssinatura', 'zeta']);
    assert.equal(LEITURAS_PERMITIDAS.length, 7);
});
