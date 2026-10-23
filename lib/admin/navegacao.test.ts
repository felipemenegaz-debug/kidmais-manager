import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { configuracaoVisivel, itemAtivo, itensNavegacao } from './navegacao.ts';

test('a navegação só lista páginas existentes e esconde configuração sem Gestão', () => {
    const operacao = itensNavegacao(false);
    assert.deepEqual(operacao.map((item) => item.href), [
        '/admin/dashboard',
        '/clientes',
        '/admin/contratos',
        '/admin/festas',
        '/admin/disponibilidade',
        '/admin/atendimento',
        '/admin/marketing',
        '/admin/marketing/campanhas',
        '/admin/marketing/origens',
        '/admin/marketing/site',
        '/admin/marketing/automacoes',
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
        'Agenda',
        'Pacotes',
        'Itens do Buffet',
        'Usuários e acessos',
        'WhatsApp',
        'Créditos de IA',
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

test('Marketing: some sem o recurso/capacidade (marketing: false); aparece no menu principal quando liberado', () => {
    const marketing = (valor?: boolean) => itensNavegacao({ gestaoEmpresa: false, plataforma: false, marketing: valor }).filter((i) => i.grupo === 'Marketing').map((i) => i.rotulo);
    assert.deepEqual(marketing(false), []);
    assert.deepEqual(marketing(true), ['Visão geral', 'Campanhas', 'Origens dos contatos', 'Site e SEO', 'Automações']);
    assert.equal(itemAtivo('/admin/marketing/site/previa', '/admin/marketing/site', itensNavegacao(true)), true);
    assert.equal(itemAtivo('/admin/marketing/site', '/admin/marketing', itensNavegacao(true)), false);
});

test('o item ativo é o link mais específico', () => {
    const itens = itensNavegacao(true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes/perfil-empresa', itens), true);
    assert.equal(itemAtivo('/admin/configuracoes/perfil-empresa', '/admin/configuracoes', itens), false);
    assert.equal(itemAtivo('/admin/festas/1', '/admin/festas', itens), true);
    assert.equal(itemAtivo('/admin/login', '/admin/contratos', itens), false);
});

test('hub de Configurações: cartões da plataforma só para a plataforma; da empresa só para Gestão (mesma regra do menu)', () => {
    const empresaSemPlataforma = { gestaoEmpresa: true, plataforma: false };
    // 083: o WhatsApp é da empresa — a Gestão de uma contratante vê e conecta o próprio número.
    assert.equal(configuracaoVisivel('/admin/configuracoes/whatsapp', empresaSemPlataforma), true, 'Gestão da contratante vê o WhatsApp da empresa');
    assert.equal(configuracaoVisivel('/admin/configuracoes/tabela-pacotes', empresaSemPlataforma), false);
    assert.equal(configuracaoVisivel('/admin/configuracoes/perfil-empresa', empresaSemPlataforma), true);
    const equipe = { gestaoEmpresa: false, plataforma: false };
    assert.equal(configuracaoVisivel('/admin/configuracoes/acessos', equipe), false);
    // 093: a tela da agenda é de Gestão (o assistente da primeira entrada é de qualquer usuário, fora do hub).
    assert.equal(configuracaoVisivel('/admin/configuracoes/agenda', equipe), false);
    assert.equal(configuracaoVisivel('/admin/configuracoes/agenda', empresaSemPlataforma), true);
    assert.equal(configuracaoVisivel('/admin/configuracoes/whatsapp', equipe), false, 'Equipe não configura o WhatsApp');
    const plataforma = { gestaoEmpresa: false, plataforma: true };
    assert.equal(configuracaoVisivel('/admin/configuracoes/whatsapp', plataforma), false, 'a plataforma sem Gestão na empresa não configura o WhatsApp dela');
    assert.equal(configuracaoVisivel('/admin/configuracoes/tabela-pacotes', plataforma), true);
    // Rota sem autoridade registrada continua visível; sem as permissões do shell, nada muda.
    assert.equal(configuracaoVisivel('/admin/configuracoes/importar-tabela', equipe), true);
    assert.equal(configuracaoVisivel('/admin/configuracoes/whatsapp', null), true);
    // Para toda rota do menu, o cartão segue exatamente o item do menu.
    for (const p of [empresaSemPlataforma, equipe, plataforma, { gestaoEmpresa: true, plataforma: true }]) {
        const menu = new Set(itensNavegacao(p).map((i) => i.href));
        for (const href of ['/admin/configuracoes/perfil-empresa', '/admin/configuracoes/agenda', '/admin/configuracoes/pacotes', '/admin/configuracoes/catalogo', '/admin/configuracoes/acessos', '/admin/configuracoes/whatsapp', '/admin/configuracoes/tabela-pacotes'])
            assert.equal(configuracaoVisivel(href, p), menu.has(href), href);
    }
});

test('o hub filtra os cartões pelas permissões do shell, e a tela do WhatsApp mostra o motivo real da recusa', () => {
    const pagina = readFileSync('app/admin/configuracoes/page.tsx', 'utf8');
    assert.ok(pagina.includes('<CartoesConfiguracoes cards={cards} />'));
    const cartoes = readFileSync('components/admin/CartoesConfiguracoes.tsx', 'utf8');
    assert.ok(cartoes.includes("configuracaoVisivel('/admin/configuracoes/' + card.route, permissoes)"));
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.ok(shell.includes('<PermissoesAdminContext.Provider value={permissoes}>{children}</PermissoesAdminContext.Provider>'));
    const whatsapp = readFileSync('components/admin/WhatsappConfiguracao.tsx', 'utf8');
    assert.ok(!whatsapp.includes("catch { if (ativo) setErro('Não foi possível carregar"), 'não esconde a mensagem do servidor');
    assert.ok(whatsapp.includes('falhaCarga ? null : <p>Carregando…</p>'), 'sem "Carregando…" depois da falha');
});
