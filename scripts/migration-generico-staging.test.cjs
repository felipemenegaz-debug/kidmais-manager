/* eslint-disable @typescript-eslint/no-require-imports */
// Adaptador genérico de STAGING (scripts/migration-generico-staging.cjs) com cliente simulado: lista fechada, recusas
// antes de conectar (zero conexões, 7.3), uma conexão só, trava de sessão antes de qualquer leitura (7.1), 111 só com a 110,
// situação do COMMIT na FALHA (7.4) e limpeza que nunca substitui o resultado (8.3). O núcleo (hashes, sentinelas,
// privilégios, situação do COMMIT) é coberto pelo teste do genérico; a prova em PostgreSQL real está no teste PG do registro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s = require('./migration-generico-staging.cjs');
const g = require('./migration-generico-production.cjs');
const stg = require('./conexao-staging.cjs');
const reg = require('./registro-migrations-banco.cjs');

const raiz = path.resolve(__dirname, '..');
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production'});
const ID_STG = Object.freeze({db: 'kidmais_staging_1z91', tls: false, servidor_privado: true});
const BACKUP = 'export staging 2026-11-22T20:00Z';
const PRIV_OK = Object.freeze({schema_create: true, sem_posse: [], sem_references: [], sem_posse_funcoes: [], sem_execute: [], sem_lock: [], sem_select: []});
// Presente = sentinelas criadas e as removidas ausentes (a 115 troca o índice da 054).
const linha = (id, v) => ({...Object.fromEntries(g.MIGRATIONS[id].criados.map((_, i) => ['c' + i, v])),
  ...Object.fromEntries((g.MIGRATIONS[id].removidos ?? []).map((_, i) => ['r' + i, !v]))});

/**
 * Cliente falso multi-id. presentes: ids já aplicados. trava: resposta do pg_try_advisory_lock (booleano, ou objeto por chave
 * 'staging:<id>' com true por omissão). falharEm: trecho de SQL que lança. precheckNaEscrita: id cujo precheck reprova só dentro
 * da transação de escrita (a leitura passou e outra sessão mudou o estado). commitPerdido: o COMMIT confirma no servidor mas a
 * resposta some. unlock/end: 'falso' | 'erro'.
 */
function clienteFalso({presentes = [], identidade = ID_STG, trava = true, falharEm, precheckNaEscrita, commitPerdido = false, unlock, end, connectFalha} = {}) {
  const estado = Object.fromEntries(s.IDS.map(id => [id, presentes.includes(id)]));
  const corpos = Object.fromEntries(s.IDS.map(id => [id, g.carregar(raiz, id)]));
  const log = []; let conexoes = 0, emTransacao = false, pendente = null, fechada = false;
  const C = class {
    on() {}
    async connect() { conexoes++; if (connectFalha) throw new Error('ECONNREFUSED simulado'); }
    async end() { fechada = true; if (end === 'erro') throw new Error('end simulado'); }
    async query(sql, params) {
      log.push({sql, params});
      if (falharEm && sql.includes(falharEm)) throw Object.assign(new Error('falha simulada em ' + falharEm), {code: 'P0001'});
      if (sql === s.SQL.trava) return {rows: [{ok: typeof trava === 'object' ? (trava[params[0]] ?? true) : trava}]};
      if (sql === s.SQL.destrava) { if (unlock === 'erro') throw new Error('unlock simulado'); return {rows: [{ok: unlock !== 'falso'}]}; }
      if (sql === 'BEGIN') emTransacao = true;
      if (sql === 'ROLLBACK') { emTransacao = false; pendente = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        if (pendente) estado[pendente] = true; emTransacao = false; pendente = null;
        if (commitPerdido) throw Object.assign(new Error('Connection terminated unexpectedly'), {});
        return {rows: [], command: 'COMMIT'};
      }
      if (sql === stg.SQL_IDENTIDADE) return {rows: [identidade]};
      for (const id of s.IDS) {
        if (sql === g.sqlEstado(id)) return {rows: [linha(id, estado[id])]};
        if (sql === g.sqlPrivilegios(id)) return {rows: [{...PRIV_OK}]};
        if (sql === corpos[id].migration) { assert.ok(emTransacao, 'migration só na transação'); pendente = id; return [{rows: [], command: 'CREATE'}]; }
        if (sql === corpos[id].precheck && emTransacao && precheckNaEscrita === id) {
          throw Object.assign(new Error('precheck ' + id + ' reprovado na transação de escrita'), {code: 'P0001'});
        }
        if (sql === corpos[id].precheck || sql === corpos[id].postcheck) return [{rows: [], command: 'DO'}, {rows: [{aprovado: true}], command: 'SELECT'}];
      }
      return {rows: [], command: 'SET'};
    }
  };
  C.log = log; C.estado = estado; C.conexoes = () => conexoes; C.fechada = () => fechada;
  return C;
}
const AGORA = () => new Date('2026-11-22T21:00:00Z');

test('plano: staging, lista fechada 120/121/110/111/115, hashes do genérico, sem conexão', async () => {
  const {codigo, saida} = await s.principal([], {});
  assert.equal(codigo, 0);
  assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.ids.map(x => x.id), ['120', '121', '110', '111', '115']);
  for (const x of saida.ids) assert.deepEqual(x.arquivos.map(a => a.sha256), g.MIGRATIONS[x.id].arquivos.map(a => a[2]));
  assert.equal(saida.ids.find(x => x.id === '111').exige, '110');
  assert.ok(saida.nuncaExecuta.includes('production'));
  // §7.6/§7.7 (Astra r1 do código P2-2): as paradas objetivas na ordem impressa, entre as migrations certas.
  const o = saida.ordem;
  const pos = re => { const i = o.findIndex(x => re.test(x)); assert.ok(i >= 0, String(re)); return i; };
  const sat = pos(/^PARADA satisfação .*SATISFACAO_PESQUISA_ENABLED.*web de staging.*cron/);
  const fin = pos(/^PARADA financeiro depois da 121 .*saldoInicialCentavos null.*saldoFinalCentavos null.*SEM_ABERTURA.*financeiro_aberturas com 0 linhas/);
  const c110 = pos(/^PARADA contagens depois da 110 /), c111 = pos(/^PARADA contagens depois da 111 /);
  const p = id => pos(new RegExp('^' + id + ': '));
  assert.ok(sat < p('120') && p('120') < p('121') && p('121') < fin && fin < p('110') && p('110') < c110 && c110 < p('111') && p('111') < c111 && c111 < p('115'), o.join('\n'));
  for (const c of [o[c110], o[c111]]) assert.ok(c.includes(s.SQL_CONTAGENS_SATISFACAO) && /as três = 0/.test(c), c);
  for (const tb of ['satisfacao_envios', 'satisfacao_entregas', 'satisfacao_respostas']) assert.match(s.SQL_CONTAGENS_SATISFACAO, new RegExp('FROM ' + tb + '\\b'));
  assert.ok(saida.paradas.some(x => /satisfação.*financeiro.*contagens/.test(x)));
});

test('modo: ID_FORA_DA_LISTA, BACKUP_OBRIGATORIO, BACKUP_INVALIDO e argumentos recusados (código 1 pelo cli)', () => {
  for (const id of ['128', '129', '130', '116', '117', '1200', '']) {
    assert.throws(() => s.modo(['--conferir', id]), /ID_FORA_DA_LISTA/);
    assert.throws(() => s.modo(['--aplicar-autorizado', id, '--backup', BACKUP]), /ID_FORA_DA_LISTA/);
  }
  assert.throws(() => s.modo(['--aplicar-autorizado', '120']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => s.modo(['--aplicar-autorizado', '120', '--backup']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => s.modo(['--aplicar-autorizado', '120', '--backup', 'x;rm']), /BACKUP_INVALIDO/);
  // P2-4: backup só de espaços ou pontuação, com espaço nas pontas ou fora de texto: recusado nas duas entradas.
  for (const ruim of ['      ', '------', ' ' + BACKUP, BACKUP + ' ', '.', '']) {
    assert.throws(() => s.modo(['--aplicar-autorizado', '120', '--backup', ruim]), /BACKUP_INVALIDO/, JSON.stringify(ruim));
  }
  assert.throws(() => s.exigirBackup(123456, 'X_RECUSADO'), /X_RECUSADO/);
  assert.equal(s.exigirBackup(BACKUP, 'X_RECUSADO'), BACKUP);
  assert.throws(() => s.modo(['--conferir']), /ARGUMENTOS_RECUSADOS/);
  assert.deepEqual(s.modo(['--conferir', '115']), {modo: 'conferir', id: '115'});
  assert.deepEqual(s.modo(['--aplicar-autorizado', '111', '--backup', BACKUP]), {modo: 'aplicar', id: '111', backup: BACKUP});
});

test('7.3: cada recusa acontece antes de criar o cliente (zero conexões, zero instâncias)', async () => {
  let instancias = 0;
  const C = clienteFalso();
  const Contado = class extends C { constructor(...a) { super(...a); instancias++; } };
  const casos = [
    [{env: ENV_STG, id: '128', backup: BACKUP}, /ID_FORA_DA_LISTA/],
    [{env: ENV_STG, id: '120', backup: ''}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_STG, id: '120', backup: undefined}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_STG, id: '120', backup: '      '}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_STG, id: '120', backup: '------'}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_STG, id: '120', backup: 123456}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_STG, id: '120', backup: ' ' + BACKUP}, /BACKUP_OBRIGATORIO/],
    [{env: ENV_PROD, id: '120', backup: BACKUP}, /SERVICO_RECUSADO|AMBIENTE_RECUSADO/],
    [{env: {...ENV_STG, KIDMAIS_DEPLOY_ENV: 'production'}, id: '120', backup: BACKUP}, /AMBIENTE_RECUSADO/],
    [{env: {...ENV_STG, PGOPTIONS: '-c x=1'}, id: '120', backup: BACKUP}, /AMBIENTE_PG_RECUSADO/],
    [{env: ENV_STG, id: '120', backup: BACKUP, raiz: path.join(raiz, 'nao-existe')}, /ENOENT|SHA|sha/i],
  ];
  for (const [args, re] of casos) await assert.rejects(s.executar({Client: Contado, ...args}), re);
  await assert.rejects(s.conferir({env: ENV_PROD, id: '120', Client: Contado}), /SERVICO_RECUSADO|AMBIENTE_RECUSADO/);
  await assert.rejects(s.conferir({env: ENV_STG, id: '131', Client: Contado}), /ID_FORA_DA_LISTA/);
  assert.equal(instancias, 0);
  assert.equal(C.conexoes(), 0);
});

test('7.1: trava de sessão staging:<id> é a primeira instrução, antes da identidade; unlock no fim; uma conexão só', async () => {
  const C = clienteFalso();
  const r = await s.executar({env: ENV_STG, id: '120', backup: BACKUP, Client: C, agora: AGORA});
  assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS');
  assert.equal(r.commit, 'CONFIRMADO');
  assert.equal(C.conexoes(), 1);
  assert.equal(C.log[0].sql, s.SQL.trava);
  assert.deepEqual(C.log[0].params, ['staging:120']);
  assert.equal(C.log.at(-1).sql, s.SQL.destrava);
  assert.deepEqual(C.log.at(-1).params, ['staging:120']);
  assert.ok(C.fechada());
  assert.equal(r.ambiente, 'staging'); assert.equal(r.backup, BACKUP); assert.equal(r.em, '2026-11-22T21:00:00.000Z');
  assert.equal(r.estadoAntes.situacao, 'ausente'); assert.equal(r.estadoDepois.situacao, 'presente');
  assert.equal(r.limpeza, undefined);
});

test('7.1: trava ocupada → EXECUTOR_ATIVO (3) no aplicar e NAO_CONCLUSIVO (2) no conferir, sem nenhuma leitura', async () => {
  const C = clienteFalso({trava: false});
  const a = await s.principal(['--aplicar-autorizado', '110', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(a.codigo, 3); assert.equal(a.saida.resultado, 'EXECUTOR_ATIVO'); assert.equal(a.saida.motivo, 'EXECUTOR_ATIVO 110');
  const c = await s.principal(['--conferir', '110'], ENV_STG, {Client: C});
  assert.equal(c.codigo, 2); assert.equal(c.saida.resultado, 'NAO_CONCLUSIVO'); assert.equal(c.saida.motivo, 'EXECUTOR_ATIVO 110');
  assert.deepEqual(C.log.map(x => x.sql), [s.SQL.trava, s.SQL.trava], 'nem identidade, nem estado, nem unlock de trava não obtida');
});

test('conferir: pega a trava, só leitura (sem BEGIN de escrita), PRONTA/JA_APLICADA com código 0', async () => {
  const C = clienteFalso({presentes: ['121']});
  const p = await s.principal(['--conferir', '120'], ENV_STG, {Client: C});
  assert.equal(p.codigo, 0); assert.equal(p.saida.resultado, 'PRONTA_PARA_APLICAR');
  const j = await s.principal(['--conferir', '121'], ENV_STG, {Client: C});
  assert.equal(j.codigo, 0); assert.equal(j.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
  assert.ok(!C.log.some(x => x.sql === 'BEGIN' || x.sql === 'COMMIT'));
  assert.equal(C.log.filter(x => x.sql === s.SQL.trava).length, 2);
  assert.equal(C.log.filter(x => x.sql === s.SQL.destrava).length, 2);
});

test('JA_APLICADA no aplicar: código 0, nenhuma escrita, commit NAO_APLICAVEL', async () => {
  const C = clienteFalso({presentes: ['115']});
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '115', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 0); assert.equal(saida.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.equal(saida.commit, 'NAO_APLICAVEL');
  assert.ok(!C.log.some(x => x.sql === 'BEGIN'));
});

test('111 sem a 110: ANTECESSORA_PENDENTE 110 (3), nenhuma escrita; com a 110 aplicada, aplica', async () => {
  const C = clienteFalso();
  const r = await s.principal(['--aplicar-autorizado', '111', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(r.codigo, 3); assert.equal(r.saida.resultado, 'ANTECESSORA_PENDENTE'); assert.match(r.saida.motivo, /^ANTECESSORA_PENDENTE 110 PRONTA_PARA_APLICAR/);
  assert.ok(!C.log.some(x => x.sql === 'BEGIN'));
  const D = clienteFalso({presentes: ['110']});
  const ok = await s.principal(['--aplicar-autorizado', '111', '--backup', BACKUP], ENV_STG, {Client: D});
  assert.equal(ok.codigo, 0); assert.equal(ok.saida.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(D.estado['111'], true);
  // A 111 segura staging:111 e staging:110, nessa ordem, antes de ler; solta na ordem inversa.
  assert.deepEqual(D.log.filter(x => x.sql === s.SQL.trava).map(x => x.params[0]), ['staging:111', 'staging:110']);
  assert.deepEqual(D.log.filter(x => x.sql === s.SQL.destrava).map(x => x.params[0]), ['staging:110', 'staging:111']);
  assert.deepEqual(s.travasDe('111'), ['111', '110']); assert.deepEqual(s.travasDe('120'), ['120']);
});

test('P2-1: --conferir 111 aplica a mesma regra da antecessora (3); com a 110 aplicada, confere a 111', async () => {
  const C = clienteFalso();
  const r = await s.principal(['--conferir', '111'], ENV_STG, {Client: C});
  assert.equal(r.codigo, 3); assert.equal(r.saida.resultado, 'ANTECESSORA_PENDENTE');
  assert.match(r.saida.motivo, /^ANTECESSORA_PENDENTE 110 PRONTA_PARA_APLICAR/);
  assert.ok(!C.log.some(x => x.sql === g.sqlEstado('111')), 'a 111 não foi lida');
  const D = clienteFalso({presentes: ['110']});
  const ok = await s.principal(['--conferir', '111'], ENV_STG, {Client: D});
  assert.equal(ok.codigo, 0); assert.equal(ok.saida.resultado, 'PRONTA_PARA_APLICAR');
  const J = clienteFalso({presentes: ['110', '111']});
  assert.equal((await s.principal(['--conferir', '111'], ENV_STG, {Client: J})).saida.resultado, 'JA_APLICADA_POSTCHECK_PASS');
});

test('P2-1: trava staging:110 ocupada ⇒ 111 sem leitura nenhuma: conferir NAO_CONCLUSIVO (2) e aplicar EXECUTOR_ATIVO (3)', async () => {
  const C = clienteFalso({presentes: ['110'], trava: {'staging:110': false}});
  const c = await s.principal(['--conferir', '111'], ENV_STG, {Client: C});
  assert.equal(c.codigo, 2); assert.equal(c.saida.resultado, 'NAO_CONCLUSIVO'); assert.equal(c.saida.motivo, 'EXECUTOR_ATIVO 110');
  const a = await s.principal(['--aplicar-autorizado', '111', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(a.codigo, 3); assert.equal(a.saida.resultado, 'EXECUTOR_ATIVO'); assert.equal(a.saida.motivo, 'EXECUTOR_ATIVO 110');
  assert.equal(C.estado['111'], false);
  // Só travas e o unlock da staging:111 obtida: nem identidade, nem estado.
  assert.deepEqual(C.log.map(x => [x.sql === s.SQL.trava ? 'trava' : x.sql === s.SQL.destrava ? 'destrava' : x.sql, x.params?.[0]]),
    [['trava', 'staging:111'], ['trava', 'staging:110'], ['destrava', 'staging:111'], ['trava', 'staging:111'], ['trava', 'staging:110'], ['destrava', 'staging:111']]);
});

test('7.4: recusa do conferir interno → RECUSARIA (3), NAO_COMMITADA, sem transação de escrita', async () => {
  const corpos = g.carregar(raiz, '121');
  const C = clienteFalso({falharEm: corpos.precheck.slice(0, 80)});
  // O precheck em READ ONLY falha antes da transação: o conferir interno recusa.
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '121', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 3); assert.equal(saida.resultado, 'RECUSARIA'); assert.equal(saida.commit, 'NAO_COMMITADA');
  assert.ok(!C.log.some(x => x.sql === 'BEGIN'));
  assert.equal(C.log.at(-1).sql, s.SQL.destrava);
});

test('7.4: falha dentro da transação → FALHA (2), NAO_COMMITADA; COMMIT perdido → FALHA (2) com INDETERMINADO e instrução', async () => {
  const corpos = g.carregar(raiz, '120');
  // Postcheck falha só dentro da transação: o conferir interno usa o precheck (estado ausente), não o postcheck.
  const C = clienteFalso({falharEm: corpos.postcheck.slice(0, 80)});
  const f = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(f.codigo, 2); assert.equal(f.saida.resultado, 'FALHA'); assert.equal(f.saida.commit, 'NAO_COMMITADA');
  assert.equal(C.estado['120'], false);
  const D = clienteFalso({commitPerdido: true});
  const linhas = [];
  const p = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: D, out: l => linhas.push(JSON.parse(l))});
  assert.equal(p.codigo, 2); assert.equal(p.saida.resultado, 'FALHA'); assert.equal(p.saida.commit, 'INDETERMINADO');
  assert.equal(p.saida.reconciliar, 'não repetir; rodar --conferir 120 e colar');
  assert.ok(linhas.some(l => l.commit === 'INDETERMINADO'), 'a linha JSON da etapa registra a situação do COMMIT');
  assert.equal(D.log.at(-1).sql, s.SQL.destrava);
});

test('P2-6 (§7.4): leitura passa, outra sessão muda o estado e o precheck da escrita reprova ⇒ FALHA (2), NAO_COMMITADA, sem objetos', async () => {
  for (const id of ['120', '115']) {
    const C = clienteFalso({precheckNaEscrita: id});
    const {codigo, saida} = await s.principal(['--aplicar-autorizado', id, '--backup', BACKUP], ENV_STG, {Client: C});
    assert.equal(codigo, 2, JSON.stringify(saida)); assert.equal(saida.resultado, 'FALHA'); assert.equal(saida.commit, 'NAO_COMMITADA');
    assert.match(saida.mensagem, /reprovado na transação de escrita/);
    assert.equal(saida.estadoAntes?.situacao, 'ausente', 'a leitura tinha passado');
    assert.equal(C.estado[id], false, 'nenhum objeto');
    assert.ok(C.log.some(x => x.sql === 'BEGIN') && C.log.some(x => x.sql === 'ROLLBACK') && !C.log.some(x => x.sql === 'COMMIT'));
    assert.ok(!C.log.some(x => x.sql === g.carregar(raiz, id).migration), 'a migration não foi enviada');
  }
});

test('7.4: exceção depois do COMMIT confirmado → FALHA (2) com commit=CONFIRMADO', async () => {
  const C = clienteFalso();
  const orig = C.prototype.query;
  let depois = false;
  C.prototype.query = async function (sql, params) {
    if (sql === 'COMMIT') { const r = await orig.call(this, sql, params); depois = true; return r; }
    if (depois && sql === g.sqlEstado('110')) throw new Error('queda depois do COMMIT');
    return orig.call(this, sql, params);
  };
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '110', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 2); assert.equal(saida.resultado, 'FALHA'); assert.equal(saida.commit, 'CONFIRMADO');
  assert.match(saida.reconciliar, /não repetir/);
});

test('8.3: erro no unlock, unlock falso e erro no end viram o campo limpeza e não trocam o resultado', async () => {
  for (const [opc, re] of [[{unlock: 'erro'}, /^UNLOCK unlock simulado/], [{unlock: 'falso'}, /^UNLOCK_SEM_TRAVA staging:120/], [{end: 'erro'}, /^END end simulado/]]) {
    const C = clienteFalso(opc);
    const {codigo, saida} = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: C});
    assert.equal(codigo, 0); assert.equal(saida.resultado, 'APLICADA_POSTCHECK_PASS'); assert.match(saida.limpeza, re);
  }
  const C = clienteFalso({unlock: 'erro', end: 'erro', commitPerdido: true});
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 2); assert.equal(saida.commit, 'INDETERMINADO'); assert.match(saida.limpeza, /UNLOCK .*; END /);
});

test('P3-1: conexão que não abre: FALHA (2), NAO_COMMITADA, sem unlock, end() tentado; erro ou demora do end vira limpeza', async () => {
  const C = clienteFalso({connectFalha: true});
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 2); assert.equal(saida.etapa, 'CONEXAO'); assert.equal(saida.commit, 'NAO_COMMITADA');
  assert.equal(C.log.length, 0); assert.equal(C.fechada(), true); assert.equal(saida.limpeza, undefined);
  const E = clienteFalso({connectFalha: true, end: 'erro'});
  const e = await s.principal(['--conferir', '120'], ENV_STG, {Client: E});
  assert.equal(e.codigo, 2); assert.equal(e.saida.resultado, 'FALHA'); assert.match(e.saida.limpeza, /^END end simulado/);
  // end() que nunca resolve: o prazo encerra e vira limpeza, sem trocar o resultado.
  const P = clienteFalso({connectFalha: true});
  P.prototype.end = () => new Promise(() => {});
  const p = await s.principal(['--conferir', '120'], ENV_STG, {Client: P, prazoEnd: 30});
  assert.equal(p.codigo, 2); assert.equal(p.saida.resultado, 'FALHA'); assert.match(p.saida.limpeza, /^END END_SEM_RESPOSTA/);
});

test('Astra r2 do código: em processo próprio, end() pendente depois de connect rejeitado mantém o processo até o prazo ⇒ FALHA (2) impressa; end normal sai na hora', () => {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env}; delete env.DATABASE_URL; delete env.KIDMAIS_HOMOLOGACAO_DATABASE_URL;
  const rodar = codigo => spawnSync(process.execPath, ['-e', codigo], {cwd: raiz, env, encoding: 'utf8', timeout: 20000});
  // O comando da Astra: sem o timer vivo, o processo saía com 0 e sem saída.
  const e = rodar("require('./scripts/migration-generico-staging.cjs').encerrar({end: () => new Promise(() => {})}, 30)" +
    ".catch(e => { console.error(e.message); process.exitCode = 2; })");
  assert.equal(e.status, 2, e.stdout + e.stderr); assert.match(e.stderr, /END_SEM_RESPOSTA/);
  // O mesmo caminho da CLI (principal + impressão + exitCode), com Client que não conecta e end() que nunca resolve.
  const cli = prazo => rodar([
    "const s = require('./scripts/migration-generico-staging.cjs');",
    "class C { on() {} async connect() { throw new Error('ECONNREFUSED simulado'); } end() { return " + (prazo ? 'new Promise(() => {})' : 'Promise.resolve()') + "; } async query() {} }",
    'const env = ' + JSON.stringify(ENV_STG) + ';',
    "s.principal(['--conferir', '120'], env, {Client: C, prazoEnd: " + (prazo ?? 5000) + '}).then(({codigo, saida}) => {',
    '  (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo; });',
  ].join('\n'));
  const p = cli(50);
  assert.equal(p.status, 2, p.stdout + p.stderr);
  const saida = JSON.parse(p.stderr.trim().split('\n').at(-1));
  assert.equal(saida.resultado, 'FALHA'); assert.match(saida.limpeza, /^END END_SEM_RESPOSTA/);
  // end() que resolve: o clearTimeout libera o processo sem esperar os 5 s do prazo padrão.
  const t0 = Date.now();
  const n = cli();
  assert.equal(n.status, 2, n.stdout + n.stderr); assert.equal(JSON.parse(n.stderr.trim().split('\n').at(-1)).limpeza, undefined);
  assert.ok(Date.now() - t0 < 4000, 'saiu sem esperar o prazo: ' + (Date.now() - t0) + ' ms');
});

test('identidade de outro banco: FALHA (2) depois da trava, sem escrita, unlock feito', async () => {
  const C = clienteFalso({identidade: {...ID_STG, db: 'kidmais_production'}});
  const {codigo, saida} = await s.principal(['--aplicar-autorizado', '120', '--backup', BACKUP], ENV_STG, {Client: C});
  assert.equal(codigo, 2); assert.match(saida.mensagem, /IDENTIDADE_RECUSADA/); assert.equal(saida.commit, 'NAO_COMMITADA');
  assert.ok(!C.log.some(x => x.sql === 'BEGIN')); assert.equal(C.log.at(-1).sql, s.SQL.destrava);
});

test('chaves da trava: staging:<id> pela mesma função do registro; SQL da trava é o do registro', () => {
  assert.deepEqual([...s.CHAVES_TRAVA], s.IDS.map(id => 'staging:' + id));
  assert.equal(s.SQL.trava, reg.SQL.travaSessao);
  assert.match(s.SQL.destrava, /pg_advisory_unlock\(hashtext\('kidmais-migration'\), hashtext\(\$1::text\)\)/);
});

test('estático: sem marcador nem disco, sem connectionString, sem DATABASE_URL lida fora do alvo', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'migration-generico-staging.cjs'), 'utf8');
  for (const proibido of ['writeFileSync', 'mkdirSync', 'exigirDisco', 'stg.DISCO', 'connectionString', 'marcadorDe']) assert.ok(!fonte.includes(proibido), proibido);
});
