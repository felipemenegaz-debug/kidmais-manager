/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador genérico de PRODUÇÃO (120, 121, 110, 111 e 115) com cliente simulado que só CONFIRMA no COMMIT e descarta no
// ROLLBACK: lista fechada com os hashes dos 3 SQL de cada id, sentinelas tiradas do precheck, molduras, estado
// (ausente/presente/parcial e a 115 idempotente), trava de alvo e identidade de produção, conferência só leitura, UMA
// transação precheck → corpo → postcheck → COMMIT, falha de check (RAISE e linha `aprovado`), situação do COMMIT
// (NAO_COMMITADA / CONFIRMADO / DESFEITA_PELO_SERVIDOR / INDETERMINADO), marcador por id, disco cheio e códigos 0/1/2/3.
// Sem rede nem banco. PENDENTE (não existe aqui): prova em PostgreSQL real descartável da cadeia 120 → 121 → 110 → 111 → 115.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const g = require('./migration-generico-production.cjs');
const prd = require('./conexao-production.cjs');
const molde = require('./migration-100-production.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = Object.freeze({db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true});
const CONEXAO = Object.freeze({banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
const BACKUP = 'dump 2026-11-12T03:00Z sha 1234abcd PITR';
const lf = a => fs.readFileSync(path.join(raiz, a), 'utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(s).digest('hex');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code, severity: 'ERROR'});
const erroNode = (code, syscall = 'write') => Object.assign(new Error(code + ' simulado'), {code, errno: -32, syscall});
const arquivo = (id, etapa) => g.MIGRATIONS[id].arquivos.find(a => a[0] === etapa)[1];
const linhaEstado = (id, criados, removidos = false) => Object.fromEntries([...g.MIGRATIONS[id].criados.map((_, i) => ['c' + i, typeof criados === 'function' ? criados(i) : criados]),
  ...g.MIGRATIONS[id].removidos.map((_, i) => ['r' + i, removidos])]);

/**
 * Cliente simulado transacional. O corpo da migration deixa o estado PENDENTE; 'COMMIT' confirma; 'ROLLBACK' descarta.
 * Opções: situacao inicial ('ausente' | 'presente' | linha explícita), falharEm (trecho → `erro`), falharCommit ({erro} ou
 * {rollback: true}), aprovado (valor da coluna `aprovado` que o check devolve), naoCompleta (o COMMIT não deixa os objetos).
 */
function clienteFalso(id, {situacao = 'ausente', identidade = ID_PROD, falharEm, erro, falharCommit, aprovado, naoCompleta} = {}) {
  const corpos = g.carregar(raiz, id);
  const log = []; let ro = false, emTransacao = false, pendente = false, commits = 0;
  const presente = () => linhaEstado(id, true, false);
  const atual = {linha: situacao === 'ausente' ? linhaEstado(id, false, g.MIGRATIONS[id].removidos.length > 0) : situacao === 'presente' ? presente() : situacao};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      if (sql === 'BEGIN') emTransacao = true;
      log.push({sql, ro, emTransacao});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('P0001', 'falha simulada em ' + falharEm);
      if (sql === 'ROLLBACK') { ro = false; emTransacao = false; pendente = false; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++;
        if (falharCommit?.rollback) { emTransacao = false; pendente = false; return {rows: [], command: 'ROLLBACK'}; }
        if (falharCommit?.erro) throw falharCommit.erro;
        if (pendente && !naoCompleta) atual.linha = presente();
        emTransacao = false; pendente = false; return {rows: [], command: 'COMMIT'};
      }
      if (sql === prd.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === g.sqlEstado(id)) return {rows: [{...atual.linha}]};
      if (sql === corpos.migration) { assert.ok(emTransacao && !ro, 'migration só na transação de escrita'); pendente = true; return [{rows: [], command: 'SET'}, {rows: [], command: 'CREATE'}]; }
      if (sql === corpos.precheck || sql === corpos.postcheck) {
        // 120 e 121 terminam com SELECT … true AS aprovado (consulta de várias instruções = lista de resultados).
        return aprovado === undefined ? [{rows: [], command: 'DO'}] : [{rows: [], command: 'DO'}, {rows: [{banco: 'kidmais_production', aprovado}], command: 'SELECT'}];
      }
      for (const [, arq] of g.MIGRATIONS[id].arquivos) assert.notEqual(sql, lf(arq), 'o arquivo com a própria moldura nunca é enviado');
      return {rows: [], command: 'SET'};
    }
  };
  C.log = log; C.atual = atual; C.corpos = corpos; C.commits = () => commits;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'generico-prod-'));
const semDisco = () => {};
const conferir = id => ['--conferir', id];
const aplicar = id => ['--aplicar-autorizado', id, '--backup', BACKUP];
const marcador = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, g.marcadorDe(id)), 'utf8'));

test('lista fechada: só 120, 121, 110, 111 e 115, na ordem do inventário; hash LF fixado dos 3 SQL de cada uma; nenhum down', async () => {
  assert.deepEqual([...g.IDS], ['120', '121', '110', '111', '115']);
  assert.deepEqual(Object.keys(g.MIGRATIONS).sort(), [...g.IDS].sort());
  for (const id of g.IDS) {
    const d = g.MIGRATIONS[id];
    assert.deepEqual(d.arquivos.map(a => a[0]), ['precheck', 'migration', 'postcheck'], id);
    for (const [etapa, arq, hash] of d.arquivos) {
      assert.equal(sha(lf(arq)), hash, arq);
      assert.match(arq, new RegExp(`^database/(checks|migrations)/\\d{8}_${id}_`), arq); assert.ok(!arq.includes('rollback') && !arq.includes('_down'), arq);
      assert.equal(arq.startsWith('database/migrations/'), etapa === 'migration');
    }
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.arquivos) && Object.isFrozen(d.criados), id);
  }
  // Na mesma ordem relativa do inventário aprovado (approvedFiles).
  const {approvedFiles} = await import('./production/check-migrations.mjs');
  const doInventario = approvedFiles.map(f => f.split('_')[1]).filter(id => g.IDS.includes(id));
  assert.deepEqual(doInventario, [...g.IDS]);
  for (const id of g.IDS) assert.ok(approvedFiles.includes(path.basename(arquivo(id, 'migration'))), id);
  // Nenhuma delas tem aplicador próprio (se ganhar um, sai do genérico).
  for (const id of g.IDS) assert.deepEqual(fs.readdirSync(__dirname).filter(n => n.startsWith(`migration-${id}`)), [], id);
  for (const fora of ['118', '112', '098', '099', '105', '116', '0', '', 'constructor', '__proto__', '120 ', undefined, 120])
    assert.throws(() => g.planoEtapas(fora, {situacao: 'ausente'}), /MIGRATION_FORA_DA_LISTA/, String(fora));
});

test('sentinelas do estado: cada nome vem do precheck da própria migration; estado ausente / presente / parcial; 115 idempotente', () => {
  for (const id of g.IDS) {
    const pre = lf(arquivo(id, 'precheck')), d = g.MIGRATIONS[id];
    for (const [nome] of [...d.criados, ...d.removidos]) for (const parte of nome.split('.')) assert.ok(pre.includes(`'${parte}'`) || pre.includes(`'public.${parte}'`), `${id}: ${nome} não aparece no precheck`);
    const sql = g.sqlEstado(id);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/);
    assert.match(sql, new RegExp(`^/\\* estado-${id} \\*/ SELECT `));
    assert.equal(g.lerEstado(id, linhaEstado(id, false)).situacao, 'ausente');
    assert.equal(g.lerEstado(id, linhaEstado(id, true)).situacao, 'presente');
    assert.throws(() => g.lerEstado(id, {}), /ESTADO_ILEGIVEL/); assert.throws(() => g.lerEstado(id, {...linhaEstado(id, true), c0: 'sim'}), /ESTADO_ILEGIVEL/);
    assert.deepEqual(g.planoEtapas(id, g.lerEstado(id, linhaEstado(id, false))), ['precheck', 'migration', 'postcheck']);
    assert.deepEqual(g.planoEtapas(id, g.lerEstado(id, linhaEstado(id, true))), ['postcheck']);
  }
  for (const id of ['120', '121', '110', '111']) {
    const s = g.lerEstado(id, linhaEstado(id, i => i === 0));
    assert.equal(s.situacao, 'parcial'); assert.equal(s.divergencias.length, g.MIGRATIONS[id].criados.length - 1);
    assert.throws(() => g.planoEtapas(id, s), new RegExp(`APLICACAO_PARCIAL_${id} falta `));
  }
  // 115: índice novo ausente = ausente (com ou sem o da 054); novo presente e o da 054 ainda presente = intermediário
  // aplicável (a subida é idempotente e o precheck decide); novo presente sem o da 054 = presente.
  assert.equal(g.MIGRATIONS['115'].idempotente, true);
  for (const id of ['120', '121', '110', '111']) assert.notEqual(g.MIGRATIONS[id].idempotente, true);
  assert.equal(g.lerEstado('115', {c0: false, r0: true}).situacao, 'ausente'); assert.equal(g.lerEstado('115', {c0: false, r0: false}).situacao, 'ausente');
  const meio = g.lerEstado('115', {c0: true, r0: true});
  assert.equal(meio.situacao, 'parcial'); assert.deepEqual(meio.divergencias, ['sobra fechamentos_054_empresa_idx']);
  assert.deepEqual(g.planoEtapas('115', meio), ['precheck', 'migration', 'postcheck']);
  assert.equal(g.lerEstado('115', {c0: true, r0: false}).situacao, 'presente');
  const m115 = lf(arquivo('115', 'migration'));
  assert.match(m115, /^CREATE INDEX IF NOT EXISTS fechamentos_115_empresa_data_idx/m); assert.match(m115, /^DROP INDEX IF EXISTS public\.fechamentos_054_empresa_idx;$/m);
});

test('molduras: migration sem o BEGIN e sem o COMMIT do arquivo; checks sem a própria moldura; formas inesperadas recusam; falha sinalizada por RAISE', () => {
  for (const id of g.IDS) {
    const m = lf(arquivo(id, 'migration')), c = g.corpoMigration(m, 'm');
    assert.doesNotMatch(c, /^(BEGIN;|COMMIT;)$/m, id); assert.ok(m.endsWith(c + 'COMMIT;\n'), id + ': só a moldura sai');
    assert.ok(c.startsWith("SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\nSET LOCAL search_path = public, pg_catalog;\n"), id + ': prazos e search_path do próprio SQL');
    assert.equal(m.slice(0, m.indexOf('BEGIN;\n')).split('\n').filter(l => l !== '' && !l.startsWith('--')).length, 0, id + ': só comentários antes do BEGIN');
    for (const etapa of ['precheck', 'postcheck']) {
      const s = lf(arquivo(id, etapa)), corpo = g.corpoCheck(s, etapa);
      assert.doesNotMatch(corpo, /^(BEGIN TRANSACTION READ ONLY;|ROLLBACK;|COMMIT;|BEGIN;)$/m, `${id} ${etapa}`);
      assert.match(corpo, /^DO \$\$/m, `${id} ${etapa}: bloco DO`); assert.match(corpo, /RAISE EXCEPTION/, `${id} ${etapa}: falha por RAISE`);
      assert.ok(s.includes(corpo), `${id} ${etapa}: o corpo é um trecho literal do arquivo`);
    }
    assert.deepEqual(g.carregar(raiz, id), {precheck: g.corpoCheck(lf(arquivo(id, 'precheck')), 'p'), migration: c, postcheck: g.corpoCheck(lf(arquivo(id, 'postcheck')), 'p')});
  }
  // Postchecks sem moldura (110, 111 e 115) vão inteiros; os com moldura (120 e 121) terminam na linha `aprovado`.
  for (const id of ['110', '111', '115']) assert.equal(g.corpoCheck(lf(arquivo(id, 'postcheck')), 'p'), lf(arquivo(id, 'postcheck')));
  for (const id of ['120', '121']) for (const etapa of ['precheck', 'postcheck']) assert.match(g.corpoCheck(lf(arquivo(id, etapa)), 'p'), /true AS aprovado;\n$/);
  const m = lf(arquivo('120', 'migration'));
  for (const ruim of [m + 'COMMIT;\n', m.replace('BEGIN;\n', ''), m.replace('BEGIN;\n', 'BEGIN;\nBEGIN;\n'), m + '-- x\n', 'SELECT 1;\n' + m, m.replace('COMMIT;\n', 'ROLLBACK;\nCOMMIT;\n'), m.replace('BEGIN;\n', 'BEGIN;\nSAVEPOINT a;\n')])
    assert.throws(() => g.corpoMigration(ruim, 'x'), /TRANSACAO_INESPERADA/);
  const p = lf(arquivo('120', 'precheck'));
  for (const ruim of [p.replace('ROLLBACK;\n', 'COMMIT;\n'), p.replace('ROLLBACK;\n', ''), p + 'SELECT 1;\n', p.replace('BEGIN TRANSACTION READ ONLY;\n', 'BEGIN;\n'), 'SELECT 1;\n' + p, p.replace('ROLLBACK;\n', 'ROLLBACK;\nROLLBACK;\n')])
    assert.throws(() => g.corpoCheck(ruim, 'x'), /MOLDURA_INESPERADA/);
  // Linha `aprovado`: só true passa; resultado único ou lista; sem a coluna vale a ausência de exceção.
  assert.doesNotThrow(() => g.exigirAprovado([{rows: []}, {rows: [{aprovado: true}]}], 'x')); assert.doesNotThrow(() => g.exigirAprovado({rows: [{n: 1}]}, 'x'));
  assert.doesNotThrow(() => g.exigirAprovado(undefined, 'x'));
  for (const v of [false, null, 't', 1]) assert.throws(() => g.exigirAprovado([{rows: []}, {rows: [{aprovado: v}]}], 'postcheck 120'), /CHECK_REPROVADO postcheck 120/);
});

test('alvo e identidade de produção iguais aos do molde, com a rigidez dos adaptadores recentes; argumentos; plano sem conexão', async () => {
  assert.deepEqual(g.ALVO, molde.ALVO); assert.equal(g.SQL_IDENTIDADE, molde.SQL_IDENTIDADE);
  assert.equal(g.DIR, '/opt/render/project/src/data/promocao-generico-producao');
  const o = g.alvo(ENV_PROD, '120');
  assert.equal(o.application_name, 'kidmais-migration-120-production'); assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.ok(!Object.hasOwn(o, 'connectionString') && !JSON.stringify(o).includes('SENHA_FALSA')); assert.equal(o.password, 'SENHA_FALSA');
  for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/], [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/],
    [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: URL_PROD + '#'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/],
    [{DATABASE_URL: URL_PROD.replace('usuario', 'usuario%00options')}, /CREDENCIAL_COM_CONTROLE/], ...g.PG_HERDADAS_RECUSADAS.map(n => [{[n]: 'x'}, new RegExp('AMBIENTE_PG_RECUSADO ' + n)])])
    assert.throws(() => g.alvo({...ENV_PROD, ...delta}, '120'), erro, JSON.stringify(delta));
  assert.throws(() => g.alvo(ENV_STG, '120'), /SERVICO_RECUSADO/); assert.throws(() => g.alvo(ENV_PROD, '118'), /MIGRATION_FORA_DA_LISTA/);
  assert.deepEqual(g.identidade(ID_PROD), CONEXAO); assert.throws(() => g.identidade({...ID_PROD, tls: false}), /SEM_TLS/);
  assert.throws(() => g.exigirDisco(path.join(os.tmpdir(), 'nao-existe-generico-prod')), /DISCO_PERSISTENTE_AUSENTE/);
  assert.deepEqual(g.modo([]), {modo: 'plano'}); assert.deepEqual(g.modo(conferir('110')), {modo: 'conferir', id: '110'});
  assert.deepEqual(g.modo(aplicar('115')), {modo: 'aplicar', id: '115', backup: BACKUP});
  for (const [argv, erro] of [[['--conferir'], /ARGUMENTOS_RECUSADOS/], [['--conferir', '118'], /MIGRATION_FORA_DA_LISTA/], [['--conferir', '120', '121'], /ARGUMENTOS_RECUSADOS/],
    [['--aplicar-autorizado', '120'], /BACKUP_OBRIGATORIO/], [['--aplicar-autorizado', '120', '--backup', 'x;rm'], /BACKUP_INVALIDO/], [['--aplicar-autorizado', '099', '--backup', BACKUP], /MIGRATION_FORA_DA_LISTA/],
    [['--conferir-120'], /ARGUMENTOS_RECUSADOS/], [['--aplicar-autorizado', '--backup', BACKUP, '120'], /BACKUP_OBRIGATORIO/]])
    assert.throws(() => g.modo(argv), erro, JSON.stringify(argv));
  const {codigo, saida} = await g.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production'); assert.deepEqual(saida.alvo, g.ALVO); assert.equal(saida.registro, g.DIR);
  assert.deepEqual(saida.migrations.map(m => m.id), [...g.IDS]);
  for (const m of saida.migrations) { assert.deepEqual(m.arquivos.map(a => a.sha256), g.MIGRATIONS[m.id].arquivos.map(a => a[2])); assert.equal(m.marcador, `migration-${m.id}.json`); }
  assert.ok(saida.nuncaExecuta.includes('down de qualquer migration') && !JSON.stringify(saida.migrations).includes('rollback'));
  assert.ok(!saida.ordem.some(x => /staging/.test(x)) && saida.ordem.some(x => /backup restaurável de production .*PITR/.test(x)));
});

for (const id of g.IDS) {
  const comAprovado = ['120', '121'].includes(id) ? true : undefined;

  test(`${id}: conferência só leitura, nada no disco: ausente = precheck e PRONTA_PARA_APLICAR; presente = postcheck e JA_APLICADA; identidade errada = FALHA`, async () => {
    const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
    fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
    try {
      const P = clienteFalso(id, {aprovado: comAprovado});
      const x = await g.principal(conferir(id), ENV_PROD, {Client: P});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'PRONTA_PARA_APLICAR'); assert.deepEqual(x.saida.conexao, CONEXAO);
      assert.deepEqual(x.saida.checks, {precheck: 'PASS'}); assert.deepEqual(x.saida.plano, ['precheck', 'migration', 'postcheck']);
      assert.ok(P.log.every(l => l.ro || l.sql === 'ROLLBACK'), 'tudo em READ ONLY');
      assert.ok(P.log.some(l => l.sql === P.corpos.precheck) && !P.log.some(l => [P.corpos.migration, P.corpos.postcheck, 'COMMIT', 'BEGIN'].includes(l.sql)));
      const J = clienteFalso(id, {situacao: 'presente', aprovado: comAprovado});
      const j = await g.principal(conferir(id), ENV_PROD, {Client: J});
      assert.equal(j.codigo, 0, JSON.stringify(j.saida)); assert.equal(j.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(j.saida.checks, {postcheck: 'PASS'});
      assert.ok(J.log.every(l => l.ro || l.sql === 'ROLLBACK') && !J.log.some(l => [J.corpos.migration, J.corpos.precheck, 'COMMIT'].includes(l.sql)));
    } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
    assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
    for (const identidade of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}, {...ID_PROD, tls_versao: 'TLSv1.1'}, {...ID_PROD, servidor_privado: false}]) {
      const C = clienteFalso(id, {identidade});
      const x = await g.principal(conferir(id), ENV_PROD, {Client: C});
      assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
      assert.ok(!C.log.some(l => l.sql === g.sqlEstado(id)), 'estado não lido');
    }
    await assert.rejects(g.principal(conferir(id), ENV_STG, {Client: clienteFalso(id)}), /SERVICO_RECUSADO/);
  });

  test(`${id}: aplicação = UMA transação (precheck → corpo sem BEGIN/COMMIT → postcheck → COMMIT), depois estado e postcheck em READ ONLY; marcador próprio`, async () => {
    const dir = tmp();
    try {
      const C = clienteFalso(id, {aprovado: comAprovado});
      const x = await g.principal(aplicar(id), ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS');
      assert.deepEqual(x.saida.commits, {[id]: 'CONFIRMADO'}); assert.deepEqual(x.saida.commitadas, [id]); assert.deepEqual(x.saida.etapas, [`transacao ${id}`, `postcheck ${id}`]);
      const q = C.log.map(l => l.sql), i = q.indexOf('BEGIN'), f = q.indexOf('COMMIT');
      assert.ok(C.log.slice(0, i).every(l => l.ro || l.sql === 'ROLLBACK'), 'antes da transação, tudo em READ ONLY');
      assert.deepEqual(q.slice(i, f + 1), ['BEGIN', "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '60s'", 'SET LOCAL search_path = public, pg_catalog',
        C.corpos.precheck, C.corpos.migration, C.corpos.postcheck, 'COMMIT']);
      assert.equal(q.filter(s => s === 'BEGIN').length, 1); assert.equal(q.filter(s => s === 'COMMIT').length, 1);
      const depois = C.log.slice(f + 1);
      assert.ok(depois.every(l => l.ro || l.sql === 'ROLLBACK') && depois.some(l => l.sql === g.sqlEstado(id)) && depois.some(l => l.sql === C.corpos.postcheck), 'estado e postcheck depois, em READ ONLY');
      const m = marcador(dir, id);
      assert.equal(path.basename(x.saida.marcador), `migration-${id}.json`);
      assert.equal(m.ambiente, 'production'); assert.equal(m.id, id); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.deepEqual(m.conexao, CONEXAO);
      assert.deepEqual(m.etapas[0].antesDoCommit, {precheck: 'PASS', migration: 'ENVIADA', postcheck: 'PASS'}); assert.equal(m.etapas[0].commit, 'CONFIRMADO');
      assert.equal(m.estadoAntes.situacao, 'ausente'); assert.equal(m.estadoDepois.situacao, 'presente');
      assert.ok(!fs.readFileSync(x.saida.marcador, 'utf8').includes('SENHA_FALSA'));
      const n = C.log.length;
      await assert.rejects(g.principal(aplicar(id), ENV_PROD, {Client: C, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
      assert.equal(C.log.length, n, 'segunda tentativa não conecta');
      // O marcador é por id: outra migration da lista usa outro arquivo na mesma pasta.
      const outro = g.IDS.find(o => o !== id);
      assert.equal((await g.principal(aplicar(outro), ENV_PROD, {Client: clienteFalso(outro, {aprovado: true}), dir, disco: semDisco})).codigo, 0);
      assert.deepEqual(fs.readdirSync(dir).sort(), [g.marcadorDe(id), g.marcadorDe(outro)].sort());
      // Retomada só pelo marcador renomeado, que fica registrado.
      fs.renameSync(path.join(dir, g.marcadorDe(id)), path.join(dir, `migration-${id}.20261112T0300.json`));
      const r = await g.principal(aplicar(id), ENV_PROD, {Client: clienteFalso(id, {situacao: 'presente', aprovado: comAprovado}), dir, disco: semDisco});
      assert.equal(r.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(marcador(dir, id).tentativasAnteriores, [`migration-${id}.20261112T0300.json`]);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
}

test('já aplicada: só o postcheck em READ ONLY, nenhuma transação de escrita; parcial recusa (código 3 / FALHA sem escrita)', async () => {
  const dir = tmp();
  try {
    const J = clienteFalso('121', {situacao: 'presente', aprovado: true});
    const x = await g.principal(aplicar('121'), ENV_PROD, {Client: J, dir, disco: semDisco});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(x.saida.commits, {}); assert.deepEqual(x.saida.etapas, ['postcheck 121']);
    assert.ok(!J.log.some(l => ['BEGIN', 'COMMIT', J.corpos.migration, J.corpos.precheck].includes(l.sql)) && J.log.every(l => l.ro || l.sql === 'ROLLBACK'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const parcial = linhaEstado('110', i => i < 2);
  const P = clienteFalso('110', {situacao: parcial});
  const c = await g.principal(conferir('110'), ENV_PROD, {Client: P});
  assert.equal(c.codigo, 3); assert.equal(c.saida.resultado, 'RECUSARIA'); assert.match(c.saida.motivo, /^APLICACAO_PARCIAL_110 falta satisfacao_entregas, falta kidmais110_envio_guarda\(\), falta marketing_automacao_regras\.canais$/);
  assert.ok(!P.log.some(l => l.sql === P.corpos.precheck || l.sql === P.corpos.postcheck));
  const dir2 = tmp();
  try {
    const A = clienteFalso('110', {situacao: parcial});
    const x = await g.principal(aplicar('110'), ENV_PROD, {Client: A, dir: dir2, disco: semDisco});
    assert.equal(x.codigo, 2); assert.match(x.saida.falha.mensagem, /APLICACAO_PARCIAL_110/); assert.deepEqual(x.saida.commits, {}); assert.deepEqual(x.saida.commitadas, []);
    assert.ok(!A.log.some(l => ['BEGIN', 'COMMIT', A.corpos.migration].includes(l.sql)));
    assert.equal(marcador(dir2, '110').situacao, 'FALHA');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  // 115 no estado intermediário (os dois índices): aplicável; a transação roda inteira.
  const dir3 = tmp();
  try {
    const M = clienteFalso('115', {situacao: {c0: true, r0: true}});
    const x = await g.principal(aplicar('115'), ENV_PROD, {Client: M, dir: dir3, disco: semDisco});
    assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(M.commits(), 1);
    assert.equal((await g.principal(conferir('115'), ENV_PROD, {Client: clienteFalso('115', {situacao: {c0: true, r0: true}})})).saida.resultado, 'PRONTA_PARA_APLICAR');
  } finally { fs.rmSync(dir3, {recursive: true, force: true}); }
});

test('falha antes do COMMIT (RAISE do precheck, corpo, RAISE do postcheck, linha aprovado ≠ true): NAO_COMMITADA, COMMIT nunca enviado, ROLLBACK, código 2', async () => {
  const c120 = g.carregar(raiz, '120');
  for (const [nome, opcoes, re, fase] of [
    ['precheck levanta', {falharEm: c120.precheck, erro: erroPg('P0001', '120 precheck: 052 ausente'), aprovado: true}, /120 precheck: 052 ausente/, 'precheck'],
    ['corpo falha (lock_timeout)', {falharEm: c120.migration, erro: erroPg('55P03', 'canceling statement due to lock timeout'), aprovado: true}, /lock timeout/, 'migration'],
    ['corpo sem privilégio', {falharEm: c120.migration, erro: erroPg('42501', 'must be owner of table financeiro_saidas'), aprovado: true}, /must be owner/, 'migration'],
    ['postcheck levanta', {falharEm: c120.postcheck, erro: erroPg('P0001', '120 postcheck: índices ausentes'), aprovado: true}, /120 postcheck: índices ausentes/, 'postcheck'],
    ['linha aprovado falsa', {aprovado: false}, /CHECK_REPROVADO precheck 120/, 'precheck']]) {
    const dir = tmp();
    try {
      const C = clienteFalso('120', opcoes);
      const x = await g.principal(aplicar('120'), ENV_PROD, {Client: C, dir, disco: semDisco});
      assert.equal(x.codigo, 2, nome); assert.equal(x.saida.resultado, 'FALHA', nome); assert.match(x.saida.falha.mensagem, re, nome);
      assert.deepEqual(x.saida.commits, {120: 'NAO_COMMITADA'}, nome); assert.deepEqual(x.saida.commitadas, [], nome); assert.equal(C.commits(), 0, nome);
      assert.equal(C.log.at(-1).sql, 'ROLLBACK', nome); assert.equal(C.atual.linha.c0, false, nome + ': nada aplicado');
      assert.match(x.saida.reconciliar, /--conferir 120/, nome);
      const m = marcador(dir, '120');
      assert.equal(m.situacao, 'FALHA', nome); assert.equal(m.etapas[0].faseDaFalha, fase, nome); assert.equal(x.saida.marcadorAtualizado, true, nome);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Na conferência, o check que levanta vira RECUSARIA (código 3) com o motivo do servidor.
  const C = clienteFalso('120', {falharEm: c120.precheck, erro: erroPg('P0001', '120 precheck: 120 já (parcialmente) presente')});
  const x = await g.principal(conferir('120'), ENV_PROD, {Client: C});
  assert.equal(x.codigo, 3); assert.deepEqual(x.saida.checks, {precheck: 'FALHOU'}); assert.match(x.saida.motivo, /120 já \(parcialmente\) presente/);
  const R = await g.principal(conferir('121'), ENV_PROD, {Client: clienteFalso('121', {situacao: 'presente', aprovado: false})});
  assert.equal(R.codigo, 3); assert.match(R.saida.motivo, /CHECK_REPROVADO postcheck 121/);
});

test('falha NO COMMIT: situação por SQLSTATE de resposta; transporte e 40003 = INDETERMINADO; resposta ROLLBACK = DESFEITA; depois do COMMIT, falha = CONFIRMADO', async () => {
  for (const [falharCommit, esperado] of [
    [{erro: erroPg('23514')}, 'DESFEITA_PELO_SERVIDOR'], [{erro: erroPg('40001')}, 'DESFEITA_PELO_SERVIDOR'], [{erro: erroPg('40P01')}, 'DESFEITA_PELO_SERVIDOR'],
    [{erro: erroPg('40003')}, 'INDETERMINADO'], [{erro: erroPg('08006')}, 'INDETERMINADO'], [{erro: erroPg('57P01')}, 'INDETERMINADO'], [{erro: erroPg('58000')}, 'INDETERMINADO'], [{erro: erroPg('XX000')}, 'INDETERMINADO'],
    [{erro: erroNode('EPIPE')}, 'INDETERMINADO'], [{erro: erroNode('ECONNRESET', 'read')}, 'INDETERMINADO'], [{erro: new Error('Connection terminated unexpectedly')}, 'INDETERMINADO'],
    [{rollback: true}, 'DESFEITA_PELO_SERVIDOR']]) {
    const dir = tmp();
    try {
      const x = await g.principal(aplicar('111'), ENV_PROD, {Client: clienteFalso('111', {falharCommit}), dir, disco: semDisco});
      assert.equal(x.codigo, 2); assert.deepEqual(x.saida.commits, {111: esperado}, JSON.stringify(falharCommit.erro?.code ?? falharCommit.erro?.message ?? 'rollback'));
      assert.deepEqual(x.saida.commitadas, []); assert.equal(marcador(dir, '111').commits['111'], esperado);
      assert.equal(marcador(dir, '111').etapas[0].faseDaFalha, 'commit');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // COMMIT confirmado, mas o estado relido não fica presente: FALHA com CONFIRMADO (nunca esconde o COMMIT).
  const dir = tmp();
  try {
    const x = await g.principal(aplicar('111'), ENV_PROD, {Client: clienteFalso('111', {naoCompleta: true}), dir, disco: semDisco});
    assert.equal(x.codigo, 2); assert.match(x.saida.falha.mensagem, /ESTADO_DEPOIS_111/); assert.deepEqual(x.saida.commits, {111: 'CONFIRMADO'}); assert.deepEqual(x.saida.commitadas, ['111']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('antes de conectar: backup obrigatório, disco exigido, SQL divergente e id fora da lista recusam (código 1) sem marcador; disco cheio depois = FALHA com o COMMIT conhecido', async () => {
  let conectou = false;
  const Espia = class extends clienteFalso('120') { async connect() { conectou = true; } };
  const d0 = tmp();
  await assert.rejects(g.executar({env: ENV_PROD, id: '120', backup: BACKUP, dir: d0, Client: Espia}), /DISCO_PERSISTENTE_AUSENTE/);
  await assert.rejects(g.executar({env: ENV_PROD, id: '120', backup: '', dir: d0, Client: Espia, disco: semDisco}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(g.executar({env: ENV_PROD, id: '118', backup: BACKUP, dir: d0, Client: Espia, disco: semDisco}), /MIGRATION_FORA_DA_LISTA/);
  await assert.rejects(g.executar({env: ENV_STG, id: '120', backup: BACKUP, dir: d0, Client: Espia, disco: semDisco}), /SERVICO_RECUSADO/);
  // Árvore com um dos 3 SQL alterado: recusa pelo hash antes do marcador (e a conferência nem conecta com sucesso).
  for (const etapa of ['precheck', 'migration', 'postcheck']) {
    const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'raiz-generico-'));
    try {
      for (const [, arq] of g.MIGRATIONS['120'].arquivos) { fs.mkdirSync(path.join(outra, path.dirname(arq)), {recursive: true}); fs.writeFileSync(path.join(outra, arq), lf(arq)); }
      fs.appendFileSync(path.join(outra, arquivo('120', etapa)), '-- x\n');
      await assert.rejects(g.executar({env: ENV_PROD, id: '120', backup: BACKUP, dir: d0, raiz: outra, Client: Espia, disco: semDisco}), /ARQUIVO_DIVERGENTE/);
      const c = await g.conferir({env: ENV_PROD, id: '120', raiz: outra, Client: clienteFalso('120')});
      assert.equal(c.resultado, 'FALHA'); assert.match(c.mensagem, /ARQUIVO_DIVERGENTE/);
    } finally { fs.rmSync(outra, {recursive: true, force: true}); }
  }
  assert.equal(conectou, false); assert.deepEqual(fs.readdirSync(d0), [], 'sem marcador');
  fs.rmSync(d0, {recursive: true, force: true});
  // ENOSPC na gravação CONCLUIDA: código 2, COMMIT CONFIRMADO na saída, aviso, e o marcador antigo impede a repetição.
  const dir = tmp(), C = clienteFalso('120', {aprovado: true}), orig = fs.writeFileSync, alvoMarcador = path.join(dir, g.marcadorDe('120'));
  fs.writeFileSync = (f, dados, ...a) => {
    if (String(f) === alvoMarcador && ['CONCLUIDA', 'FALHA'].includes(JSON.parse(String(dados)).situacao)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'});
    return orig(f, dados, ...a);
  };
  let x;
  try { x = await g.principal(aplicar('120'), ENV_PROD, {Client: C, dir, disco: semDisco}); } finally { fs.writeFileSync = orig; }
  try {
    assert.equal(x.codigo, 2, JSON.stringify(x.saida)); assert.deepEqual(x.saida.commits, {120: 'CONFIRMADO'}); assert.deepEqual(x.saida.commitadas, ['120']);
    assert.equal(x.saida.marcadorAtualizado, false); assert.match(x.saida.erroMarcador, /ENOSPC/); assert.match(x.saida.aviso, /^MARCADOR_DESATUALIZADO/);
    assert.equal(marcador(dir, '120').situacao, 'EM_ANDAMENTO');
    await assert.rejects(g.principal(aplicar('120'), ENV_PROD, {Client: C, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(C.commits(), 1, 'a migration não roda de novo');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
