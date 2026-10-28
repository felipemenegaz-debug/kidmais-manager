import assert from 'node:assert/strict';
import test from 'node:test';
import { FORMATO_PROPOSTA, gerado, hashCanonico, hashProposta, mesmaProposta, ordenarEfeitos, serializarCanonico, ValorNaoCanonico, type Efeito, type Proposta } from './recuperacao-hash.ts';

/** B-14 (§3.4): serialização canônica e hash da proposta. Sem banco nem rede. */

test('chaves ordenadas em qualquer profundidade; mesma estrutura, mesmo texto', () => {
    assert.equal(serializarCanonico({ b: 1, a: { d: [2, 'x'], c: null } }), '{"a":{"c":null,"d":[2,"x"]},"b":1}');
    assert.equal(hashCanonico({ x: 1, y: 2 }), hashCanonico({ y: 2, x: 1 }));
    assert.notEqual(hashCanonico([1, 2]), hashCanonico([2, 1]), 'lista mantém a ordem dada');
});

test('recusa número não inteiro, NaN, undefined, Date e objeto não plano', () => {
    for (const ruim of [{ v: 1.5 }, { v: Number.NaN }, { v: undefined }, { v: new Date(0) }, { v: new Map() }, { v: () => 1 }, { v: 2 ** 60 }])
        assert.throws(() => serializarCanonico(ruim), ValorNaoCanonico, JSON.stringify(Object.keys(ruim)));
});

test('valor gerado na execução entra pelo tipo, não pelo valor', () => {
    assert.equal(serializarCanonico({ creditado_em: gerado('instante') }), '{"creditado_em":{"$gerado":"instante"}}');
    assert.notEqual(hashCanonico({ id: gerado('id') }), hashCanonico({ id: gerado('instante') }));
});

const efeitos: Efeito[] = [
    { tabela: 'ia_credito_pedidos', chave: 'p1', operacao: 'UPDATE', colunas: { estado: { antes: 'AGUARDANDO_PAGAMENTO', depois: 'CREDITADO' } } },
    { tabela: 'ia_credito_lotes', chave: '$lote', operacao: 'INSERT', colunas: { vence_em: { antes: null, depois: '2027-01-20' }, criado_em: { antes: null, depois: gerado('instante') } } },
];
const proposta = (extra: Partial<Proposta> = {}): Proposta => ({ formato: FORMATO_PROPOSTA, caso: 'c1', precondicoes: { status: 'RECEIVED', estornos: [] }, efeitos, ...extra });

test('hash da proposta independe da ordem dos efeitos e muda com qualquer pré-condição ou efeito', () => {
    const h = hashProposta(proposta());
    assert.equal(hashProposta(proposta({ efeitos: [...efeitos].reverse() })), h);
    assert.notEqual(hashProposta(proposta({ precondicoes: { status: 'RECEIVED', estornos: [{ valor: 100 }] } })), h);
    const outra = efeitos.map((e) => e.chave === '$lote' ? { ...e, colunas: { ...e.colunas, vence_em: { antes: null, depois: '2027-01-21' } } } : e);
    assert.notEqual(hashProposta(proposta({ efeitos: outra })), h, 'valor comercial diferente');
    const semNotif = proposta({ efeitos: [...efeitos, { tabela: 'ia_credito_notificacoes', chave: 'PAGAMENTO_CONFIRMADO:p1', operacao: 'INSERT', colunas: {} }] });
    assert.notEqual(hashProposta(semNotif), h, 'efeito operacional a mais também muda o contrato');
    assert.deepEqual(ordenarEfeitos(efeitos).map((e) => e.tabela), ['ia_credito_lotes', 'ia_credito_pedidos']);
});

test('mesmaProposta: só hash bem formado e payload idêntico; formato errado recusado', () => {
    const h = hashProposta(proposta());
    assert.equal(mesmaProposta(h, proposta()), true);
    assert.equal(mesmaProposta(h.toUpperCase(), proposta()), false);
    assert.equal(mesmaProposta('abc', proposta()), false);
    assert.equal(mesmaProposta(h, proposta({ caso: 'c2' })), false);
    assert.throws(() => hashProposta(proposta({ formato: 2 })), ValorNaoCanonico);
});
