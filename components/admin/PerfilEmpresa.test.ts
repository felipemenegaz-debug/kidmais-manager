import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tela = readFileSync('components/admin/PerfilEmpresa.tsx', 'utf8');
const estilo = readFileSync('components/admin/perfil-empresa.module.css', 'utf8');
const rota = readFileSync('app/api/admin/configuracoes/perfil-empresa/route.ts', 'utf8');

test('a tela cobre os estados, oferece prévia da logo e não concede acesso', () => {
    assert.match(tela, /Carregando perfil/);
    assert.match(tela, /corpo.codigo === 'PERFIL_SEM_CONCESSAO'/);
    assert.match(tela, /Acesso negado/);
    assert.match(tela, /ainda não está instalada/);
    assert.match(tela, /não há empresa provisionada/);
    assert.match(tela, /Os dados digitados foram mantidos/);
    assert.match(tela, /Rascunho salvo/);
    assert.match(tela, /Complemento da unidade/);
    assert.match(tela, /Tentar novamente/);
    assert.match(tela, /Operação em andamento/);
    assert.match(tela, /Confirmo o antes e o depois/);
    assert.doesNotMatch(tela, /tenant|novas versões/);
    assert.match(tela, /Sem número/);
    assert.match(tela, /Mesmo endereço da sede/);
    assert.match(tela, /reautenticar/);
    assert.doesNotMatch(tela, /perfil_empresa_concessoes|INSERT INTO/);
    assert.match(tela, /type="file"/);
    assert.match(tela, /Prévia da logo do rascunho/);
    assert.match(estilo, /background:var\(--main-bg\)/);
    assert.match(tela, /data-profile-page/);
    assert.match(tela, /<dialog/);
    assert.doesNotMatch(estilo, /max-width:\s*46rem|#161022/);
});

test('shell mantém drawer mobile e não oferece collapse desktop', () => {
    const shell=readFileSync('components/admin/AdminShell.tsx','utf8');
    assert.doesNotMatch(shell,/Recolher menu|setRecolhido|data-recolhido/);
    assert.match(shell,/aria-expanded=\{aberto\}/);
    assert.match(shell,/Escape/);
    assert.match(shell,/menuRef.current\?\.focus\(\)/);
});

test('a API usa sessão, origem e CSRF e não concede acesso', () => {
    assert.match(rota, /exigirApiAdminCrmDisponivel/);
    assert.doesNotMatch(rota, /perfil_empresa_concessoes|INSERT INTO/);
    assert.match(rota, /salvar-rascunho/);
    assert.match(rota, /aplicar/);
});
