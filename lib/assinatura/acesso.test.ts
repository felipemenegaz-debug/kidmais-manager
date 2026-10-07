import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularAcessoComercial, permiteEscrita, permiteLeitura, type AssinaturaGravada } from './acesso.ts';

const DIA = 86_400_000;
const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const em = (dias: number) => new Date(T0 + dias * DIA).toISOString();
const base = (p: Partial<AssinaturaGravada>): AssinaturaGravada => ({ situacao: 'TESTE', testeFim: em(30), periodoAtualFim: null, emAtrasoDesde: null, encerradaEm: null, ...p });
const nivel = (a: AssinaturaGravada | null, dias: number, excecoes = []) => calcularAcessoComercial(a, excecoes, T0 + dias * DIA);

test('sem assinatura (Kidmais e empresas atuais): sempre completo', () => {
    assert.deepEqual(nivel(null, 9999), { nivel: 'COMPLETO', motivo: 'SEM_COBRANCA', ate: null });
});

test('teste: completo até o fim; 60 dias só leitura; depois bloqueado — sem tarefa agendada', () => {
    const a = base({});
    assert.equal(nivel(a, 0).nivel, 'COMPLETO');
    assert.equal(nivel(a, 29.99).nivel, 'COMPLETO');
    assert.deepEqual(nivel(a, 30), { nivel: 'SOMENTE_LEITURA', motivo: 'TESTE_ENCERRADO', ate: em(90) });
    assert.equal(nivel(a, 89.9).nivel, 'SOMENTE_LEITURA');
    assert.deepEqual(nivel(a, 90), { nivel: 'BLOQUEADO', motivo: 'TESTE_ENCERRADO', ate: null });
});

test('ativa: completo no período; período vencido sem renovação vira regularização de 7 dias', () => {
    const a = base({ situacao: 'ATIVA', periodoAtualFim: em(30) });
    assert.equal(nivel(a, 10).motivo, 'ASSINATURA_ATIVA');
    assert.deepEqual(nivel(a, 31), { nivel: 'COMPLETO', motivo: 'REGULARIZACAO', ate: em(37) });
    assert.equal(nivel(a, 37).nivel, 'SOMENTE_LEITURA');
    assert.equal(nivel(a, 97).nivel, 'BLOQUEADO');
});

test('em atraso: 7 dias completos, 60 de leitura, depois bloqueado; pagamento posterior volta a completo sem perder nada', () => {
    const a = base({ situacao: 'EM_ATRASO', periodoAtualFim: em(0), emAtrasoDesde: em(0) });
    assert.equal(nivel(a, 6.9).nivel, 'COMPLETO');
    assert.equal(nivel(a, 7).nivel, 'SOMENTE_LEITURA');
    assert.equal(nivel(a, 67).nivel, 'BLOQUEADO');
    assert.equal(nivel(base({ situacao: 'ATIVA', periodoAtualFim: em(100) }), 67).nivel, 'COMPLETO', 'reativação');
});

test('cancelada: completo até o fim do período pago; depois leitura e bloqueio; encerrada conta da data de encerramento', () => {
    const c = base({ situacao: 'CANCELADA_FIM_PERIODO', periodoAtualFim: em(20) });
    assert.equal(nivel(c, 19).motivo, 'CANCELADA_NO_PERIODO');
    assert.equal(nivel(c, 21).nivel, 'SOMENTE_LEITURA');
    assert.equal(nivel(c, 81).nivel, 'BLOQUEADO');
    const e = base({ situacao: 'ENCERRADA', encerradaEm: em(0) });
    assert.equal(nivel(e, 1).nivel, 'SOMENTE_LEITURA');
    assert.equal(nivel(e, 61).nivel, 'BLOQUEADO');
});

test('exceção comercial vigente libera; revogada, vencida ou extensão de teste (que muda o teste_fim) não liberam por si', () => {
    const a = base({ testeFim: em(-100) });
    assert.equal(nivel(a, 0).nivel, 'BLOQUEADO');
    assert.deepEqual(calcularAcessoComercial(a, [{ tipo: 'CORTESIA', validaAte: em(10), revogadaEm: null }], T0), { nivel: 'COMPLETO', motivo: 'EXCECAO_COMERCIAL', ate: em(10) });
    assert.equal(calcularAcessoComercial(a, [{ tipo: 'CORTESIA', validaAte: em(10), revogadaEm: em(-1) }], T0).nivel, 'BLOQUEADO');
    assert.equal(calcularAcessoComercial(a, [{ tipo: 'ACESSO_TEMPORARIO', validaAte: em(-1), revogadaEm: null }], T0).nivel, 'BLOQUEADO');
    assert.equal(calcularAcessoComercial(a, [{ tipo: 'EXTENSAO_TESTE', validaAte: em(10), revogadaEm: null }], T0).nivel, 'BLOQUEADO');
});

test('dados inconsistentes falham fechado; escrita só no completo, leitura fora do bloqueado', () => {
    assert.equal(nivel(base({ testeFim: 'invalida' }), 0).nivel, 'BLOQUEADO');
    assert.equal(nivel(base({ situacao: 'ATIVA', periodoAtualFim: null }), 0).nivel, 'BLOQUEADO');
    assert.equal(nivel(base({ situacao: 'EM_ATRASO', periodoAtualFim: em(0), emAtrasoDesde: null }), 0).nivel, 'BLOQUEADO', 'atraso sem data não vira regularização eterna');
    assert.equal(nivel(base({ situacao: 'CANCELADA_FIM_PERIODO', periodoAtualFim: null }), 0).nivel, 'BLOQUEADO');
    assert.equal(nivel(base({ situacao: 'ENCERRADA', encerradaEm: null }), 0).nivel, 'BLOQUEADO');
    assert.deepEqual([permiteEscrita(nivel(base({}), 0)), permiteLeitura(nivel(base({}), 0))], [true, true]);
    assert.deepEqual([permiteEscrita(nivel(base({}), 31)), permiteLeitura(nivel(base({}), 31))], [false, true]);
    assert.deepEqual([permiteEscrita(nivel(base({}), 91)), permiteLeitura(nivel(base({}), 91))], [false, false]);
});

test('exceção curta durante teste mais longo: o acesso completo vale até o maior prazo', () => {
    const teste = base({ testeFim: em(20) });
    assert.deepEqual(calcularAcessoComercial(teste, [{ tipo: 'CORTESIA', validaAte: em(5), revogadaEm: null }], T0), { nivel: 'COMPLETO', motivo: 'TESTE', ate: em(20) });
    assert.deepEqual(calcularAcessoComercial(teste, [{ tipo: 'CORTESIA', validaAte: em(40), revogadaEm: null }], T0), { nivel: 'COMPLETO', motivo: 'EXCECAO_COMERCIAL', ate: em(40) });
});

test('prazos configuráveis (hipóteses, não regras aprovadas): regularização e somente leitura vêm do parâmetro; padrão 7/60', () => {
    const atraso = base({ situacao: 'EM_ATRASO', emAtrasoDesde: em(0) });
    const prazos = { regularizacaoDias: 3, somenteLeituraDias: 10 };
    assert.deepEqual(calcularAcessoComercial(atraso, [], T0 + 2 * DIA, prazos), { nivel: 'COMPLETO', motivo: 'REGULARIZACAO', ate: em(3) });
    assert.deepEqual(calcularAcessoComercial(atraso, [], T0 + 3 * DIA, prazos), { nivel: 'SOMENTE_LEITURA', motivo: 'PAGAMENTO_PENDENTE', ate: em(13) });
    assert.equal(calcularAcessoComercial(atraso, [], T0 + 13 * DIA, prazos).nivel, 'BLOQUEADO');
    // Zero dias: sem regularização nem consulta — bloqueia logo depois do fim.
    assert.equal(calcularAcessoComercial(atraso, [], T0 + 1, { regularizacaoDias: 0, somenteLeituraDias: 0 }).nivel, 'BLOQUEADO');
    // Sem parâmetro, os valores propostos de sempre.
    assert.deepEqual(calcularAcessoComercial(atraso, [], T0 + 2 * DIA), { nivel: 'COMPLETO', motivo: 'REGULARIZACAO', ate: em(7) });
    // Sem assinatura (Kidmais), prazo nenhum se aplica.
    assert.equal(calcularAcessoComercial(null, [], T0, { regularizacaoDias: 0, somenteLeituraDias: 0 }).nivel, 'COMPLETO');
});
