import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSENTIMENTO_MCP, destinoAposLogin, loginComRetorno } from './retorno-login.ts';

// UX-1 (teste real de 28/10/2026): quem não estava logado perdia o pedido de consentimento do canal MCP.
const PEDIDO = `kmp_${'A'.repeat(43)}`;
const CONSENTIMENTO = `${CONSENTIMENTO_MCP}?pedido=${PEDIDO}`;

test('UX-1: sem sessão no consentimento, o login guarda o retorno com o pedido; nas outras telas, login simples', () => {
    assert.equal(loginComRetorno(CONSENTIMENTO_MCP, `?pedido=${PEDIDO}`), `/admin/login?voltar=${encodeURIComponent(CONSENTIMENTO)}`);
    assert.equal(loginComRetorno('/admin/dashboard', ''), '/admin/login');
    assert.equal(loginComRetorno(CONSENTIMENTO_MCP, ''), '/admin/login', 'sem pedido');
    assert.equal(loginComRetorno(CONSENTIMENTO_MCP, '?pedido=kmp_curto'), '/admin/login', 'pedido fora do formato');
    assert.equal(loginComRetorno(CONSENTIMENTO_MCP, `?pedido=${PEDIDO}%26x%3D1`), '/admin/login', 'pedido com carga extra');
});

test('UX-1: depois do login, volta ao consentimento só no formato exato; regra antiga dos caminhos intacta', () => {
    assert.equal(destinoAposLogin(CONSENTIMENTO), CONSENTIMENTO);
    for (const recusado of [
        `${CONSENTIMENTO}&x=1`,
        `${CONSENTIMENTO_MCP}?pedido=${PEDIDO}#f`,
        `${CONSENTIMENTO_MCP}?outro=${PEDIDO}`,
        `/admin/clientes?pedido=${PEDIDO}`,
        `https://evil.example${CONSENTIMENTO}`,
        `//evil.example${CONSENTIMENTO}`,
        '/admin//evil',
        '/admin/login',
        '',
    ]) assert.equal(destinoAposLogin(recusado), '/admin/dashboard', recusado);
    assert.equal(destinoAposLogin('/admin/conexoes-ia'), '/admin/conexoes-ia');
    assert.equal(destinoAposLogin('/desenvolvedor'), '/desenvolvedor');
});
