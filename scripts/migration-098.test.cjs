/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 098 (salão combinado; staging) com cliente simulado: trava de alvo, identidade, hashes, retrato somente
// leitura, plano por estado e retrato, privilégios (dono), conferência só leitura (sem gravar no disco), backup
// obrigatório, marcador anti-repetição com tentativas anteriores, COMMIT CONFIRMADO/DESFEITA/INDETERMINADO, prova de
// preservação e códigos de saída. Sem rede nem banco (a execução real fica em lib/agenda/aplicador-098.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-098-comum.cjs');
const stg = require('./migration-098-staging.cjs');
const ev108 = require('./migration-108-evidencias.cjs');

const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BASE = {d094: true, pode_criar: true, dono_098: true, papel_trocado: true};
const OBJ = Object.keys(comum.OBJETOS);
const AUSENTE = {...BASE, ...Object.fromEntries(OBJ.map(k => [k, false]))};
const COMPLETA = {...BASE, ...Object.fromEntries(OBJ.map(k => [k, true]))};
const tiposDe = e => Object.fromEntries(Object.entries(comum.RETRATOS[e].tipos).map(([k, [n, d]]) => [k, [n, d]]));
const R094 = {hash: comum.RETRATOS['094'].hash, linhas: 900, tipos: tiposDe('094')};
const R098 = {hash: comum.RETRATOS['098'].hash, linhas: 950, tipos: tiposDe('098')};
const RDIV = {hash: 'a'.repeat(64), linhas: 901, tipos: {...tiposDe('094'), F: [1, 'ffffffffffff']}};
const PRESERVA = {saloes: 3, resumo_saloes: 's1'};
const INFO = {saloes_ativos: 3, ocupacoes_futuras_com_salao: 2};
const CORTE = '2026-10-23T18:00:00.000000Z';
/** Nenhuma evidência da 107/108 (linha de SQL_EVIDENCIA_108); a 098 histórica completa também é "sem 108". */
const SEM_108 = Object.freeze({marcador_108: false, reparos_107: false, colunas_combinado: false, corpo_conflito_108: false, corpos_108: 0, funcoes_098_108: 0});

/** Cliente simulado: sequências de estados e retratos; registra cada SQL, se rodou em READ ONLY e o search_path local. */
function clienteFalso({estados = [AUSENTE, COMPLETA], retratos = [R094, R098], identidade = ID_STG, falharEm, erro, preservacao, anteriores = [0], invisiveis = [0],
  evidencias = SEM_108} = {}) {
  const log = []; let i = 0, j = 0, k = 0, v = 0, ro = false, caminho = null, papel = null, tempo = null;
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      if (sql.startsWith('SET LOCAL search_path')) caminho = sql.slice('SET LOCAL search_path = '.length);
      if (sql === 'SET LOCAL ROLE NONE') papel = 'sessao';
      const t = /^SET LOCAL statement_timeout = '(\d+s)'$/.exec(sql); if (t) tempo = t[1];
      log.push({sql, ro, caminho, papel, tempo});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') { ro = false; caminho = null; papel = null; tempo = null; }
      if (falharEm && sql.includes(falharEm)) throw erro ?? new Error('falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [estados[Math.min(i++, estados.length - 1)]]};
      if (sql === ev108.SQL_EVIDENCIA_108) return {rows: [{...evidencias}]};
      if (sql.startsWith('/* retrato-098 */')) return {rows: [retratos[Math.min(j++, retratos.length - 1)]]};
      if (sql === comum.SQL_CORTE) return {rows: [{corte: CORTE}]};
      if (sql === comum.SQL_ANTERIORES(CORTE)) return {rows: [{n: anteriores[Math.min(k++, anteriores.length - 1)], invisiveis: invisiveis[Math.min(v++, invisiveis.length - 1)]}]};
      if (sql.startsWith('/* preservacao-098 */')) {
        assert.ok(sql.includes(`'${CORTE}'::timestamptz`), 'mesmo corte antes e depois');
        return {rows: [{...PRESERVA, ...(sql.includes('combinados_ate_corte') ? {combinados_ate_corte: 0} : {}), ...(preservacao ? preservacao() : {})}]};
      }
      if (sql.includes('AS saloes_ativos')) return {rows: [{...INFO, ...(sql.includes('AS combinados') ? {combinados: 0} : {})}]};
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-098-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));
const MIGRATION = 'CREATE FUNCTION public.kidmais098_hoje()';

test('hashes fixados conferem com o retrato e os SQL da árvore (CRLF normalizado); arquivo divergente é recusado', () => {
  const raiz = path.resolve(__dirname, '..');
  for (const [, arquivo, hash] of [comum.RETRATO, ...comum.ETAPAS]) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
    assert.equal(comum.lerRevisado(raiz, arquivo, hash).includes('\r'), false);
  }
  assert.throws(() => comum.lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['precheck 098', 'migration 098', 'postcheck 098', 'integridade 098']);
});

test('retratos esperados: os mesmos do gerador e dos blocos embutidos no precheck (094) e no postcheck/integridade (098)', async () => {
  const {RETRATO_094, RETRATO_098} = await import('./migration-098-retrato.mjs');
  assert.equal(comum.RETRATOS['094'].hash, RETRATO_094); assert.equal(comum.RETRATOS['098'].hash, RETRATO_098);
  const raiz = path.resolve(__dirname, '..');
  const ler = n => comum.lerRevisado(raiz, ...comum.ETAPAS.find(e => e[0] === n).slice(1));
  assert.ok(ler('precheck 098').includes(`IS DISTINCT FROM '${RETRATO_094}'`));
  for (const n of ['postcheck 098', 'integridade 098']) assert.ok(ler(n).includes(`IS DISTINCT FROM '${RETRATO_098}'`), n);
  for (const e of ['094', '098']) {
    const t = comum.RETRATOS[e].tipos;
    assert.ok(Object.keys(t).length >= 8, 'tipos por estado preenchidos ' + e);
    for (const [n, d] of Object.values(t)) { assert.ok(Number.isInteger(n) && n > 0); assert.match(d, /^[0-9a-f]{12}$/); }
  }
});

test('consulta do retrato: a expressão do arquivo revisado, entre os marcadores, só hash/contagens/md5 por tipo (sem texto)', () => {
  const raiz = path.resolve(__dirname, '..');
  const sql = comum.sqlRetrato(raiz);
  const arq = comum.lerRevisado(raiz, comum.RETRATO[1], comum.RETRATO[2]);
  const expr = arq.slice(arq.indexOf('-- @@RETRATO-INICIO'), arq.indexOf('-- @@RETRATO-FIM') + '-- @@RETRATO-FIM'.length);
  assert.ok(sql.includes(expr)); assert.ok(sql.startsWith('/* retrato-098 */'));
  assert.match(sql, /encode\(sha256\(convert_to\(r\.t, 'UTF8'\)\), 'hex'\) AS hash/);
  assert.doesNotMatch(sql.slice(0, sql.indexOf('FROM (SELECT (')), /\br\.t AS|SELECT r\.t\b|, r\.t\b/, 'o texto do retrato não sai');
  assert.equal(comum.lerRetrato(R094).estado, '094'); assert.equal(comum.lerRetrato(R098).estado, '098');
  const d = comum.lerRetrato(RDIV);
  assert.equal(d.estado, 'DIVERGENTE'); assert.deepEqual(d.tiposDivergentes['094'], ['F']); assert.ok(d.tiposDivergentes['098'].length >= 1);
  assert.throws(() => comum.lerRetrato({hash: 'x'}), /RETRATO_ILEGIVEL/);
});

test('trava de alvo de staging: serviço, ambiente, TLS como a aplicação, host, banco e URL sem query; mensagens só com o código', () => {
  assert.equal(stg.alvo(ENV_STG).ssl, undefined);
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-098-staging');
  assert.deepEqual(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_SSL: undefined}, /TLS_CONFIGURACAO_RECUSADA/], [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_production')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-dak750gae00c73fudmg0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/],
    [{DATABASE_URL: URL_STG + '?ssl=false'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]])
    assert.throws(() => stg.alvo({...ENV_STG, ...delta}), erro);
  for (const delta of [{DATABASE_URL: URL_STG + '?password=SEGREDO'}, {RENDER_SERVICE_ID: 'srv-SEGREDO'}, {DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { stg.alvo({...ENV_STG, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  assert.equal(stg.identidade(ID_STG, ENV_STG).banco, 'kidmais_staging_1z91');
  assert.throws(() => stg.identidade({...ID_STG, servidor_privado: false}, ENV_STG), /IDENTIDADE_RECUSADA/);
  assert.throws(() => stg.identidade({...ID_STG, db: 'kidmais_production'}, ENV_STG), /IDENTIDADE_RECUSADA/);
  assert.equal(stg.DIR, '/opt/render/project/src/data/saloes-combinados-098-staging');
});

test('plano por estado e retrato: ausente+094 → 4 etapas; completa+098 → só integridade; o resto recusa antes de escrever', () => {
  const e = x => comum.lerEstado(x), r = x => comum.lerRetrato(x);
  assert.deepEqual(comum.planoEtapas(e(AUSENTE), r(R094)), ['precheck 098', 'migration 098', 'postcheck 098', 'integridade 098']);
  assert.deepEqual(comum.planoEtapas(e(COMPLETA), r(R098)), ['integridade 098']);
  for (const k of OBJ) {
    const s = e({...AUSENTE, [k]: true});
    assert.equal(s.m098, 'parcial'); assert.deepEqual(s.objetosAusentes, OBJ.filter(x => x !== k));
    assert.throws(() => comum.planoEtapas(s, r(R094)), /APLICACAO_PARCIAL_098/, k);
    assert.throws(() => comum.planoEtapas(e({...COMPLETA, [k]: false}), r(R098)), /APLICACAO_PARCIAL_098/, k);
  }
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, d094: false}), r(R094)), /DEPENDENCIA_AUSENTE_093_094/);
  // Retrato: ausente exige o estado 094 exato; completa exige 098; divergente ou ausente recusa.
  for (const [s, ret] of [[AUSENTE, R098], [AUSENTE, RDIV], [COMPLETA, R094], [COMPLETA, RDIV]])
    assert.throws(() => comum.planoEtapas(e(s), r(ret)), /RETRATO_DIVERGENTE/);
  assert.throws(() => comum.planoEtapas(e(AUSENTE), undefined), /RETRATO_DIVERGENTE/);
  // Privilégios: CREATE em public e dono das tabelas/funções alteradas; já aplicada só confere.
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, pode_criar: false}), r(R094)), /SEM_PRIVILEGIO_098 CREATE/);
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, dono_098: false}), r(R094)), /SEM_PRIVILEGIO_098 DONO/);
  assert.deepEqual(comum.planoEtapas(e({...COMPLETA, pode_criar: false, dono_098: false}), r(R098)), ['integridade 098']);
  assert.throws(() => comum.lerEstado({...AUSENTE, f_hoje: 'sim'}), /ESTADO_ILEGIVEL f_hoje/);
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user,'public','CREATE'\)/);
  assert.match(comum.SQL_ESTADO, /session_user <> current_user/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, d, 'USAGE'\)/);
  assert.deepEqual([...comum.ALTERADAS], ['agenda_saloes', 'contratos']);
  assert.equal(comum.SUBSTITUIDAS.length, 3);
  for (const f of comum.SUBSTITUIDAS) assert.ok(comum.SQL_ESTADO.includes(`to_regprocedure('public.${f}')`), f);
  // 3 colunas/restrição + 10 funções + 6 gatilhos + 3 corpos substituídos.
  assert.equal(OBJ.length, 22);
});

test('prova de preservação: só contagens e md5 agregado das colunas imutáveis dos salões até o corte; combinados só com a 098', () => {
  const p = comum.SQL_PRESERVACAO(CORTE, false), q = comum.SQL_PRESERVACAO(CORTE, true);
  assert.match(p, /md5\(string_agg\(concat_ws\('\|', id, empresa_id, estabelecimento_id, criado_em\)/);
  assert.match(p, new RegExp(`FROM agenda_saloes WHERE criado_em <= '${CORTE.replace(/\./g, '\\.')}'::timestamptz`));
  assert.doesNotMatch(p, /\bnome\b|combinado/); assert.match(q, /AS combinados_ate_corte/);
  assert.throws(() => comum.SQL_PRESERVACAO('x', false), /CORTE_INVALIDO/);
});

test('modo: plano, retrato, conferência e aplicação só com --backup e registro seguro; o resto é recusado', () => {
  assert.deepEqual(comum.modo([]), {modo: 'plano'});
  assert.deepEqual(comum.modo(['--retrato-098']), {modo: 'retrato'});
  assert.deepEqual(comum.modo(['--conferir-098']), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--aplicar-098-autorizado', '--backup', 'export 2026-10-23T18:00Z id-123']), {modo: 'aplicar', backup: 'export 2026-10-23T18:00Z id-123'});
  assert.throws(() => comum.modo(['--aplicar-098-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-098-autorizado', '--backup', 'x;rm -rf /']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--aplicar-098-autorizado', '--backup', 'a$(id)bcdef']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--retrato-098', '--conferir-098']), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--aplicar-097-autorizado']), /ARGUMENTOS_RECUSADOS/);
});

/** Observa gravações no disco durante f. */
async function semGravar(f) {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try { await f(); } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'nada gravado no disco');
}

test('retrato: só leitura, search_path pg_catalog, sem gravar; 094/098 código 0, divergente código 3 com os tipos', async () => {
  await semGravar(async () => {
    const C = clienteFalso({retratos: [R094]});
    const r = await stg.retratar({env: ENV_STG, Client: C});
    assert.equal(r.resultado, 'RETRATO_094', JSON.stringify(r)); assert.equal(r.retrato.hash, R094.hash);
    assert.deepEqual(escritas(C.log), []);
    const q = C.log.find(x => x.sql.startsWith('/* retrato-098 */'));
    assert.ok(q.ro && q.caminho === 'pg_catalog', 'retrato em READ ONLY com search_path = pg_catalog');
    assert.ok(!C.log.some(x => x.sql === comum.SQL_ESTADO), 'retrato não precisa do estado');
    assert.equal((await stg.principal(['--retrato-098'], ENV_STG, {Client: clienteFalso({retratos: [R098]})})).codigo, 0);
    const d = await stg.principal(['--retrato-098'], ENV_STG, {Client: clienteFalso({retratos: [RDIV]})});
    assert.equal(d.codigo, 3); assert.equal(d.saida.resultado, 'RETRATO_DIVERGENTE'); assert.deepEqual(d.saida.retrato.tiposDivergentes['094'], ['F']);
    assert.equal((await stg.retratar({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro'}})})).resultado, 'FALHA');
  });
  await assert.rejects(stg.principal(['--retrato-098'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('conferência: toda consulta em READ ONLY, nada gravado; PRONTA (precheck), JA_APLICADA (só integridade) e RECUSARIA', async () => {
  await semGravar(async () => {
    const P = clienteFalso({estados: [AUSENTE], retratos: [R094]});
    const r = await stg.conferir({env: ENV_STG, Client: P});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r)); assert.deepEqual(r.checks, {'precheck 098': 'PASS'});
    assert.deepEqual(r.contagens, {...PRESERVA, ...INFO}); assert.equal(r.retrato.estado, '094');
    assert.deepEqual(escritas(P.log), []); assert.ok(P.log.some(x => x.ro && x.sql.includes('098 precheck OK')));
    const J = clienteFalso({estados: [COMPLETA], retratos: [R098]});
    const j = await stg.conferir({env: ENV_STG, Client: J});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(j.checks, {'integridade 098': 'PASS'}); assert.ok(!J.log.some(x => x.sql.includes('098 postcheck OK')), 'postcheck só na instalação');
    assert.deepEqual(j.contagens, {...PRESERVA, combinados_ate_corte: 0, ...INFO, combinados: 0});
    assert.deepEqual(escritas(J.log), []);
    for (const [estado, retrato, motivo] of [[{...AUSENTE, pode_criar: false}, R094, /SEM_PRIVILEGIO_098/], [AUSENTE, RDIV, /RETRATO_DIVERGENTE/],
      [{...AUSENTE, f_hoje: true}, R094, /APLICACAO_PARCIAL_098/], [{...AUSENTE, d094: false}, R094, /DEPENDENCIA_AUSENTE/]]) {
      const x = await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [estado], retratos: [retrato]})});
      assert.equal(x.resultado, 'RECUSARIA'); assert.match(x.motivo, motivo);
    }
  });
  assert.equal((await stg.principal(['--conferir-098'], ENV_STG, {Client: clienteFalso({estados: [AUSENTE], retratos: [RDIV]})})).codigo, 3);
  assert.equal((await stg.principal(['--conferir-098'], ENV_STG, {Client: clienteFalso({estados: [AUSENTE], retratos: [R094]})})).codigo, 0);
});

test('aplicação: backup obrigatório; retrato/precheck/postcheck/integridade em READ ONLY, migration fora; COMMIT CONFIRMADO; marcador exclusivo', async () => {
  const dir = tmp();
  try {
    await assert.rejects(stg.executar({env: ENV_STG, dir, Client: clienteFalso(), disco: semDisco}), /BACKUP_OBRIGATORIO/);
    assert.deepEqual(fs.readdirSync(dir), [], 'sem backup: nada gravado');
    const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], retratos: [R094, R098]});
    const r = await stg.executar({env: ENV_STG, backup: 'export 23/10 18:00Z', dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, ['precheck 098', 'migration 098', 'postcheck 098', 'integridade 098']);
    assert.equal(r.commit, 'CONFIRMADO'); assert.equal(r.retratoAntes, '094'); assert.equal(r.retratoDepois, '098');
    const mig = C.log.find(x => x.sql.includes(MIGRATION));
    assert.ok(mig && !mig.ro, 'a migration roda na própria transação do arquivo');
    for (const t of ['098 precheck OK', '098 postcheck OK', '098 integridade OK']) assert.ok(C.log.find(x => x.sql.includes(t)).ro, t);
    assert.equal(escritas(C.log).length, 1, 'a única escrita é a migration');
    // Ordem: retrato antes do precheck; espera do corte antes da migration.
    const idx = f => C.log.findIndex(f);
    assert.ok(idx(x => x.sql.startsWith('/* retrato-098 */')) < idx(x => x.sql.includes('098 precheck OK')));
    assert.ok(idx(x => x.sql.includes('xact_start <=')) < idx(x => x.sql.includes(MIGRATION)));
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(marcador.situacao, 'CONCLUIDA'); assert.equal(marcador.backup, 'export 23/10 18:00Z'); assert.equal(marcador.ambiente, 'staging');
    assert.deepEqual(marcador.tentativasAnteriores, []);
    assert.equal(marcador.etapas.find(e => e.nome === 'migration 098').commit, 'CONFIRMADO');
    assert.ok(!JSON.stringify(marcador).includes('SENHA_FALSA') && !JSON.stringify(marcador).includes('postgresql://'));
    // Nova tentativa no mesmo disco: recusada antes de conectar.
    const D = clienteFalso();
    await assert.rejects(stg.executar({env: ENV_STG, backup: 'export 23/10 18:00Z', dir, Client: D, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(D.log.length, 0);
    // Retomada decidida: marcador renomeado (nunca apagado) entra como tentativa anterior do novo registro.
    fs.renameSync(path.join(dir, comum.MARCADOR), path.join(dir, 'migration-098.20261023T1800Z.json'));
    const E = clienteFalso({estados: [COMPLETA], retratos: [R098]});
    const e = await stg.executar({env: ENV_STG, backup: 'export 23/10 18:00Z', dir, Client: E, disco: semDisco});
    assert.equal(e.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(e.etapas, ['integridade 098']); assert.deepEqual(escritas(E.log), []);
    assert.equal(e.commit, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).tentativasAnteriores, ['migration-098.20261023T1800Z.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  await assert.rejects(stg.executar({env: ENV_STG, backup: 'export 23/10', dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.throws(() => stg.exigirDisco(path.join(os.tmpdir(), 'nao-existe-098')), /DISCO_PERSISTENTE_AUSENTE/);
});

test('aplicação: retrato divergente ou falta de privilégio recusa ANTES de escrever (FALHA registrada, commit null)', async () => {
  for (const [estado, retrato, motivo] of [[AUSENTE, RDIV, /RETRATO_DIVERGENTE/], [{...AUSENTE, dono_098: false}, R094, /SEM_PRIVILEGIO_098 DONO/]]) {
    const dir = tmp();
    try {
      const C = clienteFalso({estados: [estado], retratos: [retrato]});
      const r = await stg.executar({env: ENV_STG, backup: 'export 23/10', dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.equal(r.commit, null); assert.deepEqual(escritas(C.log), []);
      assert.equal((await stg.principal(['--aplicar-098-autorizado', '--backup', 'export 23/10'], ENV_STG,
        {dir: tmp(), Client: clienteFalso({estados: [estado], retratos: [retrato]}), disco: semDisco})).codigo, 2);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação: falha na migration — SQLSTATE comum = DESFEITA_PELO_SERVIDOR; conexão/57014/40003/XX ou sem código = INDETERMINADO', async () => {
  const casos = [[Object.assign(new Error('precheck falhou'), {code: 'P0001'}), 'DESFEITA_PELO_SERVIDOR'],
    [Object.assign(new Error('lock'), {code: '55P03'}), 'DESFEITA_PELO_SERVIDOR'],
    [Object.assign(new Error('cancelado'), {code: '57014'}), 'INDETERMINADO'], [Object.assign(new Error('incerto'), {code: '40003'}), 'INDETERMINADO'], [Object.assign(new Error('conexao'), {code: '08006'}), 'INDETERMINADO'],
    [Object.assign(new Error('interno'), {code: 'XX000'}), 'INDETERMINADO'], [new Error('Connection terminated unexpectedly'), 'INDETERMINADO']];
  for (const [erro, esperado] of casos) {
    assert.equal(comum.commitNaFalha(erro), esperado);
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: 'export 23/10', dir, Client: clienteFalso({falharEm: MIGRATION, erro}), disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, 'migration 098'); assert.equal(r.commit, esperado);
      assert.match(r.reconciliar, /--conferir-098/);
      const m = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.equal(m.commit, esperado);
      assert.deepEqual(m.etapas.map(e => [e.nome, e.ok === true]), [['precheck 098', true], ['migration 098', false]]);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação: depois do COMMIT, preservação divergente, combinado até o corte ou retrato final ≠ 098 → FALHA com commit CONFIRMADO', async () => {
  for (const [opcoes, motivo] of [
    [{preservacao: (() => { let n = 0; return () => (n++ === 0 ? {} : {resumo_saloes: 's2'}); })()}, /PRESERVACAO_DIVERGENTE resumo_saloes/],
    [{preservacao: (() => { let n = 0; return () => (n++ === 0 ? {} : {saloes: 2}); })()}, /PRESERVACAO_DIVERGENTE saloes/],
    [{preservacao: (() => { let n = 0; return () => (n++ === 0 ? {} : {combinados_ate_corte: 1}); })()}, /PRESERVACAO_DIVERGENTE combinados_ate_corte/],
    [{retratos: [R094, RDIV]}, /RETRATO_FINAL_098/],
    [{estados: [AUSENTE, AUSENTE]}, /ESTADO_DEPOIS_098/]]) {
    const dir = tmp();
    try {
      const r = await stg.executar({env: ENV_STG, backup: 'export 23/10', dir, Client: clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], ...opcoes}), disco: semDisco});
      assert.equal(r.resultado, 'FALHA', String(motivo)); assert.match(r.falha.mensagem, motivo); assert.equal(r.commit, 'CONFIRMADO');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).situacao, 'FALHA');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação espera transações abertas antes do corte; se não terminam, recusa ANTES de escrever', async () => {
  const pausas = [], pausa = async ms => { pausas.push(ms); };
  const dir = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], anteriores: [2, 1, 0]});
    const r = await stg.executar({env: ENV_STG, backup: 'export 23/10', dir, Client: C, disco: semDisco, pausa, tentativas: 5});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(pausas, [500, 500]);
    assert.deepEqual(r.esperaCorte, {esperas: 2, sessoesInvisiveis: 0});
    assert.ok(C.log.filter(x => x.sql.includes('xact_start <=')).every(x => x.ro), 'a espera só lê');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE], anteriores: [1]});
    const r = await stg.executar({env: ENV_STG, backup: 'export 23/10', dir: dir2, Client: C, disco: semDisco, pausa, tentativas: 3});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /TRANSACOES_ANTERIORES_AO_CORTE/); assert.equal(r.commit, null);
    assert.deepEqual(escritas(C.log), [], 'nada escrito');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('plano sem conexão: arquivos com sha, retratos esperados, ordem código → retrato → conferir → backup → aplicar → conferir; código 0', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false);
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [comum.RETRATO, ...comum.ETAPAS].map(e => e[2]));
  assert.deepEqual(saida.retratosEsperados, {antes: comum.RETRATOS['094'].hash, depois: comum.RETRATOS['098'].hash});
  assert.match(saida.ordem[0], /PR #223/);
  const o = saida.ordem, pos = s => o.findIndex(x => x === s || x.startsWith(s));
  assert.ok(pos('--retrato-098') < pos('--conferir-098') && pos('--conferir-098') < pos('backup') && pos('backup') < pos('autorização')
    && pos('autorização') < pos('--aplicar-098-autorizado'));
  assert.equal(o.at(-1), '--conferir-098');
  for (const x of ['down 098', 'alteração de env', 'deploy']) assert.ok(saida.nuncaExecuta.includes(x), x);
  assert.equal(stg.CODIGO.RETRATO_DIVERGENTE, 3); assert.equal(stg.CODIGO.RECUSARIA, 3); assert.equal(stg.CODIGO.FALHA, 2);
});

test('P2-1: falha de disco depois do COMMIT não escapa nem vira código 1 — FALHA (2), commit CONFIRMADO, registro não gravado, estado desconhecido', async () => {
  for (const segundaFalha of [true, false]) {
    const dir = tmp(), orig = fs.writeFileSync;
    let quebrado = false;
    // Disco falha a partir da gravação do COMMIT CONFIRMADO; com segundaFalha, a gravação da FALHA também falha.
    fs.writeFileSync = (alvo, dados, ...resto) => {
      if (String(alvo).endsWith(comum.MARCADOR) && (quebrado || String(dados).includes('"commit": "CONFIRMADO"'))) {
        if (!quebrado || segundaFalha) { quebrado = true; throw Object.assign(new Error('ENOSPC disco cheio'), {code: 'ENOSPC'}); }
      }
      return orig(alvo, dados, ...resto);
    };
    try {
      const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA]});
      const p = await stg.principal(['--aplicar-098-autorizado', '--backup', 'export 24/10'], ENV_STG, {dir, Client: C, disco: semDisco});
      assert.equal(p.codigo, 2, JSON.stringify(p.saida)); assert.equal(p.saida.resultado, 'FALHA');
      assert.equal(p.saida.commit, 'CONFIRMADO', 'o último estado em memória tem o COMMIT'); assert.match(p.saida.falha.mensagem, /ENOSPC/);
      assert.equal(p.saida.registroGravado, !segundaFalha);
      if (segundaFalha) { assert.equal(p.saida.estadoBanco, 'DESCONHECIDO_CONFERIR'); assert.match(p.saida.falha.registro, /^NAO_GRAVADO /); }
      assert.ok(!C.log.some(x => x.sql.includes('098 postcheck OK')), 'a execução para na falha de registro');
      assert.match(p.saida.reconciliar, /--conferir-098/);
    } finally { fs.writeFileSync = orig; fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Recusas ANTES do marcador continuam lançadas (código 1 na CLI): backup inválido, tentativa anterior, disco.
  await assert.rejects(stg.principal(['--aplicar-098-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
});

test('P2-2: sessão não classificável impede a aplicação (antes de escrever) e faz a conferência RECUSARIA; leitura com o papel do login', async () => {
  const pausa = async () => {};
  const dir = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE], anteriores: [0], invisiveis: [1]});
    const r = await stg.executar({env: ENV_STG, backup: 'export 24/10', dir, Client: C, disco: semDisco, pausa, tentativas: 3});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /SESSOES_NAO_CLASSIFICAVEIS 1/); assert.equal(r.commit, null);
    assert.deepEqual(escritas(C.log), [], 'nada escrito');
    const leituras = C.log.filter(x => x.sql.includes('xact_start <='));
    assert.equal(leituras.length, 3); assert.ok(leituras.every(x => x.ro && x.papel === 'sessao'), 'READ ONLY com SET LOCAL ROLE NONE');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Sessão invisível que some durante a espera: segue.
  const dir2 = tmp();
  try {
    const r = await stg.executar({env: ENV_STG, backup: 'export 24/10', dir: dir2, Client: clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], invisiveis: [1, 0]}),
      disco: semDisco, pausa, tentativas: 3});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(r.esperaCorte, {esperas: 1, sessoesInvisiveis: 0});
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  // Resposta sem a coluna (ilegível) também é conservadora.
  const x = await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [AUSENTE], invisiveis: [undefined]})});
  assert.equal(x.resultado, 'RECUSARIA'); assert.match(x.motivo, /SESSOES_NAO_CLASSIFICAVEIS 1/);
  const c = await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [AUSENTE], invisiveis: [2]})});
  assert.equal(c.resultado, 'RECUSARIA'); assert.deepEqual(c.sessoes, {anteriores: 0, invisiveis: 2});
  const ok = await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [AUSENTE]})});
  assert.equal(ok.resultado, 'PRONTA_PARA_APLICAR'); assert.deepEqual(ok.sessoes, {anteriores: 0, invisiveis: 0});
  // Já aplicada: não há migration, então a visibilidade não é exigida.
  assert.equal((await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [COMPLETA], retratos: [R098], invisiveis: [3]})})).resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
  const q = comum.SQL_ANTERIORES(CORTE);
  assert.match(q, /backend_type IS NULL AND query = '<insufficient privilege>'/, 'invisível tem backend_type nulo');
  assert.doesNotMatch(q.slice(q.indexOf('FROM pg_stat_activity')), /backend_type/, 'o filtro geral não descarta invisíveis');
});

test('tempo das leituras: retrato, precheck, postcheck e integridade com TEMPO_RETRATO (300 s); demais com 30 s; lock 5 s; duração informada', async () => {
  assert.equal(comum.TEMPO_RETRATO, '300s');
  const comRetrato = x => x.sql.startsWith('/* retrato-098 */') || /098 (precheck|postcheck|integridade) OK/.test(x.sql);
  const dir = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA]});
    const r = await stg.executar({env: ENV_STG, backup: 'export 25/10', dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    const leituras = C.log.filter(x => x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|SET LOCAL)/.test(x.sql));
    const pesadas = leituras.filter(comRetrato);
    assert.equal(pesadas.length, 2 + 3, 'retrato antes/depois + precheck, postcheck e integridade');
    assert.ok(pesadas.every(x => x.tempo === '300s'), 'leituras com retrato em 300 s: ' + JSON.stringify(pesadas.map(x => [x.sql.slice(0, 40), x.tempo])));
    assert.ok(leituras.filter(x => !comRetrato(x)).every(x => x.tempo === '30s'), 'demais leituras em 30 s');
    assert.ok(!C.log.some(x => x.sql === "SET LOCAL lock_timeout = '5s'" && !x.ro), 'lock_timeout só dentro das leituras');
    assert.equal(C.log.filter(x => x.sql === "SET LOCAL lock_timeout = '5s'").length, leituras.length, 'toda leitura com lock 5 s');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const t = await stg.retratar({env: ENV_STG, Client: clienteFalso({retratos: [R094]})});
  assert.ok(Number.isInteger(t.retrato.duracaoMs) && t.retrato.duracaoMs >= 0);
  const c = await stg.conferir({env: ENV_STG, Client: clienteFalso({estados: [AUSENTE]})});
  assert.ok(Number.isInteger(c.duracoesMs['precheck 098']) && Number.isInteger(c.retrato.duracaoMs));
});

test('COM_108: evidência que a 098 nunca produz (marcador, regra de conflito da 108, registro da 107) recusa nos TRÊS modos logo após a identidade', async () => {
  // Uma de cada vez e juntas. Funções kidmais098_* e corpos de contrato/revisão NÃO entram: são idênticos na 098 e na 108.
  const casos = [
    [{marcador_108: true}, 'marcador_108'],
    [{reparos_107: true}, 'reparos_107'],
    [{corpo_conflito_108: true}, 'corpo_conflito_108'],
    [{colunas_combinado: true, corpo_conflito_108: true, corpos_108: 3, funcoes_098_108: 10}, 'corpo_conflito_108'],
    [{marcador_108: true, reparos_107: true, colunas_combinado: true, corpo_conflito_108: true, corpos_108: 3, funcoes_098_108: 10},
      'marcador_108 corpo_conflito_108 reparos_107']];
  for (const [delta, lista] of casos) {
    const evidencias = {...SEM_108, ...delta};
    const leuSoCatalogo = (C, rotulo) => {
      const consultas = C.log.filter(l => !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(l.sql));
      assert.deepEqual(consultas.map(l => l.sql.startsWith('SELECT current_database()') ? 'identidade' : l.sql === ev108.SQL_EVIDENCIA_108 ? 'evidencia' : 'outra'),
        ['identidade', 'evidencia'], rotulo + ': só identidade e evidências (nada de estado, retrato, corte, contagens ou migration)');
      assert.ok(consultas.every(l => l.ro), rotulo + ': tudo em READ ONLY');
      assert.deepEqual(escritas(C.log), [], rotulo);
    };
    const R = clienteFalso({evidencias});
    const r = await stg.principal(['--retrato-098'], ENV_STG, {Client: R});
    assert.equal(r.codigo, 3, lista); assert.equal(r.saida.resultado, 'RECUSARIA'); assert.equal(r.saida.motivo, 'COM_108 ' + lista);
    assert.equal(r.saida.retrato, undefined); leuSoCatalogo(R, 'RETRATO ' + lista);
    const K = clienteFalso({evidencias});
    const k = await stg.principal(['--conferir-098'], ENV_STG, {Client: K});
    assert.equal(k.codigo, 3); assert.equal(k.saida.resultado, 'RECUSARIA'); assert.equal(k.saida.motivo, 'COM_108 ' + lista);
    assert.equal(k.saida.estado, undefined); leuSoCatalogo(K, 'CONFERIR ' + lista);
    const dir = tmp();
    try {
      const A = clienteFalso({evidencias});
      const a = await stg.principal(['--aplicar-098-autorizado', '--backup', 'export 23/10 18:00Z'], ENV_STG, {dir, Client: A, disco: semDisco});
      assert.equal(a.codigo, 2); assert.equal(a.saida.resultado, 'FALHA'); assert.equal(a.saida.falha.mensagem, 'COM_108 ' + lista);
      assert.equal(a.saida.commit, null); leuSoCatalogo(A, 'APLICAR ' + lista);
      assert.ok(!A.log.some(l => l.sql.includes(MIGRATION)), 'migration nunca enviada');
      const m = JSON.parse(fs.readFileSync(a.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'FALHA'); assert.deepEqual(m.evidencias108, lista.split(' '));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Controle: a 098 histórica completa COMO MEDIDA no cluster E4 (colunas, as 10 funções kidmais098_* e os corpos de
  // contrato/revisão com os mesmos hashes da 108) não é evidência da 108.
  const H = clienteFalso({estados: [COMPLETA], retratos: [R098], evidencias: {...SEM_108, colunas_combinado: true, corpos_108: 2, funcoes_098_108: 10}});
  const h = await stg.conferir({env: ENV_STG, Client: H});
  assert.equal(h.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(h)); assert.deepEqual(h.evidencias108, []);
  // Evidência ilegível: FALHA, nunca "sem 108" (e nada além da identidade e da leitura de evidências).
  const I = clienteFalso({evidencias: {...SEM_108, funcoes_098_108: null}});
  const i = await stg.retratar({env: ENV_STG, Client: I});
  assert.equal(i.resultado, 'FALHA'); assert.match(i.mensagem, /EVIDENCIA_108_ILEGIVEL funcoes_098_108/);
  assert.ok(!I.log.some(l => l.sql.startsWith('/* retrato-098 */')));
});
