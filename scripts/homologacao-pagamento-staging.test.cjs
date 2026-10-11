/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da rodada 3 (pagamento sandbox): sem rede, sem banco, sem Asaas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const h = require('./homologacao-pagamento-staging.cjs');
const rodada1 = require('./homologacao-planos-cotacao-staging.cjs');
const fundador = require('./homologacao-fundador-staging.cjs');

const fonte = fs.readFileSync(__dirname + '/homologacao-pagamento-staging.cjs', 'utf8');
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true', DATABASE_SSL:'false',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});

test('flag única; sem ela nada roda; recuperação sem disco recusada', () => {
    assert.equal(h.modo([]), null); assert.equal(h.modo(['--rodada-1-autorizada']), null); assert.equal(h.modo(['--fundador-rodada-2-autorizada']), null);
    assert.equal(h.modo(['--pagamento-rodada-3-autorizada']), 'RODADA'); assert.equal(h.modo(['--encerrar-pagamento-rodada-3-autorizada']), 'ENCERRAR');
    assert.equal(h.modo(['--pagamento-rodada-3-autorizada', '--x']), null);
    const r = spawnSync(process.execPath, [__dirname + '/homologacao-pagamento-staging.cjs'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_PAGAMENTO/);
    const e = spawnSync(process.execPath, [__dirname + '/homologacao-pagamento-staging.cjs', '--encerrar-pagamento-rodada-3-autorizada'],
        {encoding:'utf8', env:{...envStaging(), PATH:process.env.PATH}, timeout:20000});
    assert.equal(e.status, 1); assert.match(e.stderr, /RASCUNHO_SUBSTITUIDO/, 'rascunho substituído: nenhuma flag executa');
});

test('guardas: web staging, banco de staging em rede privada, sandbox, planos e cotação ligados', () => {
    assert.ok(h.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {ASAAS_AMBIENTE:'producao'},
        {ASSINATURA_PLANOS_ATIVOS:undefined}, {COTACAO_PUBLICA_POR_EMPRESA:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'}])
        assert.throws(() => h.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
});

test('fixtures novas: cinco empresas, IDs/códigos/e-mails inéditos (≠ rodadas 1 e 2 e Kidmais); três pagantes', () => {
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.tipo, f.plano]),
        [['F1','PLANO','essencial'],['F2','PLANO','profissional'],['F3','ISENTA',null],['F4','TESTE',null],['F5','PLANO','premium']]);
    assert.deepEqual(h.PAGANTES.map(f => f.chave), ['F1', 'F2', 'F5']);
    const antigos = new Set([...rodada1.FIXTURES, ...fundador.FIXTURES].flatMap(f => [f.empresa, f.usuario, f.codigo, f.email]));
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    assert.equal(new Set(ids).size, 10); assert.ok(!ids.includes(KIDMAIS));
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.match(f.codigo, /^hml-pag-[a-z]+$/);
        assert.match(f.email, /@example\.invalid$/); assert.match(f.nome, /^TESTE .* r3 /);
        for (const v of [f.empresa, f.usuario, f.codigo, f.email]) assert.ok(!antigos.has(v), v);
    }
});

test('preços e regras independentes: Fundador 40%; contratos 0% / 5% / 8% distintos do legado 10%', () => {
    const planos = fs.readFileSync(__dirname + '/../lib/assinatura/planos-comerciais.ts', 'utf8');
    for (const [plano, {regular, fundador: f}] of Object.entries(h.PRECOS)) {
        assert.match(planos, new RegExp(`${plano}: \\{[^}]*mensalCentavos: ${regular}\\b`)); assert.equal(f * 100, regular * 60);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(h.REGRAS).map(([k, v]) => [k, v.pixAvista])), {F4:5, F5:8});
    const esperados = [h.precoEsperado(0), h.precoEsperado(h.REGRAS.F4.pixAvista), h.precoEsperado(h.REGRAS.F5.pixAvista), h.precoEsperado(10)];
    assert.deepEqual(esperados, [150000, 142500, 138000, 135000]); assert.equal(new Set(esperados).size, 4);
    for (const [plano, limite] of Object.entries(h.LIMITE_PESSOAS)) assert.match(planos, new RegExp(`${plano}: \\{[^}]*limiteUsuarios: ${limite}\\b`));
});

test('campanha: três confirmações precisam caber sem mexer no teto', () => {
    assert.equal(h.VAGAS_CAMPANHA, 20);
    assert.equal(h.cabeNaCampanha({ocupadas:3}), true); assert.equal(h.cabeNaCampanha({ocupadas:17}), true);
    assert.equal(h.cabeNaCampanha({ocupadas:18}), false); assert.equal(h.cabeNaCampanha(null), false);
});

test('conta de navegador: opcional, só e-mail válido e nunca fixture', () => {
    assert.equal(h.emailDeNavegador({}), null); assert.equal(h.emailDeNavegador({HML_NAVEGADOR_EMAIL:''}), null);
    assert.equal(h.emailDeNavegador({HML_NAVEGADOR_EMAIL:'pessoa@exemplo.com'}), 'pessoa@exemplo.com');
    for (const e of ['sem-arroba', 'a@b@c', 'x@example.invalid', 'a b@c.com']) assert.throws(() => h.emailDeNavegador({HML_NAVEGADOR_EMAIL:e}), /CONTA_NAVEGADOR_INVALIDA/, e);
});

test('janela de navegador: fecha no sinal ou no prazo, sem espera real', async () => {
    let t = 0; const pausa = async ms => { t += ms; }; const agora = () => t;
    assert.equal(await h.aguardarSinal('x', 60000, () => t >= 15000, pausa, agora), 'SINAL'); assert.equal(t, 15000);
    t = 0; assert.equal(await h.aguardarSinal('x', 60000, () => false, pausa, agora), 'PRAZO'); assert.ok(t >= 60000);
    assert.equal(h.JANELA_NAVEGADOR_MS, 25 * 60 * 1000);
});

// ---------------------------------------------------------------- encerramento (mesma lógica das rodadas 1/2 + vínculo de navegador)
const [F1] = h.FIXTURES;
function falso({subs = {}, falharRemocao = false, falharBanco = false} = {}) {
    const consultas = [], removidas = [];
    const db = {query: async (sql, params) => { consultas.push({sql, params});
        if (falharBanco && /^UPDATE/.test(sql)) throw new Error('lock_timeout'); return {rows:[], rowCount:0}; }};
    const p = {listarAssinaturasPorReferencia: async ref => (subs[ref] ?? []).map(x => ({...x, deleted:removidas.includes(x.id)})),
        removerAssinatura: async id => { if (falharRemocao) throw new Error('ASAAS 500'); removidas.push(id); return {removida:true}; }};
    const api = async caminho => (caminho.startsWith('/webhooks?') ? {hasMore:false, data:[]} : null);
    return {db, p, api, salvar:() => {}, consultas, removidas, updates:() => consultas.filter(c => /^UPDATE/.test(c.sql))};
}
const provado = (extra = {}) => ({precheck:{fixturesLivres:true, asaasLivre:{F1:true, F2:true, F5:true}}, intencaoFixture:true, fixture:true, ...extra});
const vinculos = x => x.updates().find(u => /memberships/.test(u.sql)).params[1];

test('encerramento: remove só assinaturas da rodada, desativa fixtures e revoga o vínculo de navegador só com prova', async () => {
    let x = falso({subs:{[F1.empresa]:[{id:'sub_1', externalReference:F1.empresa, customer:'cus_1'}]}});
    let r = provado({F1:{intencaoCheckout:true, clienteId:'cus_1', assinaturaId:'sub_1'}, navegador:{usuarioId:'11111111-1111-4111-8111-111111111111', intencao:true}});
    assert.equal(await h.encerrar({...x, conectado:true, r}), null);
    assert.deepEqual(x.removidas, ['sub_1']); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    assert.ok(vinculos(x).includes('11111111-1111-4111-8111-111111111111'), 'vínculo da conta de navegador revogado');
    assert.ok(x.updates().every(u => !/usuarios_administrativos/.test(u.sql) || !u.params[0].includes('11111111-1111-4111-8111-111111111111')), 'a conta em si nunca é desativada');
    // Sem intenção registrada: a conta não entra no UPDATE de vínculos.
    x = falso(); r = provado({navegador:{usuarioId:'22222222-2222-4222-8222-222222222222'}});
    await h.encerrar({...x, conectado:true, r}); assert.ok(!vinculos(x).includes('22222222-2222-4222-8222-222222222222'));
    // Colisão: assinatura de outro cliente não é removida; falha registrada sem lançar.
    x = falso({subs:{[F1.empresa]:[{id:'sub_x', externalReference:F1.empresa, customer:'cus_x'}]}}); r = provado({F1:{intencaoCheckout:true, clienteId:'cus_1'}});
    assert.match((await h.encerrar({...x, conectado:true, r})).message, /LIMPEZA_ASSINATURA_F1/); assert.deepEqual(x.removidas, []);
    // Banco com falha: ROLLBACK, erro registrado, nunca lança.
    x = falso({falharBanco:true}); r = provado();
    assert.match((await h.encerrar({...x, conectado:true, r})).message, /LIMPEZA_BANCO/); assert.ok(x.consultas.some(c => c.sql === 'ROLLBACK'));
    // Sem prova de autoria: nada é tocado.
    x = falso({subs:{[F1.empresa]:[{id:'sub_1', externalReference:F1.empresa, customer:'cus_1'}]}}); r = {intencaoFixture:true, F1:{intencaoCheckout:true}};
    await h.encerrar({...x, conectado:true, r}); assert.deepEqual([x.removidas.length, x.updates().length], [0, 0]);
});

test('código-fonte: nunca apaga nem mexe em vaga Fundador; escrita por ID das fixtures; provas antes de cada efeito', () => {
    assert.doesNotMatch(fonte, /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    assert.doesNotMatch(fonte, /UPDATE assinatura_fundadores|UPDATE assinatura_contratacoes|INSERT INTO assinatura_fundadores/, 'vaga e contratação só pelo sistema');
    for (const u of fonte.match(/UPDATE [a-z_]+ SET[^`"]+/g)) assert.match(u, /WHERE (id|empresa_id)=(\$1|ANY\(\$1::uuid\[\]\))/, u);
    const i = t => fonte.indexOf(t);
    assert.ok(i('cabeNaCampanha(r.campanhaAntes)') > 0 && i('cabeNaCampanha(r.campanhaAntes)') < i('r.intencaoFixture = true'), 'sem vagas: para antes de criar');
    assert.ok(i('r[f.chave] = {intencaoCheckout:true') < i("post('/api/admin/assinatura/checkout'"));
    assert.ok(i('r[f.chave].intencaoPagamento = true') < i("'/confirm', 'POST'"), 'intenção registrada antes de confirmar o pagamento');
    assert.ok(i('r.navegador.intencao = true') < i('INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,\'REPRESENTANTE_AUTORIZADO\',\'PENDENTE\',clock_timestamp())", [f.empresa, r.navegador.usuarioId]'));
    assert.ok(i("marcar('NAVEGADOR')") < i("marcar('PRESERVACAO')"), 'janela antes da preservação final');
    assert.match(fonte, /beneficio_fim = \(\(v\.confirmada_em AT TIME ZONE 'UTC'\) \+ interval '12 months'\) AT TIME ZONE 'UTC'/);
    assert.match(fonte, /finally \{[\s\S]*?erro = erroFinal\(erro, await encerrar\(\{db, conectado, r, p, api, salvar\}\)\);/);
    assert.match(fonte, /flag:'wx'/);
    assert.ok(h.PRESERVADAS.some(([t]) => t === 'assinatura_fundadores') && h.PRESERVADAS.some(([t]) => t === 'empresa_regras_pagamento'));
});
