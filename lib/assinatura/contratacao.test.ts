import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AsaasFalhou } from './asaas.ts';
import { resultadoIncerto } from './cobranca.ts';
import { extrairEvento } from './sincronizacao.ts';

test('resultado da criação: só 4xx definitivo é "não criado"; tempo, rede, 5xx, 408/409/429 e resposta ilegível são incertos', () => {
    assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', 400, 'HTTP')), false);
    assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', 401, 'HTTP')), false);
    for (const [status, motivo] of [[null, 'TEMPO_ESGOTADO'], [null, 'REDE'], [500, 'HTTP'], [503, 'HTTP'], [408, 'HTTP'], [409, 'HTTP'], [429, 'HTTP'], [200, 'RESPOSTA_INVALIDA']] as const)
        assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', status, motivo)), true, `${status} ${motivo}`);
    assert.equal(resultadoIncerto(new Error('outro')), false);
});

test('pendências internas não entram pelo webhook: tipo e prefixo reservados são recusados', () => {
    const base = { dateCreated: '2026-10-07 10:00:00', subscription: { id: 'sub_1', externalReference: '11111111-1111-4111-8111-111111111111' } };
    assert.ok(extrairEvento({ ...base, id: 'evt_1', event: 'SUBSCRIPTION_UPDATED' }));
    assert.equal(extrairEvento({ ...base, id: 'evt_2', event: 'KIDMAIS_RECONCILIAR_CONTRATACAO' }), null);
    assert.equal(extrairEvento({ ...base, id: 'kidmais:contratacao:x', event: 'SUBSCRIPTION_UPDATED' }), null);
});

test('nenhuma exclusão automática sem vínculo confirmado; falha de compensação vira pendência (nunca .catch vazio)', () => {
    const fonte = readFileSync('lib/assinatura/cobranca.ts', 'utf8');
    assert.doesNotMatch(fonte, /removerAssinatura\([^)]*\)\.catch\(\(\) => undefined\)/, 'compensação silenciosa removida');
    const resolver = fonte.slice(fonte.indexOf('async function resolverFalhaNoVinculo('));
    assert.match(resolver, /if \(typeof vinculo === 'string' && b\.criada\) \{\s*try \{\s*await provedor\.removerAssinatura/);
    assert.match(resolver, /motivo: 'COMPENSACAO_FALHOU'/);
    assert.match(fonte, /pg_try_advisory_xact_lock\(hashtext\('kidmais:contratacao'\), hashtext\(\$1\)\)/);
});
