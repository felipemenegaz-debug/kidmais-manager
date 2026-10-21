/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da rodada 3 consolidada (pagamento + renovação): sem rede, sem banco, sem Asaas/e-mail (tudo simulado).
// Executar: node --experimental-strip-types --test scripts/homologacao-pagamento-renovacao-staging.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');
const h = require('./homologacao-pagamento-renovacao-staging.cjs');
const pagamento = require('./homologacao-pagamento-staging.cjs');
const renovacao = require('./homologacao-renovacao-staging.cjs');
const fundador = require('./homologacao-fundador-staging.cjs');
const rodada1 = require('./homologacao-planos-cotacao-staging.cjs');

const NOME = 'homologacao-pagamento-renovacao-staging';
const fonte = fs.readFileSync(__dirname + '/' + NOME + '.cjs', 'utf8');
const LIB = path.resolve(__dirname, '..', 'lib', 'assinatura', 'renovacao-fundador.ts');
const fonteLib = fs.readFileSync(LIB, 'utf8');
const G1_NA_LIB = h.g1Presente(fonteLib);
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true', DATABASE_SSL:'false',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const F = Object.fromEntries(h.FIXTURES.map(f => [f.chave, f]));
const executar = (args, env) => spawnSync(process.execPath, ['--experimental-strip-types', __dirname + '/' + NOME + '.cjs', ...args],
    {encoding:'utf8', env:{...env, PATH:process.env.PATH}, timeout:30000});
const i = t => { const n = fonte.indexOf(t); assert.ok(n >= 0, 'ausente na fonte: ' + t); return n; };

test('flag única; sem ela nada roda; fora do Render recusa antes de conectar; recuperação sem disco recusada', () => {
    assert.equal(h.modo([]), null); assert.equal(h.modo(['--pagamento-rodada-3-autorizada']), null); assert.equal(h.modo(['--renovacao-rodada-1-autorizada']), null);
    assert.equal(h.modo([h.FLAG, '--x']), null); assert.equal(h.modo([h.FLAG, 'x']), null); assert.equal(h.modo([h.FLAG, h.FLAG_ENCERRAR]), null);
    assert.equal(h.modo([h.FLAG]), 'RODADA'); assert.equal(h.modo([h.FLAG_ENCERRAR]), 'ENCERRAR');
    assert.equal(h.FLAG, '--pagamento-renovacao-rodada-3-autorizada'); assert.equal(h.FLAG_ENCERRAR, '--encerrar-pagamento-renovacao-rodada-3-autorizada');
    const nada = executar([], {}); assert.equal(nada.status, 1); assert.match(nada.stderr, /AGUARDANDO_AUTORIZACAO_PAGAMENTO_RENOVACAO/);
    const fora = executar([h.FLAG], {}); assert.equal(fora.status, 1); assert.match(fora.stderr, /HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES/);
    const rec = executar([h.FLAG_ENCERRAR], envStaging()); assert.equal(rec.status, 1); assert.match(rec.stderr, /DISCO_PERSISTENTE_AUSENTE/);
});

test('guardas: web staging, banco de staging, sandbox, planos E cotação ligados; recuperação sem exigir as chaves', () => {
    assert.ok(h.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0'}, {KIDMAIS_DEPLOY_ENV:'production'},
        {ASAAS_AMBIENTE:'producao'}, {ASSINATURA_PLANOS_ATIVOS:undefined}, {COTACAO_PUBLICA_POR_EMPRESA:undefined}, {COTACAO_PUBLICA_POR_EMPRESA:'false'}, {RENDER:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'}])
        assert.throws(() => h.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.ok(h.alvoEncerramento({...envStaging(), ASSINATURA_PLANOS_ATIVOS:undefined, COTACAO_PUBLICA_POR_EMPRESA:undefined}));
    assert.equal(h.ARQUIVO, h.DIR + '/pagamento-renovacao-rodada-3.json'); assert.equal(h.DIR, pagamento.DIR, 'mesmo diretório no disco das rodadas 1–3');
});

test('fixtures novas: 3 pagantes (mensal, anual, mensal) + isenta + teste; nada reaproveitado de NENHUMA rodada anterior', () => {
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.tipo, f.plano, f.ciclo]), [['F1','PLANO','essencial','MENSAL'], ['F2','PLANO','profissional','ANUAL'],
        ['F3','ISENTA',null,null], ['F4','TESTE',null,null], ['F5','PLANO','premium','MENSAL']]);
    assert.deepEqual(h.PAGANTES.map(f => f.chave), ['F1','F2','F5']);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    assert.equal(new Set(ids).size, 10); assert.ok(!ids.includes(KIDMAIS));
    const antigos = new Set([...pagamento.FIXTURES, ...renovacao.FIXTURES, ...fundador.FIXTURES, ...rodada1.FIXTURES].flatMap(f => [f.empresa, f.usuario, f.codigo, f.email]));
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.match(f.usuario, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.match(f.codigo, /^hml-pr-[a-z]+$/); assert.match(f.email, /^hml-pr-[0-9a-f]{8}@example\.invalid$/); assert.match(f.nome, /^TESTE .* r3 F\d$/);
        for (const v of [f.empresa, f.usuario, f.codigo, f.email]) assert.ok(!antigos.has(v), v);
    }
    // Varredura de TODOS os scripts e documentos (rodadas 1–5 do ensaio, planos, Fundador, sonda, pagamento, renovação, concorrência…).
    const proprios = new Set([NOME + '.cjs', NOME + '.test.cjs', 'HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md',
        'PACOTE_CONSOLIDADO_20261010.md', // o pacote consolidado cita a rodada de propósito
        // roteiros das janelas S3+S4 de 13/10 e 20/10 (passo do S4 com a flag e o estado da rodada 3, que parou no PRECHECK
        // de 20/10 sem criar nada e nunca chegou às fixtures)
        'RODADA_FINAL_LANCAMENTO_20261013.md', 'JANELA_S3_S4_STAGING_20261020.md', 'HOMOLOGACAO_S3_S4_STAGING_20261020.md']);
    const arquivos = d => fs.readdirSync(d, {withFileTypes:true}).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : arquivos(path.join(d, e.name)))
        : /\.(c?js|ts|md|json|sql)$/.test(e.name) && !proprios.has(e.name) ? [path.join(d, e.name)] : []);
    const texto = ['scripts', 'docs', 'database'].flatMap(d => arquivos(path.resolve(__dirname, '..', d))).map(a => fs.readFileSync(a, 'utf8')).join('\n');
    for (const v of [...ids, ...h.FIXTURES.map(f => f.email), 'hml-pr-', h.MARCA, 'pagamento-renovacao-rodada-3']) assert.ok(!texto.includes(v), 'já usado: ' + v);
});

test('preços e regras independentes: catálogo, anual = 10 × mensal, 40% exato; contratos 0% / 5% / 8% ≠ legado 10%', () => {
    const planos = fs.readFileSync(path.resolve(__dirname, '..', 'lib/assinatura/planos-comerciais.ts'), 'utf8');
    assert.match(planos, /multiplicadorAnual: 10/); assert.match(planos, /fundador: \{ descontoPercentual: 40, meses: 12, vagas: 20 \}/);
    for (const [chave, {regular, fundador: f}] of Object.entries(h.PRECOS)) {
        const [plano, ciclo] = chave.split('/');
        const mensal = Number(planos.match(new RegExp(`${plano}: \\{[^}]*mensalCentavos: (\\d+)`))[1]);
        assert.equal(regular, ciclo === 'ANUAL' ? mensal * 10 : mensal, chave); assert.equal(f * 100, regular * 60, chave);
    }
    assert.deepEqual(h.PAGANTES.map(f => [f.regular, f.fundador]), [[19700, 11820], [397000, 238200], [69700, 41820]]);
    assert.deepEqual(Object.fromEntries(Object.entries(h.REGRAS).map(([k, v]) => [k, v.pixAvista])), {F4:5, F5:8});
    const esperados = [h.precoEsperado(0), h.precoEsperado(5), h.precoEsperado(8), h.precoEsperado(10)];
    assert.deepEqual(esperados, [150000, 142500, 138000, 135000]); assert.equal(new Set(esperados).size, 4);
    for (const [plano, limite] of Object.entries(h.LIMITE_PESSOAS)) assert.match(planos, new RegExp(`${plano}: \\{[^}]*limiteUsuarios: ${limite}\\b`));
    assert.deepEqual(Object.entries(h.FINANCEIRO).filter(([, e]) => !e.completo).map(([k]) => k), ['F1'], 'só Essencial bloqueado; isenta e teste liberadas');
});

test('campanha: só 3 vagas (não 6); as três precisam caber sem mexer no teto', () => {
    assert.equal(h.VAGAS_CAMPANHA, 20); assert.equal(h.PAGANTES.length, 3);
    assert.equal(h.cabeNaCampanha({ocupadas:3}), true); assert.equal(h.cabeNaCampanha({ocupadas:17}), true);
    assert.equal(h.cabeNaCampanha({ocupadas:18}), false); assert.equal(h.cabeNaCampanha({}), false); assert.equal(h.cabeNaCampanha(null), false);
});

test('contrato G1: detecção da linha das 23 h; o executor exige G1 antes de qualquer mutação', () => {
    assert.equal(h.g1Presente('if (r.avisoTentadoEm && (deps.relogioReal?.() ?? deps.agora()).getTime() - Date.parse(r.avisoTentadoEm) >= 23 * 3600000)'), true);
    assert.equal(h.g1Presente('if (r.avisoTentadoEm && deps.agora().getTime() - Date.parse(r.avisoTentadoEm) >= 23 * 3600000)'), false);
    assert.equal(h.g1Presente('relogioReal?: () => Date;'), false, 'só o tipo não basta'); assert.equal(h.g1Presente(null), false);
    assert.ok(i("'G1_AUSENTE_S1'") < i("flag:'wx'") && i("'G1_AUSENTE_S1'") < i('db = await pool.connect()') && i("'G1_AUSENTE_S1'") < i("marcar('FIXTURES')"),
        'G1 conferido antes do estado, do banco e de qualquer criação');
    assert.match(fonte, /relogioReal:\(\) => new Date\(\)/, 'relogioReal = relógio verdadeiro');
    console.log('# G1 na lib atual: ' + (G1_NA_LIB ? 'presente' : 'ausente (testes usam emulação do contrato)'));
});

test('calendário próprio = processador do produto; tempo acelerado só no processo', async () => {
    const {primeiraRenovacaoRegular, diasAntes, diaBrasil} = await import(pathToFileURL(LIB).href);
    for (const [pv, fim] of [['2026-10-10','2027-10-10T15:00:05.000Z'], ['2026-10-10','2027-10-11T01:30:00.000Z'], ['2026-01-31','2027-01-31T12:00:00.000Z'],
        ['2028-02-29','2029-02-28T12:00:00.000Z'], ['2026-12-31','2027-12-31T23:00:00.000Z']]) for (const ciclo of ['MENSAL','ANUAL'])
        assert.equal(h.primeiraEsperada(pv, fim, ciclo), primeiraRenovacaoRegular(pv, fim, ciclo), pv + ciclo + fim);
    for (const d of ['2027-10-10','2027-03-01','2028-03-30']) assert.equal(h.somarDias(d, -30), diasAntes(d));
    for (const t of [Date.parse('2026-10-10T02:59:59Z'), Date.parse('2026-10-10T03:00:00Z'), Date.parse('2026-12-31T23:30:00Z')]) assert.equal(h.diaBrasil(new Date(t)), diaBrasil(new Date(t)));
    const t = h.planoTempo('2026-10-10', '2027-10-10');
    assert.deepEqual(t.offsets, {REAL:0, VESPERA:334, LIMITE:335, PERDIDO:336}); assert.equal(t.limite, '2027-09-10');
    assert.throws(() => h.planoTempo('2026-10-10', '2026-11-09'), /JANELA_ACELERADA_INVALIDA/);
    assert.throws(() => h.relogio(-1)); assert.throws(() => h.relogio(1.5)); assert.throws(() => h.relogio(500));
    assert.equal(h.HORA_LIMITE_BRT, 20); assert.ok(i("'HORARIO_S1'") < i("flag:'wx'"));
    assert.doesNotMatch(fonte, /useFakeTimers|Date\.now\s*=|process\.env\.TZ\s*=|SET\s+(LOCAL\s+)?TIME\s*ZONE|faketime/i, 'relógio do sistema/banco nunca é alterado');
});

test('allow-list: processador e provedor só alcançam as três pagantes e as assinaturas registradas (recusa antes da rede)', async () => {
    const esc = h.escopo();
    for (const outra of [KIDMAIS, F.F3.empresa, F.F4.empresa, renovacao.FIXTURES[0].empresa]) assert.throws(() => esc.empresa(outra), e => e.parada === 'S3', outra);
    assert.throws(() => esc.vincular(KIDMAIS, 'sub_x'), /FORA_DAS_FIXTURES/);
    esc.vincular(F.F1.empresa, 'sub_F1'); assert.throws(() => esc.vincular(F.F1.empresa, 'sub_outra'), /FORA_DAS_FIXTURES/);
    assert.throws(() => esc.vincular(F.F2.empresa, 'sub_F1'), /FORA_DAS_FIXTURES/, 'mesma assinatura em duas empresas');
    assert.throws(() => esc.assinatura('sub_terceiro'), /FORA_DAS_FIXTURES/); assert.equal(esc.assinatura('sub_F1'), 'sub_F1');
    const chamadas = [];
    const repo = h.repositorioRestrito({ler:async e => (chamadas.push('ler:' + e), e), criar:async r => r, marcar:async () => 'ok'}, esc);
    await assert.rejects(repo.ler(KIDMAIS), /FORA_DAS_FIXTURES/); await assert.rejects(repo.criar({empresaId:F.F4.empresa}), /FORA_DAS_FIXTURES/);
    await assert.rejects(repo.marcar(KIDMAIS, 'x', {}), /FORA_DAS_FIXTURES/); assert.deepEqual(chamadas, []);
    const p = h.provedorRestrito({obterAssinatura:async id => (chamadas.push(id), {id}), listarCobrancasDaAssinatura:async id => (chamadas.push(id), []),
        obterCobranca:async id => ({id, assinaturaId:id === 'pay_F1' ? 'sub_F1' : 'sub_terceiro'}), suspenderGeracao:async id => (chamadas.push('susp:' + id), {}),
        atualizarValorAssinatura:async id => (chamadas.push('put:' + id), {id})}, esc, {perderRespostaPreco:new Set(['sub_F1'])});
    await assert.rejects(p.obterAssinatura('sub_terceiro'), /FORA_DAS_FIXTURES/); await assert.rejects(p.listarCobrancasDaAssinatura('sub_x'), /FORA_DAS_FIXTURES/);
    await assert.rejects(p.suspenderGeracao('sub_x'), /FORA_DAS_FIXTURES/); await assert.rejects(p.atualizarValorAssinatura('sub_x', 1), /FORA_DAS_FIXTURES/);
    assert.deepEqual(chamadas, [], 'recusa ANTES da rede');
    await assert.rejects(p.obterCobranca('pay_x'), /FORA_DAS_FIXTURES/); assert.equal((await p.obterCobranca('pay_F1')).id, 'pay_F1');
    await assert.rejects(p.atualizarValorAssinatura('sub_F1', 19700), /RESPOSTA_PERDIDA_SIMULADA/); assert.deepEqual(chamadas, ['put:sub_F1'], 'resposta perdida DEPOIS do PUT');
    await p.atualizarValorAssinatura('sub_F1', 19700); assert.equal(p.contagem.precoAssinatura.sub_F1, 2, 'perde só uma vez');
    assert.match(fonte, /processarRenovacao\(esc\.empresa\(f\.empresa\)/); assert.ok(i('esc.vincular(f.empresa, linha.provedor_assinatura_id)') < i('RODADAS.slice(0, 3)'));
});

test('e-mail só SINK: idempotência por chave, falha de entrega, resposta perdida; nunca destino fora da fixture', async () => {
    assert.equal(h.MODO_EMAIL, 'SINK');
    assert.doesNotMatch(fonte, /resend|criarEnviarEmail|EMAIL_PROVIDER|lib\/acessos\/email|felipemenegaz|smtp/i, 'nenhum transporte real no executor');
    const m = {para:F.F5.email, assunto:'a', texto:'t', html:'<p>t</p>', idempotencia:'kidmais-renovacao/43e76c7e-b628-4d1c-9953-7aa6b72f3f65'};
    const normal = h.sinkIdempotente();
    const a = await h.envioDaFixture(F.F5, normal.enviar)(m), b = await h.envioDaFixture(F.F5, normal.enviar)(m);
    assert.deepEqual(a, b); assert.equal(a.idExterno, h.idSink(m.idempotencia)); assert.deepEqual([normal.tentativas(), normal.entregas()], [2, 1], 'mesma chave → um e-mail');
    const perde = h.sinkIdempotente({perderRespostas:1});
    await assert.rejects(perde.enviar(m), /RESPOSTA_DO_ENVIO_PERDIDA_SIMULADA/); assert.equal(perde.entregas(), 1, 'entregue antes de perder a resposta');
    assert.equal((await perde.enviar(m)).idExterno, h.idSink(m.idempotencia)); assert.deepEqual([perde.tentativas(), perde.entregas()], [2, 1]);
    const falha = h.sinkIdempotente({falharAntes:true});
    await assert.rejects(falha.enviar(m), /FALHA_DE_ENTREGA_SIMULADA/); assert.deepEqual([falha.tentativas(), falha.entregas()], [1, 0]);
    const nunca = h.sinkIdempotente();
    for (const x of [{...m, para:F.F2.email}, {...m, para:'felipemenegaz@gmail.com'}, {...m, idempotencia:'outra'}, null])
        await assert.rejects(h.envioDaFixture(F.F5, nunca.enviar)(x), /MENSAGEM_FORA_DA_FIXTURE/);
    await assert.rejects(h.envioDaFixture({...F.F5, email:'pessoa@exemplo.com'}, nunca.enviar)({...m, para:'pessoa@exemplo.com'}), /MENSAGEM_FORA_DA_FIXTURE/);
    assert.equal(nunca.tentativas(), 0, 'recusa antes do transporte');
    assert.deepEqual(h.EMAIL, {F1:{falharAntes:true}, F2:{}, F5:{perderRespostas:1}});
});

/** Asaas sandbox simulado (assinaturas por id, listagem que omite removidas como o real, cobranças) e ajuste de vencimento. */
function asaasSimulado() {
    const subs = {}, pays = {}, chamadas = [];
    for (const f of h.PAGANTES) {
        subs['sub_' + f.chave] = {id:'sub_' + f.chave, status:'ACTIVE', deleted:false, cycle:f.ciclo === 'ANUAL' ? 'YEARLY' : 'MONTHLY', customer:'cus_' + f.chave,
            externalReference:f.empresa, valorCentavos:f.fundador, nextDueDate:f.ciclo === 'ANUAL' ? '2027-10-10' : '2026-11-10'};
        pays['pay_' + f.chave] = {id:'pay_' + f.chave, status:'RECEIVED', dueDate:'2026-10-10', paymentDate:'2026-10-10', invoiceUrl:null, deleted:false,
            valorCentavos:f.fundador, assinaturaId:'sub_' + f.chave, clienteId:'cus_' + f.chave, billingType:'PIX'};
    }
    return {subs, pays, chamadas,
        p:{async obterAssinatura(id) { chamadas.push('obter:' + id); return subs[id] ? {...subs[id]} : null; },
            async listarAssinaturasPorReferencia(ref) { chamadas.push('listar:' + ref); return Object.values(subs).filter(s => s.externalReference === ref && !s.deleted).map(s => ({...s})); },
            async removerAssinatura(id) { chamadas.push('remover:' + id); subs[id].deleted = true; subs[id].status = 'INACTIVE'; return {removida:true}; },
            async listarCobrancasDaAssinatura(id) { return Object.values(pays).filter(x => x.assinaturaId === id).map(x => ({...x})); },
            async obterCobranca(id) { return pays[id] ? {...pays[id]} : null; },
            async atualizarValorAssinatura(id, v) { chamadas.push('put:' + id); subs[id].valorCentavos = v; return {...subs[id]}; },
            async atualizarValorCobranca(x, v) { pays[x.id].valorCentavos = v; return {...pays[x.id]}; },
            async suspenderGeracao(id) { chamadas.push('suspender:' + id); subs[id].status = 'INACTIVE'; return {...subs[id]}; }},
        ajustar:async (id, data) => { chamadas.push('ajustar:' + id + ':' + data); subs[id].nextDueDate = data; return {...subs[id]}; }};
}

test('salto do vencimento: só sandbox, só assinatura mensal registrada, prova gravada ANTES do PUT', async () => {
    const preparar = () => {
        const a = asaasSimulado(), esc = h.escopo(), salvos = [];
        for (const f of h.PAGANTES) esc.vincular(f.empresa, 'sub_' + f.chave);
        const r = {F1:{assinaturaId:'sub_F1', clienteId:'cus_F1'}, F2:{assinaturaId:'sub_F2', clienteId:'cus_F2'}, F5:{assinaturaId:'sub_F5', clienteId:'cus_F5'},
            tempo:{F1:{primeira:'2027-10-10'}, F2:{primeira:'2027-10-10'}, F5:{primeira:'2027-10-10'}}};
        const salvar = () => salvos.push(JSON.stringify(r)), ajustar = async (id, d) => { assert.equal(r[Object.keys(r).find(k => r[k]?.assinaturaId === id)].salto.intencao, true, 'prova antes do PUT'); return a.ajustar(id, d); };
        return {a, esc, r, salvar, salvos, ajustar};
    };
    let x = preparar();
    const salto = await h.ajustarVencimentoDaRodada({f:F.F5, r:x.r, esc:x.esc, p:x.a.p, ajustar:x.ajustar, salvar:x.salvar});
    assert.deepEqual([salto.antes, salto.alvo, salto.depois], ['2026-11-10', '2027-10-10', '2027-10-10']);
    assert.ok(x.salvos.some(s => JSON.parse(s).F5.salto?.intencao && !JSON.parse(s).F5.salto.depois), 'estado de antes persistido antes do PUT');
    const recusa = async (nome, mudar, f = F.F1) => {
        x = preparar(); mudar(x);
        await assert.rejects(h.ajustarVencimentoDaRodada({f, r:x.r, esc:x.esc, p:x.a.p, ajustar:x.ajustar, salvar:x.salvar}), e => e.parada === 'S3', nome);
        assert.ok(!x.a.chamadas.some(c => c.startsWith('ajustar:')), nome + ': nenhum PUT');
    };
    await recusa('anual', () => {}, F.F2);
    await recusa('sem registro', y => { delete y.r.F1.assinaturaId; });
    await recusa('id não vinculado', y => { y.r.F1.assinaturaId = 'sub_terceiro'; y.a.subs.sub_terceiro = {...y.a.subs.sub_F1, id:'sub_terceiro'}; });
    await recusa('outra referência', y => { y.a.subs.sub_F1.externalReference = KIDMAIS; });
    await recusa('outro cliente', y => { y.a.subs.sub_F1.customer = 'cus_outro'; });
    await recusa('removida', y => { y.a.subs.sub_F1.deleted = true; });
    await recusa('já regular', y => { y.a.subs.sub_F1.valorCentavos = F.F1.regular; });
    await recusa('já na data', y => { y.a.subs.sub_F1.nextDueDate = '2027-10-10'; });
    await recusa('não mensal no provedor', y => { y.a.subs.sub_F1.cycle = 'YEARLY'; });
    await recusa('fixture não pagante', () => {}, F.F3);
    assert.match(fonte, /updatePendingPayments:false/); assert.match(fonte, /bruto\('\/subscriptions\/' \+ encodeURIComponent\(id\), 'PUT'/);
    assert.equal((fonte.match(/\bajustar\(/g) ?? []).length, 1, 'um único ponto de ajuste, dentro da função restrita');
    assert.doesNotMatch(fonte, /api\('\/subscriptions/, 'a API genérica não alcança assinaturas');
});

/**
 * Processador do produto com e sem o contrato G1, independente do estado da lib (G1 é de outra frente de trabalho):
 * a lib real quando já tem G1; senão, cópia temporária da lib com SÓ a linha das 23 h trocada (imports relativos absolutizados).
 */
const SEM_G1 = 'deps.agora().getTime() - Date.parse(r.avisoTentadoEm)';
const COM_G1 = '(deps.relogioReal?.() ?? deps.agora()).getTime() - Date.parse(r.avisoTentadoEm)';
function fonteSemG1() {
    const s = fonteLib.includes(COM_G1) ? fonteLib.replace(COM_G1, SEM_G1) : fonteLib;
    assert.equal(s.split(SEM_G1).length, 2, 'linha das 23 h mudou: revisar a emulação do G1'); assert.equal(h.g1Presente(s), false);
    return s;
}
async function importarFonte(texto) {
    const dir = path.dirname(LIB), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kidmais-g1-'));
    try {
        const arq = path.join(tmp, 'renovacao-fundador-copia.ts');
        fs.writeFileSync(arq, texto.replace(/from '(\.{1,2}\/[^']+)'/g, (_, e) => `from '${pathToFileURL(path.resolve(dir, e)).href}'`));
        return (await import(pathToFileURL(arq).href)).processarRenovacao;
    } finally { fs.rmSync(tmp, {recursive:true, force:true}); }
}
async function processador({emular = false} = {}) {
    if (G1_NA_LIB && !emular) return (await import(pathToFileURL(LIB).href)).processarRenovacao;
    const emulado = fonteSemG1().replace(SEM_G1, COM_G1); assert.ok(h.g1Presente(emulado));
    return importarFonte(emulado);
}

/** Mundo simulado: repositório com as regras da 075 (transições, prazo do aviso pelo relógio REAL) e Asaas em memória. */
function mundo(inicio = Date.parse('2026-10-10T15:00:00Z')) {
    let real = inicio;
    const TRANS = {PENDENTE:['AVISANDO','REVISAO','CANCELADA'], AVISANDO:['AVISADA','REVISAO','CANCELADA'], AVISADA:['APLICANDO','REVISAO','CANCELADA'],
        APLICANDO:['REGULAR','REVISAO','CANCELADA'], REGULAR:['REVISAO','CANCELADA'], REVISAO:['CANCELADA'], CANCELADA:[]};
    const ctx = {}, regs = {}, a = asaasSimulado();
    for (const f of h.PAGANTES) ctx[f.empresa] = {empresaId:f.empresa, contratacaoId:f.usuario, situacao:'ATIVA', empresaAtiva:true, isenta:false,
        assinaturaId:'sub_' + f.chave, clienteId:'cus_' + f.chave, ciclo:f.ciclo, plano:f.plano.toUpperCase(), valorFinal:f.fundador, valorRegular:f.regular,
        beneficioFim:'2027-10-10T15:00:05.000Z', primeiroPagamentoId:'pay_' + f.chave, destinatarioId:f.usuario, email:f.email, destinatarioValido:true};
    const repo = {
        async ler(e) { return ctx[e] ? {...ctx[e], registro:regs[e] ? structuredClone(regs[e]) : null} : null; },
        async criar(r) { if (!regs[r.empresaId]) { assert.equal(r.estado, 'PENDENTE'); regs[r.empresaId] = structuredClone(r); } return structuredClone(regs[r.empresaId]); },
        async marcar(e, id, alt) {
            const r = regs[e]; assert.equal(r.id, id);
            if (alt.estado !== r.estado && !TRANS[r.estado].includes(alt.estado)) throw Error('TRANSICAO_075 ' + r.estado + '>' + alt.estado);
            const t = new Date(real).toISOString();
            const n = {...r, estado:alt.estado, ultimoErro:alt.erro ?? null, avisoTentadoEm:alt.tentativa ? (r.avisoTentadoEm ?? t) : r.avisoTentadoEm,
                avisoEnviadoEm:alt.envioId ? (r.avisoEnviadoEm ?? t) : r.avisoEnviadoEm, precoAplicadoEm:alt.regular ? (r.precoAplicadoEm ?? t) : r.precoAplicadoEm};
            if (n.avisoEnviadoEm && h.diaBrasil(new Date(n.avisoEnviadoEm)) > h.somarDias(r.primeiraDataRegular, -30)) throw Error('CHECK_075_PRAZO');
            if (['AVISADA','APLICANDO','REGULAR'].includes(n.estado) && !n.avisoEnviadoEm) throw Error('CHECK_075_AVISO');
            if (n.estado === 'REGULAR' && !n.precoAplicadoEm) throw Error('CHECK_075_PRECO');
            regs[e] = n;
        },
    };
    const ocupadas = new Set();
    const travar = async (e, trabalho) => {
        if (ocupadas.has(e)) throw Object.assign(Error('ocupada'), {code:'CONTRATACAO_EM_ANDAMENTO'});
        ocupadas.add(e); try { return await trabalho(); } finally { ocupadas.delete(e); }
    };
    return {base:() => real, passar:ms => { real += ms; }, ctx, regs, a, repo, travar};
}

/** Mesmo encadeamento do executor (rodar/etapaRodada), com o processador do produto e o mundo simulado. */
async function preparar(m, processarRenovacao) {
    const esc = h.escopo(), contagem = {}, perder = new Set(), erros = [];
    for (const f of h.PAGANTES) esc.vincular(f.empresa, 'sub_' + f.chave);
    const sinks = Object.fromEntries(h.PAGANTES.map(f => [f.chave, h.sinkIdempotente(h.EMAIL[f.chave])]));
    const tempo = Object.fromEntries(h.PAGANTES.map(f => [f.chave, h.planoTempo('2026-10-10', h.primeiraEsperada('2026-10-10', m.ctx[f.empresa].beneficioFim, f.ciclo))]));
    const deps = {repositorio:h.repositorioRestrito(m.repo, esc), provedor:h.provedorRestrito(m.a.p, esc, {perderRespostaPreco:perder, contagem}),
        origem:'https://kidmais-manager-staging.onrender.com', simular:false, travar:m.travar, relogioReal:() => new Date(m.base())};
    const rodar = async (f, quando) => {
        const agora = h.relogio(tempo[f.chave].offsets[quando], m.base);
        assert.equal(h.diaBrasil(agora()), tempo[f.chave].dias[quando]);
        try { return await h.comRetentativa(() => processarRenovacao(esc.empresa(f.empresa), {...deps, enviar:h.envioDaFixture(f, sinks[f.chave].enviar), agora}),
            {esperar:() => new Promise(ok => setTimeout(ok, 5))}); }
        catch (e) { if (e?.parada) throw e; erros.push([f.chave, String(e.message)]); return 'ERRO_REPROCESSAVEL'; }
    };
    const registro = f => { const r = m.regs[f.empresa];
        return {estado:r.estado, enviado:!!r.avisoEnviadoEm, aplicado:!!r.precoAplicadoEm, tentado:!!r.avisoTentadoEm, ultimo_erro:r.ultimoErro,
            primeira:r.primeiraDataRegular, para:r.mensagem.para, chave_ok:r.mensagem.idempotencia === 'kidmais-renovacao/' + r.id, total:1}; };
    const etapa = async rodada => {
        for (const f of h.PAGANTES.filter(x => rodada.quando[x.chave])) {
            m.passar(1000); const q = rodada.quando[f.chave];
            const obtido = rodada.concorrente === f.chave
                ? (await Promise.all([rodar(f, q), rodar(f, q)])).reduce((a, b) => (h.conferir(f.chave + '.concorrente', b, a), a))
                : await rodar(f, q);
            h.conferirResultado(f.chave + '.' + rodada.id, obtido, rodada.esperado[f.chave]);
        }
        if (h.REGISTROS[rodada.id]) for (const f of h.PAGANTES) h.conferirRegistro(f.chave, registro(f), h.REGISTROS[rodada.id][f.chave], f, tempo[f.chave]);
    };
    const emails = () => Object.fromEntries(h.PAGANTES.map(f => [f.chave, [sinks[f.chave].tentativas(), sinks[f.chave].entregas()]]));
    return {esc, contagem, perder, erros, tempo, sinks, rodar, etapa, emails};
}

for (const [nome, emular] of [['lib atual' + (G1_NA_LIB ? ' (com G1)' : ' (G1 emulado)'), false], ['contrato G1 emulado sobre a lib sem G1', true]])
test('renovação nas 3 pagantes com o processador do produto, ' + nome + ': aviso único, falha → revisão, PUT perdido, e-mail perdido, preço regular, cancelamento', async () => {
    const m = mundo(), x = await preparar(m, await processador({emular})), R = Object.fromEntries(h.RODADAS.map(r => [r.id, r]));
    for (const id of ['R0','R0B','R1']) await x.etapa(R[id]);
    assert.deepEqual(x.emails(), {F1:[0,0], F2:[0,0], F5:[0,0]}, 'nada enviado antes do limite'); assert.equal(Object.keys(m.regs).length, 3, 'um registro por pagante');
    x.perder.add('sub_F2');
    await x.etapa(R.R2);
    assert.deepEqual(x.erros, [['F2','RESPOSTA_PERDIDA_SIMULADA']]); assert.equal(m.a.subs.sub_F2.valorCentavos, F.F2.regular, 'PUT aplicado, resposta perdida');
    assert.deepEqual(x.emails(), {F1:[1,0], F2:[1,1], F5:[1,1]});
    await x.etapa(R.R3);
    assert.deepEqual(x.emails(), {F1:[1,0], F2:[1,1], F5:[2,1]}, 'F5: retentativa com a mesma chave; a execução concorrente não envia');
    for (const k of ['F1','F5']) assert.equal(m.a.subs['sub_' + k].valorCentavos, F[k].fundador, k + ' sem aumento antecipado');
    const r = {F1:{assinaturaId:'sub_F1', clienteId:'cus_F1'}, F5:{assinaturaId:'sub_F5', clienteId:'cus_F5'}, tempo:x.tempo};
    for (const f of [F.F1, F.F5]) await h.ajustarVencimentoDaRodada({f, r, esc:x.esc, p:m.a.p, ajustar:m.a.ajustar, salvar:() => {}});
    m.a.pays.pay_F5_2 = {...m.a.pays.pay_F5, id:'pay_F5_2', status:'PENDING', paymentDate:null, dueDate:x.tempo.F5.primeira}; // parcela já gerada pelo Asaas
    await x.etapa(R.R4); await x.etapa(R.R5);
    for (const f of [F.F2, F.F5]) assert.deepEqual(h.divergenciasPrecoRegular(m.a.subs['sub_' + f.chave], Object.values(m.a.pays).filter(p => p.assinaturaId === 'sub_' + f.chave),
        f, x.tempo[f.chave], 'pay_' + f.chave), [], f.chave);
    assert.equal(m.a.pays.pay_F5_2.valorCentavos, F.F5.regular, 'parcela da data regular corrigida');
    assert.equal(m.a.subs.sub_F1.status, 'INACTIVE'); assert.equal(m.a.subs.sub_F1.valorCentavos, F.F1.fundador, 'sem aviso: nunca aumenta; geração suspensa');
    assert.deepEqual(x.contagem.precoAssinatura, {sub_F2:1, sub_F5:1}); assert.deepEqual(x.contagem.suspensao, {sub_F1:1});
    assert.deepEqual(x.emails(), Object.fromEntries(h.PAGANTES.map(f => [f.chave, [h.TENTATIVAS[f.chave], h.ENTREGAS[f.chave]]])));
    for (const k of ['F2','F5']) { m.ctx[F[k].empresa].situacao = 'CANCELADA_FIM_PERIODO'; m.a.subs['sub_' + k].deleted = true; }
    await x.etapa(R.R6);
    assert.deepEqual(x.emails(), {F1:[1,0], F2:[1,1], F5:[2,1]}, 'repetições não reenviam');
    assert.ok(['F2','F5'].every(k => m.a.pays['pay_' + k].status === 'RECEIVED' && m.a.pays['pay_' + k].valorCentavos === F[k].fundador), 'período pago preservado');
    assert.deepEqual(Object.keys(x.esc.uso).sort(), h.PAGANTES.map(f => f.empresa).sort(), 'nenhuma outra empresa processada');
    assert.ok(!m.a.chamadas.some(c => /sub_(?!F[125]\b)/.test(c)), 'nenhuma assinatura fora da rodada');
});

test('R5/F1 aceita a corrida declarada com o cron; R6 não toca F1; demais resultados fora da lista param', () => {
    const r5 = h.RODADAS.find(r => r.id === 'R5');
    h.conferirResultado('F1', 'REVISAO_NECESSARIA', r5.esperado.F1); h.conferirResultado('F1', 'JANELA_AVISO_PERDIDA', r5.esperado.F1);
    assert.throws(() => h.conferirResultado('F1', 'REGULAR', r5.esperado.F1), e => e.parada === 'S2');
    assert.equal(h.RODADAS.find(r => r.id === 'R6').quando.F1, undefined); assert.equal(h.RODADAS.find(r => r.id === 'R3').concorrente, 'F5');
    assert.equal(h.RODADAS.length, 8); assert.ok(h.RODADAS.every(r => Object.keys(r.quando).every(k => ['F1','F2','F5'].includes(k))), 'só as três pagantes');
});

test('sem G1 a retentativa do e-mail cai em revisão (por isso o executor exige G1)', async () => {
    const m = mundo(), x = await preparar(m, await importarFonte(fonteSemG1())), R = Object.fromEntries(h.RODADAS.map(r => [r.id, r]));
    x.perder.add('sub_F2'); for (const id of ['R0','R1','R2']) await x.etapa(R[id]);
    m.passar(60000);
    assert.equal(await x.rodar(F.F5, 'LIMITE'), 'ENVIO_INCERTO_FORA_JANELA', '1 min real, mas 335 dias pelo agora');
    assert.equal(m.regs[F.F5.empresa].estado, 'REVISAO'); assert.equal(x.sinks.F5.tentativas(), 1, 'sem retry cego');
});

test('telas e registros: divergência de qualquer campo para (S2)', () => {
    const tempo = {primeira:'2027-10-10'}, f = F.F5;
    const dto = {estado:'AVISADA', avisoEnviado:true, dataRegular:'2027-10-10', valorRegular:f.regular, ciclo:'MENSAL'};
    h.conferirTela('F5', dto, ['AVISADA', true], f, tempo);
    for (const v of [{estado:'PENDENTE'}, {avisoEnviado:false}, {dataRegular:'2027-10-11'}, {valorRegular:f.fundador}, {ciclo:'ANUAL'}])
        assert.throws(() => h.conferirTela('F5', {...dto, ...v}, ['AVISADA', true], f, tempo), e => e.parada === 'S2', JSON.stringify(v));
    const linha = {estado:'AVISADA', enviado:true, aplicado:false, tentado:true, ultimo_erro:null, primeira:'2027-10-10', para:f.email, chave_ok:true, total:'1'};
    h.conferirRegistro('F5', linha, ['AVISADA', true, false, null, true], f, tempo);
    for (const v of [{total:'2'}, {chave_ok:false}, {para:'outro@example.invalid'}, {ultimo_erro:'ENVIO_INCERTO'}, {aplicado:true}, {tentado:false}])
        assert.throws(() => h.conferirRegistro('F5', {...linha, ...v}, ['AVISADA', true, false, null, true], f, tempo), e => e.parada === 'S2', JSON.stringify(v));
    assert.throws(() => h.conferirRegistro('F5', undefined, ['AVISADA', true, false, null, true], f, tempo), e => e.parada === 'S2');
});

// ---------------------------------------------------------------- encerramento (fakes; nunca conecta)
function dbFake({assinaturas = {}, vagas = [], falhar = null} = {}) {
    const sql = [];
    return {sql, async query(q, params = []) {
        const t = q.replace(/\s+/g, ' ').trim(); sql.push([t, params]);
        if (falhar && falhar.test(t)) throw Error('falha simulada');
        if (/FROM empresa_assinaturas/.test(t)) return {rows:[assinaturas[params[0]] ?? {}]};
        if (/FROM assinatura_fundadores/.test(t)) return {rows:vagas};
        return {rows:[], rowCount:1};
    }};
}
function webhooksFake(lista = []) {
    const chamadas = [];
    return {chamadas, api:async (caminho, method = 'GET') => { chamadas.push(method + ' ' + caminho);
        if (caminho.startsWith('/webhooks?')) return {hasMore:false, data:lista};
        const w = lista.find(x => '/webhooks/' + x.id === caminho); return method === 'GET' ? w ?? null : {}; }};
}
const provado = (extra = {}) => ({marca:h.MARCA, precheck:{fixturesLivres:true, asaasLivre:{F1:true, F2:true, F5:true}}, intencaoFixture:true, ...extra});
const comPagamento = k => ({intencaoCheckout:true, intencaoPagamento:true, clienteId:'cus_' + k, assinaturaId:'sub_' + k});
const escritaComercial = /(UPDATE|INSERT INTO|DELETE FROM)\s+assinatura_(fundadores|contratacoes|renovacoes)/i;

test('encerramento sem prova de autoria não toca provedor nem banco', async () => {
    const a = asaasSimulado(), w = webhooksFake([{id:'wh_1', name:'Kidmais staging ensaio hml-pr-r3', url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook'}]);
    const db = dbFake();
    assert.equal(await h.encerrar({db, conectado:true, r:{}, p:a.p, api:w.api, salvar:() => {}}), null);
    assert.deepEqual(a.chamadas, []); assert.deepEqual(w.chamadas, []); assert.deepEqual(db.sql.map(x => x[0]), ['ROLLBACK']);
    const r2 = {precheck:{fixturesLivres:false, asaasLivre:{F1:true}}, intencaoFixture:true, F1:{intencaoCheckout:true}, intencaoWebhook:true, webhookReutilizado:true, webhookNome:'x'};
    const db2 = dbFake(); await h.encerrar({db:db2, conectado:true, r:r2, p:a.p, api:w.api, salvar:() => {}});
    assert.deepEqual(a.chamadas, [], 'fixture não provada livre em S1: nada é da rodada'); assert.deepEqual(w.chamadas, [], 'webhook reutilizado nunca é removido');
    assert.ok(!db2.sql.some(([q]) => /^UPDATE/.test(q)));
});

test('encerramento após pagamento: remove só as assinaturas da rodada (prova por releitura), vagas CONFIRMADAS intocadas, fixtures desativadas', async () => {
    const a = asaasSimulado(); a.subs.sub_F5.deleted = true; // F5 já cancelada pela tela: a listagem a omite, a releitura por id prova
    const w = webhooksFake([{id:'wh_1', name:'Kidmais staging ensaio hml-pr-r3', url:'https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook'}]);
    const db = dbFake({assinaturas:Object.fromEntries(h.PAGANTES.map(f => [f.empresa, {provedor_cliente_id:'cus_' + f.chave, provedor_assinatura_id:'sub_' + f.chave}])),
        vagas:h.PAGANTES.map(f => ({e:f.empresa, estado:'CONFIRMADA'}))});
    const r = provado({F1:comPagamento('F1'), F2:comPagamento('F2'), F5:comPagamento('F5'), intencaoWebhook:true, webhookNome:'Kidmais staging ensaio hml-pr-r3', webhookId:'wh_1'});
    assert.equal(await h.encerrar({db, conectado:true, r, p:a.p, api:w.api, salvar:() => {}}), null);
    assert.deepEqual(a.chamadas.filter(c => c.startsWith('remover:')), ['remover:sub_F1', 'remover:sub_F2']);
    assert.deepEqual(h.PAGANTES.map(f => r.encerramento[f.chave].acao), Array(3).fill('ASSINATURA_REMOVIDA_COMPROVADA'));
    assert.deepEqual([r.encerramento.F5.removidas, r.encerramento.F5.pagamentoIntencionado], [0, true]);
    assert.ok(Object.values(a.pays).every(x => x.status === 'RECEIVED'), 'cobranças pagas permanecem pagas');
    assert.ok(!db.sql.some(([q]) => escritaComercial.test(q)), 'nunca escreve vaga, contratação ou renovação');
    assert.ok(w.chamadas.includes('DELETE /webhooks/wh_1')); assert.equal(r.encerramento.webhook, 'ENCERRADO');
    for (const t of ['UPDATE usuarios_administrativos SET ativo=false', "UPDATE memberships SET status='REVOGADA'", "UPDATE empresas SET status='DESATIVADA'"])
        assert.ok(db.sql.some(([q]) => q.startsWith(t)), t);
    assert.deepEqual(r.encerramento.vagasFinais, {F1:'CONFIRMADA', F2:'CONFIRMADA', F5:'CONFIRMADA'}); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    // Idempotente: segunda passada (recuperação) não remove nada de novo e continua comprovando.
    a.chamadas.length = 0; assert.equal(await h.encerrar({db:dbFake({vagas:[]}), conectado:true, r, p:a.p, api:webhooksFake([]).api, salvar:() => {}}), null);
    assert.ok(!a.chamadas.some(c => c.startsWith('remover:')));
});

test('encerramento antes do pagamento: remove a assinatura, NUNCA libera a vaga por SQL; vaga RESERVADA reportada para decisão própria', async () => {
    const a = asaasSimulado(), w = webhooksFake();
    const db = dbFake({vagas:[{e:F.F1.empresa, estado:'RESERVADA'}]});
    const r = provado({F1:{intencaoCheckout:true, clienteId:'cus_F1', assinaturaId:'sub_F1'}});
    const erro = await h.encerrar({db, conectado:true, r, p:a.p, api:w.api, salvar:() => {}});
    assert.match(String(erro?.message), /LIMPEZA_VAGAS/); assert.equal(r.vagaReservadaPendente, true);
    assert.ok(r.falhasEncerramento.some(f => /VAGA_RESERVADA_SEM_LIBERACAO F1/.test(f.mensagem)));
    assert.equal(r.encerramento.F1.acao, 'ASSINATURA_REMOVIDA_COMPROVADA'); assert.equal(r.encerramento.F1.pagamentoIntencionado, false);
    assert.ok(!db.sql.some(([q]) => escritaComercial.test(q) || /LIBERADA/.test(q))); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    assert.equal(r.encerramento.F2.acao, 'NADA_CRIADO_PELA_RODADA');
});

test('encerramento recusa colisão, não comprovação e nunca lança (disco e banco indisponíveis)', async () => {
    let a = asaasSimulado(); a.subs.sub_F1.customer = 'cus_outro';
    let r = provado({F1:comPagamento('F1')});
    const erro = await h.encerrar({db:dbFake(), conectado:true, r, p:a.p, api:webhooksFake().api, salvar:() => { throw Error('disco'); }});
    assert.match(String(erro?.message), /LIMPEZA_ASSINATURA_F1/); assert.ok(!a.chamadas.some(c => c.startsWith('remover:')));
    assert.ok(r.falhasEncerramento.some(f => /SUB_DE_OUTRO_CLIENTE/.test(f.mensagem)));
    a = asaasSimulado(); a.p.removerAssinatura = async id => (a.chamadas.push('remover:' + id), {removida:true}); // provedor não remove de fato
    r = provado({F2:comPagamento('F2')});
    assert.match(String((await h.encerrar({db:dbFake(), conectado:true, r, p:a.p, api:webhooksFake().api, salvar:() => {}}))?.message), /LIMPEZA_ASSINATURA_F2/);
    assert.equal(r.encerramento.F2.acao, 'REMOCAO_NAO_COMPROVADA');
    a = asaasSimulado();
    const db = dbFake({assinaturas:{[F.F1.empresa]:{provedor_assinatura_id:'sub_outra'}}}); r = provado({F1:comPagamento('F1')});
    assert.match(String((await h.encerrar({db, conectado:true, r, p:a.p, api:webhooksFake().api, salvar:() => {}}))?.message), /LIMPEZA_ASSINATURA_F1/);
    assert.ok(r.falhasEncerramento.some(f => /SUB_DIVERGENTE_DO_BANCO/.test(f.mensagem)));
    assert.match(String((await h.encerrar({db:null, conectado:false, r:provado(), p:a.p, api:webhooksFake().api, salvar:() => {}}))?.message), /LIMPEZA_BANCO/);
    const db3 = dbFake({falhar:/UPDATE empresas/});
    assert.match(String((await h.encerrar({db:db3, conectado:true, r:provado(), p:a.p, api:webhooksFake().api, salvar:() => {}}))?.message), /LIMPEZA_BANCO/);
    assert.equal(db3.sql.filter(([q]) => q === 'ROLLBACK').length, 2, 'falha no banco desfaz a transação');
});

test('fonte: sem apagamento, sem escrita comercial direta, escrita só por ID das fixtures, provas antes de cada efeito, saídas sanitizadas', () => {
    assert.doesNotMatch(fonte, /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    assert.doesNotMatch(fonte, escritaComercial, 'vaga, contratação e renovação só pelas funções do produto');
    assert.doesNotMatch(fonte, /\b(confirmada_em|beneficio_fim|reservada_em|criada_em)\s*=\s*(clock|now|current|\$|')|SET estado='CONFIRMADA'|simular:\s*true/i, 'sem retrodatar');
    for (const u of fonte.match(/UPDATE [a-z_]+ SET[^`"]+/g)) assert.match(u, /WHERE (id|empresa_id)=(\$1|ANY\(\$1::uuid\[\]\))/, u);
    for (const m of fonte.match(/INSERT INTO memberships[^\n]+/g)) assert.match(m, /\[f\.empresa, f\.usuario\]/, 'vínculos só das fixtures');
    assert.doesNotMatch(fonte, /navegador|HML_NAVEGADOR|aguardarSinal/i, 'sem janela de navegador e sem vincular conta real');
    assert.doesNotMatch(fonte, /empresasParaRenovacao|assinatura-renovar|assinatura-cron/, 'nunca seleciona empresas pelo produto');
    assert.doesNotMatch(fonte, /\.env\.local|env-file|dotenv|readFileSync\([^)]*\.env/);
    assert.ok(i('r.precheck = {fixturesLivres:true') < i('r.intencaoFixture = true'));
    assert.ok(i('cabeNaCampanha(r.campanhaAntes)') < i('r.intencaoFixture = true'), 'sem vagas: para antes de criar');
    assert.ok(i('r.intencaoFixture = true') < i('INSERT INTO empresas('));
    assert.ok(i('r[f.chave] = {intencaoCheckout:true') < i("post('/api/admin/assinatura/checkout'"));
    assert.ok(i('r[f.chave].intencaoPagamento = true') < i("'/confirm', 'POST'"), 'intenção registrada antes de confirmar o pagamento');
    assert.ok(i("r.empresa = 'hml-pr-r3'") < i('prepararWebhook(api, cfg, r, salvar)'), 'nome próprio do webhook da rodada');
    assert.ok(i("marcar('MATRIZ_COTACAO')") < i("marcar('RENOVACAO')") && i("marcar('RENOVACAO')") < i("marcar('SALTO_VENCIMENTO')")
        && i("marcar('SALTO_VENCIMENTO')") < i("marcar('CANCELAMENTO')") && i("marcar('CANCELAMENTO')") < i("marcar('PRESERVACAO')"), 'pagamento antes da renovação');
    const salto = h.ajustarVencimentoDaRodada.toString();
    assert.ok(salto.indexOf('reg.salto = {') > 0 && salto.indexOf('reg.salto = {') < salto.indexOf('await ajustar('), 'prova do salto antes do PUT');
    assert.match(fonte, /beneficio_fim = \(\(v\.confirmada_em AT TIME ZONE 'UTC'\) \+ interval '12 months'\) AT TIME ZONE 'UTC'/);
    assert.match(fonte, /finally \{[\s\S]*?erro = erroFinal\(erro, await encerrar\(\{db, conectado, r, p, api, salvar\}\)\);/);
    assert.match(fonte, /flag:'wx'/);
    assert.equal((fonte.match(/console\.(log|error)/g) ?? []).length, 6, 'saídas sanitizadas conhecidas');
    for (const t of ['empresas','memberships','empresa_assinaturas','assinatura_contratacoes','assinatura_fundadores','assinatura_isencoes','assinatura_renovacoes',
        'clientes','fechamentos','pacotes','financeiro_categorias','financeiro_contas_pagar','empresa_regras_pagamento'])
        assert.ok(h.PRESERVADAS.some(([x]) => x === t), t);
});
