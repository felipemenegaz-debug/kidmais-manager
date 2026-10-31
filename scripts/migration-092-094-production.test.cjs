/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 092–094 de PRODUÇÃO com cliente simulado: trava de alvo e identidade de produção, escopos separados
// (092-093 com o código antigo; 094 depois do deploy), prova de que o escopo 092-093 nunca alcança a 094 (inclusive com
// 092/093 já completas), marcadores independentes por escopo, conferência só leitura com o plano de cada escopo e a
// integridade da 094 com o corpo da 100. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comum = require('./migration-092-094-comum.cjs');
const prod = require('./migration-092-094-production.cjs');
const stg = require('./migration-092-094-staging.cjs');
const ev108 = require('./migration-108-evidencias.cjs');
const retrato108 = require('./migration-108-retrato.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const BACKUP = 'dump 2026-11-01T03:00Z sha 1234abcd PITR';
const BASE_OK = Object.fromEntries(Object.keys(comum.BASE).map(k => [k, k !== 'papel_trocado']));
BASE_OK.papel_trocado = true;
const estado = (completas = [], extra = {}) => ({...BASE_OK,
  ...Object.fromEntries(comum.IDS.flatMap(id => Object.keys(comum.OBJETOS[id]).map(k => [k, completas.includes(id)]))), ...extra});
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return comum.lerRevisado(raiz, a, h); };
const MIGRACAO = new Map(comum.IDS.map(id => [ler('migration ' + id), id]));
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const INSTALA = id => ['precheck', 'migration', 'postcheck', 'integridade'].map(t => `${t} ${id}`);

/** Nenhuma evidência da 108 (linha de SQL_EVIDENCIA_108): produção ainda não recebeu a 107/108. */
const SEM_108 = Object.freeze({marcador_108: false, reparos_107: false, colunas_combinado: false, corpo_conflito_108: false, corpos_108: 0, funcoes_098_108: 0});
/** A 108 completa como as evidências a veem (estado do modelo 108). */
const COM_108 = Object.freeze({marcador_108: true, reparos_107: true, colunas_combinado: true, corpo_conflito_108: true, corpos_108: 3, funcoes_098_108: 10});
/** Linha da prova "108 íntegra" na sessão do retrato (search_path pg_catalog, PostgreSQL 18). */
const PROVA_INTEGRA = Object.freeze({integra: true, motivos: [], search_path: 'pg_catalog', versao_pg: 180001});
const SQL_PROVA_FALSA = 'SELECT true AS integra, ARRAY[]::text[] AS motivos /* sqlProva108Integra falsa do teste */';
/** Como na suíte de staging: a função do módulo é trocada e a linha da prova vem do cliente simulado. */
async function comProvaFalsa(corpo) {
  const original = retrato108.sqlProva108Integra;
  retrato108.sqlProva108Integra = () => SQL_PROVA_FALSA;
  try { return await corpo(); } finally { retrato108.sqlProva108Integra = original; }
}
/** Esperado de F2 ainda não medido, SIMULADO. */
async function comF2Pendente(corpo) {
  const original = retrato108.sqlProva108Integra;
  retrato108.sqlProva108Integra = (o = {}) => original({...o, esperados: {...retrato108.carregarEsperados(), F2: {canonico: retrato108.PENDENTE}}});
  try { return await corpo(); } finally { retrato108.sqlProva108Integra = original; }
}
const ehProva = l => l.sql.startsWith('/* prova-108 */');
/** Valores do override de F2 (válido e ilegível): produção recusa os dois antes de consultar a prova. */
const overrides = () => [JSON.stringify({...JSON.parse(fs.readFileSync(path.join(raiz, retrato108.ARQUIVO_ESPERADOS), 'utf8')), F2: {canonico: 'ab'.repeat(32)}}), '{'];
/** Motivo sem âncoras, para a mensagem da FALHA. */
const solto = re => new RegExp(re.source.replace(/^\^/, '').replace(/\$$/, ''));
/** Cliente simulado (mesmo desenho da suíte de staging): a migration real marca os objetos dela; SQL_ESTADO devolve o atual. */
function clienteFalso({inicial = estado(), identidade = ID_PROD, falharEm, erro, corpoConflito = comum.CORPO_CONFLITO_094, evidencias = SEM_108, prova = PROVA_INTEGRA,
  exigirFalsa = true} = {}) {
  const log = []; let ro = false; const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') ro = false;
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_CORPO_CONFLITO) return {rows: corpoConflito ? [{h: corpoConflito}] : []};
      if (sql === ev108.SQL_EVIDENCIA_108) return {rows: [{...evidencias}]};
      if (ehProva({sql})) { assert.ok(!exigirFalsa || sql.includes(SQL_PROVA_FALSA), 'a prova envolve o SQL do gerador'); return {rows: [{...prova}]}; }
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      const id = MIGRACAO.get(sql);
      if (id) { assert.equal(ro, false, 'migration nunca dentro de READ ONLY'); for (const k of Object.keys(comum.OBJETOS[id])) atual[k] = true; }
      if (sql.startsWith('SELECT (SELECT count(*) FROM precos_pacote)')) return {rows: [{precos: 30, horarios: 8, festas: 120}]};
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-092-094-prod-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));
const tocou094 = log => log.some(x => MIGRACAO.get(x.sql) === '094' || /094 (precheck|postcheck) OK/.test(x.sql));
const i0 = (saida, s) => saida.ordem.findIndex(o => o.includes(s));
const aplicar = (escopo, dir, opcoes = {}) => prod.principal([comum.ESCOPOS[escopo].flag, '--backup', BACKUP], ENV_PROD, {dir, Client: clienteFalso(opcoes), disco: semDisco});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-092-094-production');
  assert.equal(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl.rejectUnauthorized, true);
  for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/], [{DATABASE_SSL: undefined}, /TLS_OBRIGATORIO/],
    [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]])
    assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), erro);
  // Mensagens só com o código: nunca URL, senha ou host.
  for (const delta of [{DATABASE_URL: URL_PROD + '?password=SEGREDO'}, {DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { prod.alvo({...ENV_PROD, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
  // Cruzamento: o adaptador de staging recusa o ambiente de produção e vice-versa.
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO/);
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada', () => {
  assert.deepEqual(prod.identidade(ID_PROD), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/],
    [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-092-094-prod')), /DISCO_PERSISTENTE_AUSENTE/);
});

test('modo: produção só aceita os escopos 092-093 e 094 (cada um com --backup); a aplicação conjunta é recusada; staging recusa as flags de produção', () => {
  assert.deepEqual(prod.escopos, ['092-093', '094']);
  assert.deepEqual(comum.modo(['--aplicar-092-093-autorizado', '--backup', BACKUP], prod.escopos), {modo: 'aplicar', escopo: '092-093', backup: BACKUP});
  assert.deepEqual(comum.modo(['--aplicar-094-autorizado', '--backup', BACKUP], prod.escopos), {modo: 'aplicar', escopo: '094', backup: BACKUP});
  assert.deepEqual(comum.modo(['--conferir-092-094'], prod.escopos), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--conferir-092-093'], prod.escopos), {modo: 'conferir', escopo: '092-093'});
  assert.deepEqual(comum.modo(['--conferir-094'], prod.escopos), {modo: 'conferir', escopo: '094'});
  assert.throws(() => comum.modo(['--conferir-094', '--backup', BACKUP], prod.escopos), /ARGUMENTOS_RECUSADOS/);
  for (const flag of ['--conferir-092-093', '--conferir-094']) assert.throws(() => comum.modo([flag]), /ARGUMENTOS_RECUSADOS/, 'staging recusa ' + flag);
  assert.throws(() => comum.modo(['--aplicar-092-094-autorizado', '--backup', BACKUP], prod.escopos), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--aplicar-094-autorizado'], prod.escopos), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-092-093-autorizado', '--backup', 'x;rm -rf /'], prod.escopos), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--aplicar-092-093-autorizado', '--aplicar-094-autorizado', '--backup', BACKUP], prod.escopos), /BACKUP_OBRIGATORIO/);
  for (const flag of ['--aplicar-092-093-autorizado', '--aplicar-094-autorizado'])
    assert.throws(() => comum.modo([flag, '--backup', BACKUP]), /ARGUMENTOS_RECUSADOS/, 'staging (todas) recusa ' + flag);
  assert.throws(() => comum.planoEtapas(comum.lerEstado(estado()), 'outro'), /ESCOPO_DESCONHECIDO/);
});

test('escopo 092-093 nunca alcança a 094: em nenhum estado válido o plano tem etapa da 094; com a 094 presente recusa', () => {
  const p = (c, x) => comum.planoEtapas(comum.lerEstado(estado(c, x)), '092-093');
  assert.deepEqual(p([]), [...INSTALA('092'), ...INSTALA('093')]);
  assert.deepEqual(p(['092']), ['integridade 092', ...INSTALA('093')]);
  assert.deepEqual(p(['092', '093']), ['integridade 092', 'integridade 093'], '092/093 completas: só confere, nada da 094');
  // Dependência e privilégios da 094 não contam no escopo 092-093 (não é aplicada).
  assert.deepEqual(p([], {d094: false, dono_094: false, referencias_094: false}), [...INSTALA('092'), ...INSTALA('093')]);
  assert.throws(() => p(['092', '093', '094']), /ESCOPO_092_093_EXIGE_094_AUSENTE/);
  for (const k of Object.keys(comum.OBJETOS['094'])) assert.throws(() => p(['092', '093'], {[k]: true}), /APLICACAO_PARCIAL_094/, k);
  for (const c of [[], ['092'], ['092', '093']]) assert.ok(!p(c).some(n => n.endsWith(' 094')), c.join('+') || 'nenhuma');
});

test('escopo 094: exige 092 e 093 completas; confere as duas e instala só a 094; já aplicada só confere', () => {
  const p = (c, x) => comum.planoEtapas(comum.lerEstado(estado(c, x)), '094');
  assert.deepEqual(p(['092', '093']), ['integridade 092', 'integridade 093', ...INSTALA('094')]);
  assert.deepEqual(p(['092', '093', '094']), ['integridade 092', 'integridade 093', 'integridade 094']);
  for (const c of [[], ['092']]) assert.throws(() => p(c), /ESCOPO_094_EXIGE_092_093_COMPLETAS/, c.join('+') || 'nenhuma');
  assert.throws(() => p(['092', '093'], {dono_094: false}), / SEM_PRIVILEGIO_094 DONO$/);
  assert.throws(() => p(['092', '093'], {d094: false}), /DEPENDENCIA_AUSENTE_094/);
});

test('E3 (escopo 092-093) a partir do zero: só as migrations 092 e 093 fora de READ ONLY; 094 continua ausente; marcador próprio', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso();
    const {codigo, saida: r} = await prod.principal(['--aplicar-092-093-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: C, disco: semDisco});
    assert.equal(codigo, 0, JSON.stringify(r)); assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(r.escopo, '092-093');
    assert.deepEqual(r.etapas, [...INSTALA('092'), ...INSTALA('093')]); assert.deepEqual(r.migracoesCommitadas, ['092', '093']);
    assert.deepEqual(escritas(C.log).map(x => MIGRACAO.get(x.sql)), ['092', '093'], 'as únicas escritas são 092 e 093');
    assert.equal(tocou094(C.log), false, 'nenhuma consulta da instalação da 094');
    assert.equal(r.estadoDepois.m094, 'ausente');
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, 'migration-092-093.json'), 'utf8'));
    assert.equal(marcador.situacao, 'CONCLUIDA'); assert.equal(marcador.escopo, '092-093'); assert.equal(marcador.ambiente, 'production'); assert.equal(marcador.backup, BACKUP);
    assert.ok(!JSON.stringify(marcador).includes('SENHA_FALSA') && !JSON.stringify(marcador).includes('postgresql://'));
    assert.equal(fs.existsSync(path.join(dir, 'migration-094.json')), false);
    // Repetir o E3 é recusado antes de conectar.
    const D = clienteFalso();
    await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, escopo: '092-093', dir, Client: D, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(D.log.length, 0);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('E3 com 092/093 já completas: só integridades, nenhuma escrita, nada da 094; com a 094 presente: FALHA sem escrita', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado(['092', '093'])});
    const {codigo, saida: r} = await aplicar('092-093', dir, {inicial: estado(['092', '093'])});
    assert.equal(codigo, 0); assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.etapas, ['integridade 092', 'integridade 093']);
    const r2 = await prod.executar({env: ENV_PROD, backup: BACKUP, escopo: '092-093', dir: tmp(), Client: C, disco: semDisco});
    assert.deepEqual(escritas(C.log), []); assert.equal(tocou094(C.log), false); assert.equal(r2.resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({inicial: estado(['092', '093', '094'])});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, escopo: '092-093', dir: dir2, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /ESCOPO_092_093_EXIGE_094_AUSENTE/);
    assert.deepEqual(escritas(C.log), []); assert.deepEqual(r.migracoesCommitadas, []);
    assert.equal((await aplicar('092-093', tmp(), {inicial: estado(['092', '093', '094'])})).codigo, 2);
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('E3 com falha na 093: a 092 fica commitada, a 093 desfeita ou indeterminada, e a 094 nunca é tentada', async () => {
  for (const [erro, indeterminada] of [[erroPg('55P03', 'lock timeout'), null], [new Error('Connection terminated unexpectedly'), '093']]) {
    const dir = tmp();
    try {
      const C = clienteFalso({falharEm: 'CREATE TABLE agenda_escopo_config', erro});
      const r = await prod.executar({env: ENV_PROD, backup: BACKUP, escopo: '092-093', dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, 'migration 093'); assert.deepEqual(r.migracoesCommitadas, ['092']);
      assert.equal(r.migracaoIndeterminada, indeterminada); assert.equal(tocou094(C.log), false);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('E6 (escopo 094) depois do E3: confere 092/093 em READ ONLY e instala só a 094; marcador próprio, independente do E3', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'migration-092-093.json'), '{"situacao":"CONCLUIDA"}');
    const C = clienteFalso({inicial: estado(['092', '093'])});
    const {codigo, saida: r} = await prod.principal(['--aplicar-094-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: C, disco: semDisco});
    assert.equal(codigo, 0, JSON.stringify(r)); assert.equal(r.escopo, '094');
    assert.deepEqual(r.etapas, ['integridade 092', 'integridade 093', ...INSTALA('094')]); assert.deepEqual(r.migracoesCommitadas, ['094']);
    assert.deepEqual(escritas(C.log).map(x => MIGRACAO.get(x.sql)), ['094']);
    for (const t of ['092 integridade OK', '093 integridade OK']) assert.ok(C.log.find(x => x.sql.includes(t)).ro, t);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, 'migration-094.json'), 'utf8'));
    assert.equal(marcador.escopo, '094'); assert.deepEqual(marcador.tentativasAnteriores, [], 'o marcador do E3 não é tentativa do E6');
    assert.deepEqual([r.estadoDepois.m092, r.estadoDepois.m093, r.estadoDepois.m094], ['completa', 'completa', 'completa']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  // Sem o E3: recusa antes de qualquer escrita.
  const dir2 = tmp();
  try {
    const C = clienteFalso({inicial: estado(['092'])});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, escopo: '094', dir: dir2, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /ESCOPO_094_EXIGE_092_093_COMPLETAS/); assert.deepEqual(escritas(C.log), []);
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
});

test('escopo fora do ambiente é recusado antes de conectar (produção não executa a aplicação conjunta)', async () => {
  const C = clienteFalso();
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, escopo: 'todas', dir: tmp(), Client: C, disco: semDisco}), /ESCOPO_RECUSADO/);
  assert.equal(C.log.length, 0);
  await assert.rejects(stg.executar({env: {}, backup: BACKUP, escopo: '094', dir: tmp(), Client: C, disco: semDisco}), /ESCOPO_RECUSADO/);
});

test('conferência de produção: só leitura, nada no disco; informa o plano de cada escopo no estado atual', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Zero = clienteFalso();
    const r = await prod.conferir({env: ENV_PROD, Client: Zero});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.planos['092-093'], [...INSTALA('092'), ...INSTALA('093')]);
    assert.match(r.planos['094'].recusaria, /ESCOPO_094_EXIGE_092_093_COMPLETAS/);
    assert.deepEqual(escritas(Zero.log), []);
    const Meio = clienteFalso({inicial: estado(['092', '093'])});
    const m = await prod.conferir({env: ENV_PROD, Client: Meio});
    assert.deepEqual(m.planos['092-093'], ['integridade 092', 'integridade 093']);
    assert.deepEqual(m.planos['094'], ['integridade 092', 'integridade 093', ...INSTALA('094')]);
    const Toda = clienteFalso({inicial: estado(['092', '093', '094']), corpoConflito: comum.CORPO_CONFLITO_100});
    const t = await prod.conferir({env: ENV_PROD, Client: Toda});
    assert.equal(t.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.equal(t.checks['integridade 094'], 'PASS_CORPO_100');
    assert.match(t.planos['092-093'].recusaria, /ESCOPO_092_093_EXIGE_094_AUSENTE/);
    assert.deepEqual(escritas(Toda.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  // A conferência de staging continua sem `planos` (escopo único).
  assert.equal((await stg.conferir({env: {RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
    DATABASE_URL: 'postgresql://u:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'}, Client: clienteFalso({identidade: {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true}})})).planos, undefined);
  assert.equal((await prod.conferir({env: ENV_PROD, Client: clienteFalso({identidade: {...ID_PROD, db: 'outro'}})})).resultado, 'FALHA');
});

test('plano sem conexão de produção: escopos, flags e marcadores separados, ordem E3/E6 e nunca a 094 no escopo 092-093', async () => {
  const {codigo, saida} = await prod.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(Object.keys(saida.modos), ['conferir', 'conferir 092-093', 'conferir 094', 'aplicar 092-093', 'aplicar 094']);
  assert.ok(i0(saida, '--conferir-092-093') < i0(saida, '--aplicar-092-093-autorizado') && i0(saida, '--conferir-094') < i0(saida, '--aplicar-094-autorizado'), 'cada etapa usa a conferência do próprio escopo');
  assert.ok(!saida.ordem.includes('--conferir-092-094'), 'o diagnóstico global não é passo do runbook');
  assert.deepEqual(saida.marcadores, {'092-093': 'migration-092-093.json', '094': 'migration-094.json'});
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [...comum.ETAPAS, comum.INTEGRIDADE_094_APOS_100, comum.INTEGRIDADE_094_APOS_108].map(e => e[2]));
  assert.ok(saida.nuncaExecuta.includes('migration 094 na execução do escopo 092-093'));
  for (const id of comum.IDS) assert.ok(saida.nuncaExecuta.includes('down ' + id));
  const i = s => saida.ordem.findIndex(o => o.includes(s));
  assert.ok(i('--aplicar-092-093-autorizado') < i('deploy do código novo') && i('deploy do código novo') < i('--aplicar-094-autorizado'), 'E3 → deploy → E6');
  assert.ok(saida.ordem.some(o => /094 AUSENTE/.test(o)) && saida.ordem.some(o => /backup restaurável de production/.test(o)));
  assert.equal(prod.DIR, '/opt/render/project/src/data/agenda-precos-092-094-producao');
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
});

test('P2 da revisão: a conferência do E3 não depende de requisitos exclusivos da 094 (dono, dependência, REFERENCES); a global mostra os planos antes de recusar', async () => {
  for (const [rotulo, extra] of [['dono_094', {dono_094: false}], ['d094', {d094: false}], ['referencias_094', {referencias_094: false}],
    ['os três', {dono_094: false, d094: false, referencias_094: false}]]) {
    for (const [completas, resultado, plano] of [[['092', '093'], 'JA_APLICADA_INTEGRIDADE_PASS', ['integridade 092', 'integridade 093']],
      [[], 'PRONTA_PARA_APLICAR', [...INSTALA('092'), ...INSTALA('093')]], [['092'], 'PRONTA_PARA_APLICAR', ['integridade 092', ...INSTALA('093')]]]) {
      const C = clienteFalso({inicial: estado(completas, extra)});
      const {codigo, saida: r} = await prod.principal(['--conferir-092-093'], ENV_PROD, {Client: C});
      const caso = rotulo + ' / ' + (completas.join('+') || 'nenhuma');
      assert.equal(codigo, 0, caso + ' ' + JSON.stringify(r)); assert.equal(r.escopo, '092-093'); assert.equal(r.resultado, resultado, caso);
      assert.deepEqual(r.plano, plano, caso);
      assert.deepEqual(Object.keys(r.checks), ['092', '093'].map(id => (completas.includes(id) ? 'integridade ' : 'precheck ') + id), caso);
      assert.equal(tocou094(C.log), false, caso + ': nada da 094'); assert.deepEqual(escritas(C.log), [], caso);
    }
    // A conferência do E6 recusa pelo requisito da 094 (código 3) e a global também, mas a global traz os planos por escopo.
    const e6 = await prod.principal(['--conferir-094'], ENV_PROD, {Client: clienteFalso({inicial: estado(['092', '093'], extra)})});
    assert.equal(e6.codigo, 3, rotulo); assert.equal(e6.saida.resultado, 'RECUSARIA'); assert.match(e6.saida.motivo, /094/);
    const g = await prod.principal(['--conferir-092-094'], ENV_PROD, {Client: clienteFalso({inicial: estado(['092', '093'], extra)})});
    assert.equal(g.codigo, 3, rotulo); assert.deepEqual(g.saida.planos['092-093'], ['integridade 092', 'integridade 093'], rotulo);
    assert.match(g.saida.planos['094'].recusaria, /094/, rotulo);
  }
});

test('conferência por escopo: E6 confere 092/093 e o precheck da 094; E3 com a 094 presente recusa (código 3); escopo fora do ambiente é recusado', async () => {
  const C = clienteFalso({inicial: estado(['092', '093'])});
  const {codigo, saida: r} = await prod.principal(['--conferir-094'], ENV_PROD, {Client: C});
  assert.equal(codigo, 0); assert.equal(r.resultado, 'PRONTA_PARA_APLICAR');
  assert.deepEqual(r.checks, {'integridade 092': 'PASS', 'integridade 093': 'PASS', 'precheck 094': 'PASS'}); assert.deepEqual(escritas(C.log), []);
  const t = await prod.principal(['--conferir-094'], ENV_PROD, {Client: clienteFalso({inicial: estado(['092', '093', '094']), corpoConflito: comum.CORPO_CONFLITO_100})});
  assert.equal(t.codigo, 0); assert.equal(t.saida.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.equal(t.saida.checks['integridade 094'], 'PASS_CORPO_100');
  const e3 = await prod.principal(['--conferir-092-093'], ENV_PROD, {Client: clienteFalso({inicial: estado(['092', '093', '094'])})});
  assert.equal(e3.codigo, 3); assert.match(e3.saida.motivo, /ESCOPO_092_093_EXIGE_094_AUSENTE/);
  await assert.rejects(prod.conferir({env: ENV_PROD, escopo: 'todas', Client: clienteFalso()}), /ESCOPO_RECUSADO/);
  await assert.rejects(stg.conferir({env: {}, escopo: '092-093', Client: clienteFalso()}), /ESCOPO_RECUSADO/);
});

// C-F1: produção que JÁ tem a 108. Os casos passam pelo adaptador de produção (prod.principal), que encaminha a prova
// (env do serviço, sem override de teste) e o escopo ao núcleo.
const ORIGINAL_094 = () => ler('integridade 094');
const APOS_100 = () => comum.lerRevisado(raiz, comum.INTEGRIDADE_094_APOS_100[1], comum.INTEGRIDADE_094_APOS_100[2]);
const APOS_108 = () => comum.lerRevisado(raiz, comum.INTEGRIDADE_094_APOS_108[1], comum.INTEGRIDADE_094_APOS_108[2]);
const COMPLETA_108 = Object.freeze({inicial: estado(['092', '093', '094']), corpoConflito: comum.CORPO_CONFLITO_108, evidencias: COM_108});

test('C-F1: produção com a 108 íntegra: E6 e a global passam pela prova (READ ONLY, pg_catalog) e pela integridade após a 108; aplicar só confere; E3 recusa', async () => {
  await comProvaFalsa(async () => {
    for (const flag of ['--conferir-094', '--conferir-092-094']) {
      const C = clienteFalso(COMPLETA_108);
      const {codigo, saida: r} = await prod.principal([flag], ENV_PROD, {Client: C});
      assert.equal(codigo, 0, flag + ' ' + JSON.stringify(r)); assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', flag);
      assert.equal(r.checks['integridade 094'], 'PASS_CORPO_108', flag);
      const i = C.log.findIndex(ehProva);
      assert.ok(i > 0 && C.log[i].ro && C.log.slice(i - 4, i).some(l => l.sql === 'SET LOCAL search_path = pg_catalog'), flag + ': prova READ ONLY com pg_catalog');
      assert.ok(C.log.findIndex(l => l.ro && l.sql === APOS_108()) > i, flag + ': integridade após a 108 depois da prova');
      assert.ok(!C.log.some(l => l.sql === APOS_100() || l.sql === ORIGINAL_094()), flag + ': nunca as outras variantes');
      assert.deepEqual(escritas(C.log), [], flag);
    }
    // E6 com a 094 já completa e a 108 íntegra: só integridades, nenhuma escrita; o marcador do E6 registra PASS_CORPO_108.
    const dir = tmp();
    try {
      const A = clienteFalso(COMPLETA_108);
      const {codigo, saida: r} = await prod.principal(['--aplicar-094-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: A, disco: semDisco});
      assert.equal(codigo, 0, JSON.stringify(r)); assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.equal(r.escopo, '094');
      assert.deepEqual(escritas(A.log), []); assert.ok(A.log.some(ehProva) && A.log.some(l => l.ro && l.sql === APOS_108()));
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'migration-094.json'), 'utf8'));
      assert.equal(m.etapas.find(y => y.nome === 'integridade 094').integridade, 'PASS_CORPO_108');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    // E3 com a 108 (logo, a 094) presente: recusa pela 094 presente; aplicar não escreve.
    const e3 = await prod.principal(['--conferir-092-093'], ENV_PROD, {Client: clienteFalso(COMPLETA_108)});
    assert.equal(e3.codigo, 3); assert.match(e3.saida.motivo, /ESCOPO_092_093_EXIGE_094_AUSENTE/);
    const dir3 = tmp();
    try {
      const A = clienteFalso(COMPLETA_108);
      const e = await prod.principal(['--aplicar-092-093-autorizado', '--backup', BACKUP], ENV_PROD, {dir: dir3, Client: A, disco: semDisco});
      assert.equal(e.codigo, 2); assert.match(e.saida.falha.mensagem, /ESCOPO_092_093_EXIGE_094_AUSENTE/); assert.deepEqual(escritas(A.log), []);
      assert.equal(tocou094(A.log), false);
    } finally { fs.rmSync(dir3, {recursive: true, force: true}); }
  });
});

test('C-F1: produção com a 108 não íntegra, parcial ou corpo desconhecido: E6 e global RECUSARIA (código 3), aplicar E6 FALHA (código 2), nada escrito', async () => {
  const completas = estado(['092', '093', '094']);
  const casos = [
    [{...COMPLETA_108, prova: {...PROVA_INTEGRA, integra: false, motivos: ['MARCADOR_108', 'RETRATO_F2']}}, /^PROVA_108_NAO_INTEGRA MARCADOR_108 RETRATO_F2$/, true],
    [{...COMPLETA_108, prova: {...PROVA_INTEGRA, integra: false, motivos: ['GATILHOS_098']}}, /^PROVA_108_NAO_INTEGRA GATILHOS_098$/, true],
    [{...COMPLETA_108, prova: {...PROVA_INTEGRA, versao_pg: 170004}}, /SESSAO_PROVA_108 versao_pg/, true],
    [{inicial: completas, corpoConflito: comum.CORPO_CONFLITO_100, evidencias: {...SEM_108, marcador_108: true}}, /^EVIDENCIA_108_PARCIAL marcador_108$/, false],
    [{inicial: completas, corpoConflito: comum.CORPO_CONFLITO_094, evidencias: {...SEM_108, funcoes_098_108: 2}}, /^EVIDENCIA_108_PARCIAL funcoes_098_108$/, false],
    [{inicial: completas, corpoConflito: comum.CORPO_CONFLITO_100, evidencias: {...SEM_108, corpos_108: 1}}, /^EVIDENCIA_108_PARCIAL corpos_108$/, false],
    [{inicial: completas, corpoConflito: 'f'.repeat(64)}, /^CORPO_CONFLITO_DESCONHECIDO_094$/, false],
    [{inicial: completas, corpoConflito: null}, /^CORPO_CONFLITO_DESCONHECIDO_094$/, false]];
  await comProvaFalsa(async () => {
    for (const [opcoes, motivo, comProva] of casos) {
      for (const flag of ['--conferir-094', '--conferir-092-094']) {
        const C = clienteFalso(opcoes);
        const x = await prod.principal([flag], ENV_PROD, {Client: C});
        const caso = flag + ' ' + motivo;
        assert.equal(x.codigo, 3, caso + ' ' + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA', caso);
        assert.match(x.saida.motivo, motivo, caso); assert.equal(x.saida.checks['integridade 094'], 'RECUSADA', caso);
        assert.equal(C.log.some(ehProva), comProva, caso + ': prova só com o corpo da 108');
        assert.ok(!C.log.some(l => l.sql === APOS_108() || l.sql === APOS_100() || l.sql === ORIGINAL_094()), caso + ': nenhuma integridade da 094');
        assert.deepEqual(escritas(C.log), [], caso);
      }
      const dir = tmp();
      try {
        const A = clienteFalso(opcoes);
        const e = await prod.principal(['--aplicar-094-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: A, disco: semDisco});
        assert.equal(e.codigo, 2, String(motivo) + ' ' + JSON.stringify(e.saida)); assert.match(e.saida.falha.mensagem, solto(motivo));
        assert.deepEqual(escritas(A.log), [], String(motivo));
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
  });
});

test('C-F1: a prova da 108 em produção vem do adaptador: F2 não medido recusa sem consultar; override de retratos de teste sempre recusado', async () => {
  for (const flag of ['--conferir-094', '--conferir-092-094']) {
    const C = clienteFalso(COMPLETA_108);
    const x = await comF2Pendente(() => prod.principal([flag], ENV_PROD, {Client: C}));
    assert.equal(x.codigo, 3, flag); assert.match(x.saida.motivo, /^PROVA_108_NAO_INTEGRA PROVA_108_INDISPONIVEL RETRATO_108_NAO_MEDIDO/, flag);
    assert.ok(!C.log.some(ehProva), flag);
  }
  // O env do serviço chega à prova (encaminhamento) e produção nunca aceita o override (aceitaTeste = false).
  for (const valor of overrides()) {
    const env = {...ENV_PROD, [ev108.ENV_RETRATOS_TESTE]: valor};
    for (const flag of ['--conferir-094', '--conferir-092-094']) {
      const C = clienteFalso({...COMPLETA_108, exigirFalsa: false});
      const x = await prod.principal([flag], env, {Client: C});
      assert.equal(x.codigo, 3, flag); assert.match(x.saida.motivo, /^RETRATOS_DE_TESTE_RECUSADOS/, flag);
      assert.ok(!C.log.some(ehProva), flag);
    }
    const dir = tmp();
    try {
      const A = clienteFalso({...COMPLETA_108, exigirFalsa: false});
      const e = await prod.principal(['--aplicar-094-autorizado', '--backup', BACKUP], env, {dir, Client: A, disco: semDisco});
      assert.equal(e.codigo, 2); assert.match(e.saida.falha.mensagem, /RETRATOS_DE_TESTE_RECUSADOS/); assert.deepEqual(escritas(A.log), []);
      assert.ok(!A.log.some(ehProva));
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});
