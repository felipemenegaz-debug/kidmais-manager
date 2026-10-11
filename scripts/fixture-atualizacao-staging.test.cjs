/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline das fixtures de /b/<código> da atualização de staging: sem rede, sem banco. Cliente, serviços e fetch simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const h = require('./fixture-atualizacao-staging.cjs');

const fonte = fs.readFileSync(__dirname + '/fixture-atualizacao-staging.cjs', 'utf8');
const KIDMAIS = '7e990a2b-e64b-4630-9aae-4646fe936ede';
const env = (extra = {}) => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox',
    DATABASE_SSL:'false', COTACAO_PUBLICA_POR_EMPRESA:'true',
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91', ...extra});
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-atualizacao-'));
const sem = () => {};

/** Cliente simulado: identidade do staging, schema 078, fixtures livres (ou não), preservação estável. */
function cliente({ocupado = false, preservacao = () => ['{"x":1}']} = {}) {
    const log = [];
    class Client {
        async connect() { log.push('CONNECT'); }
        async end() { log.push('END'); }
        async query(t, v) {
            log.push({t:t.replace(/\s+/g, ' ').trim(), v});
            if (t.includes('current_database()')) return {rows:[{db:'kidmais_staging_1z91', tls:false, servidor_privado:true}]};
            if (t.includes('to_regclass')) return {rows:[{ok:true}]};
            if (t.includes('AS ocupado')) return {rows:[{ocupado}]};
            if (t.includes('AS linha')) return {rows:preservacao().map(linha => ({linha}))};
            if (t.includes('FROM configuracao_agenda')) return {rows:[{id:'h-almoco'}, {id:'h-noite'}]};
            if (t.includes('INSERT INTO pacotes')) return {rows:[{id:'pacote-' + v[0].slice(0, 4)}]};
            if (t.includes('SELECT codigo, status FROM empresas')) return {rows:h.FIXTURES.map(f => ({codigo:f.codigo, status:'DESATIVADA'}))};
            return {rows:[], rowCount:1};
        }
    }
    return {Client, log, sql:() => log.filter(x => typeof x === 'object').map(x => x.t)};
}
function servicos({falhaEm} = {}) {
    const chamadas = [];
    const s = {};
    let n = 0;
    for (const nome of ['gravarFaixasPacote', 'definirDisponibilidadePacoteAdmin', 'criarCategoriaBuffet', 'criarItemBuffet', 'definirCategoriasPacoteAdmin'])
        s[nome] = async (...args) => { chamadas.push([nome, args]); if (nome === falhaEm) throw new Error('SERVICO_SIMULADO'); return nome === 'criarCategoriaBuffet' ? 'cat-' + (++n) : null; };
    s.criarHashSenha = async (senha) => { assert.ok(senha.length >= 8); return 'hash-sintetico'; };
    return {s, chamadas};
}
/** API pública simulada coerente com as fixtures (ou com uma divergência injetada). */
function publico({diasB} = {}) {
    return async (url) => {
        const u = new URL(url);
        const f = h.FIXTURES.find(x => x.codigo === u.searchParams.get('empresa'));
        const dias = f.chave === 'B' && diasB ? diasB : f.dias;
        const j = u.pathname.endsWith('/pacotes')
            ? {pacotes:[{codigo:'POCKET', precoMinimo:Number(f.valor), disponibilidade:dias.flatMap(dia => ['almoco', 'noite'].map(horario => ({dia, horario, estado:'DISPONIVEL'})))}]}
            : {categorias:f.composicao.map(([codigo, , , itens]) => ({codigo, itens:itens.map(nome => ({nome}))}))};
        return {status:200, json:async () => j};
    };
}

test('sem uma única flag reconhecida não executa nada (nem carrega banco ou rede)', () => {
    assert.equal(h.modo([]), null);
    assert.equal(h.modo([h.FLAG_CRIAR, h.FLAG_ENCERRAR]), null);
    assert.equal(h.modo(['--outra']), null);
    assert.equal(h.modo([h.FLAG_CRIAR]), 'CRIAR');
    assert.equal(h.modo([h.FLAG_ENCERRAR]), 'ENCERRAR');
    const r = spawnSync(process.execPath, [__dirname + '/fixture-atualizacao-staging.cjs'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_FIXTURES/);
});

test('trava de alvo: só o web staging e o banco kidmais_staging_1z91', () => {
    assert.ok(h.alvo(env()).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {ASAAS_AMBIENTE:'producao'}, {RENDER:undefined},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'},
        {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'}])
        assert.throws(() => h.alvo(env(v)), undefined, JSON.stringify(v));
});

test('fixtures: duas empresas sintéticas fixas, marcadas como homologação, distintas da Kidmais, com disponibilidade e catálogo próprios', () => {
    assert.equal(h.FIXTURES.length, 2);
    const ids = h.FIXTURES.flatMap(f => [f.empresa, f.usuario]);
    assert.equal(new Set(ids).size, 4); assert.ok(!ids.includes(KIDMAIS));
    for (const f of h.FIXTURES) {
        assert.match(f.codigo, /^hml-[a-z0-9-]+$/); assert.ok(f.nome.startsWith('TESTE '));
        assert.match(f.email, /@example\.invalid$/);
        assert.ok(f.dias.every(d => Number.isInteger(d) && d >= 1 && d <= 7));
        for (const [codigo, , escolhas, itens] of f.composicao) { assert.match(codigo, /^[A-Z][A-Z0-9_]{1,79}$/); assert.ok(escolhas >= 1 && escolhas <= itens.length); }
    }
    const [a, b] = h.FIXTURES;
    assert.notEqual(a.valor, b.valor);
    assert.ok(a.dias.includes(6) && !b.dias.includes(6), 'sábado distingue A de B na tela');
    assert.ok(a.composicao.some(([c]) => c === 'SALGADOS') && b.composicao.some(([c]) => c === 'SALGADOS'), 'mesmo código de categoria nas duas (078)');
    assert.deepEqual(h.PRESERVADAS.slice(-2).map(([t]) => t), ['buffet_categorias', 'buffet_itens']);
});

test('criar: PASS — escreve só nas fixtures, usa os serviços de domínio e confere preservação e endereço público', async () => {
    const d = dir(); const c = cliente(); const {s, chamadas} = servicos();
    const r = await h.criar({env:env(), Client:c.Client, servicos:s, dir:d, disco:sem, fetcher:publico()});
    assert.equal(r.resultado, 'PASS', JSON.stringify(r));
    assert.equal(r.preservacao, 'IGUAL'); assert.equal(r.encerramento, null);
    assert.deepEqual(Object.keys(r.publico), ['A', 'B']);
    assert.deepEqual(r.publico.B.dias, [1, 2, 3, 4, 5]);
    const estado = JSON.parse(fs.readFileSync(path.join(d, h.ARQUIVO), 'utf8'));
    assert.equal(estado.aprovado, true); assert.ok(h.comprovadas(estado));
    assert.ok(!JSON.stringify(estado).includes('hash-sintetico'), 'nada de senha/hash no estado');
    const sql = c.sql();
    assert.ok(!sql.some(t => /\b(DELETE|DROP|TRUNCATE|ALTER)\b/i.test(t)));
    const ids = new Set(h.FIXTURES.flatMap(f => [f.empresa, f.usuario]));
    for (const x of c.log.filter(x => typeof x === 'object' && /^(INSERT|UPDATE)/.test(x.t)))
        assert.ok(x.v.some(v => ids.has(v)), 'escrita fora das fixtures: ' + x.t);
    // Serviços: preço, dias × 2 períodos, categorias e itens, composição — sempre com a empresa da fixture.
    for (const f of h.FIXTURES) {
        const faixa = chamadas.find(([n, a]) => n === 'gravarFaixasPacote' && a[1] === f.empresa);
        assert.equal(faixa[1][3][0].valor, f.valor); assert.equal(faixa[1][5].empresaId, f.empresa);
        const disp = chamadas.find(([n, a]) => n === 'definirDisponibilidadePacoteAdmin' && a[3].empresaId === f.empresa);
        assert.equal(disp[1][2].disponibilidade.length, f.dias.length * 2);
        assert.equal(chamadas.filter(([n, a]) => n === 'criarItemBuffet' && a[1] === f.empresa).length, f.composicao.flatMap(([, , , i]) => i).length);
    }
    assert.equal(chamadas.filter(([n]) => n === 'definirCategoriasPacoteAdmin').length, 2);
});

test('criar: recusa repetir a rodada (estado existente) sem conectar', async () => {
    const d = dir(); fs.writeFileSync(path.join(d, h.ARQUIVO), '{}');
    const c = cliente();
    await assert.rejects(h.criar({env:env(), Client:c.Client, servicos:servicos().s, dir:d, disco:sem, fetcher:publico()}), /RODADA_EXISTENTE/);
    assert.deepEqual(c.log, []);
});

test('criar: fixture preexistente → FALHA antes de qualquer escrita; nada a desativar', async () => {
    const d = dir(); const c = cliente({ocupado:true});
    const r = await h.criar({env:env(), Client:c.Client, servicos:servicos().s, dir:d, disco:sem, fetcher:publico()});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /FIXTURE_PREEXISTENTE_S1/);
    assert.equal(r.encerramento, 'NADA_CRIADO_PELA_RODADA');
    assert.ok(!c.sql().some(t => /^(INSERT|UPDATE)/.test(t)));
});

test('criar: falha de serviço depois da intenção → desativa as fixtures (nenhuma fica ATIVA parcial)', async () => {
    const d = dir(); const c = cliente();
    const r = await h.criar({env:env(), Client:c.Client, servicos:servicos({falhaEm:'criarItemBuffet'}).s, dir:d, disco:sem, fetcher:publico()});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, 'CATALOGO'); assert.equal(r.encerramento, 'DESATIVADAS');
    const sql = c.sql();
    assert.ok(sql.includes('ROLLBACK'));
    assert.ok(sql.some(t => t.startsWith("UPDATE empresas SET status='DESATIVADA'")));
});

test('criar: endereço público divergente (dias de B) → FALHA e desativação', async () => {
    const d = dir(); const c = cliente();
    const r = await h.criar({env:env(), Client:c.Client, servicos:servicos().s, dir:d, disco:sem, fetcher:publico({diasB:[1, 2, 3, 4, 5, 6]})});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /DIAS_B/); assert.equal(r.encerramento, 'DESATIVADAS');
});

test('criar: preservação divergente (outra empresa mudou) → FALHA e desativação', async () => {
    let n = 0; const d = dir();
    const c = cliente({preservacao:() => [++n > h.PRESERVADAS.length ? '{"x":2}' : '{"x":1}']});
    const r = await h.criar({env:env(), Client:c.Client, servicos:servicos().s, dir:d, disco:sem, fetcher:publico()});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /PRESERVACAO_/); assert.equal(r.encerramento, 'DESATIVADAS');
});

test('criar: chave da cotação desligada → não chama a rede e registra', async () => {
    const d = dir(); const c = cliente();
    const r = await h.criar({env:env({COTACAO_PUBLICA_POR_EMPRESA:undefined}), Client:c.Client, servicos:servicos().s, dir:d, disco:sem,
        fetcher:async () => { throw new Error('REDE_NAO_ESPERADA'); }});
    assert.equal(r.resultado, 'PASS'); assert.equal(r.publico, 'CHAVE_COTACAO_DESLIGADA');
});

test('encerrar: só desativa (UPDATE com id + marcador); sem estado comprovado não escreve', async () => {
    const d = dir();
    await assert.rejects(h.encerrar({env:env(), Client:cliente().Client, dir:d, disco:sem}), /SEM_FIXTURES_PARA_ENCERRAR/);
    fs.writeFileSync(path.join(d, h.ARQUIVO), JSON.stringify({rodada:h.RODADA, precheck:{livres:true}}));
    let c = cliente();
    let r = await h.encerrar({env:env(), Client:c.Client, dir:d, disco:sem});
    assert.equal(r.encerramento, 'NADA_CRIADO_PELA_RODADA'); assert.ok(!c.sql().some(t => t.startsWith('UPDATE')));
    fs.writeFileSync(path.join(d, h.ARQUIVO), JSON.stringify({rodada:h.RODADA, precheck:{livres:true}, intencao:true}));
    c = cliente();
    r = await h.encerrar({env:env(), Client:c.Client, dir:d, disco:sem});
    assert.equal(r.resultado, 'ENCERRADO'); assert.equal(r.encerramento, 'DESATIVADAS');
    const escritas = c.log.filter(x => typeof x === 'object' && /^(INSERT|UPDATE|DELETE)/.test(x.t));
    assert.equal(escritas.length, 3);
    for (const x of escritas) { assert.match(x.t, /^UPDATE /); assert.ok(x.v.length >= 2, 'id + marcador'); }
    fs.writeFileSync(path.join(d, h.ARQUIVO), JSON.stringify({rodada:'outra', intencao:true, precheck:{livres:true}}));
    await assert.rejects(h.encerrar({env:env(), Client:cliente().Client, dir:d, disco:sem}), /ESTADO_DE_OUTRA_RODADA/);
});

test('código-fonte: sem DELETE/DROP/TRUNCATE, sem SQL a partir de entrada, sem imprimir senha ou URL do banco', () => {
    assert.doesNotMatch(fonte, /\b(DELETE FROM|DROP |TRUNCATE)\b/);
    assert.doesNotMatch(fonte, /console\.(log|error)\([^)]*(DATABASE_URL|senha|connectionString)/i);
    assert.match(fonte, /require\.main === module/);
    assert.match(fonte, /SET statement_timeout/);
});
