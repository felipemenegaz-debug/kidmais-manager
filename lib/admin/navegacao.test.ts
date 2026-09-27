import assert from 'node:assert/strict';
import test from 'node:test';
import { itemAtivo, itensNavegacao } from './navegacao.ts';

test('a navegação só lista páginas existentes e esconde configuração sem Gestão', () => {
    const operacao = itensNavegacao(false);
    assert.deepEqual(operacao.map((item) => item.href), ['/clientes', '/admin/contratos', '/admin/festas', '/admin/disponibilidade']);
    assert.equal(operacao.some((item) => item.href.startsWith('/admin/configuracoes')), false);
    const gestao = itensNavegacao(true);
    assert.equal(gestao.some((item) => item.href === '/admin/configuracoes/perfil-empresa'), true);
    assert.equal(gestao.some((item) => item.href.includes('inexistente')), false);
    assert.equal(gestao.some((item) => item.rotulo === 'Tabelas de Preços' || item.href.includes('tabelas-preco')), false);
    const configuracao = gestao.filter((item) => item.grupo === 'Configurações').map((item) => item.rotulo);
    assert.deepEqual(configuracao, [
        'Configurações',
        'Perfil da empresa',
        'Pacotes',
        'Itens do Buffet',
        'Usuários e acessos',
        'WhatsApp',
        'PDF de Pacotes',
    ]);
    assert.equal(configuracao.indexOf('Itens do Buffet'), configuracao.indexOf('Pacotes') + 1);
});

test('o item ativo é o link mais específico', () => {
    const itens = itensNavegacao(true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes/perfil-empresa', itens), true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes', itens), false);
    assert.equal(itemAtivo('/admin/festas/1', '/admin/festas', itens), true);
    assert.equal(itemAtivo('/admin/login', '/admin/contratos', itens), false);
});
