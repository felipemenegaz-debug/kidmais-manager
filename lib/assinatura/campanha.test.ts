import assert from 'node:assert/strict';
import test from 'node:test';
import { campanhaFundadorLigada, faseCampanha, janelaCalculada, meiaNoiteLocal, prazoAnunciado, somarDias } from './campanha.ts';

/** Exemplos de data SINTÉTICOS: nenhuma data de abertura foi decidida. */
test('calendário local: [D 00:00, D+30 00:00) em America/Sao_Paulo, sem offset fixo', () => {
    assert.equal(meiaNoiteLocal('2026-11-01'), '2026-11-01T03:00:00.000Z');
    const j = janelaCalculada('CALENDARIO_LOCAL', { data: '2026-11-01' });
    assert.deepEqual(j, { inicio: '2026-11-01T03:00:00.000Z', janelaFim: '2026-12-01T03:00:00.000Z' });
    // Virada de mês, de ano e ano bissexto.
    assert.equal(janelaCalculada('CALENDARIO_LOCAL', { data: '2026-12-15' }).janelaFim, '2027-01-14T03:00:00.000Z');
    assert.equal(janelaCalculada('CALENDARIO_LOCAL', { data: '2028-02-01' }).janelaFim, '2028-03-02T03:00:00.000Z');
    assert.equal(janelaCalculada('CALENDARIO_LOCAL', { data: '2027-02-01' }).janelaFim, '2027-03-03T03:00:00.000Z');
    assert.equal(somarDias('2028-02-28', 1), '2028-02-29');
    assert.throws(() => janelaCalculada('CALENDARIO_LOCAL', {}), /obrigatória/);
    assert.throws(() => meiaNoiteLocal('2026-13-01'), /inválida/);
    assert.throws(() => meiaNoiteLocal('01/11/2026'), /inválida/);
});

test('horário exato: 30 × 24 h a partir do instante de abertura', () => {
    const j = janelaCalculada('HORARIO_EXATO', { inicio: '2026-11-01T15:30:00.000Z' });
    assert.deepEqual(j, { inicio: '2026-11-01T15:30:00.000Z', janelaFim: '2026-12-01T15:30:00.000Z' });
    assert.throws(() => janelaCalculada('HORARIO_EXATO', {}), /obrigatório/);
});

test('fronteiras da fase: início inclusivo, fim exclusivo; encerrada vence o relógio', () => {
    const c = { estado: 'ATIVA' as const, ...janelaCalculada('CALENDARIO_LOCAL', { data: '2026-11-01' }) };
    const ini = Date.parse(c.inicio), fim = Date.parse(c.janelaFim);
    assert.equal(faseCampanha(c, ini - 1), 'ANTES');
    assert.equal(faseCampanha(c, ini), 'JANELA');
    assert.equal(faseCampanha(c, fim - 1), 'JANELA');
    assert.equal(faseCampanha(c, fim), 'POS_JANELA');
    assert.equal(faseCampanha({ ...c, estado: 'ENCERRADA' }, ini + 1), 'ENCERRADA');
});

test('prazo anunciado: último dia D+29 às 23h59 no calendário; último minuto no horário exato', () => {
    const cal = janelaCalculada('CALENDARIO_LOCAL', { data: '2026-11-01' });
    assert.deepEqual(prazoAnunciado({ contagem: 'CALENDARIO_LOCAL', janelaFim: cal.janelaFim }),
        { dia: '30/11/2026', hora: '23h59', texto: 'até 30/11/2026, 23h59 (horário de Brasília)' });
    const exato = janelaCalculada('HORARIO_EXATO', { inicio: '2026-11-01T15:30:00.000Z' });
    assert.equal(prazoAnunciado({ contagem: 'HORARIO_EXATO', janelaFim: exato.janelaFim }).texto, 'até 01/12/2026, 12h29 (horário de Brasília)');
});

test('chave operacional só com "true" literal', () => {
    assert.equal(campanhaFundadorLigada({ ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: 'true' }), true);
    for (const v of [undefined, 'TRUE', '1', 'sim', ' true']) assert.equal(campanhaFundadorLigada({ ASSINATURA_CAMPANHA_FUNDADOR_ATIVA: v }), false);
});

test('090: horário exato recusado nos bancos de staging e produção conhecidos (só calendário lá; D2)', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('database/migrations/20261022_090_campanha_fundador.sql', 'utf8');
    const ramo = sql.slice(sql.indexOf("ELSIF NEW.contagem = 'HORARIO_EXATO' THEN"), sql.indexOf("ELSE\n      RAISE EXCEPTION '090: contagem da janela não decidida."));
    assert.match(ramo, /current_database\(\) IN \('kidmais_production','kidmais_staging_1z91'\)/);
    assert.match(ramo, /horário exato só em banco de ensaio/);
});
