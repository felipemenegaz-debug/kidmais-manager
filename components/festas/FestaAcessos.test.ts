import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('a tela de acessos cria contas pela API administrativa e não pede SQL no terminal', () => {
    const ui = readFileSync('components/festas/FestaAcessos.tsx', 'utf8');
    assert.match(ui, /\/api\/admin\/configuracoes\/usuarios/);
    assert.match(ui, /Papel no sistema/);
    assert.match(ui, /Acesso às Festas/);
    assert.match(ui, /Contas desativadas/);
    assert.match(ui, /Sua conta/);
    assert.match(ui, /acesso inicial às Festas/);
    assert.doesNotMatch(ui, /provisionamento administrativo no terminal/);
    assert.match(ui, /recurso=perfis/);
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
