/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do executor de homologação: sem rede, sem banco, sem Asaas. Só guardas, fixtures e código-fonte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const h = require('./homologacao-planos-cotacao-staging.cjs');

const fonte = fs.readFileSync(__dirname + '/homologacao-planos-cotacao-staging.cjs', 'utf8');
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true', DATABASE_SSL:'true',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});

test('sem a flag única de autorização não executa nada (nem carrega banco ou rede)', () => {
    assert.equal(h.autorizado([]), false);
    assert.equal(h.autorizado(['--rodada-1-autorizada', '--outra']), false);
    assert.equal(h.autorizado(['--rodada-2-autorizada']), false);
    assert.equal(h.autorizado(['--rodada-1-autorizada']), true);
    const r = spawnSync(process.execPath, [__dirname + '/homologacao-planos-cotacao-staging.cjs'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_O3/);
});

test('guardas: só o web staging, banco kidmais_staging_1z91, sandbox e as duas chaves de O2', () => {
    assert.ok(h.alvo(envStaging()).connectionString.includes('kidmais_staging_1z91'));
    const variacoes = [
        {RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {ASAAS_AMBIENTE:'producao'},
        {ASSINATURA_PLANOS_ATIVOS:undefined}, {COTACAO_PUBLICA_POR_EMPRESA:undefined}, {RENDER:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},
        {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=disable'},
    ];
    for (const v of variacoes) assert.throws(() => h.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
});

test('fixtures: quatro empresas sintéticas fixas, distintas da Kidmais, códigos válidos e e-mails inválidos por desenho', () => {
    assert.equal(h.FIXTURES.length, 4);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    assert.equal(new Set(ids).size, 8); assert.ok(!ids.includes(KIDMAIS));
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f-]{36}$/); assert.match(f.codigo, /^hml-planos-[a-z]+$/);
        assert.match(f.codigo, /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/); assert.match(f.email, /@example\.invalid$/); assert.match(f.nome, /^TESTE /);
    }
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.tipo, f.plano]), [['F1','PLANO','essencial'],['F2','PLANO','profissional'],['F3','ISENTA',null],['F4','TESTE',null]]);
    assert.deepEqual(Object.keys(h.FINANCEIRO), ['F1','F2','F3','F4']);
    assert.equal(h.FINANCEIRO.F1.contasPagar, 403); assert.ok(['F2','F3','F4'].every(k => h.FINANCEIRO[k].contasPagar === 200));
});

test('preservação: consultas só de leitura e sempre excluindo as fixtures', () => {
    for (const [tabela, coluna, volateis] of h.PRESERVADAS) {
        const sql = h.sqlPreservacao(tabela, coluna, volateis);
        assert.match(sql, /^SELECT .* WHERE coalesce\(t\.[a-z_]+::text,''\) <> ALL\(\$1::text\[\]\) ORDER BY 1$/);
        assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    }
    assert.throws(() => h.sqlPreservacao('clientes; drop', 'empresa_id', []));
});

test('código-fonte: nunca apaga; toda escrita é das fixtures; encerramento desativa só as fixtures', () => {
    assert.doesNotMatch(fonte, /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    const updates = fonte.match(/UPDATE [a-z_]+ SET[^"]+/g) ?? [];
    assert.ok(updates.length >= 6);
    for (const u of updates) assert.match(u, /WHERE (id|empresa_id)=(\$1|ANY\(\$1::uuid\[\]\))/, u);
    const inserts = fonte.match(/INSERT INTO [a-z_]+/g) ?? [];
    assert.deepEqual([...new Set(inserts)].sort(), ['INSERT INTO assinatura_isencoes', 'INSERT INTO empresa_assinaturas', 'INSERT INTO empresas',
        'INSERT INTO financeiro_categorias', 'INSERT INTO memberships', 'INSERT INTO pacotes', 'INSERT INTO usuarios_administrativos']);
    assert.match(fonte, /finally \{\s*\/\/[^\n]*\n\s*erro \?\?= await encerrar\(\{db, conectado, r, p, api, salvar\}\);/);
    assert.match(fonte, /async function encerrar[\s\S]*removerAssinatura[\s\S]*SET ativo=false WHERE id=ANY[\s\S]*status='REVOGADA'[\s\S]*status='DESATIVADA'/);
    assert.match(fonte, /FUNDADOR_S4/); assert.match(fonte, /PRESERVACAO_S3/); assert.match(fonte, /RODADA_EXISTENTE_S1/);
    assert.doesNotMatch(fonte, /console\.log\([^)]*senha/i);
});

test('auxiliares: CPF sintético com dígitos válidos; projeção da agenda ignora campos fora do que o cliente vê', () => {
    for (let i = 0; i < 50; i++) {
        const cpf = h.cpfSintetico(); assert.match(cpf, /^\d{11}$/);
        const d = cpf.split('').map(Number);
        for (const len of [9, 10]) { const s = d.slice(0, len).reduce((t, n, j) => t + n * (len + 1 - j), 0); assert.equal((s * 10 % 11) % 10, d[len]); }
    }
    const a = h.projecaoAgenda({data:[{data:'2026-11-01', periodos:[{codigo:'TURNO_1', configuracaoId:'x', horarios:[{inicio:'12:00', fim:'16:00', ajusteMinutos:0, status:'DISPONIVEL', extra:1}]}]}], comercial:null, geradoEm:'t1'});
    const b = h.projecaoAgenda({data:[{data:'2026-11-01', periodos:[{codigo:'TURNO_1', configuracaoId:'y', horarios:[{inicio:'12:00', fim:'16:00', ajusteMinutos:0, status:'DISPONIVEL'}]}]}], comercial:null, geradoEm:'t2'});
    assert.deepEqual(a, b);
    assert.throws(() => h.conferir('x', 1, 2), e => e.parada === 'S2' && e.item === 'x');
});

test('recuperação: flag própria, mesma trava de alvo (sem exigir as chaves de O1) e recusa sem estado ou fora do staging', () => {
    assert.equal(h.modo(['--encerrar-rodada-1-autorizada']), 'ENCERRAR');
    assert.equal(h.modo(['--rodada-1-autorizada']), 'RODADA');
    assert.equal(h.modo(['--rodada-1-autorizada', '--encerrar-rodada-1-autorizada']), null);
    const semChaves = {...envStaging(), ASSINATURA_PLANOS_ATIVOS:undefined, COTACAO_PUBLICA_POR_EMPRESA:undefined};
    assert.ok(h.alvoEncerramento(semChaves).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {ASAAS_AMBIENTE:'producao'}])
        assert.throws(() => h.alvoEncerramento({...semChaves, ...v}));
    const r = spawnSync(process.execPath, [__dirname + '/homologacao-planos-cotacao-staging.cjs', '--encerrar-rodada-1-autorizada'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /ENCERRADO/);
});

test('recuperação: nunca em paralelo com a rodada viva', () => {
    assert.equal(h.processoVivo(process.pid), false, 'o próprio processo não conta');
    assert.equal(h.processoVivo(0), false); assert.equal(h.processoVivo(undefined), false);
    const filho = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
    try { assert.equal(h.processoVivo(filho.pid), true); } finally { filho.kill(); }
    assert.match(fonte, /assert\.ok\(!\(r\.concluido === undefined && processoVivo\(r\.pid\)\), 'RODADA_EM_EXECUCAO'\)/);
    assert.match(fonte, /pid:process\.pid/);
});

test('encerramento idempotente: só fixtures, sem DELETE; acha o webhook pelo nome quando o id não foi salvo', async () => {
    const consultas = [];
    const db = {query: async (sql, params) => { consultas.push({sql, params}); return {rows:[], rowCount:0}; }};
    const removidas = [];
    const p = {listarAssinaturasPorReferencia: async (ref) => ref === h.FIXTURES[1].empresa ? [{id:'sub_1', externalReference:ref, deleted:removidas.includes('sub_1')}] : [],
        removerAssinatura: async (id) => { removidas.push(id); return {removida:true}; }};
    const apagados = [];
    const api = async (caminho, method = 'GET') => {
        if (caminho.startsWith('/webhooks?')) return {data:[{id:'wh_9', name:'Kidmais staging ensaio homologacao', url:h.BASE + '/api/integracoes/asaas/webhook'}]};
        if (method === 'DELETE') { apagados.push(caminho); return {}; }
        return apagados.length ? null : {id:'wh_9', name:'Kidmais staging ensaio homologacao'};
    };
    const r = {intencaoWebhook:true, webhookNome:'Kidmais staging ensaio homologacao'};
    for (let i = 0; i < 2; i++) assert.equal(await h.encerrar({db, conectado:true, r, p, api, salvar:() => {}}), null);
    assert.deepEqual(removidas, ['sub_1']); assert.deepEqual(apagados, ['/webhooks/wh_9']);
    assert.ok(r.fixturesDesativadas && r.webhookEncerrado);
    for (const c of consultas) {
        assert.doesNotMatch(c.sql, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
        if (/^UPDATE/.test(c.sql)) for (const v of c.params.flat()) assert.ok(h.FIXTURES.some(f => f.empresa === v || f.usuario === v), String(v));
    }
});