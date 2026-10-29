/* eslint-disable @typescript-eslint/no-require-imports */
// B-14 (plano rev. 8.1, §3.1): o cron de reconciliação não muda. `executarCiclo` ganhou opções novas (provedorEfetivo,
// antesDoCommit); sem elas, o mesmo cenário precisa produzir exatamente as mesmas chamadas ao banco e ao provedor, o mesmo
// relatório e o mesmo código de saída que a versão anterior (eb1af426). A gravação de referência abaixo foi capturada
// executando este mesmo cenário contra a versão anterior do arquivo (git show eb1af426:scripts/assinatura-reconciliar.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');

/** Cenário fixo: dois eventos (um falha), três empresas (mudou, sem mudança, recusa), encerramentos e créditos. */
async function cenario(modulo, aplicar) {
    const log = [];
    const client = { query: async (sql) => { log.push(['sql', sql]); return { rows: [] }; } };
    const provedor = {
        obterCobranca: async (id) => { log.push(['provedor', 'obterCobranca', id]); return null; },
        removerAssinatura: async (id) => { log.push(['provedor', 'removerAssinatura', id]); return { removida: true }; },
    };
    const sinc = {
        eventosPendentes: async () => ['ev1', 'ev2'],
        processarEvento: async (_c, id, deps) => {
            log.push(['processarEvento', id, Object.keys(deps.provedor).sort().join(',')]);
            if (id === 'ev2') throw Object.assign(new Error('x'), { name: 'AcessoServiceError', code: 'FUNDADOR_OFERTA_EXPIRADA' });
            await deps.provedor.removerAssinatura('sub_x');
            return { situacao: 'PROCESSADO' };
        },
        empresasComProvedor: async () => ['e1', 'e2', 'e3'],
        sincronizarEmpresa: async (_c, id) => {
            log.push(['sincronizarEmpresa', id]);
            if (id === 'e1') return { resultado: 'SINCRONIZADA', mudou: true, antes: 'EM_ATRASO', depois: 'ATIVA' };
            if (id === 'e2') return { resultado: 'SINCRONIZADA', mudou: false, antes: 'ATIVA', depois: 'ATIVA' };
            return { resultado: 'RECUSADA', motivo: 'REFERENCIA_DIVERGENTE' };
        },
    };
    const pendenciasEncerramento = async () => [{ item: 'DEVOLUCAO_PENDENTE', resultado: 'AGUARDANDO_MANUAL', motivo: 'ARREPENDIMENTO_7_DIAS', recebidoMs: 1 }];
    const creditos = {
        contexto: { ambiente: 'sandbox', conta: 'c' },
        instalados: async () => true,
        pedidos: async () => ({ ids: ['p1', 'p2'], truncado: false }),
        marcar: async (_c, id) => { log.push(['marcar', id]); },
        processar: async (_c, id) => { log.push(['processar', id]); return id === 'p1' ? { resultado: 'CREDITADO' } : { resultado: 'AGUARDANDO' }; },
        pendencias: async () => [],
        divergencias: async () => [],
    };
    const relatorio = await modulo.executarCiclo({ client, provedor, aplicar, banco: 'sintetico', sinc, pendenciasEncerramento, creditos });
    return { log, relatorio, codigo: modulo.codigoDeSaida(relatorio, false) };
}

const REFERENCIA = require('./assinatura-reconciliar-preservacao.referencia.json');

for (const aplicar of [false, true]) {
    test(`sem as opções novas, o ciclo é idêntico à versão anterior (aplicar=${aplicar})`, async () => {
        const atual = await cenario(require('./assinatura-reconciliar.cjs'), aplicar);
        assert.deepEqual(JSON.parse(JSON.stringify(atual)), REFERENCIA[String(aplicar)]);
    });
}

module.exports = { cenario };

// Opções da recuperação de pagamentos (B-14, §3.1, §3.9): provedor intacto, parada antes do COMMIT e COMMIT sem resposta.
const { executarCiclo, ParadaCiclo } = require('./assinatura-reconciliar.cjs');
const { provedorSomenteLeitura, chavesForaDaLista } = require('../lib/assinatura/recuperacao-provedor.ts');

function sincSimples(log) {
    return {
        eventosPendentes: async () => ['ev1', 'ev2'],
        processarEvento: async (_c, id, deps) => { log.push(['processarEvento', id, chavesForaDaLista(deps.provedor)]); return { situacao: 'PROCESSADO' }; },
        empresasComProvedor: async () => ['e1'],
        sincronizarEmpresa: async (_c, id, deps) => { log.push(['sincronizarEmpresa', id, chavesForaDaLista(deps.provedor)]); return { resultado: 'SINCRONIZADA', mudou: false }; },
    };
}
const clienteLog = (log, falharCommit = false) => ({ query: async (sql) => {
    log.push(['sql', sql]);
    if (falharCommit && sql === 'COMMIT') throw new Error('conexão caiu');
    return { rows: [] };
} });

for (const aplicar of [false, true]) {
    test(`provedorEfetivo chega intacto aos serviços, sem o adaptador da simulação (aplicar=${aplicar})`, async () => {
        const log = [];
        const provedorEfetivo = provedorSomenteLeitura({ obterCobranca: async () => null, removerAssinatura: async () => ({ removida: true }) });
        await executarCiclo({ client: clienteLog(log), provedor: {}, aplicar, banco: 'sintetico', sinc: sincSimples(log), provedorEfetivo, antesDoCommit: async () => null });
        const chaves = log.filter((l) => l[0] !== 'sql').map((l) => l[2]);
        assert.deepEqual(chaves, [[], [], []], 'nenhuma chave fora da lista fechada (removerAssinatura não volta pelo adaptador)');
        assert.deepEqual(log.filter((l) => l[0] === 'sql').map((l) => l[1]), aplicar
            ? ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'] : ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
    });
}

test('antesDoCommit com motivo: ROLLBACK do item corrente e o ciclo para com ParadaCiclo', async () => {
    const log = [];
    let n = 0;
    await assert.rejects(executarCiclo({ client: clienteLog(log), provedor: {}, aplicar: true, banco: 'sintetico', sinc: sincSimples(log),
        provedorEfetivo: provedorSomenteLeitura({}), antesDoCommit: async () => (++n === 2 ? 'TRAVA_PERDIDA' : null) }),
    (e) => e instanceof ParadaCiclo && e.motivo === 'TRAVA_PERDIDA');
    assert.deepEqual(log.filter((l) => l[0] === 'sql').map((l) => l[1]), ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
    assert.equal(log.some((l) => l[0] === 'sincronizarEmpresa'), false, 'nenhum item depois da parada');
});

test('COMMIT sem resposta: ParadaCiclo COMMIT_INDETERMINADO, nunca ROLLBACK silencioso', async () => {
    const log = [];
    await assert.rejects(executarCiclo({ client: clienteLog(log, true), provedor: {}, aplicar: true, banco: 'sintetico', sinc: sincSimples(log),
        provedorEfetivo: provedorSomenteLeitura({}), antesDoCommit: async () => null }),
    (e) => e instanceof ParadaCiclo && e.motivo === 'COMMIT_INDETERMINADO');
    assert.deepEqual(log.filter((l) => l[0] === 'sql').map((l) => l[1]), ['BEGIN', 'COMMIT']);
});

test('sem antesDoCommit, COMMIT com falha segue o comportamento anterior (erro do item, ROLLBACK)', async () => {
    const log = [];
    const r = await executarCiclo({ client: clienteLog(log, true), provedor: {}, aplicar: true, banco: 'sintetico', sinc: sincSimples(log) });
    assert.equal(r.eventos.ERRO_Error, 2);
});
