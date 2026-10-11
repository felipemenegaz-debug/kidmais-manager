/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do aplicador da 078 em staging: sem banco nem rede (cliente PostgreSQL simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const m = require('./migration-078-staging.cjs');
const {SQL_IDENTIDADE} = require('./conexao-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const envStaging = (ssl = 'false') => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox', DATABASE_SSL:ssl,
    DATABASE_URL:'postgresql://usuario:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hml-078-'));
const gravar = (dir, nome, conteudo) => fs.writeFileSync(path.join(dir, nome), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
const ler = (dir, nome) => JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8'));
const SEM_EFEITO = {inicio:'2026-10-11T10:00:00.000Z', etapas:[], falha:{etapa:'CONEXAO', mensagem:'TLS'}, concluido:false};

/** Cliente simulado: responde identidade/schema/catálogo, registra o que foi enviado e falha onde pedido. */
function clienteFalso({identidade = {db:'kidmais_staging_1z91', tls:false, servidor_privado:true}, m078 = false, falharEm = null, conectar} = {}) {
    const enviados = []; const estado = {m078};
    const sqls = new Map(m.ETAPAS.map(([nome, arquivo, hash]) => [m.lerRevisado(raiz, arquivo, hash), nome]));
    class Cliente {
        async connect() { if (conectar) await conectar(); }
        async query(sql) {
            if (sql === SQL_IDENTIDADE) return {rows:[identidade]};
            if (sql === m.SQL_SCHEMA) return {rows:[{...estado}]};
            if (sql === m.SQL_CATALOGO) return {rows:[{categorias:9, itens:70}]};
            if (sql === m.SQL_DONOS) return {rows:[{donos:2, sem_dono:0}]};
            if (sql === 'ROLLBACK') { enviados.push('ROLLBACK'); return {rows:[]}; }
            const nome = sqls.get(sql) ?? 'OUTRO';
            enviados.push(nome);
            if (nome === falharEm) throw Error('falha simulada em ' + nome);
            if (nome === 'migration 078') estado.m078 = true;
            if (nome === 'precheck 078') return [{rows:[]}, {rows:[{banco:'kidmais_staging_1z91', categorias:7}]}, {rows:[{empresa_que_recebe_copia:'hml-x', categorias_usadas:1}]}, {rows:[]}];
            return [{rows:[]}, {rows:[{aprovado:true}]}];
        }
        async end() {}
    }
    return {Cliente, enviados};
}
const executar = (dir, extra = {}) => m.executar({env:envStaging(), dir, raiz, disco:() => {}, ...extra});

test('arquivos executados = arquivos revisados (hash fixado), na ordem precheck → migration → postcheck', () => {
    assert.deepEqual(m.ETAPAS.map(e => e[0]), ['precheck 078', 'migration 078', 'postcheck 078']);
    for (const [, arquivo, hash] of m.ETAPAS) assert.ok(m.lerRevisado(raiz, arquivo, hash).length > 100, arquivo);
    assert.throws(() => m.lerRevisado(raiz, m.ETAPAS[1][1], '0'.repeat(64)), /ARQUIVO_DIVERGENTE/);
    // A migration revisada é a da candidata (guarda “já aplicada” primeiro; troca da unicidade antes das cópias).
    const sql = m.lerRevisado(raiz, m.ETAPAS[1][1], m.ETAPAS[1][2]);
    assert.ok(sql.indexOf("'078 já aplicada.'") < sql.indexOf("'078 exige a 050"));
    assert.ok(sql.indexOf('CREATE UNIQUE INDEX buffet_categorias_empresa_codigo_uk') < sql.indexOf('INSERT INTO buffet_categorias (id, empresa_id'));
});

test('só staging; produção, banco local e sslmode na URL são recusados; sem flag não executa', () => {
    for (const ssl of ['false', 'true']) assert.ok(m.alvo(envStaging(ssl)).connectionString.includes('kidmais_staging_1z91'));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'},
        {DATABASE_URL:'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'}, {DATABASE_URL:'postgresql://u:s@localhost:5432/kidmais_manager'},
        {DATABASE_URL:'postgresql://u:s@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=disable'}])
        assert.throws(() => m.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
    assert.equal(m.autorizado([]), false); assert.equal(m.autorizado(['--aplicar-078-autorizado', '--x']), false);
    assert.equal(m.autorizado(['--aplicar-076-077-autorizado']), false, 'flag de outra operação não serve');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migration-078-staging.cjs')], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_078/);
});

test('plano conforme o schema real: ausente = 3 etapas; já aplicada = só o postcheck', () => {
    assert.deepEqual(m.planoEtapas({m078:false}), ['precheck 078', 'migration 078', 'postcheck 078']);
    assert.deepEqual(m.planoEtapas({m078:true}), ['postcheck 078']);
    assert.throws(() => m.planoEtapas({m078:null}), /SCHEMA_ILEGIVEL/);
    assert.throws(() => m.planoEtapas(undefined), /SCHEMA_ILEGIVEL/);
});

test('aplicação: grava a tentativa, as empresas que recebem cópia (códigos) e o catálogo antes/depois; nova tentativa bloqueada', async () => {
    const dir = tmp();
    try {
        const {Cliente, enviados} = clienteFalso();
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'PASS'); assert.equal(s.arquivo, 'migration-078.json');
        assert.deepEqual(enviados, ['precheck 078', 'migration 078', 'postcheck 078']);
        const r = ler(dir, s.arquivo);
        assert.equal(r.concluido, true); assert.deepEqual(r.conexao, {banco:'kidmais_staging_1z91', tls:false, redePrivada:true});
        assert.deepEqual(r.schemaAntes, {m078:false}); assert.deepEqual(r.schemaDepois, {m078:true});
        assert.deepEqual(r.etapas[0].info.find(l => 'empresa_que_recebe_copia' in l), {empresa_que_recebe_copia:'hml-x', categorias_usadas:1});
        assert.deepEqual(r.catalogoDepois, {categorias:9, itens:70, donos:2, sem_dono:0});
        await assert.rejects(executar(dir, {Client:clienteFalso().Cliente}), /TENTATIVA_ANTERIOR_REVISAR migration-078.json/);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('já aplicada: não reaplica (nem o precheck, que recusaria); só confere o postcheck', async () => {
    const dir = tmp();
    try {
        const {Cliente, enviados} = clienteFalso({m078:true});
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'PASS'); assert.deepEqual(enviados, ['postcheck 078']);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('retomada só após tentativa sem efeito (parou na conexão); preserva a anterior e grava a tentativa 2', async () => {
    const dir = tmp();
    try {
        gravar(dir, 'migration-078.json', SEM_EFEITO);
        const original = fs.readFileSync(path.join(dir, 'migration-078.json'));
        const s = await executar(dir, {Client:clienteFalso().Cliente});
        assert.equal(s.resultado, 'PASS'); assert.equal(s.arquivo, 'migration-078.tentativa-2.json');
        assert.deepEqual(fs.readFileSync(path.join(dir, 'migration-078.json')), original, 'tentativa 1 intocada');
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('tentativa anterior com efeito desconhecido, concluída, em andamento ou ilegível: para sem conectar nem gravar', async () => {
    const casos = [
        {...SEM_EFEITO, etapas:[{nome:'precheck 078', inicio:'x'}], falha:{etapa:'precheck 078'}},
        {...SEM_EFEITO, etapas:[{nome:'migration 078', inicio:'x'}], falha:undefined, concluido:undefined},
        {...SEM_EFEITO, concluido:true},
        {inicio:'x', etapas:[]},
        '{"incompleto":',
    ];
    for (const anterior of casos) {
        const dir = tmp();
        try {
            gravar(dir, 'migration-078.json', anterior);
            let conectou = false;
            const {Cliente} = clienteFalso({conectar:() => { conectou = true; }});
            await assert.rejects(executar(dir, {Client:Cliente}), /TENTATIVA_ANTERIOR_REVISAR migration-078.json/, JSON.stringify(anterior));
            assert.equal(conectou, false); assert.deepEqual(fs.readdirSync(dir), ['migration-078.json']);
        } finally { fs.rmSync(dir, {recursive:true, force:true}); }
    }
});

test('falha na migration: ROLLBACK, erro original preservado e próxima tentativa bloqueada', async () => {
    const dir = tmp();
    try {
        const {Cliente, enviados} = clienteFalso({falharEm:'migration 078'});
        const s = await executar(dir, {Client:Cliente});
        assert.equal(s.resultado, 'FALHA'); assert.deepEqual(s.falha, {etapa:'migration 078', mensagem:'falha simulada em migration 078'});
        assert.deepEqual(enviados.slice(-2), ['migration 078', 'ROLLBACK']);
        await assert.rejects(executar(dir, {Client:clienteFalso().Cliente}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('identidade divergente: para em CONEXAO sem enviar nenhuma etapa; sem disco: recusa antes de conectar', async () => {
    for (const identidade of [{db:'kidmais_staging_1z91', tls:true, servidor_privado:false}, {db:'kidmais_production', tls:false, servidor_privado:true}]) {
        const dir = tmp();
        try {
            const {Cliente, enviados} = clienteFalso({identidade});
            const s = await executar(dir, {Client:Cliente});
            assert.equal(s.resultado, 'FALHA'); assert.equal(s.falha.etapa, 'CONEXAO'); assert.deepEqual(enviados, ['ROLLBACK']);
        } finally { fs.rmSync(dir, {recursive:true, force:true}); }
    }
    const dir = path.join(tmp(), 'sem-disco');
    try {
        let conectou = false;
        await assert.rejects(m.executar({env:envStaging(), dir, raiz, Client:clienteFalso({conectar:() => { conectou = true; }}).Cliente}), /DISCO_PERSISTENTE_AUSENTE/);
        assert.equal(fs.existsSync(dir), false); assert.equal(conectou, false);
    } finally { fs.rmSync(path.dirname(dir), {recursive:true, force:true}); }
});
