/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da pós-conferência: nenhuma conexão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const p = require('./navegador-local-posconferencia.cjs');

test('pós-conferência: só SELECT em transação READ ONLY, sem colunas pessoais na saída', () => {
    for (const sql of Object.values(p.CONSULTAS)) {
        assert.match(sql.trim(), /^SELECT /);
        assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT)\b/i);
        // Colunas devolvidas (a subconsulta de CPF só conta, não devolve o CPF).
        const projecao = sql.trim().slice('SELECT '.length, sql.trim().search(/\sFROM\s/)).replace(/count\([^)]*\)/gi, 'count');
        assert.doesNotMatch(projecao, /nome|email|telefone|whatsapp|\bcpf\b/i, projecao);
    }
    const fonte = fs.readFileSync(path.join(__dirname, 'navegador-local-posconferencia.cjs'), 'utf8');
    assert.match(fonte, /BEGIN READ ONLY/);
    assert.match(fonte, /seed\.alvo\(env\)/);
    assert.match(fonte, /conferirIdentidade/);
});

test('pós-conferência: CONFERE só com 1 pedido AGUARDANDO_CONTRATO por endereço, CPF em duas empresas e nada confirmado', () => {
    const base = {
        pedidos:p.EMPRESAS_PEDIDO.map(codigo => ({codigo, origem:'CLIENTE', status:'AGUARDANDO_CONTRATO', n:1})),
        clientes:p.EMPRESAS_PEDIDO.map(codigo => ({codigo, n:1, com_cpf:1})), cpfEntreEmpresas:1, festasConfirmadas:0,
    };
    assert.equal(p.resumir(base).resultado, 'CONFERE');
    assert.equal(p.resumir({...base, festasConfirmadas:1}).resultado, 'DIVERGE');
    assert.equal(p.resumir({...base, cpfEntreEmpresas:0}).resultado, 'DIVERGE');
    assert.equal(p.resumir({...base, pedidos:[...base.pedidos, {codigo:'nav-essencial', origem:'CLIENTE', status:'AGUARDANDO_CONTRATO', n:1}]}).resultado, 'DIVERGE');
    assert.equal(p.resumir({...base, pedidos:base.pedidos.map(x => ({...x, status:'AGUARDANDO_APROVACAO'}))}).resultado, 'DIVERGE');
    assert.equal(p.resumir({...base, pedidos:base.pedidos.slice(1)}).resultado, 'DIVERGE');
});
