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
    assert.match(ui, /Contas desativadas/);
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
    assert.match(ui, /Desativadas/);
    assert.match(ui, /Alterar acesso às Festas/);
    assert.match(ui, /Desativar conta de /);
    assert.match(ui, /Este e-mail já está sendo usado por outra pessoa/);
    assert.match(ui, /Você define a senha inicial/);
    assert.match(ui, /Nenhum resultado encontrado/);
    assert.match(ui, /Estas pessoas não podem mais entrar no sistema/);
    assert.doesNotMatch(ui, /<img/);
    assert.doesNotMatch(ui, /unsplash|avatar\.png|pravatar/i);
    assert.doesNotMatch(ui, /Mostrando \d+ de \d+/);
    assert.doesNotMatch(ui, /Ver mais pessoas/);
    assert.doesNotMatch(ui, /convite por e-mail|redefinir senha|password reset/i);
    assert.match(css, /max-width:800px/);
    assert.match(css, /\.drawer\{width:100%\}/);
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
    assert.match(rota, /desativarUsuarioAdministrativo/);
});
