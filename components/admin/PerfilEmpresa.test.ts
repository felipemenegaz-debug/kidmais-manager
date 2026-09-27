import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tela = readFileSync('components/admin/PerfilEmpresa.tsx', 'utf8');
const estilo = readFileSync('components/admin/perfil-empresa.module.css', 'utf8');
const rota = readFileSync('app/api/admin/configuracoes/perfil-empresa/route.ts', 'utf8');

test('a tela cobre os estados e não envia concessão nem arquivo', () => {
    assert.match(tela, /Carregando perfil/);
    assert.match(tela, /Sem concessão ativa/);
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
    assert.doesNotMatch(tela, /type="file"|perfil_empresa_concessoes|INSERT INTO/);
    assert.match(estilo, /#161022/);
    assert.match(estilo, /#d7c4f5/);
    assert.match(estilo, /#6d28d9/);
    assert.match(estilo, /#3dd68c/);
    assert.match(estilo, /max-width: 720px/);
    assert.match(estilo, /prefers-reduced-motion/);
});

test('a API usa sessão, origem e CSRF e não concede acesso', () => {
    assert.match(rota, /exigirApiAdminCrmDisponivel/);
    assert.doesNotMatch(rota, /perfil_empresa_concessoes|INSERT INTO/);
    assert.match(rota, /salvar-rascunho/);
    assert.match(rota, /aplicar/);
});
