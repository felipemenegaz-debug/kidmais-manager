import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const anterior = readFileSync('database/migrations/20260925_027_perfil_empresa_cadastro.sql', 'utf8');
const correcao = readFileSync('database/migrations/20260925_028_perfil_empresa_revisao_aplicacao.sql', 'utf8');
const postcheck = readFileSync('database/checks/20260925_028_postcheck.sql', 'utf8');

function cicloAplicada(row: { motivo: string | null; aplicadoEm: string | null; aplicadoPor: string | null }) {
    return row.aplicadoEm != null && row.motivo != null && row.motivo.trim().length >= 3 && row.aplicadoPor != null;
}

test('revisão aplicada com motivo nulo continua inválida e 027 não é reescrita', () => {
    assert.equal(cicloAplicada({ motivo: null, aplicadoEm: '2026-09-25', aplicadoPor: 'conta' }), false);
    assert.equal(cicloAplicada({ motivo: 'ok', aplicadoEm: '2026-09-25', aplicadoPor: null }), false);
    assert.equal(cicloAplicada({ motivo: 'Correção', aplicadoEm: '2026-09-25', aplicadoPor: 'conta' }), true);
    assert.match(correcao, /motivo IS NOT NULL/);
    assert.match(correcao, /aplicado_por IS NOT NULL/);
    assert.doesNotMatch(anterior, /motivo IS NOT NULL/);
    assert.match(postcheck, /colunas da empresa usadas pelo serviço/);
    assert.match(postcheck, /colunas da unidade usadas pelo serviço/);
    assert.match(postcheck, /motivo IS NOT NULL/);
    const sql = correcao.replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /INSERT INTO|bytea|contrato_documentos/i);
});
