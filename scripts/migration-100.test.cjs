/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 100 (agenda com um salão, staging) com cliente simulado: trava de alvo, identidade, hashes, estado pelo
// corpo da regra de conflito (094 ausente / 100 completa / sem 094 / divergente), dono, inventário de pares no mesmo
// horário (recusa com pares > 0, relido antes de aplicar), conferência só leitura (sem gravar no disco), backup
// obrigatório, marcador anti-repetição, COMMIT confirmado/desfeito/indeterminado, validação composta (postcheck da 100 +
// integridade da 094 com o corpo da 100) e códigos de saída. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-100-comum.cjs');
const c094 = require('./migration-092-094-comum.cjs');
const stg = require('./migration-100-staging.cjs');
const ev108 = require('./migration-108-evidencias.cjs');
const retrato108 = require('./migration-108-retrato.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};
const BACKUP = 'export 25/10 12:00Z';
const H094 = c094.CORPO_CONFLITO_094, H100 = c094.CORPO_CONFLITO_100, H108 = c094.CORPO_CONFLITO_108;
const SEM_108 = Object.freeze({marcador_108: false, reparos_107: false, colunas_combinado: false, corpo_conflito_108: false, corpos_108: 0, funcoes_098_108: 0});
const COM_108 = Object.freeze({marcador_108: true, reparos_107: true, colunas_combinado: true, corpo_conflito_108: true, corpos_108: 3, funcoes_098_108: 10});
const PROVA_INTEGRA = Object.freeze({integra: true, motivos: [], search_path: 'pg_catalog', versao_pg: 180001});
const SQL_PROVA_FALSA = 'SELECT true AS integra, ARRAY[]::text[] AS motivos /* sqlProva108Integra falsa do teste */';
/** Esperado de F2 ainda A_MEDIR_NO_CLUSTER: troca o gerador da prova (chamado pelo objeto do módulo) durante o corpo. */
async function comProvaFalsa(corpo) {
  const original = retrato108.sqlProva108Integra;
  retrato108.sqlProva108Integra = () => SQL_PROVA_FALSA;
  try { return await corpo(); } finally { retrato108.sqlProva108Integra = original; }
}

/** Esperado de F2 ainda não medido, SIMULADO: o arquivo versionado já traz os retratos medidos no cluster E4 (29/10/2026). */
async function comF2Pendente(corpo) {
  const original = retrato108.sqlProva108Integra;
  retrato108.sqlProva108Integra = (o = {}) => original({...o, esperados: {...retrato108.carregarEsperados(), F2: {canonico: retrato108.PENDENTE}}});
  try { return await corpo(); } finally { retrato108.sqlProva108Integra = original; }
}
const APOS_108 = c094.lerRevisado(raiz, c094.INTEGRIDADE_094_APOS_108[1], c094.INTEGRIDADE_094_APOS_108[2]);
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return c094.lerRevisado(raiz, a, h); };
const MIGRATION = c094.lerRevisado(raiz, comum.ETAPAS[1][1], comum.ETAPAS[1][2]);
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const estado = (extra = {}) => ({d100: true, corpo: H094, dono: true, pode_criar: true, linguagem: true, tipos: true, papel_trocado: true, ...extra});
const inventario = (extra = {}) => ({horarios_capacidade_maior: 2, pares_mesmo_horario: 0, ocupacoes_futuras_um_salao: 7, ...extra});

/**
 * Cliente simulado: a migration (texto real) troca o corpo para o da 100; SQL_ESTADO/SQL_INVENTARIO devolvem o estado e o
 * inventário correntes. `paresDepois`: o inventário muda a partir da N-ésima leitura (pares surgem entre conferir e aplicar).
 */
function clienteFalso({inicial = estado(), inv = inventario(), identidade = ID_STG, falharEm, erro, naoTroca, paresNaLeitura, evidencias = SEM_108, prova = PROVA_INTEGRA} = {}) {
  const log = []; let ro = false, leiturasInventario = 0; const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') ro = false;
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === ev108.SQL_EVIDENCIA_108) return {rows: [{...evidencias}]};
      if (sql.startsWith('/* prova-108 */')) { assert.ok(sql.includes(SQL_PROVA_FALSA)); return {rows: [{...prova}]}; }
      if (sql === comum.SQL_INVENTARIO) {
        leiturasInventario++;
        return {rows: [paresNaLeitura && leiturasInventario >= paresNaLeitura ? {...inv, pares_mesmo_horario: 3} : {...inv}]};
      }
      if (sql === MIGRATION) { assert.equal(ro, false, 'migration nunca dentro de READ ONLY'); if (!naoTroca) atual.corpo = H100; }
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-100-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));
const PLANO_AUSENTE = ['precheck 100', 'migration 100', 'postcheck 100', 'integridade 094 apos 100'];

test('hashes fixados conferem com os 4 SQL da árvore (CRLF normalizado); a migration é uma transação só; integridade é a da 092–094', () => {
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  }
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), PLANO_AUSENTE);
  assert.equal(comum.ETAPAS[3], c094.INTEGRIDADE_094_APOS_100, 'mesma integridade (e mesmo hash) que o CONFERIR da 092–094 usa');
  assert.match(MIGRATION, /^BEGIN;$/m); assert.match(MIGRATION, /^COMMIT;\s*$/m); assert.match(MIGRATION, /SET LOCAL lock_timeout = '5s'/);
  // O postcheck e a migration exigem os mesmos corpos que o aplicador usa para o estado.
  for (const nome of ['migration 100', 'postcheck 100']) assert.ok(ler(nome).includes(H100), nome);
  for (const nome of ['precheck 100', 'migration 100']) assert.ok(ler(nome).includes(H094), nome);
  assert.throws(() => c094.lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
});

test('consultas de leitura: estado e inventário só leem (sem escrita), inventário sem ids e no escopo POR_HORARIO com hoje de São Paulo', () => {
  for (const sql of [comum.SQL_ESTADO, comum.SQL_INVENTARIO]) assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, proowner, 'USAGE'\)/);
  // Parecer do Astra (P3): privilégios de definição da função além de ser dono.
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user, 'public', 'CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user, 'plpgsql', 'USAGE'\)/);
  for (const tipo of ['uuid', 'date', 'time without time zone', 'boolean']) assert.ok(comum.SQL_ESTADO.includes(`has_type_privilege(current_user, '${tipo}', 'USAGE')`), tipo);
  assert.match(comum.SQL_INVENTARIO, /capacidade_tipo = 'POR_HORARIO'/);
  assert.match(comum.SQL_INVENTARIO, /kidmais094_ocupacoes\(\(clock_timestamp\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date, 'infinity'::date\)/);
  // P2-I1: o outro lado (y) vem de TODAS as ocupações (sem filtro de escopo); só o lado afetado (x) é de escopo POR_HORARIO.
  const todas = /todas AS MATERIALIZED \(([\s\S]*?)\),\n\s*afetadas/.exec(comum.SQL_INVENTARIO)[1];
  assert.doesNotMatch(todas, /\bum\b|POR_HORARIO|JOIN/, 'o conjunto completo não filtra escopo');
  assert.match(todas, /FROM kidmais094_ocupacoes\(/, 'o conjunto completo vem da função de ocupações da 094');
  assert.match(comum.SQL_INVENTARIO, /afetadas AS \(\s*SELECT t\.\*, um\.intervalo FROM todas t JOIN um ON/);
  assert.match(comum.SQL_INVENTARIO, /FROM afetadas x JOIN todas y ON y\.data = x\.data AND y\.fechamento_id <> x\.fechamento_id AND y\.configuracao_agenda_id = x\.configuracao_agenda_id/);
  assert.match(comum.SQL_INVENTARIO, /kidmais062_mesmo_recurso\(x\.empresa_id, x\.estabelecimento_id, y\.empresa_id, y\.estabelecimento_id\)/);
  // P2-I2: cada direção com o intervalo do lado afetado, deduplicada DEPOIS — nada depende da ordem dos ids.
  assert.match(comum.SQL_INVENTARIO, /x\.ini < y\.fim \+ x\.intervalo AND x\.fim > y\.ini - x\.intervalo/);
  assert.match(comum.SQL_INVENTARIO, /SELECT DISTINCT least\(x\.fechamento_id, y\.fechamento_id\) AS a, greatest\(x\.fechamento_id, y\.fechamento_id\) AS b/);
  assert.doesNotMatch(comum.SQL_INVENTARIO, /y\.fechamento_id > x\.fechamento_id/, 'sem corte pela ordem dos ids antes de avaliar a direção');
  assert.match(comum.SQL_INVENTARIO, /\(SELECT count\(\*\) FROM pares\)::int AS pares_mesmo_horario/);
  assert.doesNotMatch(comum.SQL_INVENTARIO, /SELECT[^;]*\bid\b[^;]*AS (id|fechamento)/i, 'nenhum id sai do inventário');
});

test('estado pelo corpo: 094 ausente, 100 completa, sem função = sem_094, outro = divergente; ilegível recusa', () => {
  assert.equal(comum.lerEstado(estado()).m100, 'ausente');
  assert.equal(comum.lerEstado(estado({corpo: H100})).m100, 'completa');
  assert.equal(comum.lerEstado(estado({corpo: null})).m100, 'sem_094');
  assert.equal(comum.lerEstado(estado({corpo: 'a'.repeat(64)})).m100, 'divergente');
  assert.throws(() => comum.lerEstado(estado({dono: 'sim'})), /ESTADO_ILEGIVEL dono/);
  assert.throws(() => comum.lerEstado(estado({linguagem: null})), /ESTADO_ILEGIVEL linguagem/);
  assert.throws(() => comum.lerEstado(estado({corpo: 'xyz'})), /ESTADO_ILEGIVEL corpo/);
  assert.throws(() => comum.lerInventario(inventario({pares_mesmo_horario: -1})), /INVENTARIO_ILEGIVEL/);
});

test('plano: ausente aplica; completa só confere; sem 094, divergente (098), sem dono, sem dependência e pares > 0 recusam antes da escrita', () => {
  const p = (e, i = inventario()) => comum.planoEtapas(comum.lerEstado(estado(e)), comum.lerInventario(i));
  assert.deepEqual(p({}), PLANO_AUSENTE);
  assert.deepEqual(p({}, inventario({horarios_capacidade_maior: 9})), PLANO_AUSENTE, 'capacidade gravada > 1 só informa (a 100 trata como 1)');
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(estado({corpo: H100}))), ['postcheck 100', 'integridade 094 apos 100']);
  assert.throws(() => p({corpo: null}), /DEPENDENCIA_AUSENTE_100 094/);
  assert.throws(() => p({corpo: 'a'.repeat(64)}), /CORPO_DIVERGENTE_100/);
  assert.throws(() => p({dono: false}), /SEM_PRIVILEGIO_100 DONO$/);
  assert.throws(() => p({pode_criar: false}), /SEM_PRIVILEGIO_100 CREATE$/);
  assert.throws(() => p({linguagem: false, tipos: false}), /SEM_PRIVILEGIO_100 LINGUAGEM TIPOS$/);
  assert.throws(() => p({dono: false, pode_criar: false, linguagem: false, tipos: false}), /SEM_PRIVILEGIO_100 DONO CREATE LINGUAGEM TIPOS$/);
  assert.throws(() => p({d100: false}), /DEPENDENCIA_AUSENTE_100 093\/094\/062/);
  assert.throws(() => p({}, inventario({pares_mesmo_horario: 2})), /CONFLITOS_PREEXISTENTES_100 2/);
});

test('trava de alvo de staging e identidade: serviço, ambiente, host, banco, porta, URL sem query; mensagem sem segredos', async () => {
  assert.equal(stg.alvo(ENV_STG).application_name, 'kidmais-migration-100-staging');
  for (const [mudanca, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-x'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-outro.render.com')}, /HOST_RECUSADO/], [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_STG + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/]]) {
    assert.throws(() => stg.alvo({...ENV_STG, ...mudanca}), (e) => erro.test(e.message) && !e.message.includes('SENHA_FALSA'));
  }
  const outro = await stg.conferir({env: ENV_STG, Client: clienteFalso({identidade: {...ID_STG, db: 'outro_banco'}})});
  assert.equal(outro.resultado, 'FALHA'); assert.ok(!JSON.stringify(outro).includes('SENHA_FALSA'));
  assert.equal(stg.DIR, '/opt/render/project/src/data/agenda-um-salao-100-staging');
});

test('conferência: só leitura com lock_timeout, nada no disco; ausente = precheck + inventário; completa = postcheck + integridade composta', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await stg.conferir({env: ENV_STG, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.checks, {'precheck 100': 'PASS', 'postcheck 100': 'APOS_100', 'integridade 094 apos 100': 'APOS_100'});
    assert.deepEqual(r.inventario, inventario()); assert.deepEqual(r.plano, PLANO_AUSENTE);
    assert.deepEqual(escritas(Pronta.log), []);
    assert.ok(Pronta.log.some(x => x.ro && x.sql === "SET LOCAL statement_timeout = '120s'"), 'inventário com tempo próprio');
    assert.ok(!Pronta.log.some(x => x.sql === MIGRATION));
    const Aplicada = clienteFalso({inicial: estado({corpo: H100})});
    const j = await stg.conferir({env: ENV_STG, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'postcheck 100': 'PASS', 'integridade 094 apos 100': 'PASS'});
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === ler('integridade 094 apos 100')));
    assert.ok(!Aplicada.log.some(x => x.sql === comum.SQL_INVENTARIO), 'completa: sem inventário');
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  for (const [opcoes, motivo] of [[{inicial: estado({corpo: 'a'.repeat(64)})}, /CORPO_DIVERGENTE_100/], [{inv: inventario({pares_mesmo_horario: 1})}, /CONFLITOS_PREEXISTENTES_100 1/],
    [{inicial: estado({dono: false})}, /SEM_PRIVILEGIO_100 DONO/]]) {
    const x = await stg.principal(['--conferir-100'], ENV_STG, {Client: clienteFalso(opcoes)});
    assert.equal(x.codigo, 3); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
  }
  // Privilégio ou corpo recusados ANTES do inventário (um papel sem SELECT recebe a recusa nomeada, não erro de permissão).
  for (const e of [estado({dono: false}), estado({corpo: 'a'.repeat(64)})]) {
    const C = clienteFalso({inicial: e});
    assert.equal((await stg.conferir({env: ENV_STG, Client: C})).resultado, 'RECUSARIA');
    assert.ok(!C.log.some(x => x.sql === comum.SQL_INVENTARIO), 'inventário não lido');
  }
  assert.equal((await stg.principal(['--conferir-100'], ENV_STG, {Client: clienteFalso()})).codigo, 0);
  await assert.rejects(stg.principal(['--conferir-100'], {...ENV_STG, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: backup obrigatório, 4 etapas na ordem, só a migration fora de READ ONLY, COMMIT confirmado, marcador exclusivo', async () => {
  await assert.rejects(stg.principal(['--aplicar-100-autorizado'], ENV_STG, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  await assert.rejects(stg.principal(['--aplicar-100-autorizado', '--backup', 'x;rm'], ENV_STG, {Client: clienteFalso()}), /BACKUP_INVALIDO/);
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_AUSENTE); assert.equal(r.commit, 'CONFIRMADO');
    assert.deepEqual(r.inventarioAntes, inventario()); assert.equal(r.estadoAntes.m100, 'ausente'); assert.equal(r.estadoDepois.m100, 'completa');
    assert.deepEqual(escritas(C.log).map(x => x.sql), [MIGRATION], 'só a migration escreve');
    const i = C.log.findIndex(x => x.sql === MIGRATION);
    assert.ok(C.log.slice(0, i).some(x => x.sql === comum.SQL_INVENTARIO), 'inventário relido antes da migration');
    assert.ok(C.log.slice(i).some(x => x.sql === ler('postcheck 100')) && C.log.slice(i).some(x => x.sql === ler('integridade 094 apos 100')), 'validação composta depois');
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP); assert.equal(m.commit, 'CONFIRMADO');
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: clienteFalso(), disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('pares surgidos entre a conferência e a aplicação: recusa antes da migration (nenhuma escrita)', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({paresNaLeitura: 1});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /CONFLITOS_PREEXISTENTES_100 3/);
    assert.deepEqual(escritas(C.log), []); assert.equal(r.commit, null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('falha DENTRO da migration: erro do servidor = desfeita; sem resposta, classe 57/08 ou 40003 = INDETERMINADO; nada depois', async () => {
  for (const [erro, esperado] of [[erroPg('55P03'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('57014'), 'INDETERMINADO'],
    [erroPg('08006'), 'INDETERMINADO'], [erroPg('40003'), 'INDETERMINADO'], [new Error('Connection terminated unexpectedly'), 'INDETERMINADO']]) {
    const dir = tmp();
    try {
      const C = clienteFalso({falharEm: 'CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao', erro});
      const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.equal(r.commit, esperado, String(erro.code));
      assert.match(r.reconciliar, /--conferir-100/);
      const i = C.log.findIndex(x => x.sql === MIGRATION);
      assert.ok(!C.log.slice(i + 1).some(x => x.sql === ler('postcheck 100')), 'nada depois da falha');
      assert.equal(JSON.parse(fs.readFileSync(r.marcador, 'utf8')).situacao, 'FALHA');
      // Não repete: o marcador da falha impede uma segunda tentativa automática (recusa antes de conectar, código 1 na CLI).
      await assert.rejects(stg.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_STG, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('migration que volta sem trocar o corpo: COMMIT confirmado registrado, depois recusa pelo estado (não segue para o postcheck)', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({naoTroca: true});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.commit, 'CONFIRMADO'); assert.match(r.falha.mensagem, /ESTADO_DEPOIS_100/);
    assert.ok(!C.log.some(x => x.sql === ler('postcheck 100')));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('já aplicada: só postcheck e integridade composta, nenhuma escrita; disco ausente recusa antes de conectar', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: estado({corpo: H100})});
    const r = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(r.etapas, ['postcheck 100', 'integridade 094 apos 100']);
    assert.deepEqual(escritas(C.log), []); assert.equal(r.commit, null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  await assert.rejects(stg.executar({env: ENV_STG, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
});

test('plano sem conexão: 4 arquivos com sha, corpos esperados, ordem com backup/janela/CONFERIR imediato e CONFERIR da 092–094; nunca o down', async () => {
  const {codigo, saida} = await stg.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'staging');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [...comum.ETAPAS, c094.INTEGRIDADE_094_APOS_108].map(e => e[2]));
  assert.deepEqual(saida.corpos, {ausente: H094, completa: H100, substituida_108: H108});
  assert.ok(saida.preRequisitos.some(p => /108 parcial recusa/.test(p)));
  assert.match(saida.ordem[0], /deploy do código/); assert.match(saida.ordem.at(-1), /CONFERIR da 092–094/);
  assert.ok(saida.ordem.some(o => /janela combinada/.test(o)) && saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /backup restaurável/.test(o)));
  assert.ok(saida.paradas.some(p => /nunca apagar/.test(p)) && saida.paradas.some(p => /INDETERMINADO/.test(p)));
  assert.ok(saida.nuncaExecuta.includes('down 100') && saida.nuncaExecuta.some(n => /remarcação/.test(n)));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.ok(saida.recuperacao.some(r => /reabre a capacidade/.test(r)));
});

test('108: corpo da 108 = substituida_108; plano só confere (prova + integridade da 094 após a 108), nunca reaplica; evidência parcial recusa', () => {
  assert.equal(comum.lerEstado(estado({corpo: H108})).m100, 'substituida_108');
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(estado({corpo: H108})), undefined, ev108.evidencias108(COM_108)), ['prova 108', 'integridade 094 apos 108']);
  // 108 substituída mesmo sem dono/CREATE: nada será escrito.
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(estado({corpo: H108, dono: false, pode_criar: false}))), ['prova 108', 'integridade 094 apos 108']);
  for (const [corpo, evid] of [[H100, {...SEM_108, marcador_108: true}], [H094, {...SEM_108, funcoes_098_108: 1}], [H100, {...SEM_108, corpos_108: 2}]]) {
    assert.throws(() => comum.planoEtapas(comum.lerEstado(estado({corpo})), inventario(), ev108.evidencias108(evid)), /EVIDENCIA_108_PARCIAL/);
  }
  // Só a 107 não é evidência da 108 para a 100.
  assert.deepEqual(comum.planoEtapas(comum.lerEstado(estado({corpo: H100})), undefined, ev108.evidencias108({...SEM_108, reparos_107: true})), ['postcheck 100', 'integridade 094 apos 100']);
});

test('108 íntegra: CONFERIR e APLICAR = JA_APLICADA_SUBSTITUIDA_108 (código 0) sem inventário, sem migration e sem nenhuma escrita', async () => {
  await comProvaFalsa(async () => {
    const C = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108});
    const x = await stg.principal(['--conferir-100'], ENV_STG, {Client: C});
    assert.equal(x.codigo, 0); assert.equal(x.saida.resultado, 'JA_APLICADA_SUBSTITUIDA_108', JSON.stringify(x.saida));
    assert.deepEqual(x.saida.checks, {'prova 108': 'INTEGRA', 'integridade 094 apos 108': 'PASS'});
    assert.deepEqual(x.saida.plano, ['prova 108', 'integridade 094 apos 108']);
    assert.ok(C.log.some(l => l.ro && l.sql.startsWith('/* prova-108 */')) && C.log.some(l => l.ro && l.sql === APOS_108));
    assert.ok(!C.log.some(l => l.sql === comum.SQL_INVENTARIO || l.sql === MIGRATION || l.sql === ler('postcheck 100')), 'sem inventário, migration ou postcheck da 100');
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108});
      const e = await stg.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_STG, {dir, Client: A, disco: semDisco});
      assert.equal(e.codigo, 0); assert.equal(e.saida.resultado, 'JA_APLICADA_SUBSTITUIDA_108', JSON.stringify(e.saida));
      assert.equal(e.saida.commit, null); assert.deepEqual(e.saida.checks, {'prova 108': 'INTEGRA', 'integridade 094 apos 108': 'PASS'});
      assert.ok(!A.log.some(l => l.sql === MIGRATION)); assert.deepEqual(escritas(A.log), []);
      const m = JSON.parse(fs.readFileSync(e.saida.marcador, 'utf8'));
      assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.resultado, 'JA_APLICADA_SUBSTITUIDA_108');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
});

test('108 não íntegra ou parcial: RECUSARIA (código 3) / FALHA (código 2) com o motivo; adulteração do marcador e de metadados', async () => {
  await comProvaFalsa(async () => {
    for (const [prova, motivo] of [[{...PROVA_INTEGRA, integra: false, motivos: ['MARCADOR_108', 'RETRATO_F2']}, /^SUBSTITUIDA_108_NAO_INTEGRA MARCADOR_108 RETRATO_F2$/],
      [{...PROVA_INTEGRA, integra: false, motivos: ['METADADOS kidmais108_instalada()']}, /METADADOS kidmais108_instalada\(\)/],
      [{...PROVA_INTEGRA, integra: false, motivos: ['FUNCOES_098_CORPO', 'GATILHOS_098']}, /FUNCOES_098_CORPO GATILHOS_098/],
      [{...PROVA_INTEGRA, search_path: 'public'}, /SESSAO_PROVA_108 search_path/]]) {
      const C = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108, prova});
      const x = await stg.principal(['--conferir-100'], ENV_STG, {Client: C});
      assert.equal(x.codigo, 3); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
      assert.ok(!C.log.some(l => l.sql === APOS_108), 'integridade não roda depois da prova recusada');
      const dir = tmp();
      try {
        const A = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108, prova});
        const e = await stg.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_STG, {dir, Client: A, disco: semDisco});
        assert.equal(e.codigo, 2); assert.match(e.saida.falha.mensagem, motivo); assert.equal(e.saida.commit, null);
        assert.ok(!A.log.some(l => l.sql === MIGRATION)); assert.deepEqual(escritas(A.log), []);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
    // Evidência da 108 com o corpo da 094 ou da 100: recusa antes do inventário (a 100 nunca seria aplicada sobre uma 108 parcial).
    for (const [corpo, evid] of [[H094, {...SEM_108, marcador_108: true}], [H100, {...SEM_108, corpos_108: 1, funcoes_098_108: 3}]]) {
      const C = clienteFalso({inicial: estado({corpo}), evidencias: evid});
      const x = await stg.principal(['--conferir-100'], ENV_STG, {Client: C});
      assert.equal(x.codigo, 3); assert.match(x.saida.motivo, /^EVIDENCIA_108_PARCIAL /);
      assert.ok(!C.log.some(l => l.sql === comum.SQL_INVENTARIO || l.sql.startsWith('/* prova-108 */')));
      const dir = tmp();
      try {
        const A = clienteFalso({inicial: estado({corpo}), evidencias: evid});
        const e = await stg.executar({env: ENV_STG, backup: BACKUP, dir, Client: A, disco: semDisco});
        assert.equal(e.resultado, 'FALHA'); assert.match(e.falha.mensagem, /EVIDENCIA_108_PARCIAL/); assert.deepEqual(escritas(A.log), []);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
  });
  // Esperado de F2 não medido (simulado): RECUSARIA, sem consultar a prova.
  const C = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108});
  const x = await comF2Pendente(() => stg.principal(['--conferir-100'], ENV_STG, {Client: C}));
  assert.equal(x.codigo, 3); assert.match(x.saida.motivo, /^SUBSTITUIDA_108_NAO_INTEGRA PROVA_108_INDISPONIVEL RETRATO_108_NAO_MEDIDO/);
  assert.ok(!C.log.some(l => l.sql.startsWith('/* prova-108 */')));
  // Evidência ilegível: FALHA (nunca "sem 108").
  const I = await stg.conferir({env: ENV_STG, Client: clienteFalso({evidencias: {...SEM_108, marcador_108: null}})});
  assert.equal(I.resultado, 'FALHA'); assert.match(I.mensagem, /EVIDENCIA_108_ILEGIVEL marcador_108/);
});

test('override de F2 recusado no aplicador de staging da 100 (só a suíte PostgreSQL o aceita)', async () => {
  const env = {...ENV_STG, [ev108.ENV_RETRATOS_TESTE]: '{}'};
  const C = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108});
  const x = await stg.principal(['--conferir-100'], env, {Client: C});
  assert.equal(x.codigo, 3); assert.match(x.saida.motivo, /^RETRATOS_DE_TESTE_RECUSADOS/);
  assert.ok(!C.log.some(l => l.sql.startsWith('/* prova-108 */')));
});
