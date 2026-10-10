/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do aplicador de 076/077: sem banco nem rede (cliente PostgreSQL simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('./migrations-076-077-staging.cjs');
const {SQL_IDENTIDADE} = require('./conexao-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const envStaging = (ssl = 'false') => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox', DATABASE_SSL:ssl,
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
/** Estado gravado em staging pela tentativa de 10/10 que parou na conferência de TLS (antes de qualquer etapa). */
const TENTATIVA_1_STAGING = {inicio:'2026-10-10T09:33:00.000Z', etapas:[], falha:{etapa:'CONEXAO', mensagem:'TLS\n\nfalse !== true\n'}, concluido:false};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hml-076-077-'));
const gravar = (dir, nome, conteudo) => fs.writeFileSync(path.join(dir, nome), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
const ler = (dir, nome) => JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8'));

/** Cliente simulado: responde identidade/schema, registra o que foi enviado e falha onde pedido. */
function clienteFalso({identidade = {db:'kidmais_staging_1z91', tls:false, servidor_privado:true}, schema = {m076:false, m077:false}, falharEm = null, conectar} = {}) {
    const enviados = []; const estado = {...schema};
    const sqls = new Map(m.ETAPAS.map(([nome, arquivo, hash]) => [m.lerRevisado(raiz, arquivo, hash), nome]));
    class Cliente {
        async connect() { if (conectar) await conectar(); }
        async query(sql) {
            if (sql === SQL_IDENTIDADE) return {rows:[identidade]};
            if (sql === m.SQL_SCHEMA) return {rows:[{...estado}]};
            if (sql === 'ROLLBACK') { enviados.push('ROLLBACK'); return {rows:[]}; }
            const nome = sqls.get(sql) ?? 'OUTRO';
            enviados.push(nome);
            if (nome === falharEm) throw Error('falha simulada em ' + nome);
            if (nome === 'migration 076') estado.m076 = true;
            if (nome === 'migration 077') estado.m077 = true;
            return [{rows:[]}, {rows:[{aprovado:true}]}];
        }
        async end() {}
    }
    return {Cliente, enviados};
}
const executar = (dir, extra = {}) => m.executar({env:envStaging(), dir, raiz, disco:() => {}, ...extra});

test('arquivos executados = arquivos revisados (hash fixado), na ordem precheck → migration → postcheck', () => {
    assert.deepEqual(m.ETAPAS.map(e => e[0]), ['precheck 076', 'migration 076', 'postcheck 076', 'precheck 077', 'migration 077', 'postcheck 077']);
    for (const [, arquivo, hash] of m.ETAPAS) assert.ok(m.lerRevisado(raiz, arquivo, hash).length > 100, arquivo);
    assert.throws(() => m.lerRevisado(raiz, m.ETAPAS[1][1], '0'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('só staging; produção, banco local e sslmode na URL são recusados; sem flag não executa', () => {
    for (const ssl of ['false', 'true']) assert.ok(m.alvo(envStaging(ssl)).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=disable'}])
        assert.throws(() => m.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.equal(m.autorizado([]), false); assert.equal(m.autorizado(['--aplicar-076-077-autorizado', '--x']), false);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migrations-076-077-staging.cjs')], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_O3/);
});

test('plano conforme o schema real: aplica só o ausente e sempre confere o postcheck', () => {
    assert.equal(m.planoEtapas({m076:false, m077:false}).length, 6);
    assert.deepEqual(m.planoEtapas({m076:true, m077:false}), ['postcheck 076', 'precheck 077', 'migration 077', 'postcheck 077']);
    assert.deepEqual(m.planoEtapas({m076:true, m077:true}), ['postcheck 076', 'postcheck 077']);
    assert.throws(() => m.planoEtapas({m076:null, m077:false}), /SCHEMA_ILEGIVEL/);
    assert.throws(() => m.planoEtapas(undefined), /SCHEMA_ILEGIVEL/);
});

test('retomada após a tentativa de staging que parou no TLS: preserva a evidência e grava a tentativa 2', async () => {
    const dir = tmp();
    try {
        gravar(dir, 'migrations-076-077.json', TENTATIVA_1_STAGING);
        const original = fs.readFileSync(path.join(dir, 'migrations-076-077.json'));
        const {Cliente, enviados} = clienteFalso();
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'PASS'); assert.equal(s.arquivo, 'migrations-076-077.tentativa-2.json');
        assert.deepEqual(enviados, m.ETAPAS.map(e => e[0]));
        assert.deepEqual(fs.readFileSync(path.join(dir, 'migrations-076-077.json')), original, 'tentativa 1 intocada');
        const r = ler(dir, s.arquivo);
        assert.equal(r.concluido, true); assert.deepEqual(r.conexao, {banco:'kidmais_staging_1z91', tls:false, redePrivada:true});
        assert.deepEqual(r.anteriores, [{arquivo:'migrations-076-077.json', semEfeito:true, concluido:false, etapas:0}]);
        assert.deepEqual(r.schemaAntes, {m076:false, m077:false}); assert.deepEqual(r.schemaDepois, {m076:true, m077:true});
        // Depois de concluída, nenhuma nova tentativa é aceita.
        await assert.rejects(executar(dir, {Client:clienteFalso().Cliente}), /TENTATIVA_ANTERIOR_REVISAR migrations-076-077.tentativa-2.json/);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('076 já aplicada (estado parcial): não reaplica; confere e aplica só a 077', async () => {
    const dir = tmp();
    try {
        const {Cliente, enviados} = clienteFalso({schema:{m076:true, m077:false}});
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'PASS'); assert.equal(s.arquivo, 'migrations-076-077.json');
        assert.deepEqual(enviados, ['postcheck 076', 'precheck 077', 'migration 077', 'postcheck 077']);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('tentativa anterior com efeito desconhecido, concluída, em andamento ou ilegível: para sem conectar nem gravar', async () => {
    const casos = [
        {...TENTATIVA_1_STAGING, etapas:[{nome:'precheck 076', inicio:'x'}], falha:{etapa:'precheck 076'}},
        {...TENTATIVA_1_STAGING, etapas:[{nome:'migration 076', inicio:'x'}], falha:undefined, concluido:undefined},
        {...TENTATIVA_1_STAGING, concluido:true},
        {inicio:'x', etapas:[]},
        {...TENTATIVA_1_STAGING, falha:{etapa:'migration 077'}},
        '{"incompleto":',
    ];
    for (const anterior of casos) {
        const dir = tmp();
        try {
            gravar(dir, 'migrations-076-077.json', anterior);
            let conectou = false;
            const {Cliente} = clienteFalso({conectar:() => { conectou = true; }});
            await assert.rejects(executar(dir, {Client:Cliente}), /TENTATIVA_ANTERIOR_REVISAR migrations-076-077.json/, JSON.stringify(anterior));
            assert.equal(conectou, false); assert.deepEqual(fs.readdirSync(dir), ['migrations-076-077.json']);
        } finally { fs.rmSync(dir, {recursive:true, force:true}); }
    }
});

test('colisão: segunda execução simultânea para na tentativa em andamento da primeira', async () => {
    const dir = tmp();
    try {
        let liberar; const espera = new Promise(ok => { liberar = ok; });
        const primeira = executar(dir, {Client:clienteFalso({conectar:() => espera}).Cliente});
        await assert.rejects(executar(dir, {Client:clienteFalso().Cliente}), /TENTATIVA_ANTERIOR_REVISAR migrations-076-077.json/);
        liberar();
        assert.equal((await primeira).resultado, 'PASS');
        assert.deepEqual(fs.readdirSync(dir), ['migrations-076-077.json']);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('falha na migration: ROLLBACK, erro original preservado e próxima tentativa bloqueada', async () => {
    const dir = tmp();
    try {
        const {Cliente, enviados} = clienteFalso({falharEm:'migration 077'});
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'FALHA'); assert.deepEqual(s.falha, {etapa:'migration 077', mensagem:'falha simulada em migration 077'});
        assert.deepEqual(enviados.slice(-2), ['migration 077', 'ROLLBACK']);
        assert.equal(ler(dir, s.arquivo).concluido, false);
        await assert.rejects(executar(dir, {Client:clienteFalso().Cliente}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('identidade divergente na nova tentativa: para em CONEXAO sem enviar nenhuma etapa', async () => {
    for (const identidade of [{db:'kidmais_staging_1z91', tls:true, servidor_privado:false}, {db:'kidmais_staging_1z91', tls:false, servidor_privado:false},
        {db:'kidmais_production', tls:false, servidor_privado:true}]) {
        const dir = tmp();
        try {
            const {Cliente, enviados} = clienteFalso({identidade});
            const s = await executar(dir, {Client:Cliente});
            assert.equal(s.resultado, 'FALHA'); assert.equal(s.falha.etapa, 'CONEXAO');
            assert.deepEqual(enviados, ['ROLLBACK']); assert.deepEqual(ler(dir, s.arquivo).etapas, []);
        } finally { fs.rmSync(dir, {recursive:true, force:true}); }
    }
});

test('sem disco persistente: recusa antes de criar diretório ou conectar', async () => {
    const dir = path.join(tmp(), 'sem-disco');
    try {
        let conectou = false;
        const {Cliente} = clienteFalso({conectar:() => { conectou = true; }});
        await assert.rejects(m.executar({env:envStaging(), dir, raiz, Client:Cliente}), /DISCO_PERSISTENTE_AUSENTE/);
        assert.equal(fs.existsSync(dir), false); assert.equal(conectou, false);
    } finally { fs.rmSync(path.dirname(dir), {recursive:true, force:true}); }
});
