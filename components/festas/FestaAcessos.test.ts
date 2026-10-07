import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ui = readFileSync('components/festas/FestaAcessos.tsx', 'utf8');
const css = readFileSync('components/festas/acessos.module.css', 'utf8');
const browser = readFileSync('scripts/festa-016-browser.cjs', 'utf8');

test('a tela de acessos cria contas pela API administrativa e não pede SQL no terminal', () => {
    assert.match(ui, /\/api\/admin\/configuracoes\/usuarios/);
    assert.match(ui, /Papel no sistema/);
    assert.match(ui, /Acesso às Festas/);
    assert.match(ui, /Pessoas removidas desta empresa/);
    assert.match(ui, /Sua conta/);
    assert.match(ui, /acesso inicial às Festas/);
    assert.doesNotMatch(ui, /provisionamento administrativo no terminal/);
    assert.match(ui, /recurso=perfis/);
});

test('layout unifica lista, busca, abas e painel Adicionar pessoa', () => {
    assert.match(ui, /Adicionar pessoa/);
    assert.match(ui, /role="dialog"/);
    assert.match(ui, /Buscar por nome ou e-mail/);
    assert.match(ui, /aria-selected=\{aba==='ativas'\}/);
    assert.match(ui, /Removidas/);
    assert.match(ui, /Alterar acesso às Festas/);
    assert.match(ui, /Remover desta empresa: /);
    // 056: a tela nunca desativa a identidade global.
    assert.doesNotMatch(ui, /acao:'desativar'/);
    assert.match(ui, /acao:'remover'/);
    // 057: assinatura de contratos pela empresa é concedida/retirada por membership, só para Gestão desta empresa.
    assert.match(ui, /acao:'assinatura',usuarioId:conta\.id,conceder/);
    assert.match(ui, /conta\.nivelSistema==='Gestão'&&<button[^\n]*?alternarAssinatura\(conta\);\}\}>\{conta\.podeAssinar\?'Retirar assinatura de contratos':'Permitir assinar contratos'\}/);
    assert.match(ui, /<dt>Assina contratos<\/dt>/);
    // F2: nenhuma mensagem diz que o e-mail já existia no Kidmais; a confirmação é a mesma nos dois casos.
    assert.doesNotMatch(ui, /já está sendo usado|já existe uma conta/i);
    assert.match(ui, /Acesso a esta empresa concedido\. Se a pessoa já usa o Kidmais, ela entra com a senha que já tem\./);
    assert.match(ui, /Você define a senha inicial/);
    assert.match(ui, /Nenhum resultado encontrado/);
    assert.match(ui, /Estas pessoas não acessam mais esta empresa/);
    assert.doesNotMatch(ui, /<img/);
    assert.doesNotMatch(ui, /unsplash|avatar\.png|pravatar/i);
    assert.doesNotMatch(ui, /Mostrando \d+ de \d+/);
    assert.doesNotMatch(ui, /Ver mais pessoas/);
    assert.doesNotMatch(ui, /redefinir senha|password reset/i);
    // E1: convite por e-mail é o caminho padrão; a senha definida pela Gestão só aparece se a criação direta estiver permitida.
    assert.match(ui, /acao:'convidar'/);
    assert.match(ui, /Convidar por e-mail/);
    assert.match(ui, /setModo\(convitesDisponiveis\?'convite':'senha'\)/);
    assert.match(ui, /convitesDisponiveis&&criacaoDireta&&<fieldset/);
    assert.match(ui, /Convites pendentes/);
    assert.match(ui, /acao,conviteId:convite\.id/);
    assert.match(ui, /Convite criado, mas o e-mail não foi enviado/);
    assert.match(css, /max-width:800px/);
    assert.match(css, /\.drawer\{width:100%\}/);
    assert.doesNotMatch(ui, /festa\.module\.css/);
    assert.doesNotMatch(ui, /menuHint/);
});

test('menu de ações permanece acionável no teste de navegação das Festas', () => {
    assert.match(browser, /Ações de '\+users\[0\]\.name/);
    assert.match(browser, /menuitem/);
    assert.match(browser, /section\[aria-label="Alterar acesso"\]/);
});

test('alterar acesso às Festas não atualiza o papel em usuarios_administrativos', () => {
    const service = readFileSync('lib/festas/service.ts', 'utf8');
    assert.match(service, /nivelSistema:nomePapelSistema/);
    assert.match(service, /perfil:nomePerfil/);
    assert.doesNotMatch(service, /UPDATE usuarios_administrativos SET papel/);
    const aplicar = service.slice(service.indexOf('export async function aplicarPerfil'), service.indexOf('export async function consultarPerfis'));
    assert.doesNotMatch(aplicar, /usuarios_administrativos SET/);
});

test('rota de usuários exige sessão administrativa e CSRF nas escritas', () => {
    const rota = readFileSync('app/api/admin/configuracoes/usuarios/route.ts', 'utf8');
    assert.equal((rota.match(/exigirApiAdminCrmDisponivel\(request\)/g) ?? []).length, 2);
    assert.match(rota, /criarUsuarioAdministrativo/);
    // 056: a rota de tenant remove a membership; desativar a identidade global é ação de plataforma.
    assert.match(rota, /removerDaEmpresa/);
    assert.match(rota, /alterarPapelNaEmpresa/);
    assert.doesNotMatch(rota, /desativarUsuarioAdministrativo/);
    assert.match(rota, /ACAO_DE_PLATAFORMA/);
    assert.match(rota, /searchParams\.get\('empresaId'\)/);
});
