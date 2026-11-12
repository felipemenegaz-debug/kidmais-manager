import assert from 'node:assert/strict';
import test from 'node:test';
import { classificar, executarAgendada, relerPreco, type OpcoesExecucao, type TravaGlobal } from './renovacao-agendada.ts';
import type { ContextoRenovacao, RegistroRenovacao } from './renovacao-fundador.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/** B-9 (plano rev. 3.1): classificação, releitura de preço, contador da janela e parada da execução. Sem banco nem rede. */
const E1 = '11111111-1111-4111-8111-111111111111', E2 = '22222222-2222-4222-8222-222222222222';
function registro(estado: RegistroRenovacao['estado'], extra: Partial<RegistroRenovacao> = {}): RegistroRenovacao {
    return { id: 'r', empresaId: E1, contratacaoId: 'c', destinatarioId: 'd', primeiroVencimento: '2026-10-09', primeiraDataRegular: '2027-10-09',
        mensagem: { para: 'x@example.invalid', assunto: 'a', texto: 't', html: '<p>t</p>', idempotencia: 'k' }, estado,
        avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null, ...extra };
}
function contexto(r: RegistroRenovacao | null): ContextoRenovacao {
    return { empresaId: E1, contratacaoId: 'c', situacao: 'ATIVA', empresaAtiva: true, isenta: false, assinaturaId: 'sub_1', clienteId: 'cus_1',
        ciclo: 'MENSAL', plano: 'ESSENCIAL', valorFinal: 11820, valorRegular: 19700, beneficioFim: '2027-10-09T12:00:00.000Z', primeiroPagamentoId: 'pay_1',
        destinatarioId: 'd', email: 'x@example.invalid', destinatarioValido: true, registro: r };
}
const sub = (valor: number): AssinaturaProvedor => ({ id: 'sub_1', customer: 'cus_1', externalReference: E1, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', valorCentavos: valor });
const parcela = (dueDate: string, valor: number): CobrancaProvedor => ({ id: dueDate, dueDate, status: 'PENDING', deleted: false, paymentDate: null, invoiceUrl: null,
    valorCentavos: valor, assinaturaId: 'sub_1', clienteId: 'cus_1', billingType: 'PIX' });
function trava(): TravaGlobal & { estado: { adquirida: boolean; minha: boolean; liberada: number } } {
    const estado = { adquirida: true, minha: true, liberada: 0 };
    return { estado, adquirir: async () => estado.adquirida, aindaMinha: async () => estado.minha, liberar: async () => { estado.liberada++; } };
}
function opcoes(over: Partial<OpcoesExecucao> & { resultados?: Record<string, string>; estados?: Record<string, [RegistroRenovacao | null, RegistroRenovacao | null]> } = {}) {
    const lidas: Record<string, number> = {};
    const t = over.travaGlobal ?? trava();
    const o: OpcoesExecucao = {
        modo: 'aplicar', empresas: [E1], travaGlobal: t,
        travarEmpresa: async (_e, f) => f(),
        ler: async (e) => { lidas[e] = (lidas[e] ?? 0) + 1; const [a, b] = over.estados?.[e] ?? [null, null]; return contexto(lidas[e] === 1 ? a : b); },
        provedor: { obterAssinatura: async () => sub(11820), listarCobrancasDaAssinatura: async () => [] },
        processar: async (e) => over.resultados?.[e] ?? 'AGUARDANDO_AVISO',
        agora: () => new Date('2027-08-01T15:00:00Z'),
        ...over,
    };
    return { o, t: t as ReturnType<typeof trava> };
}

test('classificação: tabela completa da §2.5', () => {
    for (const r of ['AGUARDANDO_AVISO', 'AGUARDANDO_ULTIMA_PARCELA', 'REGULAR', 'CANCELADA', 'SEM_FUNDADOR', 'NAO_ELEGIVEL'])
        assert.equal(classificar(r, 'PENDENTE', 'PENDENTE', 'aplicar').classe, 'OK', r);
    for (const r of ['ENVIARIA_AVISO', 'ATUALIZARIA_PRECO']) {
        assert.equal(classificar(r, 'PENDENTE', 'PENDENTE', 'simular').classe, 'OK', r);
        assert.deepEqual(classificar(r, 'PENDENTE', 'PENDENTE', 'aplicar'), { classe: 'ALERTA', motivo: 'RESULTADO_DESCONHECIDO' }, `${r} em aplicar`);
    }
    assert.equal(classificar('ENVIO_INCERTO', 'PENDENTE', 'AVISANDO', 'aplicar').classe, 'OK', 'pendente na primeira vez');
    assert.equal(classificar('AGUARDANDO_CONFIRMACAO_PRECO', 'AVISADA', 'APLICANDO', 'aplicar').classe, 'OK');
    assert.deepEqual(classificar('ENVIO_INCERTO', 'AVISANDO', 'AVISANDO', 'aplicar'), { classe: 'ALERTA', motivo: 'INTENCAO_PENDENTE_REPETIDA' });
    assert.deepEqual(classificar('AGUARDANDO_CONFIRMACAO_PRECO', 'APLICANDO', 'APLICANDO', 'aplicar'), { classe: 'ALERTA', motivo: 'INTENCAO_PENDENTE_REPETIDA' });
    assert.deepEqual(classificar('REGULAR', 'APLICANDO', 'APLICANDO', 'aplicar').classe, 'ALERTA', 'intenção que persiste é alerta qualquer que seja o resultado');
    for (const r of ['ALERTA_JANELA_AVISO_PERDIDA', 'REVISAO_EXISTENTE', 'ERRO_REPROCESSAVEL']) assert.equal(classificar(r, 'PENDENTE', 'PENDENTE', 'aplicar').classe, 'ALERTA', r);
    assert.deepEqual(classificar('INVENTADO', 'PENDENTE', 'PENDENTE', 'aplicar'), { classe: 'ALERTA', motivo: 'RESULTADO_DESCONHECIDO' });
});

test('releitura de preço: pela leitura, não pelo PUT; parcelas da renovação contadas; leitura que falha é incerta', async () => {
    const avisado = contexto(registro('APLICANDO', { avisoTentadoEm: 'x', avisoEnviadoEm: '2027-09-09T15:00:00Z' }));
    assert.equal(await relerPreco(contexto(registro('PENDENTE')), { obterAssinatura: async () => sub(1), listarCobrancasDaAssinatura: async () => [] }), null, 'sem aviso, nada a conferir');
    // Retomada depois de queda: assinatura já regular, parcela da renovação ainda Fundador (sem PUT nesta execução).
    const p = await relerPreco(avisado, { obterAssinatura: async () => sub(19700),
        listarCobrancasDaAssinatura: async () => [parcela('2027-09-09', 11820), parcela('2027-10-09', 11820), parcela('2027-11-09', 19700), { ...parcela('2027-12-09', 5), deleted: true }] });
    assert.deepEqual(p, { assinatura: 'REGULAR', parcelasDaRenovacao: { regulares: 1, fundador: 1, outras: 0, naoLidas: 0 }, estadoPersistido: 'APLICANDO', confirmado: true });
    const falha = await relerPreco(avisado, { obterAssinatura: async () => { throw new Error('x'); }, listarCobrancasDaAssinatura: async () => [] });
    assert.deepEqual([falha?.assinatura, falha?.confirmado], ['NAO_LIDA', false]);
});

test('execução: alerta de preço não lido, intenção repetida, desconhecido e ENVIARIA em aplicar saem 2; OK sai 0', async () => {
    const ok = opcoes({ estados: { [E1]: [registro('PENDENTE'), registro('PENDENTE')] } });
    assert.deepEqual([(await executarAgendada(ok.o)).codigo, ok.t.estado.liberada], [0, 1]);
    const repetida = opcoes({ resultados: { [E1]: 'AGUARDANDO_CONFIRMACAO_PRECO' },
        estados: { [E1]: [registro('APLICANDO', { avisoEnviadoEm: 'x' }), registro('APLICANDO', { avisoEnviadoEm: 'x' })] },
        provedor: { obterAssinatura: async () => sub(19700), listarCobrancasDaAssinatura: async () => [] } });
    const r = await executarAgendada(repetida.o);
    assert.deepEqual([r.codigo, r.alertas[0]?.motivo, r.alertas[0]?.precoRemoto?.assinatura], [2, 'INTENCAO_PENDENTE_REPETIDA', 'REGULAR']);
    const naoLido = opcoes({ resultados: { [E1]: 'AGUARDANDO_ULTIMA_PARCELA' }, estados: { [E1]: [registro('AVISADA', { avisoEnviadoEm: 'x' }), registro('AVISADA', { avisoEnviadoEm: 'x' })] },
        provedor: { obterAssinatura: async () => { throw new Error('fora'); }, listarCobrancasDaAssinatura: async () => [] } });
    assert.deepEqual([(await executarAgendada(naoLido.o)).alertas[0]?.motivo], ['PRECO_NAO_LIDO']);
    for (const resultado of ['INVENTADO', 'ENVIARIA_AVISO']) {
        const x = opcoes({ resultados: { [E1]: resultado } });
        assert.equal((await executarAgendada(x.o)).codigo, 2, resultado);
    }
    const sim = opcoes({ modo: 'simular', resultados: { [E1]: 'ENVIARIA_AVISO' } });
    assert.equal((await executarAgendada(sim.o)).codigo, 0);
    const erro = opcoes({ processar: async () => { throw new Error('rede'); } });
    assert.deepEqual([(await executarAgendada(erro.o)).alertas[0]?.resultado], ['ERRO_REPROCESSAVEL']);
});

test('uma única aquisição da trava por empresa envolve leitura inicial, processamento e leitura final', async () => {
    const ordem: string[] = []; let dentro = false;
    const x = opcoes({
        travarEmpresa: async (_e, f) => { ordem.push('trava'); dentro = true; try { return await f(); } finally { dentro = false; } },
        ler: async () => { ordem.push(`ler:${dentro}`); return contexto(registro('PENDENTE')); },
        processar: async (e, travar) => { ordem.push(`processar:${dentro}`); return travar(e, async () => { ordem.push(`rotina:${dentro}`); return 'AGUARDANDO_AVISO'; }); },
    });
    await executarAgendada(x.o);
    assert.deepEqual(ordem, ['trava', 'ler:true', 'processar:true', 'rotina:true', 'ler:true'], 'a rotina não adquire a trava de novo');
});

test('contador da janela: ausência de avisoEnviadoEm, não o estado; último dia é alerta', async () => {
    const hoje = () => new Date('2027-09-09T15:00:00Z'); // −30
    for (const [estado, enviado, alerta] of [['APLICANDO', true, false], ['REGULAR', true, false], ['AVISANDO', false, true], ['PENDENTE', false, true]] as const) {
        const reg = registro(estado, enviado ? { avisoTentadoEm: 'x', avisoEnviadoEm: '2027-09-07T15:00:00Z', ...(estado === 'REGULAR' ? { precoAplicadoEm: 'y' } : {}) } : {});
        const x = opcoes({ agora: hoje, resultados: { [E1]: 'AGUARDANDO_ULTIMA_PARCELA' }, estados: { [E1]: [registro('AVISADA', { avisoEnviadoEm: 'x' }), reg] },
            provedor: { obterAssinatura: async () => sub(19700), listarCobrancasDaAssinatura: async () => [] } });
        const r = await executarAgendada(x.o);
        assert.equal(r.avisosNaJanela, enviado ? 0 : 1, estado);
        assert.equal(r.alertas.some((a) => a.motivo === 'AVISO_PENDENTE_ULTIMO_DIA'), alerta, estado);
    }
    const antes = opcoes({ agora: () => new Date('2027-09-07T15:00:00Z'), estados: { [E1]: [registro('PENDENTE'), registro('PENDENTE')] } });
    const r = await executarAgendada(antes.o);
    assert.deepEqual([r.avisosNaJanela, r.codigo], [1, 0], 'na janela, antes do último dia: conta sem alertar');
});

test('trava sobreposta, trava perdida, limite e interrupção param antes de começar outra empresa', async () => {
    const sobreposta = opcoes(); sobreposta.t.estado.adquirida = false;
    const s = await executarAgendada(sobreposta.o);
    assert.deepEqual([s.execucao, s.codigo, s.processadas, sobreposta.t.estado.liberada], ['EXECUCAO_SOBREPOSTA', 0, 0, 0]);
    let n = 0; const perdida = opcoes({ empresas: [E1, E2], processar: async () => { n++; return 'AGUARDANDO_AVISO'; } });
    perdida.t.aindaMinha = async () => n === 0;
    const p = await executarAgendada(perdida.o);
    assert.deepEqual([p.execucao, p.codigo, p.processadas, perdida.t.estado.liberada], ['TRAVA_PERDIDA', 2, 1, 1]);
    const caiu = opcoes(); caiu.t.aindaMinha = async () => { throw new Error('conexão encerrada'); };
    assert.equal((await executarAgendada(caiu.o)).execucao, 'TRAVA_PERDIDA');
    let relogio = 0; const limite = opcoes({ empresas: [E1, E2], relogio: () => relogio, limiteMs: 1000, processar: async () => { relogio += 1000; return 'AGUARDANDO_AVISO'; } });
    const l = await executarAgendada(limite.o);
    assert.deepEqual([l.execucao, l.codigo, l.processadas], ['LIMITE_EXECUCAO', 2, 1]);
    let parar = false; const sinal = opcoes({ empresas: [E1, E2], interrompido: () => parar, processar: async () => { parar = true; return 'AGUARDANDO_AVISO'; } });
    const i = await executarAgendada(sinal.o);
    assert.deepEqual([i.execucao, i.codigo, i.processadas, sinal.t.estado.liberada], ['INTERROMPIDA', 1, 1, 1]);
});

test('filtro de homologação: fora da seleção é NAO_ELEGIVEL, contado e nunca processado', async () => {
    const processadas: string[] = [];
    const x = opcoes({ empresas: [E1], naoElegiveis: [E2], processar: async (e) => { processadas.push(e); return 'AGUARDANDO_AVISO'; } });
    const r = await executarAgendada(x.o);
    assert.deepEqual([processadas, r.resultados.NAO_ELEGIVEL, r.codigo], [[E1], 1, 0]);
});

test('relatório sanitizado: sem e-mail, valor ou id do provedor', async () => {
    const x = opcoes({ resultados: { [E1]: 'ALERTA_COBRANCA_JA_PROCESSADA' }, estados: { [E1]: [registro('AVISADA', { avisoEnviadoEm: 'x' }), registro('APLICANDO', { avisoEnviadoEm: 'x' })] },
        provedor: { obterAssinatura: async () => sub(19700), listarCobrancasDaAssinatura: async () => [parcela('2027-10-09', 11820)] } });
    const j = JSON.stringify(await executarAgendada(x.o));
    assert.doesNotMatch(j, /example\.invalid|sub_1|cus_1|11820|19700|2027-10-09/);
});

// ---- Revisão do B-9 implementado (26/10/2026): três P2 do executor e a verificação da trava antes da primeira empresa.
test('P2-1: exceção depois do PUT (resposta perdida) ainda relê estado e preço sob a trava; alerta com APLICANDO e preço REGULAR', async () => {
    let dentro = false; const leiturasDentro: boolean[] = [];
    const x = opcoes({
        travarEmpresa: async (_e, f) => { dentro = true; try { return await f(); } finally { dentro = false; } },
        estados: { [E1]: [registro('AVISADA', { avisoEnviadoEm: 'x' }), registro('APLICANDO', { avisoEnviadoEm: 'x' })] },
        provedor: { obterAssinatura: async () => { leiturasDentro.push(dentro); return sub(19700); }, listarCobrancasDaAssinatura: async () => { leiturasDentro.push(dentro); return []; } },
        processar: async () => { throw new Error('Resposta perdida depois do PUT.'); },
    });
    const r = await executarAgendada(x.o);
    const a = r.alertas[0];
    assert.deepEqual([a?.resultado, a?.estadoSaida, a?.precoRemoto?.assinatura, a?.precoRemoto?.confirmado], ['ERRO_REPROCESSAVEL', 'APLICANDO', 'REGULAR', true]);
    assert.ok(leiturasDentro.length === 2 && leiturasDentro.every(Boolean), 'releitura dentro da trava por empresa');
});

test('P2-2: REVISAO_EXISTENTE não gera nenhuma chamada ao provedor na execução inteira', async () => {
    let chamadas = 0;
    const revisao = registro('REVISAO', { avisoTentadoEm: 'x', avisoEnviadoEm: '2027-09-07T15:00:00Z', ultimoErro: 'JANELA_AVISO_PERDIDA' });
    const x = opcoes({ resultados: { [E1]: 'REVISAO_EXISTENTE' }, estados: { [E1]: [revisao, revisao] },
        provedor: { obterAssinatura: async () => { chamadas++; return sub(19700); }, listarCobrancasDaAssinatura: async () => { chamadas++; return []; } } });
    const r = await executarAgendada(x.o);
    assert.deepEqual([chamadas, r.alertas[0]?.resultado, r.alertas[0]?.precoRemoto], [0, 'REVISAO_EXISTENTE', null]);
});

test('P2-3: AVISADA → APLICANDO sem alerta sai em emAndamento com estado e preço relido; código 0', async () => {
    const x = opcoes({ resultados: { [E1]: 'AGUARDANDO_CONFIRMACAO_PRECO' },
        estados: { [E1]: [registro('AVISADA', { avisoEnviadoEm: 'x' }), registro('APLICANDO', { avisoEnviadoEm: 'x' })] },
        provedor: { obterAssinatura: async () => sub(19700), listarCobrancasDaAssinatura: async () => [parcela('2027-10-09', 11820)] } });
    const r = await executarAgendada(x.o);
    assert.deepEqual([r.codigo, r.alertas.length, r.emAndamento.length], [0, 0, 1]);
    const i = r.emAndamento[0];
    assert.deepEqual([i.empresaId, i.estadoSaida, i.precoRemoto?.assinatura, i.precoRemoto?.parcelasDaRenovacao.fundador, i.precoRemoto?.estadoPersistido],
        [E1, 'APLICANDO', 'REGULAR', 1, 'APLICANDO']);
    const quieto = opcoes(); // PENDENTE fora da janela: nada em andamento
    assert.equal((await executarAgendada(quieto.o)).emAndamento.length, 0);
});

test('trava conferida antes da PRIMEIRA empresa: perdida desde o início → nada processado', async () => {
    let processou = false;
    const x = opcoes({ processar: async () => { processou = true; return 'AGUARDANDO_AVISO'; } });
    x.t.aindaMinha = async () => false;
    const r = await executarAgendada(x.o);
    assert.deepEqual([r.execucao, r.processadas, processou, r.codigo], ['TRAVA_PERDIDA', 0, false, 2]);
});

// ---- Revisão da rodada 2 (26/10/2026): P2-N1 — falha da releitura do banco nunca sai como sucesso.
test('P2-N1: releitura do banco que falha depois de resultado normal é alerta ESTADO_NAO_LIDO (código 2), preservando resultado e entrada', async () => {
    for (const [resultado, entrada] of [['AGUARDANDO_CONFIRMACAO_PRECO', 'APLICANDO'], ['AGUARDANDO_ULTIMA_PARCELA', 'AVISADA'], ['AGUARDANDO_AVISO', 'PENDENTE']] as const) {
        let leituras = 0, chamadasProvedor = 0;
        const x = opcoes({
            resultados: { [E1]: resultado },
            ler: async () => { leituras++; if (leituras === 2) throw new Error('timeout transitório'); return contexto(registro(entrada, entrada === 'PENDENTE' ? {} : { avisoEnviadoEm: 'x' })); },
            provedor: { obterAssinatura: async () => { chamadasProvedor++; return sub(19700); }, listarCobrancasDaAssinatura: async () => { chamadasProvedor++; return []; } },
        });
        const r = await executarAgendada(x.o);
        const a = r.alertas[0];
        assert.deepEqual([r.codigo, a?.resultado, a?.motivo, a?.estadoEntrada, a?.estadoSaida, a?.precoRemoto, r.emAndamento.length],
            [2, resultado, 'ESTADO_NAO_LIDO', entrada, 'ILEGIVEL', null, 0], resultado);
        assert.equal(chamadasProvedor, 0, 'sem estado lido, não há preço a inventar');
    }
    // Controle: falha do processamento continua ERRO_REPROCESSAVEL (motivo próprio), também com a releitura falhando.
    let n = 0;
    const y = opcoes({ processar: async () => { throw new Error('x'); }, ler: async () => { n++; if (n === 2) throw new Error('y'); return contexto(registro('APLICANDO', { avisoEnviadoEm: 'x' })); } });
    const r = await executarAgendada(y.o);
    assert.deepEqual([r.codigo, r.alertas[0]?.resultado, r.alertas[0]?.motivo], [2, 'ERRO_REPROCESSAVEL', 'ERRO_REPROCESSAVEL']);
});
