import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { celula, csv } from './csv.ts';

test('CSV: separador ;, BOM UTF-8, aspas quando preciso e neutralização de fórmula para planilhas', () => {
    assert.equal(celula(null), '');
    assert.equal(celula('Ana'), 'Ana');
    assert.equal(celula('Rua A; 10'), '"Rua A; 10"');
    assert.equal(celula('diz "oi"'), '"diz ""oi"""');
    assert.equal(celula('linha\nquebrada'), '"linha\nquebrada"');
    for (const perigosa of ['=HYPERLINK("x")', '+55', '-1', '@SUM(A1)'])
        assert.ok(celula(perigosa).replace(/^"/, '').startsWith("'"), perigosa);
    const arquivo = csv(['Nome', 'Valor'], [['Ana', '10,00'], ['=1+1', null]]);
    assert.ok(arquivo.startsWith('﻿Nome;Valor\r\n'));
    assert.ok(arquivo.includes("'=1+1;"));
});

test('exportação: só Gestão, auditada sem conteúdo, rota sempre permitida pelo paywall e sem serviço que escreva', () => {
    const fonte = readFileSync('lib/assinatura/exportacao.ts', 'utf8');
    assert.match(fonte, /exigirGestaoNoTenant\(tenant,/);
    assert.match(fonte, /acao: 'EXPORTACAO_DADOS'/);
    assert.doesNotMatch(fonte, /listarContasPagar|garantirCategorias|INSERT INTO (?!auditoria)|UPDATE |DELETE /);
    assert.match(fonte, /WHERE empresa_id = \$1::uuid/);
    const rota = readFileSync('app/api/admin/exportacao/route.ts', 'utf8');
    assert.match(rota, /withTenantTransaction\(sessao,/);
    assert.match(rota, /"Cache-Control": "no-store"/);
    assert.match(readFileSync('lib/assinatura/paywall.ts', 'utf8'), /'\/api\/admin\/exportacao'/);
});
