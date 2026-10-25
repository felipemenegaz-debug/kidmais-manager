/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 092 → 093 → 094 (staging) com cliente simulado: trava de alvo, identidade, hashes, estado por migration,
// ordem (só prefixos), dependências e privilégios por migration pendente, conferência só leitura (sem gravar no disco),
// backup obrigatório, marcador anti-repetição, registro do COMMIT (confirmado, desfeito pelo servidor, indeterminado),
// instalação × integridade repetível (uso legítimo entre etapas) e códigos de saída. Sem rede nem banco (a execução real
// fica em lib/agenda/aplicador-092-094.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-092-094-comum.cjs');
const stg = require('./migration-092-094-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'export 23/10 03:00Z';
const BASE_OK = Object.fromEntries(Object.keys(comum.BASE).map(k => [k, k !== 'papel_trocado']));
BASE_OK.papel_trocado = true;
/** Estado com as migrations da lista completas e as demais ausentes. */
const estado = (completas = [], extra = {}) => ({...BASE_OK,
  ...Object.fromEntries(comum.IDS.flatMap(id => Object.keys(comum.OBJETOS[id]).map(k => [k, completas.includes(id)]))), ...extra});
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return comum.lerRevisado(raiz, a, h); };
const MIGRACAO = new Map(comum.IDS.map(id => [ler('migration ' + id), id]));
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});

/**
 * Cliente simulado com estado: a migration (texto real do arquivo) marca os objetos dela; o SQL_ESTADO devolve o estado
 * corrente. Opções: `falharEm` (trecho) + `erro` (lançado; padrão erro do servidor 55P03); `naoCompleta` (migration que
 * "commita" sem criar tudo); `estadoFalhaApos` (id: a leitura de estado seguinte ao COMMIT dessa migration falha);
 * `usadas` (ids com dados operacionais: o postcheck de instalação delas recusa, a integridade aceita);
 * `adulterada` (id: a integridade dela recusa — gatilho desligado, por exemplo).
 */
function clienteFalso({inicial = estado(), identidade = ID_STG, falharEm, erro, naoCompleta, estadoFalhaApos, usadas = [], adulterada, corpoConflito} = {}) {
  const log = []; let ro = false, falharEstado = false; const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') ro = false;
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_CORPO_CONFLITO) return {rows: corpoConflito ? [{h: corpoConflito}] : []};
      if (sql === comum.SQL_ESTADO) {
        if (falharEstado) { falharEstado = false; throw new Error('Connection terminated unexpectedly'); }
        return {rows: [{...atual}]};
      }
      const id = MIGRACAO.get(sql);
      if (id) {
        assert.equal(ro, false, 'migration nunca dentro de READ ONLY');
        for (const k of Object.keys(comum.OBJETOS[id])) atual[k] = id !== naoCompleta || k.endsWith('_ponto');
        if (id === estadoFalhaApos) falharEstado = true;
      }
      for (const u of usadas) if (sql.includes(u + ' postcheck OK')) throw erroPg('P0001', `${u} postcheck: dado operacional`);
      if (adulterada && sql.includes(adulterada + ' integridade OK')) throw erroPg('P0001', `${adulterada} integridade: gatilho ausente, desligado ou ligado a outra função`);
      if (sql.startsWith('SELECT (SELECT count(*) FROM precos_pacote)')) return {rows: [{precos: 12, horarios: 4, festas: 9}]};
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-092-094-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));
const INSTALA = id => ['precheck', 'migration', 'postcheck', 'integridade'].map(t => `${t} ${id}`);
const TODAS = comum.IDS.flatMap(INSTALA);
const executar = (dir, opcoes = {}) => stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});

test('hashes fixados conferem com os 12 SQL da árvore (CRLF normalizado); divergente é recusado', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
    assert.equal(comum.lerRevisado(raiz, arquivo, hash).includes('\r'), false);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]).sort(), [...TODAS].sort());
  assert.throws(() => comum.lerRevisado(raiz, comum.ETAPAS[4][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
  // Cada migration é uma transação só no próprio arquivo (o aplicador depende disso para o estado e o COMMIT).
  for (const sql of MIGRACAO.keys()) { assert.match(sql, /^BEGIN;$/m); assert.match(sql, /^COMMIT;\s*$/m); assert.match(sql, /SET LOCAL lock_timeout = '5s'/); }
});

test('integridade repetível: só catálogo (nenhuma leitura de dados), corpos de função pelo sha256 das migrations', () => {
  const corpos = new Map();
  for (const id of comum.IDS) {
    const re = /CREATE (?:OR REPLACE )?FUNCTION\s+(?:public\.)?(\w+)\s*\([^)]*\)[\s\S]*?AS\s+(\$\w*\$)([\s\S]*?)\2/g;
    for (const m of ler('migration ' + id).matchAll(re)) corpos.set(m[1], createHash('sha256').update(m[3], 'utf8').digest('hex'));
  }
  assert.equal(corpos.size, 9, 'nove funções criadas ou substituídas na 092–094');
  const todas = comum.IDS.map(id => ler('integridade ' + id)).join('\n');
  for (const [nome, hash] of corpos) assert.ok(todas.includes(hash), `${nome}: sha256 do corpo ausente da integridade`);
  for (const id of comum.IDS) {
    const sql = ler('integridade ' + id);
    assert.match(sql, new RegExp(`RAISE NOTICE '${id} integridade OK'`));
    // Repetível: nada de dados operacionais (o que o postcheck de instalação faz) nem escrita.
    assert.doesNotMatch(sql, /\bFROM\s+(configuracao_agenda|fechamentos|fechamento_revisoes|precos_pacote|agenda_saloes|agenda_escopo_config)\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  }
  assert.match(ler('integridade 093'), /tgenabled IN \('O', 'A'\)/); assert.match(ler('integridade 094'), /convalidated/);
  // Os postchecks de instalação continuam com as provas de preservação que não valem depois do uso.
  assert.match(ler('postcheck 093'), /capacidade <> 1/); assert.match(ler('postcheck 094'), /salao_id IS NOT NULL/);
});

test('trava de alvo de staging: serviço, ambiente, TLS como a aplicação, host, banco, porta e URL sem query', () => {
  assert.equal(stg.alvo(ENV_STG).ssl, undefined);
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-092-094-staging');
  assert.deepEqual(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: undefined}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_production')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-dak750gae00c73fudmg0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-daidko3m8hqs73ce4jt0-a.oregon-postgres.render.com')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/],
    [{DATABASE_URL: URL_STG + '?ssl=false'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]])
    assert.throws(() => stg.alvo({...ENV_STG, ...delta}), erro);
});

test('mensagens da trava são só o código: nunca ecoam URL, senha, host ou serviço', () => {
  for (const delta of [{DATABASE_URL: URL_STG + '?password=SEGREDO'}, {RENDER_SERVICE_ID: 'srv-SEGREDO'}, {DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'host-SEGREDO')}]) {
    let msg = ''; try { stg.alvo({...ENV_STG, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
});

test('identidade provada pelo servidor: banco exato e TLS conforme a configuração', () => {
  assert.equal(stg.identidade(ID_STG, ENV_STG).banco, 'kidmais_staging_1z91');
  assert.throws(() => stg.identidade({...ID_STG, servidor_privado: false}, ENV_STG), /IDENTIDADE_RECUSADA/);
  assert.throws(() => stg.identidade({...ID_STG, db: 'kidmais_production'}, ENV_STG), /IDENTIDADE_RECUSADA/);
});

test('plano por estado: só prefixos; completas só passam pela integridade; pendentes ganham pre → migration → post → integridade', () => {
  const p = (c, x) => comum.planoEtapas(comum.lerEstado(estado(c, x)));
  assert.deepEqual(p([]), TODAS);
  assert.deepEqual(p(['092']), ['integridade 092', ...INSTALA('093'), ...INSTALA('094')]);
  assert.deepEqual(p(['092', '093']), ['integridade 092', 'integridade 093', ...INSTALA('094')]);
  assert.deepEqual(p(['092', '093', '094']), ['integridade 092', 'integridade 093', 'integridade 094']);
  assert.ok(!p(['092', '093']).includes('postcheck 093'), 'postcheck de instalação nunca roda numa migration já completa');
  for (const fora of [['093'], ['094'], ['092', '094'], ['093', '094']]) assert.throws(() => p(fora), /ORDEM_INESPERADA_092_094/, fora.join('+'));
});

test('parcial: qualquer objeto sozinho de uma migration recusa com o número dela', () => {
  for (const id of comum.IDS) for (const k of Object.keys(comum.OBJETOS[id])) {
    const anteriores = comum.IDS.slice(0, comum.IDS.indexOf(id));
    assert.throws(() => comum.planoEtapas(comum.lerEstado(estado(anteriores, {[k]: true}))), new RegExp('APLICACAO_PARCIAL_' + id), k);
    assert.throws(() => comum.planoEtapas(comum.lerEstado(estado([...anteriores, id], {[k]: false}))), new RegExp('APLICACAO_PARCIAL_' + id), k + ' faltando');
  }
  assert.throws(() => comum.lerEstado({...estado(), m093_saloes: 'sim'}), /ESTADO_ILEGIVEL m093_saloes/);
  assert.throws(() => comum.lerEstado({...estado(), d094: null}), /ESTADO_ILEGIVEL d094/);
});

test('dependências e privilégios só das pendentes: CREATE, DONO e REFERENCES por migration; já aplicadas não exigem', () => {
  const p = (c, x) => comum.planoEtapas(comum.lerEstado(estado(c, x)));
  assert.throws(() => p([], {d092: false}), /DEPENDENCIA_AUSENTE_092 006\/029\/047/);
  assert.throws(() => p([], {d093: false}), /DEPENDENCIA_AUSENTE_093 043\/062/);
  assert.throws(() => p(['092', '093'], {d094: false}), /DEPENDENCIA_AUSENTE_094 019\/062/);
  assert.equal(p(['092'], {d092: false, dono_092: false}).at(0), 'integridade 092', '092 aplicada: dependência e dono dela não contam');
  assert.throws(() => p([], {pode_criar: false}), / SEM_PRIVILEGIO_092 CREATE$/);
  assert.throws(() => p([], {dono_092: false}), / SEM_PRIVILEGIO_092 DONO$/);
  assert.throws(() => p(['092'], {dono_093: false, referencias_093: false}), / SEM_PRIVILEGIO_093 DONO REFERENCES$/);
  assert.throws(() => p(['092', '093'], {dono_094: false}), / SEM_PRIVILEGIO_094 DONO$/);
  assert.throws(() => p(['092', '093'], {referencias_094: false}), / SEM_PRIVILEGIO_094 REFERENCES$/);
  assert.equal(p(['092', '093', '094'], {pode_criar: false, dono_092: false, dono_093: false, dono_094: false, referencias_093: false}).length, 3, 'tudo aplicado: só confere');
  // O estado lê privilégios de current_user (quem executa o DDL) e informa, sem nomes, o SET role do Render.
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user,'public','CREATE'\)/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, d, 'USAGE'\)/);
  assert.match(comum.SQL_ESTADO, /has_table_privilege\(current_user, oid, 'REFERENCES'\)/);
  assert.match(comum.SQL_ESTADO, /\(session_user <> current_user\) AS papel_trocado/);
  assert.doesNotMatch(comum.SQL_ESTADO, /\b(INSERT|UPDATE|DELETE|CREATE TABLE|ALTER|DROP)\b/);
  for (const [k, nomes] of [['dono_092', ['precos_pacote', 'fechamento_pacote_snapshots', 'kidmais_047_lacunas_escopo(uuid)']], ['dono_093', ['configuracao_agenda']],
    ['dono_094', ['fechamentos', 'fechamento_revisoes', 'kidmais019_validar_destino(uuid)', 'kidmais019_validar_contrato()', 'kidmais_validar_agenda_revisao()']]])
    for (const n of nomes) assert.ok(comum.BASE[k].includes(`'public.${n}'`), k + ' ' + n);
  for (const t of ['empresas', 'usuarios_administrativos', 'estabelecimentos', 'configuracao_agenda', 'pacotes']) assert.ok(comum.BASE.referencias_093.includes(`'public.${t}'`), t);
});

test('modo: plano, conferência e aplicação só com --backup e registro seguro; o resto é recusado', () => {
  assert.deepEqual(comum.modo([]), {modo: 'plano'});
  assert.deepEqual(comum.modo(['--conferir-092-094']), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--aplicar-092-094-autorizado', '--backup', 'export 2026-10-23T03:00Z id-123']), {modo: 'aplicar', backup: 'export 2026-10-23T03:00Z id-123'});
  assert.throws(() => comum.modo(['--aplicar-092-094-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-092-094-autorizado', '--backup', 'x;rm -rf /']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--aplicar-092-094-autorizado', '--backup', 'a$(id)bcdef']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--conferir-092-094', '--aplicar-092-094-autorizado']), /BACKUP_OBRIGATORIO|ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--aplicar-089-autorizado']), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--conferir-089']), /ARGUMENTOS_RECUSADOS/);
});

test('situação do COMMIT na falha: erro do PostgreSQL desfaz; sem resposta, conexão, classe 57 (inclusive 57014), recurso ou erro interno = indeterminado', () => {
  for (const code of ['55P03', '40P01', '23514', 'P0001', '42501', '40001', '22012']) assert.equal(comum.commitNaFalha(erroPg(code)), 'DESFEITA_PELO_SERVIDOR', code);
  for (const e of [new Error('Connection terminated unexpectedly'), erroPg('08006'), erroPg('08003'), erroPg('57P01'), erroPg('57P02'), erroPg('57014'), erroPg('57000'), erroPg('57P03'), erroPg('58030'), erroPg('XX000'),
    erroPg('ECONNRESET'), erroPg(undefined), Object.assign(new Error('x'), {code: 55}), null])
    assert.equal(comum.commitNaFalha(e), 'INDETERMINADO', String(e?.code));
});

test('conferência: só leitura com lock_timeout curto, nada no disco; prechecks das pendentes, integridade das aplicadas', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 092': 'PASS', 'precheck 093': 'PASS', 'precheck 094': 'APOS_093'});
    assert.deepEqual(r.contagens, {precos: 12, horarios: 4, festas: 9}); assert.deepEqual(r.plano, TODAS);
    assert.deepEqual(escritas(Pronta.log), [], 'nenhuma consulta fora de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql === "SET LOCAL lock_timeout = '5s'"), 'leitura com lock_timeout');
    assert.ok(!Pronta.log.some(x => x.sql.includes('094 precheck OK')), 'precheck 094 exige a 093');
    // Já aplicadas e USADAS (capacidade ≠ 1, festa com salão): a conferência passa pela integridade, nunca pelo postcheck.
    const Usada = clienteFalso({inicial: estado(['092', '093', '094']), usadas: ['092', '093', '094']});
    const j = await stg.conferir({env: ENV_STG, Client: Usada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'integridade 092': 'PASS', 'integridade 093': 'PASS', 'integridade 094': 'PASS'});
    assert.ok(!Usada.log.some(x => /postcheck OK/.test(x.sql)), 'nenhum postcheck de instalação na conferência');
    assert.deepEqual(escritas(Usada.log), []);
    const Meio = clienteFalso({inicial: estado(['092', '093']), usadas: ['093']});
    assert.deepEqual((await stg.conferir({env: ENV_STG, Client: Meio})).checks, {'integridade 092': 'PASS', 'integridade 093': 'PASS', 'precheck 094': 'PASS'});
    const x = await stg.conferir({env: ENV_STG, Client: clienteFalso({inicial: estado([], {referencias_093: false})})});
    assert.equal(x.resultado, 'RECUSARIA'); assert.match(x.motivo, /SEM_PRIVILEGIO_093 REFERENCES/);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  // Adulteração com os marcadores presentes (P3-1): estado "completa", integridade recusa → FALHA.
  const adulterada = await stg.conferir({env: ENV_STG, Client: clienteFalso({inicial: estado(['092', '093', '094']), adulterada: '094'})});
  assert.equal(adulterada.resultado, 'FALHA'); assert.match(adulterada.mensagem, /094 integridade/);
  assert.equal((await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})})).resultado, 'FALHA');
  const falha = await stg.conferir({env: ENV_STG, Client: clienteFalso({falharEm: '093 precheck OK'})});
  assert.equal(falha.resultado, 'FALHA'); assert.ok(!JSON.stringify(falha).includes('SENHA_FALSA'));
  assert.equal((await stg.principal(['--conferir-092-094'], ENV_STG, {Client: clienteFalso({inicial: estado([], {m093_saloes: true})})})).codigo, 3);
  assert.equal((await stg.principal(['--conferir-092-094'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-092-094'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: backup obrigatório, 12 etapas na ordem, só as 3 migrations fora de READ ONLY, COMMIT registrado, sem repetição', async () => {
  const dir = tmp();
  try {
    await assert.rejects(stg.executar({env: ENV_STG, dir, Client: clienteFalso(), disco: semDisco}), /BACKUP_OBRIGATORIO/);
    assert.deepEqual(fs.readdirSync(dir), [], 'sem backup: nada gravado');
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(r.etapas, TODAS);
    assert.deepEqual(r.migracoesCommitadas, ['092', '093', '094']);
    assert.deepEqual(escritas(C.log).map(x => MIGRACAO.get(x.sql)), ['092', '093', '094'], 'as únicas escritas são as três migrations, em ordem');
    for (const id of comum.IDS) for (const t of ['precheck OK', 'postcheck OK', 'integridade OK']) assert.ok(C.log.find(x => x.sql.includes(`${id} ${t}`)).ro, `${id} ${t}`);
    const i = s => C.log.findIndex(x => x.sql.includes(s)), m = id => C.log.findIndex(x => MIGRACAO.get(x.sql) === id);
    assert.ok(i('093 precheck OK') > i('092 integridade OK') && i('092 integridade OK') > i('092 postcheck OK') && i('092 postcheck OK') > m('092'));
    assert.ok(i('094 precheck OK') > m('093'));
    assert.deepEqual([r.estadoDepois.m092, r.estadoDepois.m093, r.estadoDepois.m094], ['completa', 'completa', 'completa']);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(marcador.situacao, 'CONCLUIDA'); assert.equal(marcador.backup, BACKUP); assert.equal(marcador.ambiente, 'staging');
    assert.deepEqual(marcador.migracoesCommitadas, ['092', '093', '094']); assert.deepEqual(marcador.tentativasAnteriores, []);
    assert.deepEqual(marcador.etapas.filter(e => e.commit).map(e => [e.nome, e.commit]), comum.IDS.map(id => ['migration ' + id, 'CONFIRMADO']));
    assert.ok(!JSON.stringify(marcador).includes('SENHA_FALSA') && !JSON.stringify(marcador).includes('postgresql://'));
    const D = clienteFalso();
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: D, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(D.log.length, 0, 'repetição recusada antes de conectar');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('P2-1: COMMIT confirmado continua registrado se a leitura seguinte falhar (estado, postcheck ou integridade)', async () => {
  for (const [rotulo, opcoes, etapa, commitadas] of [
    ['leitura de estado perdida após o COMMIT da 092 (repro do parecer)', {estadoFalhaApos: '092'}, 'migration 092', ['092']],
    ['093 "commitou" incompleta', {naoCompleta: '093'}, 'migration 093', ['092', '093']],
    ['postcheck 093 recusa', {falharEm: '093 postcheck OK'}, 'postcheck 093', ['092', '093']],
    ['integridade 094 recusa', {adulterada: '094'}, 'integridade 094', ['092', '093', '094']]]) {
    const dir = tmp();
    try {
      const r = await executar(dir, opcoes);
      assert.equal(r.resultado, 'FALHA', rotulo); assert.equal(r.falha.etapa, etapa, rotulo);
      assert.deepEqual(r.migracoesCommitadas, commitadas, rotulo); assert.equal(r.migracaoIndeterminada, null, rotulo);
      assert.match(r.reconciliar, /--conferir-092-094/);
      const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
      assert.equal(marcador.situacao, 'FALHA'); assert.deepEqual(marcador.migracoesCommitadas, commitadas, rotulo + ' (marcador)');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('falha DENTRO da migration: erro do servidor = desfeita; sem resposta = INDETERMINADO; a seguinte nunca é tentada', async () => {
  for (const [rotulo, erro, commit] of [['lock_timeout (55P03)', erroPg('55P03', 'canceling statement due to lock timeout'), 'DESFEITA_PELO_SERVIDOR'],
    ['conexão perdida durante a 093', new Error('Connection terminated unexpectedly'), 'INDETERMINADO'],
    ['servidor desligado (57P01)', erroPg('57P01', 'terminating connection due to administrator command'), 'INDETERMINADO'],
    // Rodada 2 do Astra: cancelamento (57014) pode chegar durante o COMMIT — não prova rollback.
    ['cancelamento/statement_timeout (57014)', erroPg('57014', 'canceling statement due to statement timeout'), 'INDETERMINADO']]) {
    const dir = tmp();
    try {
      const C = clienteFalso({falharEm: 'CREATE TABLE agenda_escopo_config', erro});
      const {codigo, saida: r} = await stg.principal(['--aplicar-092-094-autorizado', '--backup', BACKUP], ENV_STG, {dir, Client: C, disco: semDisco});
      assert.equal(codigo, 2, rotulo); assert.equal(r.falha.etapa, 'migration 093', rotulo);
      assert.deepEqual(r.migracoesCommitadas, ['092'], rotulo);
      assert.equal(r.migracaoIndeterminada, commit === 'INDETERMINADO' ? '093' : null, rotulo);
      assert.ok(!C.log.some(x => MIGRACAO.get(x.sql) === '094'), rotulo + ': 094 não tentada');
      const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
      assert.equal(marcador.etapas.at(-1).nome, 'migration 093'); assert.equal(marcador.etapas.at(-1).commit, commit, rotulo);
      assert.notEqual(marcador.etapas.at(-1).ok, true);
      await assert.rejects(executar(dir), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('P2-2: retomada depois de uso legítimo da 093 (capacidade ≠ 1, salões) aplica a 094 sem o postcheck da 093', async () => {
  const dir = tmp();
  try {
    // Tentativa anterior preservada pelo operador (renomeada, nunca apagada) entra no novo registro.
    fs.writeFileSync(path.join(dir, 'migration-092-094.2026-10-23T04-00Z.json'), '{"situacao":"FALHA"}');
    const C = clienteFalso({inicial: estado(['092', '093']), usadas: ['092', '093']});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, ['integridade 092', 'integridade 093', ...INSTALA('094')]); assert.deepEqual(r.migracoesCommitadas, ['094']);
    assert.ok(!C.log.some(x => /09[23] postcheck OK/.test(x.sql)), 'postcheck de instalação só da 094, a recém-aplicada');
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.deepEqual(marcador.tentativasAnteriores, ['migration-092-094.2026-10-23T04-00Z.json']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('já aplicada: só as três integridades, nenhuma escrita; recusa por estado não grava DDL; disco ausente recusa', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado(['092', '093', '094']), usadas: ['093', '094']});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.etapas, ['integridade 092', 'integridade 093', 'integridade 094']);
    assert.deepEqual(escritas(C.log), []); assert.deepEqual(r.migracoesCommitadas, []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({inicial: estado([], {dono_094: false})});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir: dir2, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /SEM_PRIVILEGIO_094 DONO/); assert.deepEqual(escritas(C.log), [], 'recusa antes da 092');
    assert.deepEqual(r.migracoesCommitadas, []); assert.equal(r.migracaoIndeterminada, null);
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  await assert.rejects(stg.executar({env: ENV_STG, backup: 'export 23/10', dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.throws(() => stg.exigirDisco(path.join(os.tmpdir(), 'nao-existe-092-094')), /DISCO_PERSISTENTE_AUSENTE/);
});

test('plano sem conexão: 12 arquivos + a integridade da 094 após a 100, com sha; ordem com janela e CONFERIR imediato, regras de parada; nunca os down', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [...comum.ETAPAS, comum.INTEGRIDADE_094_APOS_100].map(e => e[2]));
  assert.match(saida.ordem[0], /deploy do código/); assert.equal(saida.ordem.at(-1), '--conferir-092-094');
  assert.ok(saida.ordem.some(o => /janela combinada/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /backup restaurável/.test(o)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /migracaoIndeterminada/.test(p)));
  for (const id of comum.IDS) assert.ok(saida.nuncaExecuta.includes('down ' + id));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.equal(stg.DIR, '/opt/render/project/src/data/agenda-precos-092-094-staging');
});

test('migration 100: a integridade da 094 troca SÓ a expectativa do corpo da regra de conflito (arquivo com uma linha diferente)', () => {
  const [, a094, h094] = comum.ETAPAS.find(e => e[0] === 'integridade 094');
  const [nome, a100, h100] = comum.INTEGRIDADE_094_APOS_100;
  assert.equal(nome, 'integridade 094 apos 100');
  const antes = comum.lerRevisado(raiz, a094, h094).split('\n'), depois = comum.lerRevisado(raiz, a100, h100).split('\n');
  assert.equal(antes.length, depois.length);
  const diferentes = antes.map((l, i) => [l, depois[i]]).filter(([x, y]) => x !== y);
  assert.equal(diferentes.length, 1, 'uma linha só');
  assert.equal(diferentes[0][1], diferentes[0][0].replace(comum.CORPO_CONFLITO_094, comum.CORPO_CONFLITO_100));
  assert.match(diferentes[0][0], /kidmais094_conflito_ocupacao/);
  // O hash da 100 é o mesmo que a migration 100 grava no postcheck dela.
  assert.ok(fs.readFileSync(path.join(raiz, 'database/checks/20261025_100_postcheck.sql'), 'utf8').includes(comum.CORPO_CONFLITO_100));
});

test('migration 100: com o corpo da 100, conferência e aplicação passam pela integridade da 094 após a 100; corpo diferente cai na da 094', async () => {
  const apos = comum.lerRevisado(raiz, comum.INTEGRIDADE_094_APOS_100[1], comum.INTEGRIDADE_094_APOS_100[2]);
  const original = ler('integridade 094');
  const Com100 = clienteFalso({inicial: estado(['092', '093', '094']), corpoConflito: comum.CORPO_CONFLITO_100, usadas: ['094']});
  const r = await stg.conferir({env: ENV_STG, Client: Com100});
  assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(r));
  assert.equal(r.checks['integridade 094'], 'PASS_CORPO_100');
  assert.ok(Com100.log.some(x => x.ro && x.sql === apos), 'roda a variante em READ ONLY');
  assert.ok(!Com100.log.some(x => x.sql === original), 'não roda a integridade da 094 original');
  assert.ok(Com100.log.some(x => x.ro && x.sql === comum.SQL_CORPO_CONFLITO), 'lê o corpo em READ ONLY');
  assert.deepEqual(escritas(Com100.log), []);
  // Corpo da 094 (ou qualquer outro, como o da 098): integridade da 094 original — a divergência nunca é ignorada.
  for (const corpo of [comum.CORPO_CONFLITO_094, 'f'.repeat(64), undefined]) {
    const C = clienteFalso({inicial: estado(['092', '093', '094']), corpoConflito: corpo});
    const x = await stg.conferir({env: ENV_STG, Client: C});
    assert.equal(x.checks['integridade 094'], 'PASS', String(corpo));
    assert.ok(C.log.some(l => l.sql === original) && !C.log.some(l => l.sql === apos), String(corpo));
  }
  // Aplicação já completa com a 100: só integridades, a da 094 na variante, registrada na etapa.
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado(['092', '093', '094']), corpoConflito: comum.CORPO_CONFLITO_100});
    const e = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(e.resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
    const marcador = JSON.parse(fs.readFileSync(e.marcador, 'utf8'));
    assert.equal(marcador.etapas.find(x => x.nome === 'integridade 094').integridade, 'PASS_CORPO_100');
    assert.deepEqual(escritas(C.log), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
