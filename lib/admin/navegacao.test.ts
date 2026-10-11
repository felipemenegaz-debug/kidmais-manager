import assert from 'node:assert/strict';
import test from 'node:test';
import { itemAtivo, itensNavegacao } from './navegacao.ts';

test('a navegação só lista páginas existentes e esconde configuração sem Gestão', () => {
    const operacao = itensNavegacao(false);
    assert.deepEqual(operacao.map((item) => item.href), [
        '/admin/dashboard',
        '/clientes',
        '/admin/contratos',
        '/admin/festas',
        '/admin/disponibilidade',
        '/admin/financeiro',
        '/admin/financeiro/contas-receber',
        '/admin/financeiro/contas-pagar',
        '/admin/financeiro/fluxo-caixa',
        '/admin/financeiro/relatorios',
    ]);
    assert.equal(operacao.some((item) => item.href.startsWith('/admin/configuracoes')), false);
    const gestao = itensNavegacao(true);
    assert.equal(gestao.some((item) => item.href === '/admin/configuracoes/perfil-empresa'), true);
    assert.equal(gestao.some((item) => item.href.includes('inexistente')), false);
    assert.equal(gestao.some((item) => item.rotulo === 'Tabelas de Preços' || item.href.includes('tabelas-preco')), false);
    const configuracao = gestao.filter((item) => item.grupo === 'Configurações').map((item) => item.rotulo);
    assert.deepEqual(configuracao, [
        'Perfil da empresa',
        'Pacotes',
        'Itens do Buffet',
        'Usuários e acessos',
        'WhatsApp',
        'PDF de Pacotes',
    ]);
    assert.equal(configuracao.indexOf('Itens do Buffet'), configuracao.indexOf('Pacotes') + 1);
    // O grupo continua; só o item clicável redundante saiu. A rota segue acessível diretamente.
    assert.equal(gestao.some((item) => item.href === '/admin/configuracoes'), false);
});

test('plano sem financeiro completo esconde contas a pagar, fluxo e relatórios; mantém visão e contas a receber', () => {
    const financeiro = (financeiroCompleto?: boolean) => itensNavegacao({ gestaoEmpresa: true, plataforma: false, financeiroCompleto })
        .filter((item) => item.grupo === 'Financeiro').map((item) => item.href);
    assert.deepEqual(financeiro(false), ['/admin/financeiro', '/admin/financeiro/contas-receber']);
    const completo = ['/admin/financeiro', '/admin/financeiro/contas-receber', '/admin/financeiro/contas-pagar', '/admin/financeiro/fluxo-caixa', '/admin/financeiro/relatorios'];
    assert.deepEqual(financeiro(true), completo);
    assert.deepEqual(financeiro(undefined), completo, 'sem informação do plano (teste, legado, isenta) nada é escondido');
    assert.equal(itensNavegacao({ gestaoEmpresa: true, plataforma: false, financeiroCompleto: false }).some((i) => i.href === '/admin/configuracoes/perfil-empresa'), true);
});

test('o item ativo é o link mais específico', () => {
    const itens = itensNavegacao(true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes/perfil-empresa', itens), true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes', itens), false);
    assert.equal(itemAtivo('/admin/festas/1', '/admin/festas', itens), true);
    assert.equal(itemAtivo('/admin/login', '/admin/contratos', itens), false);
});
