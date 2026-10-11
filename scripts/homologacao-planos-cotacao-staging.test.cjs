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
    ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true', DATABASE_SSL:'false',
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

test('fixtures: cinco empresas sintéticas fixas, distintas da Kidmais, códigos válidos e e-mails inválidos por desenho', () => {
    assert.equal(h.FIXTURES.length, 5);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    assert.equal(new Set(ids).size, 10); assert.ok(!ids.includes(KIDMAIS));
    for (const f of h.FIXTURES) {
        assert.match(f.empresa, /^[0-9a-f-]{36}$/); assert.match(f.codigo, /^hml-planos-[a-z]+$/);
        assert.match(f.codigo, /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/); assert.match(f.email, /@example\.invalid$/); assert.match(f.nome, /^TESTE /);
    }
    assert.deepEqual(h.FIXTURES.map(f => [f.chave, f.tipo, f.plano]), [['F1','PLANO','essencial'],['F2','PLANO','profissional'],['F3','ISENTA',null],['F4','TESTE',null],['F5','PLANO','premium']]);
    assert.deepEqual(Object.keys(h.FINANCEIRO), ['F1','F2','F3','F4','F5']);
    assert.equal(h.FINANCEIRO.F1.contasPagar, 403); assert.ok(['F2','F3','F4','F5'].every(k => h.FINANCEIRO[k].contasPagar === 200));
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
    assert.deepEqual([...new Set(inserts)].sort(), ['INSERT INTO assinatura_isencoes', 'INSERT INTO empresa_assinaturas', 'INSERT INTO empresa_regras_pagamento', 'INSERT INTO empresas',
        'INSERT INTO financeiro_categorias', 'INSERT INTO memberships', 'INSERT INTO pacotes', 'INSERT INTO usuarios_administrativos']);
    assert.match(fonte, /finally \{\s*\/\/[^\n]*\n\s*erro = erroFinal\(erro, await encerrar\(\{db, conectado, r, p, api, salvar\}\)\);/);
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

test('conexão: S1 e recuperação conferem banco e TLS pela configuração da aplicação (staging privado sem TLS)', () => {
    for (const ssl of ['false', 'true']) assert.ok(h.alvo({...envStaging(), DATABASE_SSL:ssl}).connectionString.includes('kidmais_staging_1z91'));
    assert.equal(h.alvo(envStaging()).ssl, undefined, 'configuração real de staging: DATABASE_SSL=false, rede privada');
    assert.doesNotMatch(fonte, /id\.tls, true/, 'sem exigência incondicional de TLS');
    assert.equal(fonte.match(/conferirIdentidade\(id, process\.env, '_S1'\)/g).length, 2, 'S1 e recuperação');
    assert.equal(fonte.match(/db\.query\(SQL_IDENTIDADE\)/g).length, 2);
});

test('disco: rodada e recuperação exigem o disco persistente antes de ler ou gravar estado', () => {
    const rodada = fonte.slice(fonte.indexOf('async function main()'));
    assert.ok(rodada.indexOf('exigirDisco();') > 0 && rodada.indexOf('exigirDisco();') < rodada.indexOf('fs.mkdirSync(DIR'));
    const recuperacao = fonte.slice(fonte.indexOf('async function recuperar()'), fonte.indexOf('async function main()'));
    assert.ok(recuperacao.indexOf('exigirDisco();') > 0 && recuperacao.indexOf('exigirDisco();') < recuperacao.indexOf('fs.existsSync(arquivo)'));
    // Limpeza sem disco: fora do disco montado a recuperação para antes de tocar banco, Asaas ou estado.
    const semChaves = {...envStaging(), ASSINATURA_PLANOS_ATIVOS:undefined, COTACAO_PUBLICA_POR_EMPRESA:undefined, PATH:process.env.PATH};
    const r = spawnSync(process.execPath, [__dirname + '/homologacao-planos-cotacao-staging.cjs', '--encerrar-rodada-1-autorizada'], {encoding:'utf8', env:semChaves, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /DISCO_PERSISTENTE_AUSENTE/); assert.equal(r.stdout, '');
});

test('recuperação: nunca em paralelo com a rodada viva', () => {
    assert.equal(h.processoVivo(process.pid), false, 'o próprio processo não conta');
    assert.equal(h.processoVivo(0), false); assert.equal(h.processoVivo(undefined), false);
    const filho = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
    try { assert.equal(h.processoVivo(filho.pid), true); } finally { filho.kill(); }
    assert.match(fonte, /assert\.ok\(!\(r\.concluido === undefined && processoVivo\(r\.pid\)\), 'RODADA_EM_EXECUCAO'\)/);
    assert.match(fonte, /pid:process\.pid/);
});

// ---------------------------------------------------------------- encerramento: falha, colisão e interrupção
const NOME_WEBHOOK = 'Kidmais staging ensaio homologacao-planos-cotacao-20261010';
const [F1, F2] = h.FIXTURES;
/** Ambiente falso do encerramento: banco, Asaas e webhooks em memória, com falhas injetáveis. */
function falso({subs = {}, webhooks = [], falharRemocao = false, falharBanco = false, salvarLanca = false} = {}) {
    const consultas = [], removidas = [], apagados = [];
    const db = {query: async (sql, params) => { consultas.push({sql, params});
        if (falharBanco && /^UPDATE/.test(sql)) throw new Error('lock_timeout'); return {rows:[], rowCount:0}; }};
    const p = {listarAssinaturasPorReferencia: async ref => (subs[ref] ?? []).map(x => ({...x, deleted:removidas.includes(x.id)})),
        removerAssinatura: async id => { if (falharRemocao) throw new Error('ASAAS 500'); removidas.push(id); return {removida:true}; }};
    const api = async (caminho, method = 'GET') => {
        if (caminho.startsWith('/webhooks?')) return {hasMore:false, data:webhooks};
        const id = decodeURIComponent(caminho.split('/')[2] ?? '');
        if (method === 'DELETE') { apagados.push(id); return {}; }
        return apagados.includes(id) ? null : webhooks.find(w => w.id === id) ?? null;
    };
    const salvar = () => { if (salvarLanca) throw new Error('disco cheio'); };
    return {db, p, api, salvar, consultas, removidas, apagados, updates:() => consultas.filter(c => /^UPDATE/.test(c.sql))};
}
const provado = (extra = {}) => ({precheck:{fixturesLivres:true, asaasLivre:{F1:true, F2:true}}, intencaoFixture:true, fixture:true, ...extra});

test('sucesso: encerra só o comprovado (assinatura da rodada, webhook criado, fixtures por ID + marcador); idempotente', async () => {
    const x = falso({subs:{[F2.empresa]:[{id:'sub_2', externalReference:F2.empresa, customer:'cus_2'}]},
        webhooks:[{id:'wh_9', name:NOME_WEBHOOK, url:h.BASE + '/api/integracoes/asaas/webhook'}]});
    const r = provado({F2:{intencaoCheckout:true, clienteId:'cus_2', assinaturaId:'sub_2'}, intencaoWebhook:true, webhookNome:NOME_WEBHOOK});
    for (let i = 0; i < 2; i++) assert.equal(await h.encerrar({...x, conectado:true, r}), null);
    assert.deepEqual(x.removidas, ['sub_2']); assert.deepEqual(x.apagados, ['wh_9']);
    assert.equal(r.encerramento.F1.acao, 'NADA_CRIADO_PELA_RODADA', 'F1 sem intenção de checkout não é tocada');
    for (const u of x.updates()) {
        assert.doesNotMatch(u.sql, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
        assert.match(u.sql, /email=ANY|usuario_id=ANY|codigo=ANY\(\$2::text\[\]\) AND nome=ANY/);
        for (const v of u.params.flat()) assert.ok(h.FIXTURES.some(f => [f.empresa, f.usuario, f.email, f.codigo, f.nome].includes(v)), String(v));
    }
});

test('falha: o erro original da rodada prevalece; falhas de limpeza ficam registradas e as demais etapas continuam', async () => {
    const x = falso({subs:{[F2.empresa]:[{id:'sub_2', externalReference:F2.empresa, customer:'cus_2'}]}, falharRemocao:true, falharBanco:true});
    const r = provado({F2:{intencaoCheckout:true, clienteId:'cus_2'}});
    const original = Object.assign(new Error('MATRIZ_DIVERGENTE'), {parada:'S2'});
    const doEncerramento = await h.encerrar({...x, conectado:true, r});
    assert.match(doEncerramento.message, /LIMPEZA_ASSINATURA_F2/);
    assert.equal(h.erroFinal(original, doEncerramento), original);
    assert.equal(h.erroFinal(null, doEncerramento), doEncerramento);
    assert.deepEqual(r.falhasEncerramento.map(f => f.etapa), ['ASSINATURA_F2', 'BANCO']);
    assert.ok(x.consultas.some(c => c.sql === 'ROLLBACK'), 'transação do banco desfeita após falha');
    assert.equal(r.encerramento.webhook, 'NADA_CRIADO_PELA_RODADA');
});

test('falha: encerramento nunca lança, mesmo sem banco e com estado em disco indisponível', async () => {
    const x = falso({salvarLanca:true});
    const r = provado();
    const erro = await h.encerrar({...x, conectado:false, r});
    assert.match(erro.message, /LIMPEZA_BANCO/);
    assert.equal(x.updates().length, 0);
});

test('colisão: sem prova de autoria nada é tocado (fixture ou cliente Asaas preexistente, webhook reutilizado)', async () => {
    const subs = {[F1.empresa]:[{id:'sub_alheia', externalReference:F1.empresa, customer:'cus_x'}]};
    const webhooks = [{id:'wh_alheio', name:NOME_WEBHOOK, url:h.BASE + '/api/integracoes/asaas/webhook'}];
    for (const r of [
        {precheck:{fixturesLivres:false}, intencaoFixture:true, F1:{intencaoCheckout:true}},             // S1 achou fixture ocupada
        {intencaoFixture:true, F1:{intencaoCheckout:true}},                                                // precheck nunca concluído
        {precheck:{fixturesLivres:true, asaasLivre:{F1:false}}, F1:{intencaoCheckout:true}},              // cliente Asaas já existia
        {precheck:{fixturesLivres:true, asaasLivre:{F1:true}}, webhookReutilizado:true, webhookNome:NOME_WEBHOOK, intencaoWebhook:true},
    ]) {
        const x = falso({subs, webhooks});
        await h.encerrar({...x, conectado:true, r});
        assert.deepEqual(x.removidas, [], JSON.stringify(r)); assert.deepEqual(x.apagados, []); assert.equal(x.updates().length, 0);
    }
});

test('colisão: assinatura com o mesmo referência mas de outro cliente ou outro id não é removida', async () => {
    for (const registro of [{clienteId:'cus_da_rodada'}, {clienteId:'cus_x', assinaturaId:'sub_da_rodada'}]) {
        const x = falso({subs:{[F1.empresa]:[{id:'sub_alheia', externalReference:F1.empresa, customer:'cus_x'}]}});
        const r = provado({F1:{intencaoCheckout:true, ...registro}});
        const erro = await h.encerrar({...x, conectado:true, r});
        assert.deepEqual(x.removidas, []); assert.match(erro.message, /LIMPEZA_ASSINATURA_F1/);
    }
});

test('interrupção: cada ponto de parada encerra exatamente o que já foi criado', async () => {
    // (a) morto entre BEGIN e salvar `fixture`: intenção + precheck bastam; UPDATE confere ID e marcador.
    let x = falso(); let r = {precheck:{fixturesLivres:true, asaasLivre:{F1:true, F2:true}}, intencaoFixture:true};
    await h.encerrar({...x, conectado:true, r}); assert.equal(x.updates().length, 3); assert.equal(r.encerramento.fixtures, 'DESATIVADAS');
    // (b) morto depois do checkout, antes de salvar ids: remove pela referência (S1 provou que não havia nenhuma).
    x = falso({subs:{[F1.empresa]:[{id:'sub_1', externalReference:F1.empresa, customer:'cus_1'}]}});
    r = provado({F1:{intencaoCheckout:true}}); await h.encerrar({...x, conectado:true, r}); assert.deepEqual(x.removidas, ['sub_1']);
    // (c) morto entre criar o webhook e salvar o id: acha pelo nome inédito da rodada.
    x = falso({webhooks:[{id:'wh_1', name:NOME_WEBHOOK, url:h.BASE + '/api/integracoes/asaas/webhook'}, {id:'wh_outro', name:'Outro', url:h.BASE + '/api/integracoes/asaas/webhook'}]});
    r = provado({intencaoWebhook:true, webhookNome:NOME_WEBHOOK}); await h.encerrar({...x, conectado:true, r}); assert.deepEqual(x.apagados, ['wh_1']);
    // (d) morto antes do precheck terminar: nada a encerrar.
    x = falso({subs:{[F1.empresa]:[{id:'sub_1', externalReference:F1.empresa}]}}); r = {pid:123};
    await h.encerrar({...x, conectado:true, r}); assert.deepEqual([x.removidas.length, x.updates().length], [0, 0]);
    // (e) dois webhooks com o nome da rodada: ambíguo, não apaga nenhum.
    x = falso({webhooks:[{id:'a', name:NOME_WEBHOOK, url:h.BASE + '/api/integracoes/asaas/webhook'}, {id:'b', name:NOME_WEBHOOK, url:h.BASE + '/api/integracoes/asaas/webhook'}]});
    r = provado({intencaoWebhook:true, webhookNome:NOME_WEBHOOK}); const erro = await h.encerrar({...x, conectado:true, r});
    assert.deepEqual(x.apagados, []); assert.match(erro.message, /LIMPEZA_WEBHOOK/);
});

test('regra não zero e Premium: esperados independentes do sistema e escrita só na fixture F4', () => {
    assert.deepEqual({...h.REGRA_F4}, {pixAvista:5, pixParcelado:2, cartao:'Cartão homologação', diaUtil:false});
    assert.equal(h.precoEsperado(h.REGRA_F4.pixAvista), 142500, 'R$ 1.500,00 com 5% = R$ 1.425,00');
    assert.notEqual(h.precoEsperado(h.REGRA_F4.pixAvista), h.precoEsperado(10), 'distinto do legado da Kidmais (R$ 1.350,00)');
    const planos = fs.readFileSync(__dirname + '/../lib/assinatura/planos-comerciais.ts', 'utf8');
    for (const [plano, limite] of Object.entries(h.LIMITE_PESSOAS))
        assert.match(planos, new RegExp(`${plano}: \\{[^}]*limiteUsuarios: ${limite}\\b`), plano);
    assert.ok(h.PRESERVADAS.some(([t]) => t === 'empresa_regras_pagamento'), 'regra legada da Kidmais e demais empresas preservadas');
    const insercoes = fonte.match(/INSERT INTO empresa_regras_pagamento/g) ?? [];
    assert.equal(insercoes.length, 1);
    assert.match(fonte, /if \(f\.chave === 'F4'\)\s+await db\.query\(`INSERT INTO empresa_regras_pagamento/);
    assert.doesNotMatch(fonte, /(UPDATE|DELETE FROM) empresa_regras_pagamento/);
});

test('ordem na rodada: prova de autoria gravada antes de cada criação', () => {
    const ordem = ['r.precheck = {fixturesLivres:true', "r.precheck.asaasLivre[f.chave] = true", 'r.intencaoFixture = true; salvar(); await db.query(\'BEGIN\')',
        "INSERT INTO empresas", 'r[f.chave] = {intencaoCheckout:true', "post('/api/admin/assinatura/checkout'"].map(t => fonte.indexOf(t));
    assert.ok(ordem.every(i => i > 0), JSON.stringify(ordem));
    assert.deepEqual([...ordem].sort((a, b) => a - b), ordem);
    // prepararWebhook (ensaio de 09/10) confere nome inédito antes de registrar a intenção de criar.
    const ensaio = fs.readFileSync(__dirname + '/assinatura-staging-ensaio.cjs', 'utf8');
    assert.ok(ensaio.indexOf("'WEBHOOK_NOME_PREEXISTENTE'") < ensaio.indexOf('r.intencaoWebhook=true'));
});

test('preço independente: faixa fixa da fixture em centavos e desconto com arredondamento contratual', () => {
    assert.equal(h.precoEsperado(0), 150000);
    assert.equal(h.precoEsperado(10), 135000);
    assert.equal(h.precoEsperado(3), 145500);
    assert.equal(h.precoEsperado(7), 139500);
    assert.throws(() => h.precoEsperado(2.5));
    assert.match(fonte, /conferir\('preco\.cotacao\.tabela', Math\.round\(Number\(cotacao\.j\.data\.valorTabela\) \* 100\), precoEsperado\(0\)\)/);
    assert.match(fonte, /conferir\('preco\.fechamentoF2\.tabela'/);
    // Contrato: gerado pela API real e valor final GRAVADO na versão comparado ao esperado independente.
    assert.match(fonte, /s\.F2\.post\('\/api\/admin\/contratos', \{fechamentoId:p1\.j\.fechamentoId\}\)/);
    assert.match(fonte, /conferir\('contrato\.F2\.gerado', contratoF2\.status, 201\)/);
    assert.match(fonte, /v\.snapshot->'comercial'->>'valorFinalContrato' AS final/);
    assert.match(fonte, /conferir\('preco\.contratoF2\.valorFinal', Math\.round\(Number\(versaoF2\?\.final\) \* 100\), precoEsperado\(0\)\)/);
    assert.doesNotMatch(fonte, /contratoPixAvista', precoEsperado\(Number/, 'sem comparação do esperado com ele mesmo');
    assert.notEqual(h.precoEsperado(0), h.precoEsperado(10), 'o esperado distingue regra da empresa (0%) do legado (10%)');
});