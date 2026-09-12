import assert from 'node:assert/strict';
import test from 'node:test';

import { conferirSenha, criarHashSenha, senhaValida } from './senha.ts';

test('política administrativa recusa sete caracteres e aceita oito', () => {
    assert.equal(senhaValida('1234567'), false);
    assert.equal(senhaValida('12345678'), true);
});

test('senha simples com oito caracteres não exige composição', () => {
    assert.equal(senhaValida('aaaaaaaa'), true);
});

test('criação e conferência preservam o hash scrypt usado pelo login', async () => {
    await assert.rejects(criarHashSenha('1234567'), /entre 8 e 128 caracteres/);

    const hash = await criarHashSenha('aaaaaaaa');
    assert.match(hash, /^scrypt\$v=1\$N=131072\$r=8\$p=1\$/);
    assert.equal(await conferirSenha('aaaaaaaa', hash), true);
    assert.equal(await conferirSenha('bbbbbbbb', hash), false);
});
