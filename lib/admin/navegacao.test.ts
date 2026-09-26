import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { GRUPOS_NAVEGACAO, gruposNavegacao, itemAtivo, itensNavegacao } from './navegacao.ts';

test('a navegação só lista páginas existentes e esconde configuração sem Gestão', () => {
    const operacao = itensNavegacao(false);
    assert.deepEqual(operacao.map((item) => item.href), ['/clientes', '/admin/contratos', '/admin/festas', '/admin/disponibilidade']);
    assert.equal(operacao.some((item) => item.href.startsWith('/admin/configuracoes')), false);
    const gestao = itensNavegacao(true);
    assert.equal(gestao.some((item) => item.href === '/admin/configuracoes/perfil-empresa'), true);
    assert.equal(gestao.some((item) => item.href.includes('inexistente')), false);
    for (const item of gestao)
        assert.equal(existsSync(new URL(`../../app${item.href}/page.tsx`, import.meta.url)), true, `${item.href} sem page.tsx`);
});

test('a configuração mantém os destinos e rótulos atuais', () => {
    assert.deepEqual(itensNavegacao(true).filter((item) => item.grupo === 'Configuração').map((item) => [item.href, item.rotulo]), [
        ['/admin/configuracoes', 'Configurações'],
        ['/admin/configuracoes/perfil-empresa', 'Perfil da empresa'],
        ['/admin/configuracoes/acessos', 'Usuários e acessos'],
        ['/admin/configuracoes/whatsapp', 'WhatsApp'],
        ['/admin/configuracoes/tabela-pacotes', 'Tabela de pacotes'],
        ['/admin/configuracoes/catalogo', 'Buffet e adicionais'],
    ]);
});

test('destinos sem rota do menu pretendido não aparecem', () => {
    const rotulos = itensNavegacao(true).map((item) => item.rotulo);
    for (const ausente of ['Dashboard', 'Solicitações', 'Pacotes', 'Tabelas de Preços', 'Itens de Buffet', 'Segurança'])
        assert.equal(rotulos.includes(ausente), false, ausente);
});

test('os grupos seguem a arquitetura e omitem grupos vazios', () => {
    assert.deepEqual([...GRUPOS_NAVEGACAO], ['Principal', 'Operação', 'Configuração']);
    assert.deepEqual(gruposNavegacao(itensNavegacao(true)).map((secao) => secao.grupo), ['Operação', 'Configuração']);
    assert.deepEqual(gruposNavegacao(itensNavegacao(false)).map((secao) => secao.grupo), ['Operação']);
    const itens = gruposNavegacao(itensNavegacao(true)).flatMap((secao) => secao.itens);
    assert.deepEqual(itens, itensNavegacao(true));
});

test('o item ativo é o link mais específico', () => {
    const itens = itensNavegacao(true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes/perfil-empresa', itens), true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes', itens), false);
    assert.equal(itemAtivo('/admin/festas/1', '/admin/festas', itens), true);
    assert.equal(itemAtivo('/admin/login', '/admin/contratos', itens), false);
});
