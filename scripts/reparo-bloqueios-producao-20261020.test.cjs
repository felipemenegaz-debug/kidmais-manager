/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline do executor do reparo de 20/10: cliente simulado e pastas temporárias, sem banco nem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const r = require('./reparo-bloqueios-producao-20261020.cjs');

const sql = r.lerSql();
const URL_OK = 'postgresql://usuario:segredo@dpg-dak750gae00c73fudmg0-a/kidmais_production';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_OK});
const ID_OK = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true, pg_major: 18};
const SCHEMA_OK = {tabela_bloqueios: true, tabela_resolucao: true, tabela_empresas: true, coluna_empresa: true, coluna_unidade: true,
  funcao_trava_datas: true, funcao_alcance: true, funcao_ocupacoes: true, gatilhos: [...r.GATILHOS_ESPERADOS], papel_trocado: false};
const PRIV_OK = {bloqueios: true, resolucao: true, empresas: true, trava_datas: true};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reparo-20261020-'));

function alvoRow(a, estado, extra = {}) {
  const intacto = estado === 'INTACTO';
  return {ordem: a.ordem, data: a.data, passado: a.data < '2026-10-20', existe: true, data_confere: true, ativo: true, sem_empresa: intacto,
    da_kidmais: !intacto, sem_unidade: true, formato: true, resolucao: !intacto, resolucao_kidmais: !intacto, conflitos: 0, ...extra};
}
function situacao(estado, extra = {}, porAlvo = () => ({})) {
  const intacto = estado === 'INTACTO';
  return {hoje: '2026-10-20', empresas: 1, kidmais: 1, kidmais_id_confere: true, alvos: r.ALVOS.map(a => alvoRow(a, estado, porAlvo(a))),
    globais_ativos: intacto ? 5 : 0, globais_futuros: intacto ? 4 : 0, globais_futuros_fora_do_alvo: 0, globais_passados_fora_do_alvo: 0,
    bloqueios_total: 9, bloqueios_ativos: 7, bloqueios_ativos_kidmais: intacto ? 2 : 7, resolucoes_total: intacto ? 0 : 5, ...extra};
}
/** Cliente simulado: estado INTACTO até o SQL do reparo rodar; `falharSql` simula erro dentro da transação. */
function cliente({id = ID_OK, inicial = 'INTACTO', falharSql = null, trava = true, extra = {}, porAlvo} = {}) {
  const log = []; let estado = inicial;
  return {log, get estado() { return estado; }, async query(t) {
    log.push(t);
    if (t === r.SQL_IDENTIDADE) return {rows: [id]};
    if (t === r.SQL_SCHEMA) return {rows: [SCHEMA_OK]};
    if (t === r.SQL_PRIVILEGIOS) return {rows: [PRIV_OK]};
    if (t === r.SQL_SITUACAO) return {rows: [situacao(estado, estado === 'INTACTO' ? extra : {}, porAlvo)]};
    if (t === r.SQL_TRAVA) return {rows: [{trava}]};
    if (t === sql) { if (falharSql) throw new Error(falharSql); estado = 'REPARADO'; return []; }
    return {rows: []};
  }};
}

test('SQL revisado intacto: sha fixo (o mesmo do corte de 13/10), alvo fixo, autorização de sessão, sem DELETE nem desativação', () => {
  assert.equal(createHash('sha256').update(sql).digest('hex'), 'a36f8fe981d226e9ac96f1d83677666dc142265bb64ad6b19f720f982c223f85');
  assert.match(sql, /current_database\(\)<>'kidmais_production'/);
  assert.match(sql, new RegExp(`current_setting\\('kidmais.reparo_lancamento',true\\) IS DISTINCT FROM '${r.AUTORIZACAO}'`));
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b|SET ativo\s*=\s*false/i);
  for (const a of r.ALVOS) assert.equal((sql.match(new RegExp(a.id, 'g')) || []).length, 4, a.id);
  for (const a of r.ALVOS) assert.ok(sql.includes(`'${a.data}'::date`), a.data);
  assert.ok(sql.includes(r.KIDMAIS_ID));
  const corte = fs.readFileSync(path.join(__dirname, '..', 'docs/evidencias/cutover-production-comando-20261013.txt'), 'utf8');
  assert.ok(corte.includes(`"rel":"${r.SQL_ARQUIVO}","sha256":"${r.SQL_SHA256}"`), 'mesmo hash do corte de 13/10');
});

test('modo: só as combinações exatas', () => {
  assert.deepEqual(r.modo([]), {modo: 'plano'});
  assert.deepEqual(r.modo(['--conferir']), {modo: 'conferir'});
  assert.deepEqual(r.modo(['--aplicar-autorizado', '--backup', 'x']), {modo: 'aplicar', backup: 'x'});
  assert.deepEqual(r.modo(['--retomar-autorizado', '--backup', 'x']), {modo: 'retomar', backup: 'x'});
  for (const a of [['--aplicar-autorizado'], ['--conferir', '--aplicar-autorizado'], ['--aplicar', '--backup', 'x'], ['--backup', 'x', '--aplicar-autorizado']])
    assert.throws(() => r.modo(a), /USO_RECUSADO/);
});

test('trava de alvo: web de produção, host interno exato, banco, porta, TLS e URL sem query', () => {
  const o = r.alvo(ENV);
  assert.equal(o.ssl.rejectUnauthorized, false); assert.equal(o.ssl.minVersion, 'TLSv1.2');
  assert.equal(r.alvo({...ENV, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [mudanca, codigo] of [[{RENDER: undefined}, 'FORA_DO_RENDER'], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, 'SERVICO_RECUSADO'],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, 'AMBIENTE_RECUSADO'], [{DATABASE_SSL: 'false'}, 'TLS_OBRIGATORIO'], [{DATABASE_URL: 'nao-e-url'}, 'URL_RECUSADA'],
    [{DATABASE_URL: URL_OK.replace('-a/', '-a.virginia-postgres.render.com/')}, 'HOST_RECUSADO'],
    [{DATABASE_URL: URL_OK.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, 'HOST_RECUSADO'],
    [{DATABASE_URL: URL_OK.replace('kidmais_production', 'kidmais_staging_1z91')}, 'BANCO_RECUSADO'],
    [{DATABASE_URL: URL_OK.replace('-a/', '-a:5433/')}, 'PORTA_RECUSADA'], [{DATABASE_URL: URL_OK + '?sslmode=disable'}, 'CONNECTION_QUERY_REJECTED']])
    assert.throws(() => r.alvo({...ENV, ...mudanca}), new RegExp(codigo), JSON.stringify(mudanca));
});

test('identidade vista pelo servidor: banco, TLS 1.2+, rede privada, PostgreSQL 18', () => {
  assert.equal(r.conferirIdentidade(ID_OK).tlsVersao, 'TLSv1.3');
  for (const [m, c] of [[{db: 'kidmais_staging_1z91'}, 'BANCO_DIVERGENTE'], [{tls: false}, 'SEM_TLS'], [{tls_versao: 'TLSv1.1'}, 'TLS_VERSAO_RECUSADA'],
    [{servidor_privado: false}, 'SERVIDOR_FORA_DA_REDE_PRIVADA'], [{pg_major: 17}, 'VERSAO_POSTGRES_DIVERGENTE']])
    assert.throws(() => r.conferirIdentidade({...ID_OK, ...m}), new RegExp(c));
});

test('avaliação: APTO, JA_APLICADO e cada recusa antecipada (o que só falharia dentro da transação)', () => {
  assert.equal(r.avaliar(SCHEMA_OK, PRIV_OK, situacao('INTACTO')).resultado, 'APTO');
  assert.equal(r.avaliar(SCHEMA_OK, PRIV_OK, situacao('REPARADO')).resultado, 'JA_APLICADO');
  const casos = [
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {globais_futuros_fora_do_alvo: 1}), /CONJUNTO_GLOBAL_DIVERGENTE/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {}, a => (a.ordem === 3 ? {conflitos: 1} : {})), /CONFLITO_COM_CONTRATACAO_VIGENTE 2026-11-07:1/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {}, a => (a.ordem === 2 ? {ativo: false} : {})), /ALVOS_MISTOS_OU_DIVERGENTES .*2:DIVERGENTE/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {}, a => (a.ordem === 5 ? {existe: false} : {})), /5:AUSENTE/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {}, a => (a.ordem === 1 ? {data_confere: false} : {})), /1:DIVERGENTE/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {}, a => (a.ordem === 4 ? {resolucao: true} : {})), /4:DIVERGENTE/],
    [SCHEMA_OK, PRIV_OK, situacao('INTACTO', {kidmais_id_confere: false}), /IDENTIDADE_KIDMAIS_DIVERGENTE/],
    [{...SCHEMA_OK, gatilhos: [...r.GATILHOS_ESPERADOS, 'bloqueios_agenda:novo_trg:O']}, PRIV_OK, situacao('INTACTO'), /GATILHOS_DIVERGENTES/],
    [{...SCHEMA_OK, gatilhos: r.GATILHOS_ESPERADOS.map(g => g.replace('fr_bloqueio_proteger_trg:O', 'fr_bloqueio_proteger_trg:D'))},
      PRIV_OK, situacao('INTACTO'), /GATILHOS_DIVERGENTES/],
    [SCHEMA_OK, {...PRIV_OK, resolucao: false}, situacao('INTACTO'), /SEM_PRIVILEGIO resolucao/],
    [{...SCHEMA_OK, funcao_trava_datas: false}, null, null, /SCHEMA_AUSENTE funcao_trava_datas/],
    [SCHEMA_OK, PRIV_OK, situacao('REPARADO', {globais_futuros: 1}), /GLOBAL_FUTURO_RESTANTE/],
  ];
  for (const [s, p, x, motivo] of casos) {
    const a = r.avaliar(s, p, x);
    assert.equal(a.resultado, 'RECUSARIA'); assert.match(a.motivos.join(' | '), motivo);
  }
});

test('marcadores: primeira tentativa, retomada explícita, nunca depois de COMMIT_CONFIRMADO; marcador de 11/10 exige retomada', () => {
  const dir = tmp(), dirLancamento = tmp();
  try {
    assert.equal(path.basename(r.tentativa(false, {dir, dirLancamento}).arquivo), 'reparo.json');
    fs.writeFileSync(path.join(dir, 'reparo.json'), JSON.stringify({situacao: 'FALHA_NADA_GRAVADO'}));
    assert.throws(() => r.tentativa(false, {dir, dirLancamento}), /TENTATIVA_ANTERIOR_REVISAR reparo\.json/);
    assert.equal(path.basename(r.tentativa(true, {dir, dirLancamento}).arquivo), 'reparo.tentativa-2.json');
    fs.writeFileSync(path.join(dir, 'reparo.tentativa-2.json'), JSON.stringify({situacao: 'COMMIT_CONFIRMADO'}));
    assert.throws(() => r.tentativa(true, {dir, dirLancamento}), /JA_CONFIRMADA reparo\.tentativa-2\.json/);
    const d2 = tmp();
    fs.writeFileSync(path.join(dirLancamento, r.MARCADOR_LEGADO), '{}');
    assert.throws(() => r.tentativa(false, {dir: d2, dirLancamento}), /MARCADOR_LEGADO_REVISAR/);
    assert.equal(r.tentativa(true, {dir: d2, dirLancamento}).numero, 1);
    fs.rmSync(d2, {recursive: true});
  } finally { fs.rmSync(dir, {recursive: true}); fs.rmSync(dirLancamento, {recursive: true}); }
});

test('conferir: só leitura (nenhum SET/SQL do reparo, nenhum arquivo); flags, marcador e estado mudam o resultado', async () => {
  const dir = path.join(tmp(), 'nao-criar'), dirLancamento = tmp();
  try {
    const c = cliente();
    const s = await r.conferirNoCliente(c, {env: {}, dir, dirLancamento});
    assert.equal(s.resultado, 'CONFERIDO'); assert.equal(s.estadoDoReparo, 'APTO');
    assert.ok(!c.log.some(t => t === sql || /^SET kidmais/.test(t)), 'nada do reparo');
    assert.ok(c.log.filter(t => t === 'BEGIN TRANSACTION READ ONLY').length >= 4 && !c.log.includes('BEGIN'), 'só transações READ ONLY');
    assert.equal(fs.existsSync(dir), false);
    assert.equal((await r.conferirNoCliente(cliente(), {env: {CADASTRO_PUBLICO_ATIVO: 'true'}, dir, dirLancamento})).resultado, 'RECUSARIA');
    assert.equal((await r.conferirNoCliente(cliente({inicial: 'REPARADO'}), {env: {}, dir, dirLancamento})).resultado, 'REPARO_JA_APLICADO');
    assert.equal((await r.conferirNoCliente(cliente({extra: {globais_futuros_fora_do_alvo: 2}}), {env: {}, dir, dirLancamento})).resultado, 'RECUSARIA');
    fs.writeFileSync(path.join(dirLancamento, r.MARCADOR_LEGADO), '{}');
    const m = await r.conferirNoCliente(cliente(), {env: {}, dir, dirLancamento});
    assert.equal(m.resultado, 'RECUSARIA'); assert.match(m.motivos.join(' '), /MARCADOR_ANTERIOR/);
    await assert.rejects(r.conferirNoCliente(cliente({id: {...ID_OK, db: 'kidmais_staging_1z91'}}), {env: {}, dir, dirLancamento}), /BANCO_DIVERGENTE/);
  } finally { fs.rmSync(path.dirname(dir), {recursive: true}); fs.rmSync(dirLancamento, {recursive: true}); }
});

test('aplicar: autorização de sessão antes do SQL e RESET depois; marcador wx; pós-verificação exige os cinco reparados', async () => {
  const dir = path.join(tmp(), 'marcadores'), dirLancamento = tmp();
  try {
    const c = cliente();
    const s = await r.aplicarNoCliente(c, {sql, dir, dirLancamento});
    assert.equal(s.resultado, 'PASS', JSON.stringify(s)); assert.equal(s.gravado, true);
    const i = c.log.indexOf(sql);
    assert.equal(c.log[i - 1], `SET kidmais.reparo_lancamento = '${r.AUTORIZACAO}'`);
    assert.equal(c.log[i + 1], 'RESET kidmais.reparo_lancamento');
    assert.ok(c.log.indexOf(r.SQL_TRAVA) < i && c.log.at(-1) === r.SQL_SOLTAR);
    const mk = JSON.parse(fs.readFileSync(path.join(dir, 'reparo.json'), 'utf8'));
    assert.equal(mk.situacao, 'COMMIT_CONFIRMADO'); assert.equal(mk.sql.sha256, r.SQL_SHA256); assert.equal(mk.depois.globais_futuros, 0);
    // Repetição: marcador recusa antes de qualquer SQL de escrita; com o estado já reparado, recusa também pelo estado.
    const c2 = cliente({inicial: 'REPARADO'});
    const s2 = await r.aplicarNoCliente(c2, {sql, dir, dirLancamento});
    assert.equal(s2.resultado, 'FALHA'); assert.match(s2.falha, /ESTADO_NAO_APTO JA_APLICADO/); assert.ok(!c2.log.includes(sql));
    const c3 = cliente();
    const s3 = await r.aplicarNoCliente(c3, {sql, dir, dirLancamento});
    assert.equal(s3.resultado, 'FALHA'); assert.match(s3.falha, /TENTATIVA_ANTERIOR_REVISAR/); assert.equal(s3.gravado, false); assert.ok(!c3.log.includes(sql));
  } finally { fs.rmSync(path.dirname(dir), {recursive: true}); fs.rmSync(dirLancamento, {recursive: true}); }
});

test('falha dentro da transação: ROLLBACK, RESET, marcador FALHA_NADA_GRAVADO; retomada explícita conclui', async () => {
  const dir = path.join(tmp(), 'marcadores'), dirLancamento = tmp();
  try {
    const c = cliente({falharSql: 'canceling statement due to lock timeout'});
    const s = await r.aplicarNoCliente(c, {sql, dir, dirLancamento});
    assert.equal(s.resultado, 'FALHA'); assert.equal(s.gravado, false); assert.match(s.falha, /lock timeout/);
    const i = c.log.indexOf(sql);
    assert.deepEqual(c.log.slice(i + 1, i + 3), ['ROLLBACK', 'RESET kidmais.reparo_lancamento']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'reparo.json'), 'utf8')).situacao, 'FALHA_NADA_GRAVADO');
    const s2 = await r.aplicarNoCliente(cliente(), {sql, dir, dirLancamento});
    assert.match(s2.falha, /TENTATIVA_ANTERIOR_REVISAR/);
    const s3 = await r.aplicarNoCliente(cliente(), {sql, retomar: true, dir, dirLancamento});
    assert.equal(s3.resultado, 'PASS'); assert.equal(path.basename(s3.marcador), 'reparo.tentativa-2.json');
    // Estado não APTO (global fora do alvo) recusa antes do marcador e do SQL.
    const d2 = path.join(tmp(), 'm');
    const c4 = cliente({extra: {globais_futuros_fora_do_alvo: 1}});
    const s4 = await r.aplicarNoCliente(c4, {sql, dir: d2, dirLancamento});
    assert.match(s4.falha, /ESTADO_NAO_APTO RECUSARIA CONJUNTO_GLOBAL_DIVERGENTE/); assert.equal(fs.existsSync(d2), false); assert.ok(!c4.log.includes(sql));
    fs.rmSync(path.dirname(d2), {recursive: true});
    // Execução concorrente: trava ocupada recusa antes de ler e de gravar.
    await assert.rejects(r.aplicarNoCliente(cliente({trava: false}), {sql, dir, dirLancamento}), /EXECUCAO_CONCORRENTE/);
    await assert.rejects(r.aplicarNoCliente(cliente(), {sql: sql + ' ', dir, dirLancamento}), /SQL_DIVERGENTE/);
  } finally { fs.rmSync(path.dirname(dir), {recursive: true}); fs.rmSync(dirLancamento, {recursive: true}); }
});

test('principal: recusas antes de conectar (flags, registro de backup, backup) e códigos de saída', async () => {
  let construidos = 0;
  class Client { constructor() { construidos++; return Object.assign(cliente(), {connect: async () => {}, end: async () => {}}); } }
  const deps = {Client, disco: () => {}, conferirBackup: async () => ({criadoEm: 'x', pitrConferidoEm: 'y'})};
  const BK = '/opt/render/project/src/data/lancamento-venda-20261011/backup-20261020T0700Z.json';
  await assert.rejects(r.principal(['--aplicar-autorizado', '--backup', BK], {...ENV, ASSINATURA_PLANOS_ATIVOS: ' TRUE '}, deps), /FLAG_LIGADA ASSINATURA_PLANOS_ATIVOS/);
  await assert.rejects(r.principal(['--aplicar-autorizado', '--backup', '/tmp/backup-x.json'], ENV, deps), /REGISTRO_BACKUP_INVALIDO/);
  await assert.rejects(r.principal(['--aplicar-autorizado', '--backup', BK], ENV, {...deps, conferirBackup: async () => { throw new Error('BACKUP_ANTIGO'); }}), /BACKUP_ANTIGO/);
  await assert.rejects(r.principal(['--aplicar-autorizado', '--backup', BK], ENV, {...deps, disco: () => { throw new Error('DISCO_PERSISTENTE_AUSENTE'); }}), /DISCO_PERSISTENTE_AUSENTE/);
  await assert.rejects(r.principal(['--conferir'], {...ENV, RENDER_SERVICE_ID: 'crn-db493i142hec73ahmoe0'}, deps), /SERVICO_RECUSADO/);
  assert.equal(construidos, 0, 'nenhuma conexão nas recusas');
  const conf = await r.principal(['--conferir'], ENV, deps);
  assert.equal(conf.codigo, 0); assert.equal(conf.saida.resultado, 'CONFERIDO');
  const plano = await r.principal([], {}, deps);
  assert.equal(plano.codigo, 0); assert.equal(plano.saida.conecta, false); assert.equal(construidos, 1);
});

test('CLI: sem argumentos só o plano; argumentos errados ou fora do Render recusam antes de conectar (código 1)', () => {
  const rodar = args => spawnSync(process.execPath, [path.join(__dirname, 'reparo-bloqueios-producao-20261020.cjs'), ...args], {encoding: 'utf8', env: {PATH: process.env.PATH}, timeout: 20000});
  const p = rodar([]);
  assert.equal(p.status, 0); const j = JSON.parse(p.stdout); assert.equal(j.resultado, 'PLANO'); assert.equal(j.sql.sha256, r.SQL_SHA256);
  const u = rodar(['--aplicar-autorizado']); assert.equal(u.status, 1); assert.match(u.stderr, /USO_RECUSADO/);
  const f = rodar(['--conferir']); assert.equal(f.status, 1); assert.match(f.stderr, /FORA_DO_RENDER/);
});
