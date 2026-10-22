/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicadores da 090 (campanha Fundador; staging e produção) com cliente simulado: trava de alvo, identidade, hashes, plano por estado,
// privilégios, conferência só leitura (sem gravar no disco), backup obrigatório, marcador anti-repetição, falha
// registrada e códigos de saída. Sem rede nem banco (a execução real fica em lib/assinatura/aplicador-090.postgres.test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-090-comum.cjs');
const prod = require('./migration-090-production.cjs');
const stg = require('./migration-090-staging.cjs');

const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a/kidmais_production';
const URL_STG = 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false', DATABASE_URL: URL_STG});
const BASE = {m074a: true, m075: true, usuarios: true, pode_criar: true, pode_referenciar: true, dono_alteradas: true, papel_trocado: true};
const OBJ = [...comum.OBJETOS];
const AUSENTE = {...BASE, ...Object.fromEntries(OBJ.map(k => [k, false])), indice_antigo: true};
const COMPLETA = {...BASE, ...Object.fromEntries(OBJ.map(k => [k, true])), indice_antigo: false};
const PRESERVA = {fundadores: 6, resumo_fundadores: 'r1', contratacoes: 3, resumo_contratacoes: 'c1'};
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const ID_STG = {db: 'kidmais_staging_1z91', tls: false, servidor_privado: true};

/** Cliente simulado: devolve a sequência de estados; registra cada SQL e se rodou dentro de READ ONLY. */
function clienteFalso({estados = [AUSENTE, COMPLETA], identidade = ID_PROD, falharEm, preservacao, anteriores = [0]} = {}) {
  let k = 0;
  const log = []; let i = 0, ro = false;
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') ro = false;
      if (falharEm && sql.includes(falharEm)) throw new Error('falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [estados[Math.min(i++, estados.length - 1)]]};
      if (sql === comum.SQL_CORTE) return {rows: [{corte: '2026-10-22T12:00:00.000000Z'}]};
      if (sql === comum.SQL_ANTERIORES('2026-10-22T12:00:00.000000Z')) return {rows: [{n: anteriores[Math.min(k++, anteriores.length - 1)]}]};
      if (sql.startsWith('/* preservacao-')) { assert.ok(sql.includes("'2026-10-22T12:00:00.000000Z'::timestamptz"), 'mesmo corte antes e depois'); return {rows: [{...PRESERVA, ...(preservacao ? preservacao(i) : {})}]}; }
      if (sql.includes("origem = 'LEGADO'")) return {rows: [{legado_ate_corte: 6, legado: 7, janela: 0, pos_janela: 0, campanhas_ativadas: 0}]};
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-090-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));

test('hashes fixados conferem com os SQL da árvore (CRLF normalizado) e o arquivo divergente é recusado', () => {
  const raiz = path.resolve(__dirname, '..');
  for (const [, arquivo, hash] of comum.ETAPAS) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
    assert.equal(comum.lerRevisado(raiz, arquivo, hash).includes('\r'), false);
  }
  assert.throws(() => comum.lerRevisado(raiz, comum.ETAPAS[1][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['precheck 090', 'migration 090', 'postcheck 090']);
});

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório, host interno, banco, porta e URL sem query', () => {
  assert.deepEqual(prod.alvo(ENV_PROD).ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.deepEqual(prod.alvo({...ENV_PROD, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  for (const [delta, erro] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/],
    [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-dak750gae00c73fudmg0-a.virginia-postgres.render.com')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('fudmg0-a/', 'fudmg0-a:6543/')}, /PORTA_RECUSADA/],
    [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/], [{DATABASE_URL: 'nao-e-url'}, /URL_RECUSADA/]])
    assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), erro);
});

test('trava de alvo de staging: serviço, ambiente, TLS como a aplicação, host, banco e URL sem query', () => {
  assert.equal(stg.alvo(ENV_STG).ssl, undefined);
  assert.deepEqual(stg.alvo({...ENV_STG, DATABASE_SSL: 'true'}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  for (const [delta, erro] of [[{RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg'}, /SERVICO_RECUSADO/], [{KIDMAIS_DEPLOY_ENV: 'production'}, /AMBIENTE_RECUSADO/],
    [{DATABASE_SSL: undefined}, /TLS_CONFIGURACAO_RECUSADA/], [{DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'}, /TLS_CONFIGURACAO_RECUSADA/],
    [{DATABASE_URL: URL_STG.replace('kidmais_staging_1z91', 'kidmais_production')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'dpg-dak750gae00c73fudmg0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_STG + '?ssl=false'}, /CONNECTION_QUERY_REJECTED/]])
    assert.throws(() => stg.alvo({...ENV_STG, ...delta}), erro);
});

test('mensagens da trava são só o código: nunca ecoam URL, senha, host ou serviço', () => {
  for (const [m, env, delta] of [[prod, ENV_PROD, {DATABASE_URL: URL_PROD + '?password=SEGREDO'}], [prod, ENV_PROD, {RENDER_SERVICE_ID: 'srv-SEGREDO'}],
    [stg, ENV_STG, {DATABASE_URL: URL_STG.replace('dpg-daidko3m8hqs73ce4jt0-a', 'host-SEGREDO')}]]) {
    let msg = ''; try { m.alvo({...env, ...delta}); } catch (e) { msg = String(e.message); }
    assert.match(msg, /^[A-Z_]+$/); assert.ok(!msg.includes('SEGREDO') && !msg.includes('SENHA_FALSA'));
  }
});

test('identidade provada pelo servidor: banco, TLS/versão e rede privada (produção); banco e TLS conforme a configuração (staging)', () => {
  assert.deepEqual(prod.identidade(ID_PROD), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
  for (const delta of [{db: 'kidmais_staging_1z91'}, {tls: false}, {tls_versao: 'TLSv1.1'}, {servidor_privado: false}]) assert.throws(() => prod.identidade({...ID_PROD, ...delta}));
  assert.equal(stg.identidade(ID_STG, ENV_STG).banco, 'kidmais_staging_1z91');
  assert.throws(() => stg.identidade({...ID_STG, servidor_privado: false}, ENV_STG), /IDENTIDADE_RECUSADA/);
  assert.throws(() => stg.identidade({...ID_STG, db: 'kidmais_production'}, ENV_STG), /IDENTIDADE_RECUSADA/);
});

test('plano por estado: ausente → 3 etapas; completa → só postcheck; parcial, sem 074a/075 ou sem privilégio/dono → recusa antes de escrever', () => {
  const e = x => comum.lerEstado(x);
  assert.deepEqual(comum.planoEtapas(e(AUSENTE)), ['precheck 090', 'migration 090', 'postcheck 090']);
  assert.deepEqual(comum.planoEtapas(e(COMPLETA)), ['postcheck 090']);
  for (const k of OBJ)
    assert.throws(() => comum.planoEtapas(e({...AUSENTE, [k]: true})), /APLICACAO_PARCIAL_090/, k);
  // Índice de vaga antigo: some na mesma transação que cria os novos; sozinho (sem objetos) ou junto com todos = parcial.
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, indice_antigo: false})), /APLICACAO_PARCIAL_090/);
  assert.throws(() => comum.planoEtapas(e({...COMPLETA, indice_antigo: true})), /APLICACAO_PARCIAL_090/);
  for (const k of ['m074a', 'm075', 'usuarios'])
    assert.throws(() => comum.planoEtapas(e({...AUSENTE, [k]: false})), /DEPENDENCIA_AUSENTE_074A_075/, k);
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, dono_alteradas: false})), /SEM_PRIVILEGIO_090 DONO/);
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, pode_criar: false})), /SEM_PRIVILEGIO_090 CREATE/);
  assert.throws(() => comum.planoEtapas(e({...AUSENTE, pode_referenciar: false})), /SEM_PRIVILEGIO_090 REFERENCES/);
  assert.deepEqual(comum.planoEtapas(e({...COMPLETA, pode_criar: false})), ['postcheck 090'], 'já aplicada: só confere');
  assert.throws(() => comum.lerEstado({...AUSENTE, gatilho_fundador: 'sim'}), /ESTADO_ILEGIVEL gatilho_fundador/);
  // O estado lê privilégios de current_user (quem executa o DDL) e informa, sem nomes, o SET role do Render.
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user,'public','CREATE'\)/);
  assert.match(comum.SQL_ESTADO, /'REFERENCES'/); assert.match(comum.SQL_ESTADO, /session_user <> current_user AS papel_trocado/);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, c\.relowner, 'USAGE'\)/);
  assert.deepEqual([...comum.REFERENCIADAS], ['usuarios_administrativos']); assert.deepEqual([...comum.ALTERADAS], ['assinatura_fundadores']);
  // A prova de preservação só lê colunas da 074a e devolve md5 agregado (nenhum id ou documento na saída).
  // Revisão de 22/10/2026: só colunas imutáveis, só linhas até o corte; NULL explícito; corte validado.
  const p = comum.SQL_PRESERVACAO('2026-10-22T12:00:00.000000Z');
  assert.doesNotMatch(p, /origem|campanha_id|regra_versao|oferta_valida_ate|\bestado\b|confirmada_em|pagamento_confirmacao_id|to_jsonb/); assert.match(p, /md5\(string_agg/);
  assert.match(p, /reservada_em <= '2026-10-22T12:00:00.000000Z'::timestamptz/); assert.match(p, /coalesce\(\(vaga\)::text,'~'\)/);
  for (const ruim of ["2026-10-22'; DROP TABLE x; --", '2026-10-22', undefined]) assert.throws(() => comum.SQL_PRESERVACAO(ruim), /CORTE_INVALIDO/);
});

test('modo: plano, conferência e aplicação só com --backup e registro seguro; o resto é recusado', () => {
  assert.deepEqual(comum.modo([]), {modo: 'plano'});
  assert.deepEqual(comum.modo(['--conferir-090']), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--aplicar-090-autorizado', '--backup', 'export 2026-10-22T03:00Z id-123']), {modo: 'aplicar', backup: 'export 2026-10-22T03:00Z id-123'});
  assert.throws(() => comum.modo(['--aplicar-090-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-090-autorizado', '--backup', 'x;rm -rf /']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--aplicar-090-autorizado', '--backup', 'a$(id)bcdef']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--conferir-090', '--aplicar-090-autorizado']), /BACKUP_OBRIGATORIO|ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--aplicar-084-autorizado']), /ARGUMENTOS_RECUSADOS/);
});

test('conferência: só leitura (toda consulta em READ ONLY), não grava nada no disco; PRONTA, JA_APLICADA e RECUSARIA', async () => {
  for (const [m, env, id] of [[prod, ENV_PROD, ID_PROD], [stg, ENV_STG, ID_STG]]) {
    // Nenhuma gravação em disco durante a conferência (fs observado).
    const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
    fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
    try {
    const Pronta = clienteFalso({estados: [AUSENTE], identidade: id});
    const r = await m.conferir({env, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r)); assert.equal(r.precheck, 'PASS'); assert.deepEqual(r.contagens, PRESERVA);
    assert.deepEqual(escritas(Pronta.log), [], 'nenhuma consulta fora de READ ONLY');
    assert.ok(Pronta.log.some(x => x.ro && x.sql.includes('090 precheck')));
    const Ja = clienteFalso({estados: [COMPLETA], identidade: id});
    const j = await m.conferir({env, Client: Ja});
    assert.equal(j.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.equal(j.postcheck, 'PASS'); assert.deepEqual(j.contagens, {...PRESERVA, legado_ate_corte: 6, legado: 7, janela: 0, pos_janela: 0, campanhas_ativadas: 0});
    assert.deepEqual(escritas(Ja.log), []);
    const Rec = clienteFalso({estados: [{...AUSENTE, pode_referenciar: false}], identidade: id});
    const x = await m.conferir({env, Client: Rec});
    assert.equal(x.resultado, 'RECUSARIA'); assert.match(x.motivo, /SEM_PRIVILEGIO_090/);
    } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
    assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
    const Errado = clienteFalso({estados: [AUSENTE], identidade: {...id, db: 'outro_banco'}});
    assert.equal((await m.conferir({env, Client: Errado})).resultado, 'FALHA');
  }
  assert.equal((await prod.principal(['--conferir-090'], ENV_PROD, {Client: clienteFalso({estados: [{...AUSENTE, tabela: true}]})})).codigo, 3);
  await assert.rejects(prod.principal(['--conferir-090'], {...ENV_PROD, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: backup obrigatório, precheck/postcheck em READ ONLY, migration fora, marcador exclusivo e sem repetição', async () => {
  for (const [m, env, id] of [[prod, ENV_PROD, ID_PROD], [stg, ENV_STG, ID_STG]]) {
    const dir = tmp();
    try {
      await assert.rejects(m.executar({env, dir, Client: clienteFalso({identidade: id}), disco: semDisco}), /BACKUP_OBRIGATORIO/);
      assert.deepEqual(fs.readdirSync(dir), [], 'sem backup: nada gravado');
      const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], identidade: id});
      const r = await m.executar({env, backup: 'export 22/10 03:00Z', dir, Client: C, disco: semDisco});
      assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(r.etapas, ['precheck 090', 'migration 090', 'postcheck 090']);
      const mig = C.log.find(x => x.sql.includes('CREATE TABLE assinatura_campanhas'));
      assert.ok(mig && !mig.ro, 'a migration roda na própria transação do arquivo');
      assert.ok(C.log.find(x => x.sql.includes('090 precheck OK')).ro); assert.ok(C.log.find(x => x.sql.includes('090 postcheck OK')).ro);
      assert.equal(escritas(C.log).length, 1, 'a única escrita é a migration');
      const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
      assert.equal(marcador.situacao, 'CONCLUIDA'); assert.equal(marcador.backup, 'export 22/10 03:00Z'); assert.equal(marcador.ambiente, m === prod ? 'production' : 'staging');
      assert.ok(!JSON.stringify(marcador).includes('SENHA_FALSA') && !JSON.stringify(marcador).includes('postgresql://'));
      // Nova tentativa no mesmo disco: recusada antes de conectar.
      const D = clienteFalso({identidade: id});
      await assert.rejects(m.executar({env, backup: 'export 22/10 03:00Z', dir, Client: D, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
      assert.equal(D.log.length, 0);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação: falha da migration fica FALHA no marcador (código 2), sem repetir; já aplicada só confere; disco ausente recusa', async () => {
  const dir = tmp();
  try {
    const r = await prod.executar({env: ENV_PROD, backup: 'export 22/10', dir, Client: clienteFalso({falharEm: 'CREATE TABLE assinatura_campanhas'}), disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, 'migration 090'); assert.equal(r.migracaoCommitada, false);
    assert.match(r.falha.mensagem, /falha simulada/);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(marcador.situacao, 'FALHA'); assert.deepEqual(marcador.etapas.map(e => [e.nome, e.ok === true]), [['precheck 090', true], ['migration 090', false]]);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({estados: [COMPLETA]});
    const r = await prod.executar({env: ENV_PROD, backup: 'export 22/10', dir: dir2, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(r.etapas, ['postcheck 090']); assert.deepEqual(escritas(C.log), []);
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  await assert.rejects(prod.executar({env: ENV_PROD, backup: 'export 22/10', dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-090')), /DISCO_PERSISTENTE_AUSENTE/);
});

test('plano sem conexão: arquivos com sha, ordem código → conferir → aplicar → conferir; CLI devolve 0', async () => {
  for (const m of [prod, stg]) {
    const {codigo, saida} = await m.principal([], {});
    assert.equal(codigo, 0); assert.equal(saida.conecta, false);
    assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
    assert.match(saida.ordem[0], /deploy do código/); assert.equal(saida.ordem.at(-2), '--conferir-090'); assert.match(saida.ordem.at(-1), /campanha continua em rascunho/);
    assert.ok(saida.nuncaExecuta.includes('down 090'));
  }
  assert.equal(prod.DIR, '/opt/render/project/src/data/assinatura-campanha-090-producao'); assert.equal(stg.DIR, '/opt/render/project/src/data/assinatura-campanha-090-staging');
  for (const m of [prod, stg]) assert.ok(m.plano().nuncaExecuta.includes('criação ou ativação de campanha'));
});

test('aplicação: resumo das colunas antigas diferente depois da migration → FALHA (migração commitada, marcador FALHA, sem repetir)', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], preservacao: () => (n++ === 0 ? {} : {resumo_fundadores: 'r2'})});
    const r = await prod.executar({env: ENV_PROD, backup: 'export 22/10', dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /PRESERVACAO_DIVERGENTE resumo_fundadores/); assert.equal(r.migracaoCommitada, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).situacao, 'FALHA');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('aplicação espera transações abertas antes do corte; se não terminam, recusa ANTES de escrever (sem falso PRESERVACAO_DIVERGENTE)', async () => {
  const pausas = [];
  const pausa = async ms => { pausas.push(ms); };
  const dir = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE, COMPLETA, COMPLETA], anteriores: [2, 1, 0]});
    const r = await prod.executar({env: ENV_PROD, backup: 'export 22/10', dir, Client: C, disco: semDisco, pausa, tentativas: 5});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r)); assert.deepEqual(pausas, [500, 500]);
    assert.ok(C.log.filter(x => x.sql.includes('xact_start <=')).every(x => x.ro), 'a espera só lê');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({estados: [AUSENTE], anteriores: [1]});
    const r = await prod.executar({env: ENV_PROD, backup: 'export 22/10', dir: dir2, Client: C, disco: semDisco, pausa, tentativas: 3});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /TRANSACOES_ANTERIORES_AO_CORTE/); assert.equal(r.migracaoCommitada, false);
    assert.deepEqual(escritas(C.log), [], 'nada escrito');
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  assert.ok(comum.SQL_ANTERIORES('2026-10-22T12:00:00.000000Z').includes('pid <> pg_backend_pid() AND datname = current_database()'));
});
