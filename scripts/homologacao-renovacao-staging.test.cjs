/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da rodada de renovação: sem rede, sem banco, sem Asaas/Resend (repositório, provedor e transporte simulados).
// Executar: node --experimental-strip-types --test scripts/homologacao-renovacao-staging.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');
const h = require('./homologacao-renovacao-staging.cjs');
const fundador = require('./homologacao-fundador-staging.cjs');
const rodada1 = require('./homologacao-planos-cotacao-staging.cjs');

const fonte = fs.readFileSync(__dirname + '/homologacao-renovacao-staging.cjs', 'utf8');
const ts = arquivo => import(pathToFileURL(path.resolve(__dirname, '..', arquivo)).href);
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true', DATABASE_SSL:'false', DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const [RM, RA, RF] = h.FIXTURES;
const executar = (args, env) => spawnSync(process.execPath, ['--experimental-strip-types', __dirname + '/homologacao-renovacao-staging.cjs', ...args],
    {encoding:'utf8', env:{...env, PATH:process.env.PATH}, timeout:30000});

test('sem a flag única não executa; flags extras recusadas; recuperação tem flag própria e exige o disco', () => {
    assert.equal(h.modo([]), null); assert.equal(h.modo(['--fundador-rodada-2-autorizada']), null);
    assert.equal(h.modo([h.FLAG, '--x']), null); assert.equal(h.modo([h.FLAG, 'x']), null);
    assert.equal(h.modo([h.FLAG]), 'RODADA'); assert.equal(h.modo([h.FLAG_ENCERRAR]), 'ENCERRAR');
    const nada = executar([], {});
    assert.equal(nada.status, 1); assert.match(nada.stderr, /AGUARDANDO_AUTORIZACAO_RENOVACAO/);
    // Rascunho substituído pela rodada consolidada: nenhuma flag executa.
    for (const flag of [h.FLAG, h.FLAG_ENCERRAR]) { const x = executar([flag], envStaging()); assert.equal(x.status, 1); assert.match(x.stderr, /RASCUNHO_SUBSTITUIDO/, flag); }
});

test('guardas: só web staging, banco de staging, sandbox, planos ligados', () => {
    assert.ok(h.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0'}, {KIDMAIS_DEPLOY_ENV:'production'},
        {ASAAS_AMBIENTE:'producao'}, {ASSINATURA_PLANOS_ATIVOS:undefined}, {RENDER:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'}])
        assert.throws(() => h.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.ok(h.alvoEncerramento({...envStaging(), ASSINATURA_PLANOS_ATIVOS:undefined}), 'recuperação não exige a chave');
});

test('fixtures inéditas (≠ rodadas Fundador/planos e Kidmais); e-mail sintético por padrão; marcador de encerramento próprio', () => {
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.plano, f.ciclo]), [['RM','essencial','MENSAL'], ['RA','essencial','ANUAL'], ['RF','profissional','MENSAL']]);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    const antigos = new Set([...fundador.FIXTURES, ...rodada1.FIXTURES].flatMap(f => [f.empresa, f.usuario, f.codigo, f.email]));
    assert.equal(new Set(ids).size, 6); assert.ok(!ids.includes(KIDMAIS));
    assert.equal(h.MODO_EMAIL, 'SINK', 'envio real exige decisão e nova candidata');
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.match(f.codigo, /^hml-renovacao-[a-z]+$/);
        assert.match(f.email, /@example\.invalid$/); assert.match(f.nome, /^TESTE .* r1 /);
        assert.notEqual(h.emailEncerrado(f.usuario), f.email); assert.match(h.emailEncerrado(f.usuario), /-encerrado@example\.invalid$/);
        for (const v of [f.empresa, f.usuario, f.codigo, f.email]) assert.ok(!antigos.has(v), v);
    }
    assert.equal(h.emailDe('RM', RM.usuario, 'RESEND'), h.DESTINO_AUTORIZADO, 'RESEND: só RM, só o destinatário autorizado');
    assert.match(h.emailDe('RA', RA.usuario, 'RESEND'), /@example\.invalid$/); assert.match(h.emailDe('RF', RF.usuario, 'RESEND'), /@example\.invalid$/);
});

test('preços independentes: catálogo regular, anual = 10 × mensal, 40% Fundador exato', () => {
    const planos = fs.readFileSync(__dirname + '/../lib/assinatura/planos-comerciais.ts', 'utf8');
    assert.match(planos, /multiplicadorAnual: 10/); assert.match(planos, /fundador: \{ descontoPercentual: 40, meses: 12, vagas: 20 \}/);
    for (const [chave, {regular, fundador: f}] of Object.entries(h.PRECOS)) {
        const [plano, ciclo] = chave.split('/');
        const mensal = Number(planos.match(new RegExp(`${plano}: \\{[^}]*mensalCentavos: (\\d+)`))[1]);
        assert.equal(regular, ciclo === 'ANUAL' ? mensal * 10 : mensal, chave); assert.equal(f * 100, regular * 60, chave);
    }
    assert.deepEqual([RM.fundador, RA.fundador, RF.fundador], [11820, 118200, 23820]);
});

test('campanha: as três vagas precisam caber sem mexer no teto', () => {
    assert.equal(h.cabeNaCampanha({ocupadas:17}), true); assert.equal(h.cabeNaCampanha({ocupadas:18}), false);
    assert.equal(h.cabeNaCampanha({}), false); assert.equal(h.cabeNaCampanha(null), false);
});

test('calendário próprio = processador do produto (âncora, fim de mês, bissexto, UTC do benefício)', async () => {
    const {primeiraRenovacaoRegular, diasAntes, diaBrasil} = await ts('lib/assinatura/renovacao-fundador.ts');
    assert.equal(h.somarMeses('2026-01-31', 1), '2026-02-28'); assert.equal(h.somarMeses('2026-01-31', 2), '2026-03-31');
    assert.equal(h.somarMeses('2028-01-31', 1), '2028-02-29'); assert.equal(h.somarMeses('2026-10-10', 12), '2027-10-10');
    const casos = [['2026-10-10','2027-10-10T15:00:05.000Z'], ['2026-10-10','2027-10-11T01:30:00.000Z'], ['2026-01-31','2027-01-31T12:00:00.000Z'],
        ['2028-02-29','2029-02-28T12:00:00.000Z'], ['2026-12-31','2027-12-31T23:00:00.000Z']];
    for (const [pv, fim] of casos) for (const ciclo of ['MENSAL','ANUAL'])
        assert.equal(h.primeiraEsperada(pv, fim, ciclo), primeiraRenovacaoRegular(pv, fim, ciclo), pv + ciclo + fim);
    assert.equal(h.primeiraEsperada('2026-10-10', '2027-10-11T01:30:00.000Z', 'MENSAL'), '2027-11-10', 'confirmação após 21h BRT: 13º vencimento');
    for (const d of ['2027-10-10','2027-03-01','2028-03-30']) assert.equal(h.somarDias(d, -30), diasAntes(d));
    for (const t of [Date.parse('2026-10-10T02:59:59Z'), Date.parse('2026-10-10T03:00:00Z'), Date.parse('2026-12-31T23:30:00Z')])
        assert.equal(h.diaBrasil(new Date(t)), diaBrasil(new Date(t)));
});

test('tempo acelerado: limite no futuro, instantes em dias inteiros, nada além do processo', () => {
    const t = h.planoTempo('2026-10-10', '2027-10-10');
    assert.equal(t.limite, '2027-09-10'); assert.deepEqual(t.offsets, {REAL:0, VESPERA:334, LIMITE:335, PERDIDO:336});
    assert.deepEqual(t.dias, {REAL:'2026-10-10', VESPERA:'2027-09-09', LIMITE:'2027-09-10', PERDIDO:'2027-09-11'});
    assert.throws(() => h.planoTempo('2026-10-10', '2026-11-09'), /JANELA_ACELERADA_INVALIDA/, 'limite hoje: CHECK da 075 exige limite no futuro neste desenho');
    assert.throws(() => h.planoTempo('2026-10-10', '2026-11-01'), /JANELA_ACELERADA_INVALIDA/);
    assert.throws(() => h.planoTempo('2026-10-10', '2028-12-10'), /JANELA_ACELERADA_INVALIDA/);
    const base = () => Date.parse('2026-10-10T15:00:00Z');
    for (const [k, off] of Object.entries(t.offsets)) assert.equal(h.diaBrasil(h.relogio(off, base)()), t.dias[k], k);
    assert.throws(() => h.relogio(-1)); assert.throws(() => h.relogio(1.5)); assert.throws(() => h.relogio(500));
    assert.doesNotMatch(fonte, /useFakeTimers|Date\.now\s*=|process\.env\.TZ\s*=|SET\s+(LOCAL\s+)?TIME\s*ZONE|faketime/i, 'relógio do sistema/banco nunca é alterado');
});

test('escopo: processador e provedor só alcançam fixtures e as assinaturas delas', async () => {
    const esc = h.escopo();
    assert.throws(() => esc.empresa(KIDMAIS), /FORA_DAS_FIXTURES/); assert.equal(esc.empresa(RM.empresa), RM.empresa);
    assert.throws(() => esc.vincular(KIDMAIS, 'sub_x'), /FORA_DAS_FIXTURES/);
    esc.vincular(RM.empresa, 'sub_RM'); assert.throws(() => esc.vincular(RM.empresa, 'sub_outra'), /FORA_DAS_FIXTURES/);
    assert.throws(() => esc.assinatura('sub_terceiro'), /FORA_DAS_FIXTURES/); assert.equal(esc.assinatura('sub_RM'), 'sub_RM');
    const repo = h.repositorioRestrito({ler:async e => e, criar:async r => r, marcar:async () => 'ok'}, esc);
    await assert.rejects(async () => repo.ler(KIDMAIS), /FORA_DAS_FIXTURES/); await assert.rejects(async () => repo.criar({empresaId:KIDMAIS}), /FORA_DAS_FIXTURES/);
    await assert.rejects(async () => repo.marcar(KIDMAIS, 'x', {}), /FORA_DAS_FIXTURES/); assert.equal(await repo.ler(RM.empresa), RM.empresa);
    const chamadas = [];
    const p = h.provedorRestrito({obterAssinatura:async id => (chamadas.push(id), {id}), obterCobranca:async id => ({id, assinaturaId:id === 'pay_RM' ? 'sub_RM' : 'sub_terceiro'}),
        atualizarValorAssinatura:async id => (chamadas.push('put:' + id), {id})}, esc, {perderRespostaPreco:new Set(['sub_RM'])});
    await assert.rejects(p.obterAssinatura('sub_terceiro'), /FORA_DAS_FIXTURES/); assert.deepEqual(chamadas, [], 'recusa ANTES da rede');
    await assert.rejects(p.obterCobranca('pay_x'), /FORA_DAS_FIXTURES/); assert.equal((await p.obterCobranca('pay_RM')).id, 'pay_RM');
    await assert.rejects(p.atualizarValorAssinatura('sub_RM', 19700), /RESPOSTA_PERDIDA_SIMULADA/);
    assert.deepEqual(chamadas, ['put:sub_RM'], 'resposta perdida DEPOIS do PUT real');
    assert.equal((await p.atualizarValorAssinatura('sub_RM', 19700)).id, 'sub_RM', 'perde só uma vez');
    assert.equal(p.contagem.precoAssinatura.sub_RM, 2);
});

test('transporte: sink determinístico, falha sem rede, Resend só ao destinatário autorizado e uma vez', async () => {
    const m = {para:RM.email, assunto:'a', texto:'t', html:'<p>t</p>', idempotencia:'kidmais-renovacao/0547c356-9f39-4168-9baa-249c65c963e2'};
    const log = [];
    assert.deepEqual(await h.envioDaFixture(RM, h.envioSink(log))(m), {provedor:'sink', idExterno:h.idSink(m.idempotencia)});
    assert.equal(h.idSink(m.idempotencia), h.idSink(m.idempotencia)); assert.notEqual(h.idSink(m.idempotencia), h.idSink('outra'));
    await assert.rejects(h.envioDaFixture(RM, h.envioSink(log))({...m, para:RA.email}), /MENSAGEM_FORA_DA_FIXTURE/);
    await assert.rejects(h.envioDaFixture(RM, h.envioSink(log))({...m, idempotencia:'outra'}), /MENSAGEM_FORA_DA_FIXTURE/);
    await assert.rejects(h.envioDaFixture(RF, h.envioFalho(log))({...m, para:RF.email}), /FALHA_DE_ENTREGA_SIMULADA/);
    assert.equal(log.length, 2);
    const rede = [];
    const pedido = (body, extra = {}) => ['https://api.resend.com/emails', {method:'POST', headers:{'Idempotency-Key':m.idempotencia}, body:JSON.stringify(body), ...extra}];
    const ok = {from:h.REMETENTE_TESTE, to:[h.DESTINO_AUTORIZADO]};
    for (const [nome, args] of [['outro destino', pedido({...ok, to:['outro@example.com']})], ['dois destinos', pedido({...ok, to:[h.DESTINO_AUTORIZADO, 'x@y.z']})],
        ['outro remetente', pedido({...ok, from:'Kidmais <no-reply@kidmais.com.br>'})], ['outra URL', ['https://api.resend.com/domains', pedido(ok)[1]]],
        ['GET', pedido(ok, {method:'GET'})], ['chave fora do registro', pedido(ok, {headers:{'Idempotency-Key':'x'}})]]) {
        const f = h.fetchResendRestrito(async (...a) => (rede.push(a), {ok:true}));
        await assert.rejects(f(...args), /DESTINO_RECUSADO/, nome);
    }
    const f = h.fetchResendRestrito(async (...a) => (rede.push(a), {ok:true}));
    await f(...pedido(ok)); await assert.rejects(f(...pedido(ok)), /DESTINO_RECUSADO/, 'no máximo uma requisição');
    assert.equal(rede.length, 1); assert.equal(rede[0][1].redirect, 'error'); assert.equal(f.requisicoes(), 2);
});

test('evento entregue à rota do webhook é aceito pelo parser real e aponta só para a fixture', async () => {
    const {extrairEvento} = await ts('lib/assinatura/sincronizacao.ts');
    const ev = h.eventoConfirmacao(RA, 'pay_abc123', 'sub_def456', '00000000-0000-4000-8000-000000000000');
    const x = extrairEvento(ev);
    assert.equal(x.tipo, 'PAYMENT_CONFIRMED'); assert.equal(x.cobrancaId, 'pay_abc123'); assert.equal(x.assinaturaId, 'sub_def456');
    assert.equal(x.referenciaExterna, RA.empresa); assert.match(x.eventoId, /^hml-renovacao-RA-/);
});

/** Mundo simulado: repositório com as regras da 075 (transições, prazo do aviso pelo relógio REAL), Asaas em memória. */
function mundo(inicio = Date.parse('2026-10-10T15:00:00Z')) {
    let real = inicio;
    const base = () => real, passar = ms => { real += ms; };
    const TRANS = {PENDENTE:['AVISANDO','REVISAO','CANCELADA'], AVISANDO:['AVISADA','REVISAO','CANCELADA'], AVISADA:['APLICANDO','REVISAO','CANCELADA'],
        APLICANDO:['REGULAR','REVISAO','CANCELADA'], REGULAR:['REVISAO','CANCELADA'], REVISAO:['CANCELADA'], CANCELADA:[]};
    const ctx = {}, regs = {}, subs = {}, pays = {};
    const fim = '2027-10-10T15:00:05.000Z';
    for (const f of h.FIXTURES) {
        ctx[f.empresa] = {empresaId:f.empresa, contratacaoId:f.usuario, situacao:'ATIVA', empresaAtiva:true, isenta:false, assinaturaId:'sub_' + f.chave,
            clienteId:'cus_' + f.chave, ciclo:f.ciclo, plano:f.plano.toUpperCase(), valorFinal:f.fundador, valorRegular:f.regular, beneficioFim:fim,
            primeiroPagamentoId:'pay_' + f.chave, destinatarioId:f.usuario, email:f.email, destinatarioValido:true};
        subs['sub_' + f.chave] = {id:'sub_' + f.chave, status:'ACTIVE', deleted:false, cycle:f.ciclo === 'ANUAL' ? 'YEARLY' : 'MONTHLY', customer:'cus_' + f.chave,
            externalReference:f.empresa, valorCentavos:f.fundador, nextDueDate:f.ciclo === 'ANUAL' ? '2027-10-10' : '2026-11-10'};
        pays['pay_' + f.chave] = {id:'pay_' + f.chave, status:'RECEIVED', dueDate:'2026-10-10', paymentDate:'2026-10-10', invoiceUrl:null, deleted:false,
            valorCentavos:f.fundador, assinaturaId:'sub_' + f.chave, clienteId:'cus_' + f.chave, billingType:'PIX'};
    }
    const repo = {
        async ler(e) { return ctx[e] ? {...ctx[e], registro:regs[e] ? structuredClone(regs[e]) : null} : null; },
        async criar(r) { if (!regs[r.empresaId]) { assert.equal(r.estado, 'PENDENTE'); regs[r.empresaId] = structuredClone(r); } return structuredClone(regs[r.empresaId]); },
        async marcar(e, id, a) {
            const r = regs[e]; assert.equal(r.id, id);
            if (a.estado !== r.estado && !TRANS[r.estado].includes(a.estado)) throw Error('TRANSICAO_075 ' + r.estado + '>' + a.estado);
            const t = new Date(real).toISOString();
            const n = {...r, estado:a.estado, ultimoErro:a.erro ?? null, avisoTentadoEm:a.tentativa ? (r.avisoTentadoEm ?? t) : r.avisoTentadoEm,
                avisoEnviadoEm:a.envioId ? (r.avisoEnviadoEm ?? t) : r.avisoEnviadoEm, precoAplicadoEm:a.regular ? (r.precoAplicadoEm ?? t) : r.precoAplicadoEm};
            if (n.avisoEnviadoEm && h.diaBrasil(new Date(n.avisoEnviadoEm)) > h.somarDias(r.primeiraDataRegular, -30)) throw Error('CHECK_075_PRAZO');
            if (['AVISADA','APLICANDO','REGULAR'].includes(n.estado) && !n.avisoEnviadoEm) throw Error('CHECK_075_AVISO');
            if (n.estado === 'REGULAR' && !n.precoAplicadoEm) throw Error('CHECK_075_PRECO');
            regs[e] = n;
        },
    };
    const asaas = {
        async obterAssinatura(id) { return subs[id] ? {...subs[id]} : null; },
        async listarCobrancasDaAssinatura(id) { return Object.values(pays).filter(x => x.assinaturaId === id).map(x => ({...x})); },
        async obterCobranca(id) { return pays[id] ? {...pays[id]} : null; },
        async atualizarValorAssinatura(id, v) { subs[id].valorCentavos = v; return {...subs[id]}; },
        async atualizarValorCobranca(x, v) { pays[x.id].valorCentavos = v; return {...pays[x.id]}; },
        async suspenderGeracao(id) { subs[id].status = 'INACTIVE'; return {...subs[id]}; },
    };
    const ocupadas = new Set();
    const travar = async (e, trabalho) => {
        if (ocupadas.has(e)) throw Object.assign(Error('ocupada'), {code:'CONTRATACAO_EM_ANDAMENTO'});
        ocupadas.add(e); try { return await trabalho(); } finally { ocupadas.delete(e); }
    };
    return {base, passar, ctx, regs, subs, pays, repo, asaas, travar};
}

/** Mesmo encadeamento do executor (rodar/etapaRodada), com o processador REAL do produto e o mundo simulado. */
async function preparar(m) {
    const {processarRenovacao} = await ts('lib/assinatura/renovacao-fundador.ts');
    const esc = h.escopo(), contagem = {}, perder = new Set(), envios = {RM:[], RA:[], RF:[]}, erros = [];
    for (const f of h.FIXTURES) esc.vincular(f.empresa, 'sub_' + f.chave);
    const tempo = Object.fromEntries(h.FIXTURES.map(f => [f.chave, h.planoTempo('2026-10-10', h.primeiraEsperada('2026-10-10', m.ctx[f.empresa].beneficioFim, f.ciclo))]));
    const transporte = f => f.chave === 'RF' ? h.envioFalho(envios.RF) : h.envioSink(envios[f.chave]);
    const deps = {repositorio:h.repositorioRestrito(m.repo, esc), provedor:h.provedorRestrito(m.asaas, esc, {perderRespostaPreco:perder, contagem}),
        origem:'https://kidmais-manager-staging.onrender.com', simular:false, travar:m.travar};
    const rodar = async (f, quando) => {
        const agora = h.relogio(tempo[f.chave].offsets[quando], m.base);
        assert.equal(h.diaBrasil(agora()), tempo[f.chave].dias[quando]);
        try { return await h.comRetentativa(() => processarRenovacao(esc.empresa(f.empresa), {...deps, enviar:h.envioDaFixture(f, transporte(f)), agora}), {esperar:() => new Promise(ok => setTimeout(ok, 5))}); }
        catch (e) { if (e?.parada) throw e; erros.push([f.chave, String(e.message)]); return 'ERRO_REPROCESSAVEL'; }
    };
    const registro = f => { const r = m.regs[f.empresa];
        return {estado:r.estado, enviado:!!r.avisoEnviadoEm, aplicado:!!r.precoAplicadoEm, ultimo_erro:r.ultimoErro, primeira:r.primeiraDataRegular,
            para:r.mensagem.para, chave_ok:r.mensagem.idempotencia === 'kidmais-renovacao/' + r.id, total:1}; };
    const etapa = async rodada => {
        for (const f of h.FIXTURES.filter(x => rodada.quando[x.chave])) {
            m.passar(1000);
            const obtido = rodada.id === 'R2' && f.chave === 'RM'
                ? (await Promise.all([rodar(f, 'LIMITE'), rodar(f, 'LIMITE')])).reduce((a, b) => (h.conferir('RM.R2.concorrente', b, a), a))
                : await rodar(f, rodada.quando[f.chave]);
            h.conferirResultado(f.chave + '.' + rodada.id, obtido, rodada.esperado[f.chave]);
        }
        if (h.REGISTROS[rodada.id]) for (const f of h.FIXTURES) h.conferirRegistro(f.chave, registro(f), h.REGISTROS[rodada.id][f.chave], f, tempo[f.chave]);
    };
    return {esc, contagem, perder, envios, erros, tempo, rodar, etapa};
}

test('matriz completa com o processador real: aviso único, preço regular na data, resposta perdida, falha de entrega, cancelamento', async () => {
    const m = mundo(), x = await preparar(m), R = Object.fromEntries(h.RODADAS.map(r => [r.id, r]));
    for (const id of ['R0','R0B','R1']) await x.etapa(R[id]);
    assert.deepEqual(x.envios, {RM:[], RA:[], RF:[]}, 'nada enviado antes do limite');
    assert.equal(Object.keys(m.regs).length, 3, 'um registro por fixture, persistido antes do envio');
    x.perder.add('sub_RA');
    await x.etapa(R.R2);
    assert.deepEqual(x.erros, [['RA','RESPOSTA_PERDIDA_SIMULADA']]); assert.equal(m.subs.sub_RA.valorCentavos, RA.regular, 'PUT aplicado, resposta perdida');
    await x.etapa(R.R3);
    for (const k of ['RM','RF']) { assert.equal(m.subs['sub_' + k].valorCentavos, h.FIXTURES.find(f => f.chave === k).fundador, k + ' sem aumento antecipado'); }
    // Salto do próximo vencimento só nas assinaturas mensais das fixtures (no executor: PUT nextDueDate no sandbox).
    for (const k of ['RM','RF']) m.subs['sub_' + k].nextDueDate = x.tempo[k].primeira;
    m.pays.pay_RM_2 = {...m.pays.pay_RM, id:'pay_RM_2', status:'PENDING', paymentDate:null, dueDate:x.tempo.RM.primeira}; // Asaas pode já ter gerado a parcela
    await x.etapa(R.R4); await x.etapa(R.R5);
    for (const f of [RM, RA]) assert.deepEqual(h.divergenciasPrecoRegular(m.subs['sub_' + f.chave], Object.values(m.pays).filter(p => p.assinaturaId === 'sub_' + f.chave),
        f, x.tempo[f.chave], 'pay_' + f.chave), [], f.chave);
    assert.equal(m.pays.pay_RM_2.valorCentavos, RM.regular, 'parcela já gerada na data regular corrigida');
    assert.equal(m.subs.sub_RF.status, 'INACTIVE'); assert.equal(m.subs.sub_RF.valorCentavos, RF.fundador, 'sem aviso: nunca aumenta; geração suspensa');
    assert.deepEqual(x.contagem.precoAssinatura, {sub_RA:1, sub_RM:1}); assert.deepEqual(x.contagem.suspensao, {sub_RF:1});
    assert.deepEqual(Object.fromEntries(Object.entries(x.envios).map(([k, v]) => [k, v.length])), h.ENVIOS);
    for (const k of ['RM','RA']) { m.ctx[h.FIXTURES.find(f => f.chave === k).empresa].situacao = 'CANCELADA_FIM_PERIODO'; m.subs['sub_' + k].deleted = true; }
    await x.etapa(R.R6);
    assert.deepEqual(Object.fromEntries(Object.entries(x.envios).map(([k, v]) => [k, v.length])), h.ENVIOS, 'repetições não reenviam');
    assert.ok(['pay_RM','pay_RA'].every(id => m.pays[id].status === 'RECEIVED' && m.pays[id].valorCentavos === h.FIXTURES.find(f => 'pay_' + f.chave === id).fundador), 'período pago preservado');
    assert.deepEqual(Object.keys(x.esc.uso).sort(), h.FIXTURES.map(f => f.empresa).sort(), 'nenhuma outra empresa processada');
});

test('R5/RF aceita a corrida declarada com o cron; resultado fora da lista para', () => {
    const r5 = h.RODADAS.find(r => r.id === 'R5');
    h.conferirResultado('RF', 'REVISAO_NECESSARIA', r5.esperado.RF); h.conferirResultado('RF', 'JANELA_AVISO_PERDIDA', r5.esperado.RF);
    assert.throws(() => h.conferirResultado('RF', 'REGULAR', r5.esperado.RF), e => e.parada === 'S2');
    assert.throws(() => h.conferirResultado('RM', 'AGUARDANDO_ULTIMA_PARCELA', 'REGULAR'), e => e.parada === 'S2');
    assert.equal(h.RODADAS.find(r => r.id === 'R6').quando.RF, undefined, 'RF não é cancelada pela tela');
});

test('lacuna G1 documentada: com relógio deslocado, retentativa de envio cai em revisão (23 h medidas contra o relógio real)', async () => {
    const m = mundo(), x = await preparar(m), R = Object.fromEntries(h.RODADAS.map(r => [r.id, r]));
    x.perder.add('sub_RA'); for (const id of ['R0','R1','R2']) await x.etapa(R[id]);
    m.passar(60000);
    assert.equal(await x.rodar(RF, 'LIMITE'), 'ENVIO_INCERTO_FORA_JANELA', 'um minuto real depois, mas 335 dias pelo agora injetado');
    assert.equal(m.regs[RF.empresa].estado, 'REVISAO'); assert.equal(x.envios.RF.length, 1, 'sem retry cego');
});

test('repetição e concorrência no limite: um registro, uma mensagem, mesma chave', async () => {
    const m = mundo(), x = await preparar(m);
    await x.rodar(RM, 'REAL');
    const id = m.regs[RM.empresa].id;
    const r = await Promise.all([x.rodar(RM, 'LIMITE'), x.rodar(RM, 'LIMITE'), x.rodar(RM, 'LIMITE')]);
    assert.ok(r.every(v => v === 'AGUARDANDO_ULTIMA_PARCELA'), r.join());
    assert.deepEqual(x.envios.RM, ['kidmais-renovacao/' + id]); assert.equal(m.regs[RM.empresa].id, id);
});

test('telas e registros: divergência de qualquer campo para (S2)', () => {
    const tempo = {primeira:'2027-10-10'};
    const dto = {estado:'AVISADA', avisoEnviado:true, dataRegular:'2027-10-10', valorRegular:RM.regular, ciclo:'MENSAL'};
    h.conferirTela('RM', dto, ['AVISADA', true], RM, tempo);
    for (const v of [{estado:'PENDENTE'}, {avisoEnviado:false}, {dataRegular:'2027-10-11'}, {valorRegular:RM.fundador}, {ciclo:'ANUAL'}])
        assert.throws(() => h.conferirTela('RM', {...dto, ...v}, ['AVISADA', true], RM, tempo), e => e.parada === 'S2', JSON.stringify(v));
    assert.throws(() => h.conferirTela('RM', null, ['AVISADA', true], RM, tempo), e => e.parada === 'S2');
    const linha = {estado:'AVISADA', enviado:true, aplicado:false, ultimo_erro:null, primeira:'2027-10-10', para:RM.email, chave_ok:true, total:'1'};
    h.conferirRegistro('RM', linha, ['AVISADA', true, false, null], RM, tempo);
    for (const v of [{total:'2'}, {chave_ok:false}, {para:'outro@example.invalid'}, {ultimo_erro:'ENVIO_INCERTO'}, {aplicado:true}])
        assert.throws(() => h.conferirRegistro('RM', {...linha, ...v}, ['AVISADA', true, false, null], RM, tempo), e => e.parada === 'S2', JSON.stringify(v));
    assert.throws(() => h.conferirRegistro('RM', undefined, ['AVISADA', true, false, null], RM, tempo), e => e.parada === 'S2');
});

test('preço regular no Asaas: período pago com valor Fundador, nada regular antes, nada Fundador depois', () => {
    const tempo = {primeira:'2027-10-10'};
    const sub = {status:'ACTIVE', deleted:false, valorCentavos:RM.regular, nextDueDate:'2027-10-10'};
    const pago = {id:'p1', deleted:false, status:'CONFIRMED', valorCentavos:RM.fundador, dueDate:'2026-10-10'};
    assert.deepEqual(h.divergenciasPrecoRegular(sub, [pago], RM, tempo, 'p1'), []);
    assert.deepEqual(h.divergenciasPrecoRegular({...sub, valorCentavos:RM.fundador}, [pago], RM, tempo, 'p1'), ['assinatura.valorRegular']);
    assert.deepEqual(h.divergenciasPrecoRegular({...sub, nextDueDate:'2027-09-10'}, [pago], RM, tempo, 'p1'), ['assinatura.proximoVencimento']);
    assert.deepEqual(h.divergenciasPrecoRegular(sub, [{...pago, status:'REFUNDED'}], RM, tempo, 'p1'), ['periodoPago']);
    assert.deepEqual(h.divergenciasPrecoRegular(sub, [pago, {id:'p2', deleted:false, valorCentavos:RM.regular, dueDate:'2026-11-10'}], RM, tempo, 'p1'), ['antes.2026-11-10']);
    assert.deepEqual(h.divergenciasPrecoRegular(sub, [pago, {id:'p3', deleted:false, valorCentavos:RM.fundador, dueDate:'2027-10-10'}], RM, tempo, 'p1'), ['regular.2027-10-10']);
    assert.deepEqual(h.divergenciasPrecoRegular(sub, [pago, {id:'p4', deleted:true, valorCentavos:RM.fundador, dueDate:'2027-10-10'}], RM, tempo, 'p1'), []);
    assert.ok(h.divergenciasPrecoRegular(null, [], RM, tempo, 'p1').includes('assinatura.ativa'));
});

/** Banco simulado do encerramento: registra SQL; nunca conecta. */
function dbFake({assinaturas = {}, falhar = null} = {}) {
    const sql = [];
    return {sql, async query(q, params = []) {
        const t = q.replace(/\s+/g, ' ').trim(); sql.push([t, params]);
        if (falhar && falhar.test(t)) throw Error('falha simulada');
        if (/FROM empresa_assinaturas/.test(t)) return {rows:[assinaturas[params[0]] ?? {}]};
        if (/SELECT empresa_id, estado FROM assinatura_fundadores/.test(t)) return {rows:[]};
        return {rows:[], rowCount:1};
    }};
}
function asaasFake({subs = {}, cobrancas = {}, releitura = {}} = {}) {
    const chamadas = [];
    return {chamadas,
        p:{async listarAssinaturasPorReferencia(ref) { chamadas.push('listar:' + ref); return subs[ref] ? [subs[ref]] : []; },
            async listarCobrancasDaAssinatura(id) { chamadas.push('cobrancas:' + id); return cobrancas[id] ?? []; },
            async removerAssinatura(id) { chamadas.push('remover:' + id); return {removida:true}; },
            async obterAssinatura(id) { chamadas.push('obter:' + id); return null; }},
        obterCobranca:async id => releitura[id] ?? null};
}
const rodadaComProva = extra => ({marca:h.MARCA, precheck:{fixturesLivres:true, asaasLivre:{RM:true, RA:true, RF:true}}, intencaoFixture:true, ...extra});

test('encerramento sem prova de autoria não toca provedor nem banco', async () => {
    const db = dbFake(), a = asaasFake();
    assert.equal(await h.encerrar({db, conectado:true, r:{}, p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}}), null);
    assert.deepEqual(a.chamadas, []); assert.deepEqual(db.sql.map(x => x[0]), ['ROLLBACK']);
    const r2 = {precheck:{fixturesLivres:false, asaasLivre:{RM:true}}, intencaoFixture:true, RM:{intencaoCheckout:true}};
    await h.encerrar({db:dbFake(), conectado:true, r:r2, p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}});
    assert.deepEqual(a.chamadas, [], 'fixture não provada livre em S1: nada é da rodada');
});

test('encerramento com pagamento intencionado: remove a assinatura, nunca libera a vaga, desativa fixtures e troca o e-mail', async () => {
    const sub = {id:'sub_RM', externalReference:RM.empresa, customer:'cus_RM', deleted:false};
    const a = asaasFake({subs:{[RM.empresa]:sub}, cobrancas:{sub_RM:[{id:'pay_RM', status:'RECEIVED', paymentDate:'2026-10-10'}]}});
    const db = dbFake({assinaturas:{[RM.empresa]:{provedor_cliente_id:'cus_RM', provedor_assinatura_id:'sub_RM'}}});
    const r = rodadaComProva({RM:{intencaoCheckout:true, intencaoPagamento:true, clienteId:'cus_RM', assinaturaId:'sub_RM'}});
    assert.equal(await h.encerrar({db, conectado:true, r, p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}}), null);
    assert.ok(a.chamadas.includes('remover:sub_RM')); assert.equal(r.encerramento.RM.acao, 'ASSINATURA_REMOVIDA_VAGA_PRESERVADA');
    assert.ok(!db.sql.some(([q]) => /UPDATE assinatura_fundadores|UPDATE assinatura_contratacoes/.test(q)), 'vaga/contratação intocadas');
    const usuarios = db.sql.filter(([q]) => /UPDATE usuarios_administrativos/.test(q));
    assert.equal(usuarios.length, 3); assert.deepEqual(usuarios[0][1], [RM.usuario, RM.email, h.emailEncerrado(RM.usuario)]);
    assert.ok(db.sql.some(([q]) => /UPDATE empresas SET status='DESATIVADA'/.test(q))); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    assert.equal(r.encerramento.RA.acao, 'NADA_CRIADO_PELA_RODADA');
});

test('encerramento antes do pagamento: regra Fundador (cobrança removida e não paga) libera só a vaga da fixture', async () => {
    const sub = {id:'sub_RA', externalReference:RA.empresa, customer:'cus_RA', deleted:false};
    const pendente = {id:'pay_RA', status:'PENDING', paymentDate:null};
    const a = asaasFake({subs:{[RA.empresa]:sub}, cobrancas:{sub_RA:[pendente]}, releitura:{pay_RA:{...pendente, deleted:true}}});
    const db = dbFake(), r = rodadaComProva({RA:{intencaoCheckout:true, clienteId:'cus_RA', assinaturaId:'sub_RA'}});
    assert.equal(await h.encerrar({db, conectado:true, r, p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}}), null);
    assert.equal(r.encerramento.RA.acao, 'ASSINATURA_REMOVIDA_COMPROVADA');
    const lib = db.sql.filter(([q]) => /UPDATE assinatura_fundadores SET estado='LIBERADA'/.test(q));
    assert.equal(lib.length, 1); assert.equal(lib[0][1][0], RA.empresa); assert.match(lib[0][0], /estado='RESERVADA'/);
    // Pago sem intenção registrada: bloqueia, não remove, não libera.
    const pago = asaasFake({subs:{[RA.empresa]:sub}, cobrancas:{sub_RA:[{...pendente, status:'RECEIVED'}]}});
    const db2 = dbFake(), r2 = rodadaComProva({RA:{intencaoCheckout:true, assinaturaId:'sub_RA'}});
    assert.match(String((await h.encerrar({db:db2, conectado:true, r:r2, p:pago.p, obterCobranca:pago.obterCobranca, salvar:() => {}}))?.message), /LIMPEZA_ASSINATURA_RA/);
    assert.ok(!pago.chamadas.some(c => c.startsWith('remover:'))); assert.ok(!db2.sql.some(([q]) => /LIBERADA/.test(q)));
});

test('encerramento recusa colisão de referência e nunca lança (disco e banco indisponíveis)', async () => {
    const a = asaasFake({subs:{[RM.empresa]:{id:'sub_X', externalReference:RM.empresa, customer:'cus_outro', deleted:false}}});
    const r = rodadaComProva({RM:{intencaoCheckout:true, intencaoPagamento:true, clienteId:'cus_RM', assinaturaId:'sub_RM'}});
    const erro = await h.encerrar({db:dbFake(), conectado:true, r, p:a.p, obterCobranca:a.obterCobranca, salvar:() => { throw Error('disco'); }});
    assert.match(String(erro?.message), /LIMPEZA_ASSINATURA_RM/); assert.ok(!a.chamadas.some(c => c.startsWith('remover:')));
    assert.ok(r.falhasEncerramento.some(f => /SUB_DE_OUTRO_CLIENTE/.test(f.mensagem)));
    const r2 = rodadaComProva({});
    assert.match(String((await h.encerrar({db:null, conectado:false, r:r2, p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}}))?.message), /LIMPEZA_BANCO/);
    const db3 = dbFake({falhar:/UPDATE empresas/});
    assert.match(String((await h.encerrar({db:db3, conectado:true, r:rodadaComProva({}), p:a.p, obterCobranca:a.obterCobranca, salvar:() => {}}))?.message), /LIMPEZA_BANCO/);
    assert.ok(db3.sql.some(([q]) => q === 'ROLLBACK'), 'falha no banco desfaz a transação');
});

test('fonte: sem rotina geral, sem .env, sem escrita de estado comercial fora da regra, preservação de terceiros completa', () => {
    assert.doesNotMatch(fonte, /empresasParaRenovacao|assinatura-renovar|assinatura-cron/, 'nunca seleciona empresas pelo produto');
    assert.doesNotMatch(fonte, /\.env\.local|env-file|dotenv|readFileSync\([^)]*\.env/);
    assert.doesNotMatch(fonte, /DELETE FROM|TRUNCATE|DROP |ALTER TABLE|SET estado='CONFIRMADA'|confirmada_em\s*=|beneficio_fim\s*=|reservada_em|criada_em\s*=/i,
        'nenhum apagamento nem retrodatação de vaga/contratação');
    assert.doesNotMatch(fonte, /simular:\s*true/); assert.match(fonte, /processarRenovacao\(esc\.empresa\(f\.empresa\)/);
    assert.equal((fonte.match(/UPDATE assinatura_fundadores/g) ?? []).length, 1, 'só a liberação de vaga RESERVADA');
    assert.equal((fonte.match(/console\.(log|error)/g) ?? []).length, 7, 'saídas sanitizadas conhecidas (inclui RASCUNHO_SUBSTITUIDO)');
    for (const t of ['empresa_assinaturas','assinatura_contratacoes','assinatura_fundadores','assinatura_isencoes','assinatura_renovacoes'])
        assert.ok(h.PRESERVADAS.some(([x]) => x === t), t);
    assert.equal(h.RODADAS.length, 8); assert.deepEqual(Object.keys(h.ENVIOS), ['RM','RA','RF']);
});
