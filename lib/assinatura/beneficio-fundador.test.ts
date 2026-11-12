import assert from 'node:assert/strict';
import test from 'node:test';
import { consultarBeneficioFundador, consultarBeneficioFundadorDesenvolvedor } from './beneficio-fundador.ts';
import { dataHoraBrasilia, NOTA_COMPROVANTE_BENEFICIO, textoBeneficioFundador } from './textos-fundador.ts';

/** Executor falso: responde às guardas de schema e à consulta da concessão, registrando o SQL (nenhum banco). */
function executor(opcoes: { planos: boolean; campanha: boolean; linha?: Record<string, unknown> }) {
    const sql: string[] = [];
    const tx = {
        async query(texto: string, params?: unknown[]) {
            sql.push(texto);
            if (texto.includes('AS instalado074')) return { rows: [{ instalado074: opcoes.planos }] };
            if (texto.includes('AS instalado090')) return { rows: [{ instalado090: opcoes.campanha }] };
            assert.deepEqual(params, ['e1'], 'só a empresa informada pelo chamador');
            return { rows: opcoes.linha ? [opcoes.linha] : [] };
        },
    };
    return { tx: tx as never, sql };
}
const LINHA = { situacao: 'CONFIRMADA_VIGENTE', reservadaEm: '2026-10-25T10:02:00.638Z', confirmadaEm: '2026-10-25T10:22:16.000Z', beneficioFim: '2027-10-25T10:22:16.000Z',
    contratacaoId: 'o1', contratacaoEstado: 'CONFIRMADA', vaga: 13, origem: 'LEGADO' };

test('sem a 074a: null e nenhuma consulta à concessão (comportamento anterior)', async () => {
    const { tx, sql } = executor({ planos: false, campanha: false, linha: LINHA });
    assert.equal(await consultarBeneficioFundador(tx, 'e1'), null);
    assert.equal(await consultarBeneficioFundadorDesenvolvedor(tx, 'e1'), null);
    assert.ok(sql.every((s) => !s.includes('FROM assinatura_fundadores')));
});

test('consulta filtrada pela empresa, sem liberada, sem documento nem id do provedor; sem escrita', async () => {
    const { tx, sql } = executor({ planos: true, campanha: true, linha: LINHA });
    await consultarBeneficioFundadorDesenvolvedor(tx, 'e1');
    const consulta = sql.find((s) => s.includes('FROM assinatura_fundadores'))!;
    assert.match(consulta, /WHERE f\.empresa_id = \$1::uuid AND f\.estado <> 'LIBERADA'/);
    assert.match(consulta, /o\.empresa_id = f\.empresa_id AND o\.fundador_id = f\.id/);
    assert.match(consulta, /beneficio_fim > clock_timestamp\(\)/);
    assert.doesNotMatch(consulta, /documento_beneficiario|pagamento_confirmacao_id/);
    assert.doesNotMatch(consulta, /interval|\+ ?'?12/i, 'não recalcula o fim: usa o persistido');
    for (const s of sql) assert.doesNotMatch(s, /\b(INSERT|UPDATE|DELETE)\b/);
});

test('sem a 090: fase nula; com a 090: fase da concessão', async () => {
    const sem = executor({ planos: true, campanha: false, linha: { ...LINHA, origem: null } });
    await consultarBeneficioFundadorDesenvolvedor(sem.tx, 'e1');
    assert.match(sem.sql.at(-1)!, /NULL::text AS origem/);
    const com = executor({ planos: true, campanha: true, linha: LINHA });
    assert.equal((await consultarBeneficioFundadorDesenvolvedor(com.tx, 'e1'))?.origem, 'LEGADO');
    assert.match(com.sql.at(-1)!, /f\.origem AS origem/);
});

test('Gestão recebe só estado, datas e oferta; vaga e fase ficam para o desenvolvedor', async () => {
    const { tx } = executor({ planos: true, campanha: true, linha: LINHA });
    assert.deepEqual(await consultarBeneficioFundador(tx, 'e1'), { situacao: 'CONFIRMADA_VIGENTE', reservadaEm: LINHA.reservadaEm, confirmadaEm: LINHA.confirmadaEm,
        beneficioFim: LINHA.beneficioFim, contratacaoId: 'o1', contratacaoEstado: 'CONFIRMADA' });
    assert.equal(await consultarBeneficioFundador(executor({ planos: true, campanha: true }).tx, 'e1'), null, 'sem concessão');
});

test('horário de Brasília só na apresentação: UTC persistido convertido, inclusive na virada do dia', () => {
    assert.equal(dataHoraBrasilia('2026-10-25T10:22:16.000Z'), '25/10/2026 às 07:22');
    assert.equal(dataHoraBrasilia('2027-10-25T02:30:00.000Z'), '24/10/2027 às 23:30', 'fim perto da meia-noite UTC cai no dia anterior em Brasília');
    assert.equal(dataHoraBrasilia('2027-10-25T03:00:00.000Z'), '25/10/2027 às 00:00');
    assert.equal(dataHoraBrasilia('invalida'), null);
});

test('reservada nunca é apresentada como confirmada; vigente e encerrada com as datas; sem datas não apresenta', () => {
    const reservada = textoBeneficioFundador({ situacao: 'RESERVADA', confirmadaEm: null, beneficioFim: null })!;
    assert.match(reservada, /reservada, ainda não confirmada/);
    assert.doesNotMatch(reservada, /confirmada em|vigente|até \d/);
    const vigente = textoBeneficioFundador({ situacao: 'CONFIRMADA_VIGENTE', confirmadaEm: LINHA.confirmadaEm, beneficioFim: LINHA.beneficioFim })!;
    assert.equal(vigente, 'Condição Fundador confirmada em 25/10/2026 às 07:22. Benefício de 12 meses vigente até 25/10/2027 às 07:22 (horário de Brasília).');
    const encerrada = textoBeneficioFundador({ situacao: 'ENCERRADA', confirmadaEm: LINHA.confirmadaEm, beneficioFim: LINHA.beneficioFim })!;
    assert.match(encerrada, /encerrada: o benefício de 12 meses, confirmado em 25\/10\/2026 às 07:22, terminou em 25\/10\/2027 às 07:22/);
    assert.doesNotMatch(encerrada, /vigente/);
    assert.equal(textoBeneficioFundador({ situacao: 'CONFIRMADA_VIGENTE', confirmadaEm: null, beneficioFim: LINHA.beneficioFim }), null);
    assert.equal(textoBeneficioFundador({ situacao: 'ENCERRADA', confirmadaEm: LINHA.confirmadaEm, beneficioFim: null }), null);
    assert.match(NOTA_COMPROVANTE_BENEFICIO, /comprovante registra as condições aceitas.*situação atual/);
});
