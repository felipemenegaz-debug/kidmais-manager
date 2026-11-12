import assert from 'node:assert/strict';
import test from 'node:test';
import { classificar, contagemVazia, executarAgendada, instrumentarProvedor, observarRepositorio, type Instrumentos, type OpcoesExecucao } from './renovacao-agendada.ts';
import type { ContextoRenovacao, RegistroRenovacao, RepositorioRenovacao } from './renovacao-fundador.ts';
import type { AssinaturaProvedor, ProvedorRenovacao } from './asaas.ts';

/** D-P5-5 = B (Felipe, 29/10/2026; plano rev. 5 §1): contagem de PUTs por empresa e alertas. Sem banco nem rede. */
const E1 = '11111111-1111-4111-8111-111111111111', E2 = '22222222-2222-4222-8222-222222222222';
const instr = (estado: Instrumentos['estadoVigente'] = 'AVISADA'): Instrumentos => ({ contagem: contagemVazia(), estadoVigente: estado, substituiu: false });
const sub: AssinaturaProvedor = { id: 'sub_1', customer: 'cus_1', externalReference: E1, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', valorCentavos: 19700 };
function provedorBase(falhar: Partial<Record<keyof ProvedorRenovacao, boolean>> = {}) {
    const p = {
        obterAssinatura: async () => ({ ...sub }), listarCobrancasDaAssinatura: async () => [], obterCobranca: async () => null,
        atualizarValorAssinatura: async () => { if (falhar.atualizarValorAssinatura) throw new Error('timeout'); return { ...sub }; },
        atualizarValorCobranca: async (c: never) => { if (falhar.atualizarValorCobranca) throw new Error('timeout'); return c; },
        suspenderGeracao: async () => ({ ...sub }),
        // Métodos do cliente Asaas que NÃO podem atravessar a lista fechada.
        criarAssinatura: async () => ({ ...sub }), removerAssinatura: async () => ({ removida: true }), criarCliente: async () => ({}),
    };
    return p as unknown as ProvedorRenovacao;
}
function registro(estado: RegistroRenovacao['estado']): RegistroRenovacao {
    return { id: 'r', empresaId: E1, contratacaoId: 'c', destinatarioId: 'd', primeiroVencimento: '2026-10-09', primeiraDataRegular: '2027-10-09',
        mensagem: { para: 'segredo@example.invalid', assunto: 'a', texto: 't', html: '<p>t</p>', idempotencia: 'k' }, estado,
        avisoTentadoEm: 'x', avisoEnviadoEm: '2027-09-07T15:00:00Z', precoAplicadoEm: null, ultimoErro: null };
}
const contexto = (r: RegistroRenovacao | null): ContextoRenovacao => ({ empresaId: E1, contratacaoId: 'c', situacao: 'ATIVA', empresaAtiva: true, isenta: false,
    assinaturaId: 'sub_1', clienteId: 'cus_1', ciclo: 'MENSAL', plano: 'ESSENCIAL', valorFinal: 11820, valorRegular: 19700,
    beneficioFim: '2027-10-09T12:00:00.000Z', primeiroPagamentoId: 'pay_1', destinatarioId: 'd', email: 'segredo@example.invalid', destinatarioValido: true, registro: r });

/** Entrada lida antes do processamento; a saída (releitura) é REGULAR, para não cair na regra da intenção repetida. */
function opcoes(processar: OpcoesExecucao['processar'], over: Partial<OpcoesExecucao> & { entrada?: RegistroRenovacao['estado'] } = {}): OpcoesExecucao {
    const lidas = new Map<string, number>();
    return {
        modo: 'aplicar', empresas: [E1],
        travaGlobal: { adquirir: async () => true, aindaMinha: async () => true, liberar: async () => undefined },
        travarEmpresa: async (_e, f) => f(),
        ler: async (e) => { const n = (lidas.get(e) ?? 0) + 1; lidas.set(e, n); return contexto(registro(n % 2 === 1 ? over.entrada ?? 'AVISADA' : 'REGULAR')); },
        provedor: { obterAssinatura: async () => ({ ...sub }), listarCobrancasDaAssinatura: async () => [] },
        processar, agora: () => new Date('2027-09-20T15:00:00Z'), ...over,
    };
}

test('lista fechada: exatamente os 6 métodos de ProvedorRenovacao; os demais do cliente Asaas ficam ausentes', () => {
    const p = instrumentarProvedor(provedorBase(), instr());
    assert.deepEqual(Object.keys(p).sort(), ['atualizarValorAssinatura', 'atualizarValorCobranca', 'listarCobrancasDaAssinatura', 'obterAssinatura', 'obterCobranca', 'suspenderGeracao']);
    for (const m of ['criarAssinatura', 'removerAssinatura', 'criarCliente']) assert.equal((p as unknown as Record<string, unknown>)[m], undefined, m);
});

test('contagem: três mutações, falha antes de delegar e depois de sucesso, leitura não conta, fora de APLICANDO pelo estado vigente', async () => {
    const i = instr('APLICANDO');
    const p = instrumentarProvedor(provedorBase({ atualizarValorCobranca: true }), i);
    await p.obterAssinatura('sub_1'); await p.listarCobrancasDaAssinatura('sub_1'); await p.obterCobranca('x');
    await p.atualizarValorAssinatura('sub_1', 19700);
    await assert.rejects(p.atualizarValorCobranca({} as never, 19700), /timeout/, 'falha na parcela depois do sucesso na assinatura');
    assert.deepEqual(i.contagem, { assinatura: 1, parcelas: 1, suspensao: 0, falhas: 1, foraDeAplicando: 0 });
    i.estadoVigente = 'REGULAR';
    await p.suspenderGeracao('sub_1');
    assert.deepEqual(i.contagem, { assinatura: 1, parcelas: 1, suspensao: 1, falhas: 1, foraDeAplicando: 1 });
});

test('estado vigente só muda depois que a escrita resolve; falha de commit não habilita', async () => {
    const i = instr('AVISADA');
    let falhar = true;
    const repo: RepositorioRenovacao = { ler: async () => null, criar: async (r) => r,
        marcar: async () => { if (falhar) throw new Error('COMMIT falhou'); } };
    const o = observarRepositorio(repo, i);
    await assert.rejects(o.marcar(E1, 'r', { estado: 'APLICANDO' }));
    assert.equal(i.estadoVigente, 'AVISADA', 'APLICANDO não foi persistido');
    falhar = false;
    await o.marcar(E1, 'r', { estado: 'APLICANDO' });
    assert.equal(i.estadoVigente, 'APLICANDO');
    assert.equal(o.substituir, undefined, 'repositório da 075 continua sem substituir');
});

test('executor: alertas de PUT (fora de APLICANDO, repetido, suspensão, simulação) e retomada em APLICANDO sem alerta', async () => {
    const caso = async (f: (p: ProvedorRenovacao, i: Instrumentos) => Promise<void>, over: Partial<OpcoesExecucao> & { entrada?: RegistroRenovacao['estado'] } = {}) =>
        executarAgendada(opcoes(async (_e, _t, i) => { await f(instrumentarProvedor(provedorBase(), i), i); return 'REGULAR'; }, over));
    // REGULAR com preço divergente: PUT sem passar por APLICANDO (D-PUT-1 = PUT + alerta).
    let r = await caso(async (p) => { await p.atualizarValorAssinatura('sub_1', 19700); }, { entrada: 'REGULAR' });
    assert.deepEqual([r.codigo, r.alertas[0]?.motivo, r.alertas[0]?.puts.foraDeAplicando], [2, 'PUT_FORA_DE_APLICANDO', 1]);
    // Retomada legítima: entrada APLICANDO.
    r = await caso(async (p) => { await p.atualizarValorAssinatura('sub_1', 19700); await p.atualizarValorCobranca({} as never, 19700); }, { entrada: 'APLICANDO' });
    assert.deepEqual([r.codigo, r.alertas.length, r.emAndamento[0]?.puts], [0, 0, { assinatura: 1, parcelas: 1, suspensao: 0, falhas: 0, foraDeAplicando: 0 }]);
    // Saída commitada de APLICANDO seguida de PUT → foraDeAplicando.
    r = await caso(async (p, i) => { i.estadoVigente = 'REVISAO'; await p.atualizarValorCobranca({} as never, 19700); }, { entrada: 'APLICANDO' });
    assert.deepEqual([r.alertas[0]?.motivo, r.alertas[0]?.puts.foraDeAplicando], ['PUT_FORA_DE_APLICANDO', 1]);
    // Duas tentativas de preço da assinatura.
    r = await caso(async (p) => { await p.atualizarValorAssinatura('sub_1', 19700); await p.atualizarValorAssinatura('sub_1', 19700); }, { entrada: 'APLICANDO' });
    assert.deepEqual([r.alertas[0]?.motivo, r.alertas[0]?.puts.assinatura], ['PUT_ASSINATURA_REPETIDO', 2]);
    r = await caso(async (p) => { await p.suspenderGeracao('sub_1'); }, { entrada: 'APLICANDO' });
    assert.equal(r.alertas[0]?.motivo, 'PUT_SUSPENSAO_NO_AGENDADO');
    r = await caso(async (p) => { await p.atualizarValorCobranca({} as never, 19700); }, { entrada: 'APLICANDO', modo: 'simular' });
    assert.equal(r.alertas[0]?.motivo, 'PUT_EM_SIMULACAO');
});

test('totais: por empresa sem mistura, sobrevivem a exceção e a interrupção; zeros nas saídas antecipadas; JSON sem dados sensíveis', async () => {
    let parar = false;
    const o = opcoes(async (e, _t, i) => {
        const p = instrumentarProvedor(provedorBase(), i);
        if (e === E1) { await p.atualizarValorAssinatura('sub_1', 19700); throw new Error('resposta perdida depois do PUT'); }
        await p.atualizarValorCobranca({} as never, 19700); await p.atualizarValorCobranca({} as never, 19700); parar = true; return 'REGULAR';
    }, { empresas: [E1, E2, '33333333-3333-4333-8333-333333333333'], entrada: 'APLICANDO', interrompido: () => parar });
    const r = await executarAgendada(o);
    assert.equal(r.execucao, 'INTERROMPIDA');
    const porId = Object.fromEntries([...r.alertas, ...r.emAndamento].map((x) => [x.empresaId, x.puts]));
    assert.deepEqual(porId[E1], { assinatura: 1, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 0 }, 'E1 só com o dela');
    assert.deepEqual(porId[E2], { assinatura: 0, parcelas: 2, suspensao: 0, falhas: 0, foraDeAplicando: 0 });
    assert.deepEqual(r.putsTotais, { assinatura: 1, parcelas: 2, suspensao: 0, falhas: 0, foraDeAplicando: 0, empresasComTentativa: 2 });
    const json = JSON.stringify(r);
    assert.ok(!json.includes('segredo@example.invalid') && !json.includes('sub_1') && !json.includes('19700'), 'sem e-mail, id do provedor ou valor');
    // Trava por empresa não obtida: item com zeros.
    const t = await executarAgendada({ ...opcoes(async () => 'REGULAR'), travarEmpresa: async () => { throw new Error('CONTRATACAO_EM_ANDAMENTO'); } });
    assert.deepEqual([t.alertas[0]?.resultado, t.alertas[0]?.puts, t.putsTotais.empresasComTentativa], ['ERRO_REPROCESSAVEL', contagemVazia(), 0]);
    const sobreposta = await executarAgendada({ ...opcoes(async () => 'REGULAR'), travaGlobal: { adquirir: async () => false, aindaMinha: async () => true, liberar: async () => undefined } });
    assert.deepEqual(sobreposta.putsTotais, { ...contagemVazia(), empresasComTentativa: 0 });
});

test('janela perdida: substituição preservada no catch do executor; classificação dos resultados novos', async () => {
    const r = await executarAgendada(opcoes(async (_e, _t, i) => { i.substituiu = true; throw new Error('queda depois do COMMIT'); }, { entrada: 'PENDENTE' }));
    assert.deepEqual([r.alertas[0]?.resultado, r.alertas[0]?.motivo], ['AVISO_REAGENDADO_ERRO_REPROCESSAVEL', 'JANELA_PERDIDA_REAGENDADA']);
    for (const x of ['AVISO_REAGENDADO', 'AVISO_REAGENDADO_AGUARDANDO', 'AVISO_REAGENDADO_ENVIO_INCERTO'])
        assert.deepEqual(classificar(x, 'PENDENTE', 'AVISADA', 'aplicar'), { classe: 'ALERTA', motivo: 'JANELA_PERDIDA_REAGENDADA' }, x);
    assert.deepEqual(classificar('REAGENDARIA_AVISO', 'PENDENTE', 'PENDENTE', 'simular'), { classe: 'OK', motivo: null });
    assert.deepEqual(classificar('REAGENDARIA_AVISO', 'PENDENTE', 'PENDENTE', 'aplicar'), { classe: 'ALERTA', motivo: 'RESULTADO_DESCONHECIDO' });
    for (const x of ['ALERTA_REAGENDAMENTO_SEM_DESTINATARIO', 'ALERTA_SUBSTITUICAO_RECUSADA', 'ALERTA_HISTORICO_SEM_VIGENTE'])
        assert.equal(classificar(x, 'PENDENTE', 'PENDENTE', 'aplicar').classe, 'ALERTA', x);
});
