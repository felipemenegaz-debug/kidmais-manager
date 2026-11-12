import assert from 'node:assert/strict';
import test from 'node:test';
import { processarRenovacao, proximaDataDaSerie, inicioJanelaAviso, diasAntes, mensagemRenovacao, type ContextoRenovacao, type DepsRenovacao,
    type RegistroRenovacao } from './renovacao-fundador.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * B-9 production (plano docs/PLANO_B9_PRODUCAO_PUTS_JANELA_20261029.md rev. 5, D-JP-1..4): janela de aviso perdida trocada
 * pelo sucessor no modo agendado. Sem banco nem rede: repositório e provedor falsos.
 */
const E = '11111111-1111-4111-8111-111111111111';
const DEST = '33333333-3333-4333-8333-333333333333';

function fixture(o: { ciclo?: 'MENSAL' | 'ANUAL'; registro?: Partial<RegistroRenovacao>; capacidade?: '075' | '109'; simular?: boolean } = {}) {
    let agora = new Date('2027-09-12T15:00:00Z'); // janela normal (06/09–09/09) perdida
    const ciclo = o.ciclo ?? 'MENSAL';
    const c: ContextoRenovacao = { empresaId: E, contratacaoId: '22222222-2222-4222-8222-222222222222', situacao: 'ATIVA', empresaAtiva: true,
        isenta: false, assinaturaId: 'sub_1', clienteId: 'cus_1', ciclo, plano: 'ESSENCIAL', valorFinal: 11820, valorRegular: 19700,
        beneficioFim: '2027-10-09T12:00:00.000Z', primeiroPagamentoId: 'pay_1', destinatarioId: DEST,
        email: 'gestor@example.invalid', destinatarioValido: true, registro: null };
    const original: RegistroRenovacao = { id: '44444444-4444-4444-8444-444444444444', empresaId: E, contratacaoId: c.contratacaoId, destinatarioId: DEST,
        primeiroVencimento: '2026-10-09', primeiraDataRegular: '2027-10-09',
        mensagem: mensagemRenovacao(c, '44444444-4444-4444-8444-444444444444', '2027-10-09', 'https://kidmais.example'),
        estado: 'PENDENTE', avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null, ...o.registro };
    c.registro = original;
    const sub: AssinaturaProvedor = { id: 'sub_1', customer: 'cus_1', externalReference: E, status: 'ACTIVE', deleted: false,
        cycle: ciclo === 'ANUAL' ? 'YEARLY' : 'MONTHLY', valorCentavos: 11820, nextDueDate: '2027-10-09' };
    const parcela: CobrancaProvedor = { id: 'p_out', dueDate: '2027-10-09', status: 'PENDING', deleted: false, paymentDate: null, invoiceUrl: null,
        valorCentavos: 11820, assinaturaId: 'sub_1', clienteId: 'cus_1', billingType: 'PIX' };
    const chamadas: string[] = [], enviadas: { idempotencia: string; texto: string }[] = [], substituidos: string[] = [];
    let falhaEmail = false, recusarSubstituicao = false;
    const deps: DepsRenovacao = {
        agora: () => agora, origem: 'https://kidmais.example', simular: o.simular ?? false, travar: async (_e, f) => f(), modoAgendado: true,
        capacidade: o.capacidade ?? '109',
        repositorio: {
            ler: async () => structuredClone(c),
            criar: async () => { throw new Error('criar não deveria ser chamado'); },
            marcar: async (_e, id, a) => {
                assert.equal(id, c.registro!.id, 'marca sempre o vigente');
                chamadas.push(`estado:${a.estado}`);
                const r = c.registro!; r.estado = a.estado; r.ultimoErro = a.erro ?? null;
                if (a.tentativa) r.avisoTentadoEm ??= agora.toISOString();
                if (a.envioId) r.avisoEnviadoEm ??= agora.toISOString();
            },
            substituir: async (_e, anterior, sucessor) => {
                chamadas.push('substituir');
                if (recusarSubstituicao) throw new Error('SUBSTITUICAO_RECUSADA');
                assert.equal(anterior.id, c.registro!.id);
                substituidos.push(anterior.id);
                c.registro = { ...structuredClone(sucessor), substituto: true };
                return structuredClone(c.registro);
            },
        },
        enviar: async (m) => {
            chamadas.push('enviar'); enviadas.push({ idempotencia: m.idempotencia!, texto: m.texto });
            if (falhaEmail) throw new Error('Resposta perdida.');
            return { provedor: 'arquivo', idExterno: 'email_1' };
        },
        provedor: {
            obterAssinatura: async () => ({ ...sub }),
            obterCobranca: async () => ({ ...parcela }),
            listarCobrancasDaAssinatura: async () => [{ ...parcela }],
            atualizarValorAssinatura: async () => { chamadas.push('preco'); return { ...sub }; },
            atualizarValorCobranca: async () => { chamadas.push('parcela'); return { ...parcela }; },
            suspenderGeracao: async () => { chamadas.push('suspender'); return { ...sub }; },
        },
    };
    return { c, deps, sub, chamadas, enviadas, substituidos, dia: (s: string) => { agora = new Date(s); },
        falharEmail: () => { falhaEmail = true; }, recusar: () => { recusarSubstituicao = true; } };
}

test('série de vencimentos: mensal com candidata em hoje+33 e depois; âncora 31/jan em fevereiro; anual em múltiplos de 12', () => {
    assert.equal(proximaDataDaSerie('2026-10-09', 'MENSAL', '2027-10-15'), '2027-11-09', 'estritamente depois de hoje+33');
    assert.equal(proximaDataDaSerie('2026-10-09', 'MENSAL', '2027-11-09'), '2027-11-09', 'exatamente hoje+33');
    assert.equal(proximaDataDaSerie('2027-01-31', 'MENSAL', '2028-02-02'), '2028-02-29', 'fevereiro bissexto preserva a âncora');
    assert.equal(proximaDataDaSerie('2027-01-31', 'MENSAL', '2027-02-02'), '2027-02-28', 'fevereiro comum');
    assert.equal(proximaDataDaSerie('2027-01-31', 'MENSAL', '2027-03-01'), '2027-03-31', 'sem desvio acumulado depois de fevereiro');
    assert.equal(proximaDataDaSerie('2026-10-09', 'MENSAL', '2029-05-20'), '2029-06-09', 'recuperação muito tardia');
    assert.equal(proximaDataDaSerie('2026-10-09', 'ANUAL', '2027-10-15'), '2028-10-09', 'anual: próximo múltiplo de 12');
    assert.equal(proximaDataDaSerie('2024-02-29', 'ANUAL', '2026-01-01'), '2026-02-28', 'anual: 12k meses da âncora (não acumula)');
    assert.equal(proximaDataDaSerie('2024-02-29', 'ANUAL', '2027-03-01'), '2028-02-29');
    assert.throws(() => proximaDataDaSerie('2026-02-30', 'MENSAL', '2027-01-01'));
});

test('janela do sucessor: 63..30 dias; mensal sempre aberta no dia da substituição; anual aberto e aguardando', () => {
    // Para todo hoje de um ano, a primeira data mensal ≥ hoje+33 deixa hoje dentro de [data−63, data−30].
    for (let d = Date.parse('2027-01-01'); d < Date.parse('2028-01-01'); d += 86400000) {
        const hoje = new Date(d).toISOString().slice(0, 10);
        const minimo = new Date(d + 33 * 86400000).toISOString().slice(0, 10);
        for (const ancora of ['2026-01-31', '2026-10-09', '2026-03-30']) {
            const data = proximaDataDaSerie(ancora, 'MENSAL', minimo);
            assert.ok(hoje >= inicioJanelaAviso(data, true) && hoje <= diasAntes(data), `${ancora} ${hoje} → ${data}`);
        }
    }
    assert.equal(inicioJanelaAviso('2027-12-15', true), '2027-10-13');
    assert.ok('2027-10-29' >= inicioJanelaAviso(proximaDataDaSerie('2026-12-15', 'ANUAL', '2027-12-01'), true), 'anual com janela já aberta');
    assert.ok('2027-10-29' < inicioJanelaAviso(proximaDataDaSerie('2026-10-15', 'ANUAL', '2027-12-01'), true), 'anual aguardando');
    assert.equal(inicioJanelaAviso('2027-12-15'), '2027-11-12', 'janela normal sem mudança');
});

test('mensal: substitui, avisa na mesma execução pelo sucessor (chave nova, frase de substituição) e não toca o preço', async () => {
    const f = fixture();
    assert.equal(await processarRenovacao(E, f.deps), 'AVISO_REAGENDADO');
    assert.deepEqual(f.chamadas, ['substituir', 'estado:AVISANDO', 'enviar', 'estado:AVISADA']);
    assert.equal(f.c.registro!.primeiraDataRegular, '2027-11-09');
    assert.equal(f.c.registro!.substituto, true);
    assert.equal(f.enviadas[0].idempotencia, `kidmais-renovacao/${f.c.registro!.id}`);
    assert.notEqual(f.c.registro!.id, '44444444-4444-4444-8444-444444444444');
    assert.match(f.enviadas[0].texto, /09\/11\/2027/);
    assert.match(f.enviadas[0].texto, /Este aviso substitui qualquer data de renovação informada antes\./);
});

test('anual: substitui e aguarda a janela do sucessor (resultado explícito); nada enviado', async () => {
    const f = fixture({ ciclo: 'ANUAL' });
    assert.equal(await processarRenovacao(E, f.deps), 'AVISO_REAGENDADO_AGUARDANDO');
    assert.deepEqual(f.chamadas, ['substituir']);
    assert.equal(f.c.registro!.primeiraDataRegular, '2028-10-09');
    // Retomada: o sucessor PENDENTE segue o fluxo normal com a janela dele.
    f.dia('2028-08-07T15:00:00Z');
    assert.equal(await processarRenovacao(E, f.deps), 'AGUARDANDO_ULTIMA_PARCELA');
    assert.deepEqual(f.chamadas.slice(1), ['estado:AVISANDO', 'enviar', 'estado:AVISADA']);
});

test('capacidade 075, simulação e destinatário: sem substituição', async () => {
    const a = fixture({ capacidade: '075' });
    assert.equal(await processarRenovacao(E, a.deps), 'ALERTA_JANELA_AVISO_PERDIDA');
    const s = fixture({ simular: true });
    assert.equal(await processarRenovacao(E, s.deps), 'REAGENDARIA_AVISO');
    for (const [nome, mudar] of [['inválido', (c: ContextoRenovacao) => { c.destinatarioValido = false; }],
        ['outro destinatário', (c: ContextoRenovacao) => { c.destinatarioId = '55555555-5555-4555-8555-555555555555'; }],
        ['outro e-mail', (c: ContextoRenovacao) => { c.email = 'outro@example.invalid'; }]] as const) {
        const d = fixture(); mudar(d.c);
        assert.equal(await processarRenovacao(E, d.deps), 'ALERTA_REAGENDAMENTO_SEM_DESTINATARIO', nome);
        assert.deepEqual(d.chamadas, [], nome);
    }
    for (const x of [a, s]) assert.deepEqual(x.chamadas, []);
});

test('R3-F3: PENDENTE com tentativa preenchida e janela vencida → zero chamadas a substituir', async () => {
    const f = fixture({ registro: { avisoTentadoEm: '2027-09-07T15:00:00.000Z' } });
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_JANELA_AVISO_PERDIDA');
    assert.equal(f.chamadas.filter((x) => x === 'substituir').length, 0);
});

test('AVISANDO (exclusão por estado) fora da substituição, com tentativa < 23 h e ≥ 23 h; sem chave nova', async () => {
    for (const tentado of ['2027-09-12T05:00:00.000Z', '2027-09-09T05:00:00.000Z']) {
        const f = fixture({ registro: { estado: 'AVISANDO', avisoTentadoEm: tentado, ultimoErro: 'ENVIO_INCERTO' } });
        assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_JANELA_AVISO_PERDIDA', tentado);
        assert.deepEqual(f.chamadas, [], tentado);
    }
});

test('R2-F4 (idade): AVISANDO com tentativa ≥ 23 h DENTRO da janela de calendário → nenhum envio novo', async () => {
    const f = fixture({ registro: { estado: 'AVISANDO', avisoTentadoEm: '2027-09-06T15:00:00.000Z', ultimoErro: 'ENVIO_INCERTO' } });
    f.dia('2027-09-08T15:00:00Z');
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_ENVIO_INCERTO_FORA_JANELA');
    assert.deepEqual(f.chamadas, []);
});

test('resultados compostos: substituição recusada, envio incerto e exceção depois do COMMIT nunca somem', async () => {
    const r = fixture(); r.recusar();
    assert.equal(await processarRenovacao(E, r.deps), 'ALERTA_SUBSTITUICAO_RECUSADA');
    assert.deepEqual(r.chamadas, ['substituir']);
    const e = fixture(); e.falharEmail();
    assert.equal(await processarRenovacao(E, e.deps), 'AVISO_REAGENDADO_ENVIO_INCERTO');
    assert.deepEqual(e.chamadas, ['substituir', 'estado:AVISANDO', 'enviar', 'estado:AVISANDO']);
    const x = fixture();
    const marcar = x.deps.repositorio.marcar;
    x.deps.repositorio.marcar = async (...a) => { if (a[2].estado === 'AVISADA') throw new Error('queda ao marcar AVISADA'); return marcar(...a); };
    // A exceção sai da rotina; o executor converte em AVISO_REAGENDADO_ERRO_REPROCESSAVEL (renovacao-agendada.test.ts).
    // Aqui: o envio foi tentado e AVISADA não foi gravada → ENVIO_INCERTO composto.
    assert.equal(await processarRenovacao(E, x.deps), 'AVISO_REAGENDADO_ENVIO_INCERTO');
});

test('fora do modo agendado (ferramenta manual) a janela perdida continua REVISAO, sem substituição', async () => {
    const f = fixture();
    f.deps.modoAgendado = false;
    assert.equal(await processarRenovacao(E, f.deps), 'JANELA_AVISO_PERDIDA');
    assert.ok(!f.chamadas.includes('substituir'));
});

test('D-JP-2: a folga é hoje+33 (não hoje+30): perdida em 30/01, a série dia 1 dá 01/04 (com +30 daria 01/03)', async () => {
    const f = fixture({ registro: { primeiroVencimento: '2026-02-01', primeiraDataRegular: '2027-02-01' } });
    f.dia('2027-01-30T15:00:00Z'); // limite normal 02/01; hoje+30 = 01/03; hoje+33 = 04/03
    f.sub.nextDueDate = '2027-02-01';
    assert.equal(await processarRenovacao(E, f.deps), 'AVISO_REAGENDADO');
    assert.equal(f.c.registro!.primeiraDataRegular, '2027-04-01');
});

test('F3 (revisão do código): HISTORICO_SEM_VIGENTE na criação → ALERTA_HISTORICO_SEM_VIGENTE no processador e no executor; outra exceção sobe', async () => {
    const { executarAgendada } = await import('./renovacao-agendada.ts');
    const preparar = (erro: string) => {
        const f = fixture();
        f.c.registro = null;
        f.deps.provedor.obterCobranca = async () => ({ id: 'pay_1', dueDate: '2026-10-09', status: 'RECEIVED', deleted: false, paymentDate: '2026-10-09', invoiceUrl: null,
            valorCentavos: 11820, assinaturaId: 'sub_1', clienteId: 'cus_1', billingType: 'PIX' });
        f.deps.repositorio.criar = async () => { throw new Error(erro); };
        return f;
    };
    const f = preparar('HISTORICO_SEM_VIGENTE');
    assert.equal(await processarRenovacao(E, f.deps), 'ALERTA_HISTORICO_SEM_VIGENTE');
    assert.deepEqual(f.chamadas, [], 'nenhuma raiz, nenhum envio, nenhum PUT');
    await assert.rejects(processarRenovacao(E, preparar('conexão perdida').deps), /conexão perdida/);
    const g = preparar('HISTORICO_SEM_VIGENTE');
    const r = await executarAgendada({ modo: 'aplicar', empresas: [E], agora: () => new Date('2027-09-12T15:00:00Z'),
        travaGlobal: { adquirir: async () => true, aindaMinha: async () => true, liberar: async () => undefined },
        travarEmpresa: async (_e, t) => t(), ler: async () => null, provedor: { obterAssinatura: async () => null, listarCobrancasDaAssinatura: async () => [] },
        processar: (e, travar) => processarRenovacao(e, { ...g.deps, travar }) });
    assert.deepEqual([r.alertas[0]?.resultado, r.alertas[0]?.motivo, r.codigo], ['ALERTA_HISTORICO_SEM_VIGENTE', 'ALERTA_HISTORICO_SEM_VIGENTE', 2]);
});
