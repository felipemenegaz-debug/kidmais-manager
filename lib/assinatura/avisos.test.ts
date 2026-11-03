import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularAcessoComercial, type AssinaturaGravada, type PrazosAcesso } from './acesso.ts';
import { avisosDaTransicao, avisosLigados, fimDoAcessoCompleto, JANELA_AVISO_DIAS, marcosDevidos, motivoObsoleto, ultimoDiaBrasil } from './avisos.ts';

/** Regras puras dos avisos (087): sem banco, sem rede, relógio fixo. Datas em UTC; dias em Brasília (UTC−3). */
const DIA = 86_400_000;
const P: PrazosAcesso = { regularizacaoDias: 7, somenteLeituraDias: 60 };
const t = (iso: string) => Date.parse(iso);
const base = (o: Partial<AssinaturaGravada>): AssinaturaGravada => ({ situacao: 'TESTE', testeFim: '2026-11-01T03:00:00.000Z', periodoAtualFim: null, emAtrasoDesde: null, encerradaEm: null, ...o });
const tipos = (a: AssinaturaGravada | null, agora: number, prazos = P, excecoes = [] as Parameters<typeof marcosDevidos>[1]) => marcosDevidos(a, excecoes, agora, prazos).map((m) => m.tipo);

test('trava de ativação: só ASSINATURA_AVISOS_EMAIL=ligado liga', () => {
    assert.equal(avisosLigados({}), false);
    for (const v of ['', 'sim', 'true', '1', 'desligado']) assert.equal(avisosLigados({ ASSINATURA_AVISOS_EMAIL: v }), false, v);
    assert.equal(avisosLigados({ ASSINATURA_AVISOS_EMAIL: ' Ligado ' }), true);
});

test('fim do teste: 3 dias antes, no último dia (Brasília) e nada fora disso', () => {
    // teste_fim = 01/11 00:00 BRT ⇒ último dia = 31/10.
    const a = base({});
    assert.equal(ultimoDiaBrasil(a.testeFim), '2026-10-31');
    assert.deepEqual(tipos(a, t('2026-10-27T12:00:00Z')), []);                    // faltam 4 dias
    assert.deepEqual(tipos(a, t('2026-10-28T03:00:00Z')), ['TESTE_FIM_3_DIAS']);  // 28/10 00:00 BRT, faltam 3
    assert.deepEqual(tipos(a, t('2026-10-30T23:00:00Z')), ['TESTE_FIM_3_DIAS']);  // 30/10 20:00 BRT, falta 1
    assert.deepEqual(tipos(a, t('2026-10-31T03:00:00Z')), ['TESTE_FIM_HOJE']);    // 31/10 00:00 BRT
    assert.deepEqual(tipos(a, t('2026-11-01T02:59:59Z')), ['TESTE_FIM_HOJE']);    // 31/10 23:59:59 BRT
    assert.deepEqual(tipos(a, t('2026-11-01T03:00:00Z')).includes('TESTE_FIM_HOJE'), false);
    // Mesmo marco nos dois avisos do teste: um por tipo.
    const [m3] = marcosDevidos(a, [], t('2026-10-29T12:00:00Z'), P), [mh] = marcosDevidos(a, [], t('2026-10-31T12:00:00Z'), P);
    assert.equal(m3.marco, '2026-11-01T03:00:00.000Z'); assert.equal(mh.marco, m3.marco);
});

test('extensão do teste muda o marco (novo aviso); exceção comercial vigente e sem assinatura não avisam', () => {
    const agora = t('2026-10-29T12:00:00Z');
    assert.equal(marcosDevidos(base({ testeFim: '2026-11-15T03:00:00.000Z' }), [], t('2026-11-12T12:00:00Z'), P)[0].marco, '2026-11-15T03:00:00.000Z');
    assert.deepEqual(tipos(null, agora), []);
    assert.deepEqual(tipos(base({}), agora, P, [{ tipo: 'CORTESIA', validaAte: '2026-12-31T00:00:00.000Z', revogadaEm: null }]), []);
    assert.deepEqual(tipos(base({ testeFim: 'invalida' }), agora), []);
});

test('pagamento pendente: entrada na regularização (período vencido ou EM_ATRASO), só a partir do dia seguinte (Brasília) e dentro da janela', () => {
    // Vencimento 10/11 00:00 BRT (03:00Z). No próprio dia 10/11 ninguém recebe cobrança (P2-1): nem às 08:00 nem às 23:59 BRT.
    const ativa = base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-10T03:00:00.000Z' });
    assert.deepEqual(tipos(ativa, t('2026-11-09T12:00:00Z')), []);
    assert.deepEqual(tipos(ativa, t('2026-11-10T11:00:00Z')), [], 'D 08:00 BRT');
    assert.deepEqual(tipos(ativa, t('2026-11-11T02:59:59Z')), [], 'D 23:59:59 BRT');
    assert.equal(calcularAcessoComercial(ativa, [], t('2026-11-10T11:00:00Z'), P).motivo, 'REGULARIZACAO', 'já está em regularização, mas sem aviso');
    // D+1 08:00 BRT: aviso com o marco do vencimento (início da regularização), não do dia seguinte.
    const [m] = marcosDevidos(ativa, [], t('2026-11-11T11:00:00Z'), P);
    assert.deepEqual(m, { tipo: 'PAGAMENTO_PENDENTE', marco: '2026-11-10T03:00:00.000Z', motivo: 'PAGAMENTO_PENDENTE', ate: '2026-11-17T03:00:00.000Z' });
    assert.deepEqual(tipos(ativa, t('2026-11-11T03:00:00Z')), ['PAGAMENTO_PENDENTE'], 'D+1 00:00 BRT');
    // A janela conta do dia seguinte: 2 dias depois ainda vale; 1 ms além, não.
    assert.deepEqual(tipos(ativa, t('2026-11-11T03:00:00Z') + JANELA_AVISO_DIAS * DIA), ['PAGAMENTO_PENDENTE']);
    assert.deepEqual(tipos(ativa, t('2026-11-11T03:00:00Z') + JANELA_AVISO_DIAS * DIA + 1), []);
    // Vencimento no meio do dia (15:00 BRT): o dia seguinte começa à meia-noite de Brasília, não 24 h depois.
    const meioDia = base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-10T18:00:00.000Z' });
    assert.deepEqual(tipos(meioDia, t('2026-11-11T02:59:59Z')), []);
    assert.equal(marcosDevidos(meioDia, [], t('2026-11-11T03:00:00Z'), P)[0].marco, '2026-11-10T18:00:00.000Z');
    const atraso = base({ situacao: 'EM_ATRASO', periodoAtualFim: '2026-11-10T03:00:00.000Z', emAtrasoDesde: '2026-11-12T03:00:00.000Z' });
    assert.deepEqual(tipos(atraso, t('2026-11-12T10:00:00Z')), [], 'EM_ATRASO no próprio dia');
    assert.equal(marcosDevidos(atraso, [], t('2026-11-13T10:00:00Z'), P)[0].marco, '2026-11-12T03:00:00.000Z');
    // Um aviso pendente gravado no dia D (versão antiga) é revalidado pela mesma regra: no dia D é obsoleto, no D+1 vale.
    const pendente = { tipo: 'PAGAMENTO_PENDENTE' as const, marco: '2026-11-10T03:00:00.000Z', criadoEm: '2026-11-10T12:00:00.000Z' };
    assert.equal(motivoObsoleto(pendente, ativa, [], t('2026-11-10T12:00:00Z'), P), 'AVISO_OBSOLETO');
    assert.equal(motivoObsoleto(pendente, ativa, [], t('2026-11-11T12:00:00Z'), P), null);
});

test('somente leitura (por motivo), lembrete 7 dias antes da suspensão e suspensão', () => {
    const teste = base({});
    const [l] = marcosDevidos(teste, [], t('2026-11-01T15:00:00Z'), P);
    assert.deepEqual(l, { tipo: 'SOMENTE_LEITURA', marco: '2026-11-01T03:00:00.000Z', motivo: 'TESTE_ENCERRADO', ate: '2026-12-31T03:00:00.000Z' });
    assert.deepEqual(tipos(teste, t('2026-11-20T12:00:00Z')), []);                          // meio da leitura
    assert.deepEqual(tipos(teste, t('2026-12-24T03:00:00Z')), ['SUSPENSAO_EM_7_DIAS']);
    assert.deepEqual(tipos(teste, t('2026-12-31T02:59:59Z')), ['SUSPENSAO_EM_7_DIAS']);
    const [s] = marcosDevidos(teste, [], t('2026-12-31T04:00:00Z'), P);
    assert.deepEqual(s, { tipo: 'SUSPENSO', marco: '2026-12-31T03:00:00.000Z', motivo: 'TESTE_ENCERRADO', ate: null });
    assert.deepEqual(tipos(teste, t('2027-01-10T00:00:00Z')), []);                          // suspensão antiga
    const motivos = [
        [base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-10T03:00:00.000Z' }), 'PAGAMENTO_PENDENTE', '2026-11-17T03:00:00.000Z'],
        [base({ situacao: 'CANCELADA_FIM_PERIODO', periodoAtualFim: '2026-11-10T03:00:00.000Z' }), 'CANCELADA', '2026-11-10T03:00:00.000Z'],
        [base({ situacao: 'ENCERRADA', encerradaEm: '2026-11-10T15:00:00.000Z' }), 'ENCERRADA', '2026-11-10T15:00:00.000Z'],
    ] as const;
    for (const [a, motivo, inicio] of motivos) {
        const [m] = marcosDevidos(a, [], t(inicio) + 3_600_000, P);
        assert.deepEqual([m.tipo, m.motivo, m.marco], ['SOMENTE_LEITURA', motivo, inicio]);
    }
});

test('prazos configurados: leitura curta não gera lembrete duplicado; sem regularização vai direto à leitura', () => {
    const curto: PrazosAcesso = { regularizacaoDias: 0, somenteLeituraDias: 5 };
    const ativa = base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-10T03:00:00.000Z' });
    assert.deepEqual(tipos(ativa, t('2026-11-10T04:00:00Z'), curto), ['SOMENTE_LEITURA']);
    assert.deepEqual(tipos(ativa, t('2026-11-14T04:00:00Z'), curto), []);
    assert.deepEqual(tipos(ativa, t('2026-11-15T04:00:00Z'), curto), ['SUSPENSO']);
    assert.deepEqual(tipos(ativa, t('2026-11-10T04:00:00Z'), { regularizacaoDias: 0, somenteLeituraDias: 0 }), ['SUSPENSO']);
});

test('coerência com acesso.ts numa grade: início da leitura + prazo = fim informado pelo acesso', () => {
    const casos: AssinaturaGravada[] = [
        base({}), base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-10T03:00:00.000Z' }),
        base({ situacao: 'EM_ATRASO', periodoAtualFim: '2026-11-10T03:00:00.000Z', emAtrasoDesde: '2026-11-11T03:00:00.000Z' }),
        base({ situacao: 'CANCELADA_FIM_PERIODO', periodoAtualFim: '2026-11-20T03:00:00.000Z' }), base({ situacao: 'ENCERRADA', encerradaEm: '2026-11-05T12:00:00.000Z' }),
    ];
    for (const prazos of [P, { regularizacaoDias: 3, somenteLeituraDias: 10 }, { regularizacaoDias: 30, somenteLeituraDias: 365 }])
        for (const a of casos)
            for (let agora = t('2026-10-20T00:00:00Z'); agora < t('2028-01-01T00:00:00Z'); agora += DIA / 2) {
                const acesso = calcularAcessoComercial(a, [], agora, prazos);
                if (acesso.nivel === 'SOMENTE_LEITURA')
                    assert.equal(fimDoAcessoCompleto(a, prazos) + prazos.somenteLeituraDias * DIA, Date.parse(acesso.ate!));
                for (const m of marcosDevidos(a, [], agora, prazos)) {
                    // Nenhum aviso contradiz o nível atual.
                    if (m.tipo === 'SUSPENSO') assert.equal(acesso.nivel, 'BLOQUEADO');
                    if (m.tipo === 'SOMENTE_LEITURA' || m.tipo === 'SUSPENSAO_EM_7_DIAS') assert.equal(acesso.nivel, 'SOMENTE_LEITURA');
                    if (m.tipo.startsWith('TESTE_') || m.tipo === 'PAGAMENTO_PENDENTE') assert.equal(acesso.nivel, 'COMPLETO');
                }
            }
});

test('transição: pagamento confirmado só quando o período pago cresce; reentrega com o mesmo estado não avisa', () => {
    const teste = { situacao: 'TESTE' as const, periodoAtualFim: null };
    const ativa = { situacao: 'ATIVA' as const, periodoAtualFim: '2026-12-09T03:00:00.000Z' };
    assert.deepEqual(avisosDaTransicao(teste, ativa, P), [{ tipo: 'PAGAMENTO_CONFIRMADO', marco: '2026-12-09T03:00:00.000Z', motivo: 'ASSINATURA_ATIVA', ate: '2026-12-09T03:00:00.000Z' }]);
    assert.deepEqual(avisosDaTransicao(ativa, ativa, P), []);
    assert.equal(avisosDaTransicao(ativa, { ...ativa, periodoAtualFim: '2027-01-09T03:00:00.000Z' }, P)[0].tipo, 'PAGAMENTO_CONFIRMADO');
    const atraso = { situacao: 'EM_ATRASO' as const, periodoAtualFim: ativa.periodoAtualFim };
    assert.deepEqual(avisosDaTransicao(ativa, atraso, P), []);
    assert.equal(avisosDaTransicao(atraso, { ...ativa, periodoAtualFim: '2027-01-09T03:00:00.000Z' }, P).length, 1);
});

test('transição: cancelamento confirmado uma vez (fim do período ou encerrada); cancelada → encerrada não repete', () => {
    const ativa = { situacao: 'ATIVA' as const, periodoAtualFim: '2026-12-09T03:00:00.000Z' };
    const cancelada = { situacao: 'CANCELADA_FIM_PERIODO' as const, periodoAtualFim: ativa.periodoAtualFim, canceladaEm: '2026-11-20T15:00:00.000Z' };
    assert.deepEqual(avisosDaTransicao(ativa, cancelada, P), [{ tipo: 'CANCELAMENTO_CONFIRMADO', marco: '2026-11-20T15:00:00.000Z', motivo: 'CANCELADA_NO_PERIODO', ate: '2026-12-09T03:00:00.000Z' }]);
    assert.deepEqual(avisosDaTransicao(cancelada, { ...cancelada, situacao: 'ENCERRADA', encerradaEm: ativa.periodoAtualFim }, P), []);
    const [e] = avisosDaTransicao({ situacao: 'EM_ATRASO', periodoAtualFim: ativa.periodoAtualFim }, { situacao: 'ENCERRADA', periodoAtualFim: ativa.periodoAtualFim, encerradaEm: '2026-12-20T12:00:00.000Z' }, P);
    assert.deepEqual([e.motivo, e.ate], ['ENCERRADA', '2027-02-18T12:00:00.000Z']);
    assert.equal(avisosDaTransicao(ativa, { ...cancelada, canceladaEm: null }, P).length, 0);
});

test('aviso pendente obsoleto: já pagou, teste estendido, transição velha', () => {
    const fimTeste = '2026-11-01T03:00:00.000Z';
    const pendente = { tipo: 'TESTE_FIM_3_DIAS' as const, marco: fimTeste, criadoEm: '2026-10-29T12:00:00.000Z' };
    const agora = t('2026-10-29T13:00:00Z');
    assert.equal(motivoObsoleto(pendente, base({}), [], agora, P), null);
    assert.equal(motivoObsoleto(pendente, base({ situacao: 'ATIVA', periodoAtualFim: '2026-11-29T03:00:00.000Z' }), [], agora, P), 'AVISO_OBSOLETO');
    assert.equal(motivoObsoleto(pendente, base({ testeFim: '2026-11-20T03:00:00.000Z' }), [], agora, P), 'AVISO_OBSOLETO');
    assert.equal(motivoObsoleto(pendente, null, [], agora, P), 'SEM_ASSINATURA');
    const pago = { tipo: 'PAGAMENTO_CONFIRMADO' as const, marco: '2026-11-29T03:00:00.000Z', criadoEm: '2026-10-29T12:00:00.000Z' };
    const ativa = base({ situacao: 'ATIVA', periodoAtualFim: pago.marco });
    assert.equal(motivoObsoleto(pago, ativa, [], t('2026-11-01T11:00:00Z'), P), null);
    assert.equal(motivoObsoleto(pago, ativa, [], t('2026-11-01T12:00:01Z'), P), 'FORA_DA_JANELA');
});
