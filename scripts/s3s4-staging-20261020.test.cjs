/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline das conferências da janela S3+S4 de 20/10: pastas temporárias, banco e Asaas simulados. Sem rede, sem Render.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process'), {createHash} = require('node:crypto');
const j = require('./s3s4-staging-20261020.cjs');
const h = require('./homologacao-pagamento-renovacao-staging.cjs');
const c10 = require('./configuracao-homologacao-staging.cjs');
const root = path.resolve(__dirname, '..');
const CAND = '321c9d50b0685fc97bd1293acc519c51f88f9688';
const CHAVE = '$aact_hmlg_SINTETICAnaoREAL0123456789abcdef';
const TOKEN = 'tokenSINTETICOdoWEBHOOKnaoREAL_0123456789';
const NOME = path.basename(h.ARQUIVO);
const base = {RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', RENDER_GIT_COMMIT:CAND,
    DATABASE_SSL:'false', DATABASE_URL:'postgresql://sintetico:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
    ASAAS_AMBIENTE:'sandbox', ASAAS_API_KEY:CHAVE, ASAAS_WEBHOOK_TOKEN:TOKEN};
const janelaS4 = {...base, ASSINATURA_PLANOS_ATIVOS:'true', COTACAO_PUBLICA_POR_EMPRESA:'true'};
const janelaS3 = {...janelaS4, CADASTRO_PUBLICO_ATIVO:'true', USUARIOS_CRIACAO_DIRETA:'desativada', EMAIL_PROVIDER:'resend',
    EMAIL_REMETENTE:'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>', RESEND_API_KEY:'re_SINTETICAnaoREAL'};
const sha = b => createHash('sha256').update(b).digest('hex');
const AGORA = new Date('2026-10-21T13:00:00Z'); // 10h BRT

/** Pasta da rodada 3 com o registro de 10/10 (chaves ausentes) e, opcionalmente, estado e log. */
function pasta({estado, log} = {}) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 's3s4-'));
    fs.writeFileSync(path.join(d, c10.ARQUIVO), JSON.stringify(c10.registrar({})));
    if (estado) fs.writeFileSync(path.join(d, NOME), JSON.stringify(estado));
    if (log !== undefined) fs.writeFileSync(path.join(d, j.LOG), log);
    return d;
}
/** Estado como o da tentativa de 20/10: parou no PRECHECK (Asaas 401), nada criado, rodada concluída com erro. */
const estado401 = () => ({marca:h.MARCA, inicio:'2026-10-20T10:28:51.123Z', pid:2147480000, modoEmail:'SINK', etapas:[], resultados:{}, tempo:{},
    precheck:{fixturesLivres:true, asaasLivre:{}}, campanhaAntes:{confirmadas:2, ocupadas:3}, campanhaDepois:{confirmadas:2, ocupadas:3},
    falha:{etapa:'PRECHECK', parada:null, item:null, obtido:null, esperado:null, http:401, mensagem:'ASAAS_HTTP'},
    encerramento:{fim:'2026-10-20T10:29:10.000Z'}, concluido:false});

/** Asaas simulado: só aceita GET na URL do sandbox com a chave; registra chamadas. */
function asaasFalso({status = 200, webhooks = [], total, hasMore = false, rede = false} = {}) {
    const chamadas = [];
    const f = async (url, init) => {
        chamadas.push({url, metodo:init.method, chave:init.headers.access_token === CHAVE, ua:init.headers['User-Agent']});
        assert.equal(init.method, 'GET'); assert.ok(url.startsWith('https://api-sandbox.asaas.com/v3/'));
        if (rede) throw new Error('ECONNRESET host interno');
        const resp = (s, corpo) => ({status:s, ok:s >= 200 && s < 300, json:async () => corpo});
        if (url.endsWith('/customers?limit=1')) return resp(status, {data:[], totalCount:0});
        if (url.endsWith('/webhooks?limit=100')) return resp(200, {data:webhooks.map(w => ({id:w.id, url:w.url})), totalCount:total ?? webhooks.length, hasMore});
        const w = webhooks.find(x => url.endsWith('/webhooks/' + x.id));
        return w ? resp(200, w) : resp(404, null);
    };
    f.chamadas = chamadas; return f;
}
const webhook = (id, extra = {}) => ({id, url:j.ROTA_WEBHOOK, enabled:true, interrupted:false, events:['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'], ...extra});

/** Banco simulado: respostas por trecho de SQL; registra tudo. */
function Banco({db = 'kidmais_staging_1z91', privado = true, campanha = {confirmadas:2, ocupadas:3}, ocupado = false, globais = 0,
    kidmais = {empresas:1, assinaturas:0}, cnpj = {cadastros:0, testes:0, fundadores:0}, s3 = [], s4n = []} = {}) {
    const log = [];
    class C {
        constructor(o) { this.o = o; C.opcoes = o; }
        on() {} async connect() {} async end() { C.fechado = true; }
        async query(t, v) {
            log.push(t); C.valores.push(v);
            if (t.includes('current_database()')) return {rows:[{db, privado}]};
            if (t.includes('FROM assinatura_fundadores') && t.includes('ocupadas')) return {rows:[campanha]};
            if (t.includes('AS ocupado')) return {rows:[{ocupado}]};
            if (t.includes('FROM bloqueios_agenda')) return {rows:[{n:globais}]};
            if (t.includes('AS cadastros')) return {rows:[cnpj]};
            if (t.includes('eventos_processados')) return {rows:s4n};
            if (t.includes('cadastros_empresas')) return {rows:s3};
            if (t.includes("codigo='kidmais'")) return {rows:[kidmais]};
            return {rows:[]};
        }
    }
    C.log = log; C.valores = []; return C;
}
const rodar = (argv, o = {}) => j.principal(argv, {deploy:root, disco:true, agora:AGORA, ...o});
const semSegredo = x => { const s = JSON.stringify(x); assert.ok(!s.includes(CHAVE) && !s.includes(TOKEN) && !s.includes('sintetico:sintetico') && !s.includes('re_SINTETICA')); };

test('uso: um modo; candidata exigida só onde precisa; CNPJ com dígitos válidos, nunca o da Kidmais', () => {
    assert.deepEqual(j.analisar(['--pre']), {modo:'pre', candidata:null, cnpj:null});
    assert.deepEqual(j.analisar(['--janela', '--candidata=' + CAND]), {modo:'janela', candidata:CAND, cnpj:null});
    assert.deepEqual(j.analisar(['--s3-antes', '--candidata=' + CAND, '71.394.825/0001-86']), {modo:'s3-antes', candidata:CAND, cnpj:'71394825000186'});
    for (const [argv, m] of [[[], /USO_RECUSADO/], [['--pre', '--pos'], /USO_RECUSADO/], [['--apagar'], /USO_RECUSADO/], [['--janela'], /CANDIDATA_AUSENTE/],
        [['--pre', '--candidata=' + CAND], /USO_RECUSADO/], [['--janela', '--candidata=321c9d5'], /CANDIDATA_INVALIDA/], [['--pos', '--candidata=' + CAND, 'x'], /USO_RECUSADO/],
        [['--s3-depois', '--candidata=' + CAND], /USO_RECUSADO/], [['--s3-depois', '--candidata=' + CAND, '71394825000187'], /CNPJ_DV_INVALIDO/],
        [['--s3-depois', '--candidata=' + CAND, '20.119.900/0001-60'], /CNPJ_DA_KIDMAIS/], [['--s3-depois', '--candidata=' + CAND, '11111111111111'], /CNPJ_INVALIDO/]])
        assert.throws(() => j.analisar(argv), m, JSON.stringify(argv));
    assert.equal(j.cnpjValido(j.CNPJ_S3R), j.CNPJ_S3R); assert.equal(j.cnpjValido(j.CNPJ_TESTE_S3), j.CNPJ_TESTE_S3);
    assert.notEqual(j.CNPJ_S3R, j.CNPJ_TESTE_S3);
});

test('guardas: só no Web Shell do staging; modos com candidata exigem o commit no ar igual a ela', async () => {
    for (const [v, m] of [[{RENDER:undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/],
        [{KIDMAIS_DEPLOY_ENV:'production'}, /AMBIENTE_RECUSADO/]])
        await assert.rejects(rodar(['--pre'], {env:{...base, ...v}, dir:pasta(), fetch:asaasFalso()}), m);
    await assert.rejects(rodar(['--pos', '--candidata=' + CAND], {env:{...base, RENDER_GIT_COMMIT:'73618a298673b837ef52b0380b74d22b3cab9edc'}, dir:pasta()}), /CANDIDATA_DIVERGENTE/);
    assert.equal((await rodar(['--plano'], {env:{}})).saida.resultado, 'PLANO');
});

test('PRE: tentativa de 20/10 (PRECHECK 401, nada criado) é arquivável; Asaas mostra só status, sem segredo', async () => {
    const d = pasta({estado:estado401(), log:'{"resultado":"INCOMPLETO"}\n'});
    const f = asaasFalso({status:401});
    const r = await rodar(['--pre'], {env:base, dir:d, fetch:f});
    assert.equal(r.codigo, 0); assert.equal(r.saida.resultado, 'PRE_OK_ARQUIVAR'); assert.equal(r.saida.arquivavel, true);
    assert.equal(r.saida.commitNoAr, CAND); assert.equal(r.saida.registro.resultado, 'RESTAURADA'); assert.equal(r.saida.logR3, 'PRESENTE');
    assert.equal(r.saida.asaas.resultado, 'ASAAS_CHAVE_RECUSADA'); assert.equal(r.saida.asaas.http, 401);
    assert.deepEqual(f.chamadas.map(x => [x.metodo, x.url.replace(j.ASAAS, ''), x.chave, x.ua]), [['GET', '/customers?limit=1', true, 'kidmais-staging-homologacao']]);
    assert.deepEqual(r.saida.estadoR3.campanhaAntes, {confirmadas:2, ocupadas:3}); assert.equal(r.saida.estadoR3.falha.http, 401);
    semSegredo(r.saida);
    // Sem estado: PRE_OK. Log sozinho: parar (log órfão). Chaves da janela presentes ou registro divergente: parar.
    assert.equal((await rodar(['--pre'], {env:base, dir:pasta(), fetch:asaasFalso()})).saida.resultado, 'PRE_OK');
    assert.deepEqual((await rodar(['--pre'], {env:base, dir:pasta({log:'x'}), fetch:asaasFalso()})).saida.motivos, ['LOG_SEM_ESTADO']);
    const p = await rodar(['--pre'], {env:{...base, ASSINATURA_PLANOS_ATIVOS:'true'}, dir:pasta(), fetch:asaasFalso()});
    assert.equal(p.codigo, 2); assert.deepEqual(p.saida.motivos, ['CHAVES_DA_JANELA_PRESENTES', 'REGISTRO_DIVERGENTE']);
    assert.deepEqual((await rodar(['--pre'], {env:base, dir:pasta(), fetch:asaasFalso(), disco:false})).saida.motivos, ['DISCO_PERSISTENTE_AUSENTE']);
});

test('PRE: estado com qualquer sinal de criação, sem conclusão ou de outra rodada NÃO é arquivável', async () => {
    const casos = [{etapas:['FIXTURES']}, {intencaoFixture:true}, {fixture:true}, {intencaoWebhook:true, webhookNome:'x'}, {webhookId:'w1'},
        {F1:{intencaoCheckout:true}, precheck:{fixturesLivres:true, asaasLivre:{F1:true}}}, {concluido:undefined}, {concluido:true, aprovado:true},
        {marca:'outra-rodada'}, {falha:{etapa:'CHECKOUT'}}, {vagaReservadaPendente:true}, {falhasEncerramento:[{etapa:'ASAAS'}]}];
    for (const extra of casos) {
        const e = {...estado401(), ...extra};
        const r = await rodar(['--pre'], {env:base, dir:pasta({estado:e}), fetch:asaasFalso()});
        assert.equal(r.saida.resultado, 'PRE_PARAR', JSON.stringify(extra)); assert.deepEqual(r.saida.motivos, ['ESTADO_NAO_ARQUIVAVEL']);
        await assert.rejects(rodar(['--arquivar-r3'], {env:base, dir:pasta({estado:e})}), /ESTADO_NAO_ARQUIVAVEL/, JSON.stringify(extra));
    }
});

test('ARQUIVAR: renomeia log e estado com o carimbo da tentativa, conteúdo idêntico, nunca sobrescreve nem apaga conteúdo', async () => {
    const e = estado401(), d = pasta({estado:e, log:'linha 1\n{"resultado":"INCOMPLETO"}\n'});
    const antes = {estado:sha(fs.readFileSync(path.join(d, NOME))), log:sha(fs.readFileSync(path.join(d, j.LOG)))};
    const r = await rodar(['--arquivar-r3'], {env:base, dir:d});
    assert.equal(r.codigo, 0); assert.equal(r.saida.resultado, 'ARQUIVADO'); assert.equal(r.saida.estadoAgora, 'AUSENTE'); assert.equal(r.saida.logAgora, 'AUSENTE');
    const nomes = fs.readdirSync(d).sort();
    const est = NOME.replace(/\.json$/, '.precheck-20261020T102851Z.json'), lg = 'pagamento-renovacao-saida.precheck-20261020T102851Z.log';
    assert.deepEqual(nomes, [c10.ARQUIVO, lg, est].sort());
    assert.equal(sha(fs.readFileSync(path.join(d, est))), antes.estado); assert.equal(sha(fs.readFileSync(path.join(d, lg))), antes.log);
    assert.deepEqual(r.saida.arquivos.map(x => [x.arquivo, x.acao, x.sha256]), [[j.LOG, 'ARQUIVADO', antes.log], [NOME, 'ARQUIVADO', antes.estado]]);
    await assert.rejects(rodar(['--arquivar-r3'], {env:base, dir:d}), /SEM_ESTADO_PARA_ARQUIVAR/);
    // Destino já existente: recusa antes de mexer em qualquer arquivo.
    const d2 = pasta({estado:e, log:'x'}); fs.writeFileSync(path.join(d2, est), 'outro');
    await assert.rejects(rodar(['--arquivar-r3'], {env:base, dir:d2}), /DESTINO_EXISTE/);
    assert.ok(fs.existsSync(path.join(d2, NOME)) && fs.existsSync(path.join(d2, j.LOG))); assert.equal(fs.readFileSync(path.join(d2, est), 'utf8'), 'outro');
    // Sem log: arquiva só o estado. Sem disco persistente: recusa.
    const d3 = pasta({estado:e});
    assert.deepEqual((await rodar(['--arquivar-r3'], {env:base, dir:d3})).saida.arquivos.map(x => x.acao), ['AUSENTE', 'ARQUIVADO']);
    await assert.rejects(rodar(['--arquivar-r3'], {env:base, dir:pasta({estado:e}), disco:false}), /DISCO_PERSISTENTE_AUSENTE/);
    assert.equal(j.carimbo('2026-10-20T10:28:51.123Z'), '20261020T102851Z'); assert.throws(() => j.carimbo('x'), /INICIO_INVALIDO/);
});

test('Asaas: webhook reutilizável, criado pela rodada ou bloqueante; formato inválido não chama a rede; rede fora não vaza detalhe', async () => {
    const pronto = await j.asaas(base, asaasFalso({webhooks:[webhook('w1')]}));
    assert.equal(pronto.resultado, 'ASAAS_PRONTO'); assert.equal(pronto.webhookDaRodada, 'REUTILIZA_O_EXISTENTE');
    assert.equal((await j.asaas(base, asaasFalso())).webhookDaRodada, 'CRIA_UM_PROPRIO');
    for (const [o, motivo] of [[{webhooks:[webhook('w1', {interrupted:true})]}, 'WEBHOOK_INTERROMPIDO'], [{webhooks:[webhook('w1', {enabled:false})]}, 'WEBHOOK_INUTILIZAVEL'],
        [{webhooks:[webhook('w1', {events:['PAYMENT_RECEIVED']})]}, 'WEBHOOK_INUTILIZAVEL'], [{webhooks:[webhook('w1'), webhook('w2')]}, 'WEBHOOK_AMBIGUO'],
        [{total:10}, 'LIMITE_WEBHOOKS'], [{hasMore:true}, 'WEBHOOKS_PAGINADOS']]) {
        const r = await j.asaas(base, asaasFalso(o)); assert.equal(r.resultado, 'ASAAS_BLOQUEIA_S4'); assert.equal(r.motivo, motivo); semSegredo(r);
    }
    for (const v of [{ASAAS_AMBIENTE:'producao'}, {ASAAS_API_KEY:'$aact_prod_x'}, {ASAAS_WEBHOOK_TOKEN:'curto'}, {ASAAS_WEBHOOK_TOKEN:CHAVE}]) {
        const f = asaasFalso(), r = await j.asaas({...base, ...v}, f);
        assert.equal(r.resultado, 'ASAAS_FORMATO_INVALIDO', JSON.stringify(Object.keys(v))); assert.equal(f.chamadas.length, 0); semSegredo(r);
    }
    const rede = await j.asaas(base, asaasFalso({rede:true}));
    assert.equal(rede.resultado, 'ASAAS_SEM_RESPOSTA'); assert.ok(!JSON.stringify(rede).includes('host interno'));
});

test('JANELA: pronto só com as duas chaves, estado e log arquivados, antes das 20h BRT, Asaas pronto, vagas e fixtures livres (leitura)', async () => {
    const C = Banco();
    const r = await rodar(['--janela', '--candidata=' + CAND], {env:janelaS4, dir:pasta(), fetch:asaasFalso(), Client:C});
    assert.equal(r.codigo, 0, JSON.stringify(r.saida)); assert.equal(r.saida.resultado, 'PRONTO_PARA_S4'); assert.equal(r.saida.horaBrasil, 10);
    assert.deepEqual(r.saida.banco, {campanha:{confirmadas:2, ocupadas:3}, cabe:true, fixturesLivres:true, kidmais:{empresas:1, assinaturas:0}});
    assert.equal(C.log[0], 'BEGIN TRANSACTION READ ONLY'); assert.equal(C.log.at(-1), 'ROLLBACK'); assert.equal(C.fechado, true);
    assert.equal(C.opcoes.application_name, 'kidmais-s3s4-somente-leitura');
    assert.deepEqual(C.valores.find(v => v)?.[0], h.FIXTURES.map(f => f.empresa), 'fixtures da própria rodada 3 (fonte única: o executor)');
    semSegredo(r.saida);
    const casos = [[{env:{...janelaS4, COTACAO_PUBLICA_POR_EMPRESA:undefined}}, ['CHAVE_COTACAO_PUBLICA_POR_EMPRESA']],
        [{dir:pasta({estado:estado401()})}, ['ESTADO_R3_PRESENTE']], [{dir:pasta({log:'x'})}, ['LOG_R3_PRESENTE']],
        [{agora:new Date('2026-10-21T23:05:00Z')}, ['HORARIO_LIMITE']], [{fetch:asaasFalso({status:401})}, ['ASAAS_CHAVE_RECUSADA']],
        [{Client:Banco({campanha:{confirmadas:17, ocupadas:18}})}, ['FUNDADOR_SEM_VAGAS']], [{Client:Banco({ocupado:true})}, ['FIXTURE_PREEXISTENTE']],
        [{disco:false}, ['DISCO_PERSISTENTE_AUSENTE']]];
    for (const [o, motivos] of casos) {
        const x = await rodar(['--janela', '--candidata=' + CAND], {env:janelaS4, dir:pasta(), fetch:asaasFalso(), Client:Banco(), ...o});
        assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'JANELA_PARAR'); assert.deepEqual(x.saida.motivos, motivos);
    }
    await assert.rejects(rodar(['--janela', '--candidata=' + CAND], {env:janelaS4, dir:pasta(), fetch:asaasFalso(), Client:Banco({db:'kidmais_production'})}), /BANCO_CONECTADO_DIVERGENTE/);
    await assert.rejects(rodar(['--janela', '--candidata=' + CAND], {env:janelaS4, dir:pasta(), fetch:asaasFalso(), Client:Banco({privado:false})}), /REDE_NAO_PRIVADA/);
    await assert.rejects(rodar(['--janela', '--candidata=' + CAND], {env:{...janelaS4, DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},
        dir:pasta(), fetch:asaasFalso(), Client:Banco()}), /HOST_RECUSADO/);
});

test('S4-ACOMPANHAR: PASS, INCOMPLETO, em execução, interrompida e sem rodada; log reduzido aos campos de leitura', async () => {
    const final = JSON.stringify({resultado:'PASS', falha:null, erro:null, campanhaAntes:{confirmadas:2, ocupadas:3}, campanhaDepois:{confirmadas:5, ocupadas:6},
        vagas:{F1:4, F2:5, F5:6}, falhasEncerramento:[], tempo:{x:1}});
    const pass = await rodar(['--s4-acompanhar'], {env:base, dir:pasta({estado:{...estado401(), falha:undefined, etapas:['FIXTURES', 'R6'], aprovado:true, concluido:true}, log:'a\n' + final + '\n'})});
    assert.equal(pass.codigo, 0); assert.equal(pass.saida.resultado, 'PASS'); assert.equal(pass.saida.log.final.resultado, 'PASS');
    assert.deepEqual(pass.saida.log.final.campanhaDepois, {confirmadas:5, ocupadas:6}); assert.equal(pass.saida.log.final.tempo, undefined);
    const inc = await rodar(['--s4-acompanhar'], {env:base, dir:pasta({estado:estado401(), log:'HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES X\n'})});
    assert.equal(inc.codigo, 2); assert.equal(inc.saida.resultado, 'INCOMPLETO'); assert.equal(inc.saida.log.ultima, 'HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES X');
    const vivo = await rodar(['--s4-acompanhar'], {env:base, dir:pasta({estado:{...estado401(), concluido:undefined, falha:undefined, pid:process.ppid}})});
    assert.equal(vivo.codigo, 0); assert.equal(vivo.saida.resultado, 'EM_EXECUCAO'); assert.equal(vivo.saida.log.log, 'AUSENTE');
    const morto = await rodar(['--s4-acompanhar'], {env:base, dir:pasta({estado:{...estado401(), concluido:undefined, falha:undefined}})});
    assert.equal(morto.saida.resultado, 'INTERROMPIDA_SEM_CONCLUSAO'); assert.equal(morto.codigo, 2);
    assert.equal((await rodar(['--s4-acompanhar'], {env:base, dir:pasta()})).saida.resultado, 'SEM_RODADA');
});

test('POS: restaurado só com as quatro chaves ausentes e o registro de 10/10 conferido; lista os arquivados', async () => {
    const d = pasta(); fs.writeFileSync(path.join(d, NOME.replace(/\.json$/, '.precheck-20261020T102851Z.json')), '{}');
    const r = await rodar(['--pos', '--candidata=' + CAND], {env:base, dir:d});
    assert.equal(r.codigo, 0); assert.equal(r.saida.resultado, 'RESTAURADO'); assert.equal(r.saida.arquivados.length, 1);
    for (const k of j.CHAVES_JANELA) {
        const x = await rodar(['--pos', '--candidata=' + CAND], {env:{...base, [k]:'true'}, dir:pasta()});
        assert.equal(x.codigo, 2); assert.deepEqual(x.saida.chavesPresentes, [k]);
    }
    const sem = await rodar(['--pos', '--candidata=' + CAND], {env:base, dir:fs.mkdtempSync(path.join(os.tmpdir(), 's3s4-'))});
    assert.equal(sem.saida.registro.resultado, 'SEM_REGISTRO'); assert.equal(sem.codigo, 2);
});

test('S3-R (opcional): janela do cadastro, CNPJ novo livre e S3_PASS; o CNPJ do S3 de 20/10 é recusado', async () => {
    const ok = await rodar(['--s3-antes', '--candidata=' + CAND, j.CNPJ_S3R], {env:janelaS3, dir:pasta(), Client:Banco()});
    assert.equal(ok.codigo, 0); assert.equal(ok.saida.resultado, 'PRONTO_PARA_CADASTRO'); semSegredo(ok.saida);
    assert.equal((await rodar(['--s3-antes', '--candidata=' + CAND, j.CNPJ_S3R], {env:janelaS3, dir:pasta(), Client:Banco({cnpj:{cadastros:1, testes:1, fundadores:0}})})).saida.resultado, 'CNPJ_JA_USADO');
    assert.equal((await rodar(['--s3-antes', '--candidata=' + CAND, j.CNPJ_S3R], {env:janelaS3, dir:pasta(), Client:Banco({globais:1})})).saida.resultado, 'CADASTRO_RECUSARIA_503');
    await assert.rejects(rodar(['--s3-antes', '--candidata=' + CAND, j.CNPJ_TESTE_S3], {env:janelaS3, dir:pasta(), Client:Banco()}), /CNPJ_JA_USADO_NO_S3_DE_20_10/);
    for (const [v, m] of [[{CADASTRO_PUBLICO_ATIVO:undefined}, /CADASTRO_FECHADO/], [{USUARIOS_CRIACAO_DIRETA:undefined}, /CRIACAO_DIRETA_LIGADA/],
        [{EMAIL_PROVIDER:'arquivo'}, /EMAIL_PROVEDOR/], [{ASSINATURA_TESTE_DIAS:'30'}, /TESTE_DIFERENTE_DE_15/]])
        await assert.rejects(rodar(['--s3-antes', '--candidata=' + CAND, j.CNPJ_S3R], {env:{...janelaS3, ...v}, dir:pasta(), Client:Banco()}), m);
    const empresa = {status:'ATIVA', situacao:'TESTE', quinze_dias:true, sem_provedor:true, teste_vigente:true, gestao:1, contratacoes:0};
    const dep = await rodar(['--s3-depois', '--candidata=' + CAND, j.CNPJ_S3R], {env:base, dir:pasta(), Client:Banco({s3:[empresa]})});
    assert.equal(dep.codigo, 0); assert.equal(dep.saida.resultado, 'S3_PASS'); assert.equal(dep.saida.cnpj, j.CNPJ_S3R);
    assert.equal((await rodar(['--s3-depois', '--candidata=' + CAND, j.CNPJ_S3R], {env:base, dir:pasta(), Client:Banco({s3:[]})})).codigo, 2);
});

test('S4-N (opcional): contratação Essencial mensal Fundador confirmada pelo webhook; qualquer desvio = S4N_DIVERGENTE', async () => {
    const linha = {status:'ATIVA', situacao:'ATIVA', ciclo:'MENSAL', com_provedor:true, confirmadas:1,
        contratacao:{plano:'ESSENCIAL', ciclo:'MENSAL', regular:19700, final:11820, desconto:40, fundador:true}, fundador:{estado:'CONFIRMADA', beneficioLongo:true}, eventos_processados:2};
    const C = Banco({s4n:[linha]});
    const r = await rodar(['--s4n-depois', '--candidata=' + CAND, j.CNPJ_TESTE_S3], {env:base, dir:pasta(), Client:C});
    assert.equal(r.codigo, 0); assert.equal(r.saida.resultado, 'S4N_PASS'); assert.deepEqual(C.valores.filter(Boolean), [[j.CNPJ_TESTE_S3]]);
    assert.equal(C.log[0], 'BEGIN TRANSACTION READ ONLY'); assert.equal(C.log.at(-1), 'ROLLBACK');
    assert.ok(j.s4nOk([{...linha, situacao:'CANCELADA_FIM_PERIODO'}], {empresas:1, assinaturas:0}), 'cancelada no fim do período também prova o fluxo');
    for (const ruim of [{situacao:'TESTE'}, {confirmadas:2}, {contratacao:{...linha.contratacao, final:19700, desconto:0}}, {fundador:{estado:'RESERVADA', beneficioLongo:true}},
        {fundador:null}, {eventos_processados:0}, {com_provedor:false}, {contratacao:{...linha.contratacao, plano:'PREMIUM'}}])
        assert.equal(j.s4nOk([{...linha, ...ruim}], {empresas:1, assinaturas:0}), false, JSON.stringify(ruim));
    assert.equal(j.s4nOk([linha, linha], {empresas:1, assinaturas:0}), false); assert.equal(j.s4nOk([linha], {empresas:1, assinaturas:1}), false);
});

test('valores do S4-N batem com o catálogo (Essencial R$ 197, Fundador 40%) e a fonte não escreve no banco nem no Asaas', () => {
    const planos = fs.readFileSync(path.join(root, 'lib/assinatura/planos-comerciais.ts'), 'utf8');
    assert.equal(Number(planos.match(/essencial: \{[^}]*mensalCentavos: (\d+)/)[1]), j.S4N.regular);
    assert.match(planos, /fundador: \{ descontoPercentual: 40, meses: 12, vagas: 20 \}/); assert.equal(j.S4N.final * 100, j.S4N.regular * 60);
    const fonte = fs.readFileSync(path.join(__dirname, 's3s4-staging-20261020.cjs'), 'utf8');
    assert.doesNotMatch(fonte, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|DROP |TRUNCATE)\b/);
    assert.doesNotMatch(fonte, /method:\s*'(POST|PUT|DELETE)'/); assert.equal((fonte.match(/method:'GET'/g) || []).length, 1);
    assert.doesNotMatch(fonte, /writeFileSync|rmSync|rmdirSync|renameSync|appendFileSync|copyFileSync/);
    assert.equal((fonte.match(/fs\.(linkSync|unlinkSync)\(/g) || []).length, 2, 'só o arquivamento mexe no disco');
    assert.doesNotMatch(fonte, /console\.(log|error)\([^)]*env/);
    for (const f of j.DEPLOY_S4) assert.ok(fs.existsSync(path.join(root, f)), f);
});

test('CNPJ do S3-R é inédito no repositório (fora desta ferramenta e do roteiro novo)', () => {
    const permitidos = new Set(['s3s4-staging-20261020.cjs', 's3s4-staging-20261020.test.cjs', 'bloco-shell-s3s4-staging-20261020.cjs',
        'bloco-shell-s3s4-staging-20261020.test.cjs', 'HOMOLOGACAO_S3_S4_STAGING_20261020.md']);
    const arquivos = d => fs.readdirSync(d, {withFileTypes:true}).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : arquivos(path.join(d, e.name)))
        : /\.(c?js|ts|tsx|md|json|sql|txt)$/.test(e.name) && !permitidos.has(e.name) ? [path.join(d, e.name)] : []);
    const texto = ['scripts', 'docs', 'database', 'lib'].flatMap(d => arquivos(path.join(root, d))).map(a => fs.readFileSync(a, 'utf8')).join('\n');
    for (const v of ['71394825000186', '71.394.825/0001-86']) assert.ok(!texto.includes(v), v);
});

test('CLI: --plano sem ambiente; fora do Render recusa com código 1 e motivo seguro', () => {
    const cli = path.join(__dirname, 's3s4-staging-20261020.cjs');
    const env = {...process.env}; for (const k of Object.keys(env)) if (/^(RENDER|DATABASE_|KIDMAIS_|ASAAS_|EMAIL_|RESEND_)/.test(k)) delete env[k];
    const p = spawnSync(process.execPath, [cli, '--plano'], {encoding:'utf8', env});
    assert.equal(p.status, 0); assert.equal(JSON.parse(p.stdout).resultado, 'PLANO');
    const r = spawnSync(process.execPath, [cli, '--pre'], {encoding:'utf8', env});
    assert.equal(r.status, 1); assert.deepEqual(JSON.parse(r.stdout), {resultado:'RECUSADO', motivo:'FORA_DO_RENDER'});
    const u = spawnSync(process.execPath, [cli, '--apagar-tudo'], {encoding:'utf8', env});
    assert.equal(u.status, 1); assert.equal(JSON.parse(u.stdout).motivo, 'USO_RECUSADO');
    assert.equal(j.motivoSeguro(new Error('connect ECONNREFUSED 10.0.0.1:5432')), 'ERRO_INESPERADO');
    assert.equal(j.motivoSeguro(Object.assign(new Error('x y'), {code:'ECONNREFUSED'})), 'ERRO_INESPERADO_ECONNREFUSED');
});
