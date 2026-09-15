import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { garantirFestaFormalizada, bloquearAgendaFormalizacao } from './formalizacao.ts';
import type { DbExecutor } from '../db/contracts';
import { estruturaFesta019Sql } from './estrutura-019.ts';

function executor(options: { valida?: boolean; existentes?: object[]; falha?: string } = {}) {
    const chamadas: { sql: string; values?: readonly unknown[] }[] = [];
    const tx = { query: async (sql: string, values?: readonly unknown[]) => {
        chamadas.push({ sql, values });
        if (options.falha && sql.includes(options.falha)) throw Error('Falha sintética');
        let rows: object[] = [];
        if (sql.includes(' AS valida')) rows = [{ valida: options.valida ?? true }];
        if (sql.startsWith('SELECT id,invalidada_em')) rows = options.existentes ?? [];
        if (sql.startsWith('SELECT id,parte')) rows = [{ id: 'assinatura-k', parte: 'KIDMAIS' }, { id: 'assinatura-c', parte: 'CLIENTE' }];
        if (sql.startsWith('INSERT INTO public.festas')) rows = [{ id: 'festa-unica' }];
        return { rows, rowCount: rows.length };
    } } as DbExecutor;
    return { tx, chamadas };
}

test('formalização incompleta recusa antes de qualquer escrita', async () => {
    const { tx, chamadas } = executor({ valida: false });
    await assert.rejects(garantirFestaFormalizada(tx, 'contrato', 'versao'), /incompleta/);
    assert.equal(chamadas.length, 1);
});
test('Festa existente é reutilizada sem reiniciar filhos ou inserir eventos', async () => {
    const { tx, chamadas } = executor({ existentes: [{ id: 'original', invalidada_em: null }] });
    assert.deepEqual(await garantirFestaFormalizada(tx, 'contrato', 'nova-versao'), { festaId: 'original', reutilizado: true });
    assert(!chamadas.some(c => /INSERT|UPDATE|DELETE/.test(c.sql.replace('FOR UPDATE', ''))));
});
test('retry de contrato antigo sem Festa não faz backfill silencioso', async () => {
    const { tx, chamadas } = executor();
    await assert.rejects(garantirFestaFormalizada(tx, 'c', 'v', {}, 'RETRY'), /Reconciliação/);
    assert(!chamadas.some(c => c.sql.startsWith('INSERT')));
});
test('Festa invalidada não é ressuscitada nem por reconciliação', async () => {
    for (const modo of ['CRIAR', 'RETRY', 'RECONCILIAR'] as const) {
        const { tx } = executor({ existentes: [{ id: 'antiga', invalidada_em: '2026-09-15' }] });
        await assert.rejects(garantirFestaFormalizada(tx, 'c', 'v', {}, modo), /invalidada/);
    }
});
test('lock e revalidação são statements separados no mesmo executor', async () => {
    const { tx, chamadas } = executor();
    await bloquearAgendaFormalizacao(tx, 'c');
    assert.equal(chamadas.length, 2);
    assert.match(chamadas[0].sql, /bloquear_contrato/);
    assert.match(chamadas[1].sql, /validar_destino/);
});
test('criação automática registra sistema, duas assinaturas, request e chave comum sem sessão administrativa', async () => {
    const { tx, chamadas } = executor();
    assert.deepEqual(await garantirFestaFormalizada(tx, 'c', 'v', { requestId: 'request' }), { festaId: 'festa-unica', reutilizado: false });
    const festa = chamadas.find(c => c.sql.startsWith('INSERT INTO public.festas'))!;
    const evento = chamadas.find(c => c.sql.startsWith('INSERT INTO public.festa_eventos'))!;
    assert.equal(festa.values![2], evento.values![3]);
    const causa = JSON.parse(String(evento.values![1]));
    assert.equal(causa.ator, 'SISTEMA');
    assert.equal(causa.requestId, 'request');
    assert.equal(causa.assinaturas.length, 2);
    assert.match(festa.sql, /NULL,'AUTOMATICA_FORMALIZACAO'/);
    assert(chamadas.some(c => c.sql.includes('INSERT INTO public.auditoria')));
    assert(chamadas.some(c => c.sql.includes('INSERT INTO public.eventos_historico_cliente')));
    assert(!chamadas.some(c => /sessoes_administrativas|FESTA_CRIAR|BEGIN|COMMIT/.test(c.sql)));
});
for (const falha of ['kidmais019_validar_destino', 'INSERT INTO public.festas', 'INSERT INTO public.auditoria']) {
    test(`falha propagada ao orquestrador para rollback: ${falha}`, async () => {
        const { tx } = executor({ falha });
        await assert.rejects(garantirFestaFormalizada(tx, 'c', 'v'), /Falha sintética/);
    });
}
test('banco exige ambas as partes e o documento exato; uma assinatura não satisfaz formalização', () => {
    const sql = readFileSync('database/migrations/20260915_019_festa_formalizacao.sql', 'utf8');
    assert.match(sql, /k\.parte='KIDMAIS'/);
    assert.match(sql, /a\.parte='CLIENTE'/);
    assert.match(sql, /k\.documento_id=d\.id AND a\.documento_id=d\.id/);
    assert.match(sql, /a\.pdf_hash=d\.pdf_hash/);
    assert.match(sql, /e\.estado='CONCLUIDA'/);
    assert(!/INSERT INTO (?:public\.)?bloqueios_agenda/.test(sql));
});
test('orquestrador conclui no mesmo tx; UI não exige criação manual', () => {
    const service = readFileSync('lib/contratos/services/contrato-publico.service.ts', 'utf8');
    const hook = service.indexOf('await garantirFestaFormalizada(tx, contrato.id, versaoAssinada.id');
    assert(hook > service.indexOf('const fechamentoAssinado'));
    assert(service.indexOf('await bloquearAgendaFormalizacao(tx') < service.indexOf('const prova = await identity.consumirProvaParaContrato'));
    assert.doesNotMatch(readFileSync('components/festas/FestaConsole.tsx', 'utf8'), /Adicionar esta festa|Adicionar festa de uma contratação/);
});

test('manifesto físico acompanha exatamente os corpos SQL versionados', () => {
    const sql = readFileSync('database/migrations/20260915_019_festa_formalizacao.sql', 'utf8').replaceAll('\r', '');
    const functions = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)];
    assert.equal(functions.length, 10);
    for (const match of functions) {
        assert(estruturaFesta019Sql.includes(createHash('sha256').update(match[2]).digest('hex')), match[1]);
    }
});
test('runners operacionais recusam execução sem autorização e destino, antes da conexão', () => {
    for (const script of ['festa-019.integration.mjs', 'festa-019-reconciliacao.integration.mjs', 'festa-019-reconciliar.mjs']) {
        const r = spawnSync(process.execPath, ['--experimental-strip-types', `scripts/${script}`], {
            encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        });
        assert.equal(r.status, 1);
        assert.doesNotMatch(r.stdout + r.stderr, /ECONNREFUSED|ENOTFOUND|FAKE_PASSWORD/);
    }
});

test('URL inválida nos runners físicos não expõe seu conteúdo', () => {
    for (const script of ['festa-019.integration.mjs', 'festa-019-reconciliacao.integration.mjs']) {
        const r = spawnSync(process.execPath, [`scripts/${script}`, '--authorize-disposable'], {
            encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FESTA_019_TEST_URL: 'SYNTHETIC_PRIVATE_VALUE' },
        });
        assert.equal(r.status, 1);
        assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC_PRIVATE_VALUE|ECONNREFUSED|ENOTFOUND/);
    }
});
