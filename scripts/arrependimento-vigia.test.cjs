/* eslint-disable @typescript-eslint/no-require-imports */
// Vigia das manifestações de arrependimento (097; P2-C3): classificação pura, modo e recusa de alvo, sem banco nem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { avaliarVigia, lerVigia, modo, SQL_VIGIA, LIMIAR_MS, TOLERANCIA_AVISO_MS } = require('./arrependimento-vigia.cjs');

const AGORA = Date.parse('2026-10-23T15:00:00.000Z');
const linha = (minutos, aviso = 'ENVIADO', comunicado = false) => ({ aviso_interno: aviso, comunicado, solicitado_ms: AGORA - minutos * 60_000 });

test('limiares: 1 h para vencida; aviso interno não entregue alarma já (PENDENTE só depois de 5 min)', () => {
    assert.equal(LIMIAR_MS, 3_600_000); assert.equal(TOLERANCIA_AVISO_MS, 300_000);
    assert.deepEqual(avaliarVigia([], AGORA), { recebidas: 0, alarmes: [], codigo: 0 });
    assert.equal(avaliarVigia([linha(59)], AGORA).codigo, 0, 'aviso entregue, menos de 1 h: nada');
    assert.deepEqual(avaliarVigia([linha(60)], AGORA).alarmes, [{ tipo: 'VENCIDO_SEM_COMUNICACAO', quantidade: 1, maisAntigaMin: 60 }]);
    assert.deepEqual(avaliarVigia([linha(90, 'ENVIADO', true)], AGORA).alarmes, [{ tipo: 'VENCIDO_SEM_CONCLUSAO', quantidade: 1, maisAntigaMin: 90 }]);
    for (const aviso of ['FALHOU', 'NAO_CONFIGURADO'])
        assert.deepEqual(avaliarVigia([linha(0, aviso)], AGORA).alarmes, [{ tipo: 'AVISO_INTERNO_NAO_ENTREGUE', quantidade: 1, maisAntigaMin: 0 }], aviso);
    assert.equal(avaliarVigia([linha(4, 'PENDENTE')], AGORA).codigo, 0, 'envio ainda em curso');
    assert.equal(avaliarVigia([linha(5, 'PENDENTE')], AGORA).alarmes[0].tipo, 'AVISO_INTERNO_NAO_ENTREGUE');
    const r = avaliarVigia([linha(70, 'FALHOU'), linha(10), linha(200, 'ENVIADO', true)], AGORA);
    assert.deepEqual(r, { recebidas: 3, codigo: 2, alarmes: [
        { tipo: 'AVISO_INTERNO_NAO_ENTREGUE', quantidade: 1, maisAntigaMin: 70 },
        { tipo: 'VENCIDO_SEM_COMUNICACAO', quantidade: 1, maisAntigaMin: 70 },
        { tipo: 'VENCIDO_SEM_CONCLUSAO', quantidade: 1, maisAntigaMin: 200 }] });
    assert.doesNotMatch(JSON.stringify(r), /KA-|protocolo|empresa/);
});

test('modo: aguardando é o padrão; outro valor recusa', () => {
    assert.equal(modo({}), 'aguardando');
    assert.equal(modo({ KIDMAIS_VIGIA_MODO: 'conferir' }), 'conferir');
    assert.throws(() => modo({ KIDMAIS_VIGIA_MODO: 'aplicar' }), /inválido/);
});

test('leitura: só RECEBIDAS, em transação READ ONLY desfeita; sem a 097 nada a vigiar', async () => {
    assert.match(SQL_VIGIA, /WHERE situacao = 'RECEBIDO'/); assert.doesNotMatch(SQL_VIGIA, /protocolo|empresa_id|INSERT|UPDATE|DELETE/i);
    const log = [];
    const cliente = (instalado) => ({ query: async (sql) => {
        log.push(sql);
        if (sql.includes('to_regclass')) return { rows: [{ ok: instalado }] };
        if (sql === SQL_VIGIA) return { rows: [linha(61)] };
        return { rows: [] };
    } });
    const r = await lerVigia(cliente(true), AGORA);
    assert.equal(r.codigo, 2); assert.equal(r.instalado, true);
    assert.equal(log[0], 'BEGIN TRANSACTION READ ONLY'); assert.equal(log.at(-1), 'ROLLBACK');
    log.length = 0;
    assert.deepEqual(await lerVigia(cliente(false), AGORA), { instalado: false, agora: new Date(AGORA).toISOString(), recebidas: 0, alarmes: [], codigo: 0 });
    assert.ok(!log.includes(SQL_VIGIA));
});

test('agendamento proposto: a cada 15 min, aguardando, sem segredos, não aplicado', () => {
    const y = fs.readFileSync('infra/render-arrependimento-vigia-production.yaml', 'utf8');
    assert.match(y, /schedule: "\*\/15 \* \* \* \*"/);
    assert.match(y, /startCommand: node scripts\/arrependimento-vigia\.cjs/);
    assert.match(y, /key: KIDMAIS_VIGIA_MODO\n\s+value: aguardando/);
    assert.match(y, /NÃO é aplicada automaticamente/);
    for (const k of ['KIDMAIS_RECONCILIAR_DATABASE_URL']) assert.match(y, new RegExp(`key: ${k}\\n\\s+sync: false`));
    assert.doesNotMatch(y, /postgres(ql)?:\/\//);
});
