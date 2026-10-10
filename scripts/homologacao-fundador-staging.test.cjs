/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da rodada Fundador: sem rede, sem banco, sem Asaas (provedor e banco simulados).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const h = require('./homologacao-fundador-staging.cjs');
const rodada1 = require('./homologacao-planos-cotacao-staging.cjs');

const fonte = fs.readFileSync(__dirname + '/homologacao-fundador-staging.cjs', 'utf8');
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true', DATABASE_SSL:'false', DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const [FE, FP, FM] = h.FIXTURES;

test('sem a flag única não executa; recuperação tem flag própria', () => {
    assert.equal(h.modo([]), null); assert.equal(h.modo(['--rodada-1-autorizada']), null);
    assert.equal(h.modo([h.FLAG, '--x']), null); assert.equal(h.modo([h.FLAG]), 'RODADA'); assert.equal(h.modo([h.FLAG_ENCERRAR]), 'ENCERRAR');
    const r = spawnSync(process.execPath, [__dirname + '/homologacao-fundador-staging.cjs'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_FUNDADOR/);
    const e = spawnSync(process.execPath, [__dirname + '/homologacao-fundador-staging.cjs', h.FLAG_ENCERRAR], {encoding:'utf8', env:{...envStaging(), PATH:process.env.PATH}, timeout:20000});
    assert.equal(e.status, 1); assert.match(e.stderr, /DISCO_PERSISTENTE_AUSENTE/, 'sem disco: nada é lido nem tocado');
});

test('guardas: só web staging, banco de staging, sandbox, planos ligados; rede privada aceita pela configuração', () => {
    assert.ok(h.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {ASAAS_AMBIENTE:'producao'}, {ASSINATURA_PLANOS_ATIVOS:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'}])
        assert.throws(() => h.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.ok(h.alvoEncerramento({...envStaging(), ASSINATURA_PLANOS_ATIVOS:undefined}), 'recuperação não exige a chave (pode já ter sido restaurada)');
});

test('fixtures novas: três planos, IDs/códigos/e-mails inéditos (≠ rodada 1 e Kidmais)', () => {
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.plano]), [['FE','essencial'],['FP','profissional'],['FM','premium']]);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    const antigos = new Set(rodada1.FIXTURES.flatMap(f => [f.empresa, f.usuario, f.codigo, f.email]));
    assert.equal(new Set(ids).size, 6); assert.ok(!ids.includes(KIDMAIS));
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.match(f.codigo, /^hml-fundador-[a-z]+$/);
        assert.match(f.email, /@example\.invalid$/); assert.match(f.nome, /^TESTE .* r2 /);
        for (const v of [f.empresa, f.usuario, f.codigo, f.email]) assert.ok(!antigos.has(v), v);
    }
});

test('preços independentes: regulares do catálogo e 40% Fundador exatos (mesma regra do CHECK da 074)', () => {
    const planos = fs.readFileSync(__dirname + '/../lib/assinatura/planos-comerciais.ts', 'utf8');
    assert.match(planos, /fundador: \{ descontoPercentual: 40, meses: 12, vagas: 20 \}/);
    for (const [plano, {regular, fundador}] of Object.entries(h.PRECOS)) {
        assert.match(planos, new RegExp(`${plano}: \\{[^}]*mensalCentavos: ${regular}\\b`), plano);
        assert.equal(fundador, Math.round(regular * 60 / 100)); assert.equal(fundador * 100, regular * 60);
    }
    assert.deepEqual(Object.values(h.PRECOS).map(p => p.fundador), [11820, 20820, 35820]);
});

test('campanha: as três vagas precisam caber sem mexer no teto', () => {
    assert.equal(h.VAGAS_CAMPANHA, 20);
    assert.equal(h.cabeNaCampanha({ocupadas:0}), true); assert.equal(h.cabeNaCampanha({ocupadas:17}), true);
    assert.equal(h.cabeNaCampanha({ocupadas:18}), false); assert.equal(h.cabeNaCampanha({ocupadas:20}), false);
    assert.equal(h.cabeNaCampanha({}), false); assert.equal(h.cabeNaCampanha(null), false);
});

test('cancelamento comprovado só com assinatura e cobranças removidas (404 ou deleted)', () => {
    assert.equal(h.cancelamentoComprovado({assinaturas:[null], cobrancas:[{deleted:true}]}), true);
    assert.equal(h.cancelamentoComprovado({assinaturas:[{deleted:true}], cobrancas:[null]}), true);
    assert.equal(h.cancelamentoComprovado({assinaturas:[], cobrancas:[]}), true, 'nada criado no provedor');
    assert.equal(h.cancelamentoComprovado({assinaturas:[{deleted:false}], cobrancas:[]}), false);
    assert.equal(h.cancelamentoComprovado({assinaturas:[null], cobrancas:[{deleted:false, status:'PENDING'}]}), false);
    assert.equal(h.cancelamentoComprovado({}), false);
});

// ------------------------------------------------------------------ encerramento simulado
/** Provedor e banco em memória. subs[ref] = [{id, customer, externalReference, deleted}]; cobrancas[subId] = [{id,status,deleted}]. */
function falso({subs = {}, cobrancas = {}, falharRemocao = false, manterCobranca = false, naoLiberadas = {}, falharBanco = false} = {}) {
    const removidas = [], consultas = [];
    const p = {
        listarAssinaturasPorReferencia: async ref => (subs[ref] ?? []).map(s => ({...s, deleted:s.deleted || removidas.includes(s.id)})),
        listarCobrancasDaAssinatura: async id => cobrancas[id] ?? [],
        removerAssinatura: async id => { if (falharRemocao) throw Error('ASAAS 500'); removidas.push(id); return {removida:true}; },
        obterAssinatura: async id => removidas.includes(id) ? null : {id, deleted:false},
    };
    const obterCobranca = async id => {
        const sub = Object.entries(cobrancas).find(([, l]) => l.some(c => c.id === id))?.[0];
        return removidas.includes(sub) && !manterCobranca ? null : {id, deleted:false, status:'PENDING'};
    };
    const db = {query: async (sql, params) => {
        consultas.push({sql, params});
        if (falharBanco && /^UPDATE/.test(sql)) throw Error('lock_timeout');
        if (/^SELECT estado FROM assinatura_fundadores/.test(sql)) return {rows:(naoLiberadas[params[0]] ?? []).map(estado => ({estado})), rowCount:0};
        return {rows:[], rowCount:/^UPDATE assinatura_(contratacoes|fundadores)/.test(sql) ? 1 : 0};
    }};
    const updates = re => consultas.filter(c => re.test(c.sql));
    return {p, obterCobranca, db, removidas, consultas, updates, salvar:() => {}};
}
const sub = (f, extra = {}) => ({id:'sub_' + f.chave, customer:'cus_' + f.chave, externalReference:f.empresa, deleted:false, ...extra});
const provado = (extra = {}) => ({precheck:{fixturesLivres:true, asaasLivre:{FE:true, FP:true, FM:true}}, intencaoFixture:true,
    FE:{intencaoCheckout:true, clienteId:'cus_FE', assinaturaId:'sub_FE'}, FP:{intencaoCheckout:true, clienteId:'cus_FP', assinaturaId:'sub_FP'},
    FM:{intencaoCheckout:true, clienteId:'cus_FM', assinaturaId:'sub_FM'}, ...extra});
const todas = () => ({subs:Object.fromEntries(h.FIXTURES.map(f => [f.empresa, [sub(f)]])),
    cobrancas:Object.fromEntries(h.FIXTURES.map(f => ['sub_' + f.chave, [{id:'pay_' + f.chave, status:'PENDING', deleted:false}]]))});

test('sucesso: remove no Asaas, comprova, cancela a contratação e libera só a vaga de cada fixture; desativa fixtures', async () => {
    const x = falso(todas()); const r = provado();
    assert.equal(await h.encerrar({...x, conectado:true, r}), null);
    assert.deepEqual(x.removidas, ['sub_FE', 'sub_FP', 'sub_FM']);
    const cancel = x.updates(/^UPDATE assinatura_contratacoes/), libera = x.updates(/^UPDATE assinatura_fundadores/);
    assert.deepEqual(cancel.map(c => c.params[0]), [FE.empresa, FP.empresa, FM.empresa]);
    assert.deepEqual(libera.map(c => c.params[0]), [FE.empresa, FP.empresa, FM.empresa]);
    for (const c of [...cancel, ...libera]) assert.equal(c.params[1], h.MOTIVO);
    assert.ok(x.consultas.findIndex(c => c === cancel[0]) < x.consultas.findIndex(c => c === libera[0]), 'cancela antes de liberar (gatilho 074)');
    assert.equal(r.encerramento.fixtures, 'DESATIVADAS'); assert.equal(r.encerramento.FE.acao, 'ASSINATURA_REMOVIDA_COMPROVADA');
    assert.deepEqual(r.encerramento.vagas.FM, {contratacoesCanceladas:1, vagasLiberadas:1, naoLiberadas:[]});
    // Idempotente: segunda execução não remove nada novo e não falha.
    const de2 = await h.encerrar({...x, conectado:true, r}); assert.equal(de2, null); assert.equal(x.removidas.length, 3);
});

test('remoção não comprovada (cobrança ainda ativa) ou falha no Asaas: vaga NÃO é liberada; demais seguem', async () => {
    let x = falso({...todas(), manterCobranca:true}); let r = provado();
    let erro = await h.encerrar({...x, conectado:true, r});
    assert.match(erro.message, /LIMPEZA_ASSINATURA_FE/); assert.equal(x.updates(/^UPDATE assinatura_fundadores/).length, 0);
    assert.equal(r.encerramento.FE.acao, 'REMOCAO_NAO_COMPROVADA'); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    x = falso({...todas(), falharRemocao:true}); r = provado();
    erro = await h.encerrar({...x, conectado:true, r});
    assert.match(erro.message, /LIMPEZA_ASSINATURA/); assert.equal(x.updates(/^UPDATE assinatura_(fundadores|contratacoes)/).length, 0);
    assert.equal(r.falhasEncerramento.length, 3);
});

test('cobrança paga: não remove, não libera (vaga seria confirmada, nunca liberável)', async () => {
    const base = todas(); base.cobrancas.sub_FP = [{id:'pay_FP', status:'RECEIVED', deleted:false}];
    const x = falso(base); const r = provado();
    const erro = await h.encerrar({...x, conectado:true, r});
    assert.match(erro.message, /LIMPEZA_ASSINATURA_FP/); assert.ok(!x.removidas.includes('sub_FP'));
    assert.deepEqual(x.updates(/^UPDATE assinatura_fundadores/).map(c => c.params[0]), [FE.empresa, FM.empresa]);
});

test('sem prova de autoria nada é tocado (precheck incompleto, checkout não registrado, outra rodada)', async () => {
    for (const r of [{}, {precheck:{fixturesLivres:true, asaasLivre:{}}, intencaoFixture:true}, provado({FE:{}, FP:{}, FM:{}}),
        provado({precheck:{fixturesLivres:false, asaasLivre:{FE:true, FP:true, FM:true}}})]) {
        const x = falso(todas());
        await h.encerrar({...x, conectado:true, r});
        assert.deepEqual(x.removidas, []); assert.equal(x.updates(/^UPDATE assinatura_/).length, 0, JSON.stringify(r));
    }
});

test('colisão: assinatura de outro cliente, outro id ou duplicada não é removida e a vaga fica reservada', async () => {
    for (const subsFE of [[sub(FE, {customer:'cus_outro'})], [sub(FE, {id:'sub_outra'})], [sub(FE), sub(FE, {id:'sub_2'})]]) {
        const base = todas(); base.subs[FE.empresa] = subsFE;
        const x = falso(base); const r = provado();
        const erro = await h.encerrar({...x, conectado:true, r});
        assert.match(erro.message, /LIMPEZA_ASSINATURA_FE/); assert.ok(!x.removidas.some(id => id.startsWith('sub_') && id !== 'sub_FP' && id !== 'sub_FM'));
        assert.ok(!x.updates(/^UPDATE assinatura_fundadores/).some(c => c.params[0] === FE.empresa));
    }
});

test('interrupção antes de a assinatura existir: nada no provedor, contratação/vaga da fixture canceladas e liberadas', async () => {
    const x = falso({}); const r = provado({FE:{intencaoCheckout:true}, FP:{}, FM:{}});
    assert.equal(await h.encerrar({...x, conectado:true, r}), null);
    assert.deepEqual(x.updates(/^UPDATE assinatura_fundadores/).map(c => c.params[0]), [FE.empresa]);
});

test('vaga já confirmada (pagamento externo) nunca é forçada: registra e acusa erro', async () => {
    const x = falso({...todas(), naoLiberadas:{[FM.empresa]:['CONFIRMADA']}}); const r = provado();
    const erro = await h.encerrar({...x, conectado:true, r});
    assert.match(erro.message, /LIMPEZA_BANCO/); assert.deepEqual(r.encerramento.vagas.FM.naoLiberadas, ['CONFIRMADA']);
    assert.match(r.falhasEncerramento.at(-1).mensagem, /VAGA_NAO_LIBERADA FM/);
});

test('banco indisponível ou com falha: encerramento nunca lança e preserva o registro', async () => {
    let x = falso(todas()); let r = provado();
    let erro = await h.encerrar({...x, conectado:false, r});
    assert.match(erro.message, /LIMPEZA_BANCO/); assert.equal(r.limpezaBancoPendente, true);
    x = falso({...todas(), falharBanco:true}); r = provado();
    erro = await h.encerrar({...x, conectado:true, r});
    assert.match(erro.message, /LIMPEZA_BANCO/); assert.ok(x.consultas.some(c => c.sql === 'ROLLBACK'));
});

test('código-fonte: nunca apaga; nunca paga; escritas só por ID das fixtures; prova antes do checkout', () => {
    assert.doesNotMatch(fonte, /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    assert.doesNotMatch(fonte, /sandbox\/payment|\/confirm'/, 'nenhum pagamento é confirmado');
    for (const u of fonte.match(/UPDATE [a-z_]+ SET[^`"]+/g)) assert.match(u, /WHERE (id|empresa_id)=(\$1|ANY\(\$1::uuid\[\]\))/, u);
    assert.match(fonte, /UPDATE assinatura_fundadores SET estado='LIBERADA'[^`]+WHERE empresa_id=\$1 AND estado='RESERVADA'/);
    assert.match(fonte, /UPDATE assinatura_contratacoes SET estado='CANCELADA'[^`]+WHERE empresa_id=\$1 AND estado='EM_ABERTO'/);
    const i = t => fonte.indexOf(t);
    assert.ok(i('r.precheck = {fixturesLivres:true') < i('r.intencaoFixture = true') && i('r.intencaoFixture = true') < i('INSERT INTO empresas'));
    assert.ok(i('r[f.chave] = {intencaoCheckout:true}') < i("post('/api/admin/assinatura/checkout'"));
    assert.ok(i('cabeNaCampanha(r.campanhaAntes)') < i('r.intencaoFixture = true'), 'sem vagas: para antes de criar qualquer coisa');
    assert.match(fonte, /finally \{[\s\S]*?erro = erroFinal\(erro, await encerrar\(/);
    assert.ok(h.PRESERVADAS.some(([t]) => t === 'assinatura_fundadores'), 'vagas de terceiros comparadas');
});
