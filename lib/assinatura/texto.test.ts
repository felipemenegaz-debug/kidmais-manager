import assert from 'node:assert/strict';
import test from 'node:test';
import { dias } from './texto.ts';

test('duração do teste: singular só para 1 dia', () => {
    assert.equal(dias(1), '1 dia');
    assert.equal(dias(2), '2 dias');
    assert.equal(dias(15), '15 dias');
    assert.equal(dias(90), '90 dias');
});

test('telas públicas usam o texto com singular/plural (nada de "1 dias")', async () => {
    const { readFileSync } = await import('node:fs');
    for (const arquivo of ['app/planos/page.tsx', 'app/cadastro/page.tsx']) {
        const fonte = readFileSync(arquivo, 'utf8');
        assert.match(fonte, /from '@\/lib\/assinatura\/texto'/, arquivo);
        assert.doesNotMatch(fonte, /\$\{(situacao\.)?testeDias\} dias/, arquivo);
    }
});
