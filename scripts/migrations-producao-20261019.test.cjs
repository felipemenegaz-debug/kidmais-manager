/* eslint-disable @typescript-eslint/no-require-imports */
// Pacote de migrations de produção (19/10/2026): testes sem banco e sem rede (cliente simulado, disco temporário).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const m = require('./migrations-producao-20261019.cjs');
const lanc = require('./migrations-lancamento-production.cjs');
const raiz = path.resolve(__dirname, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
const lf = a => fs.readFileSync(path.join(raiz, a), 'utf8').replace(/\r\n/g, '\n');
const ORDEM = ['074a', '075', '076', '077', '078', '079', '084', '060', '065', '080', '081', '082', '083', '085', '086'];
const {sequencia} = m.carregar(raiz);

test('manifesto: hash fixo, ordem, 15 etapas, 38 SQL conferidos e amarração ao pacote do lançamento', () => {
  assert.equal(sha(lf(m.MANIFESTO)), m.HASH_MANIFESTO);
  assert.deepEqual(sequencia.map(e => e.id), ORDEM);
  assert.deepEqual(sequencia.map(e => e.aplicador), [...Array(6).fill('lancamento'), 'migration-084-production', ...Array(8).fill('este')]);
  const arquivos = sequencia.flatMap(e => e.arquivos);
  assert.equal(arquivos.length, 18 + 1 + 19);
  for (const a of arquivos) assert.equal(sha(lf(a.arquivo)), a.sha256, a.arquivo);
  const man = JSON.parse(lf(m.MANIFESTO));
  assert.equal(man.lancamento.sha256, lanc.HASH_MANIFESTO);
  assert.equal(man.status, 'PREPARADO_NAO_EXECUTADO');
  assert.deepEqual(man.alvo, m.ALVO);
});

test('mesmos SQL revisados dos aplicadores de staging (083, 085/086) e de produção (084)', () => {
  const s8586 = require('./migration-085-086-staging.cjs').ETAPAS, s083 = require('./migration-083-staging.cjs'), p084 = require('./migration-084-production.cjs').ETAPAS;
  const hashes = new Map(sequencia.flatMap(e => e.arquivos.map(a => [a.arquivo, a.sha256])));
  for (const [, arquivo, h] of s8586) assert.equal(hashes.get(arquivo), h, arquivo);
  assert.equal(hashes.get(p084[2][1]), p084[2][2]);
  const etapas083 = (s083.ETAPAS ?? []);
  for (const e of etapas083) { const [arquivo, h] = Array.isArray(e) ? [e[1], e[2]] : [e.arquivo, e.sha256]; if (hashes.has(arquivo)) assert.equal(hashes.get(arquivo), h, arquivo); }
});

function copiaRaiz() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-prod-raiz-'));
  const man = JSON.parse(lf(m.MANIFESTO)), manL = JSON.parse(lf(man.lancamento.manifesto));
  const lista = [m.MANIFESTO, man.lancamento.manifesto, man.lancamento.aplicador, man.lancamento.diagnostico,
    ...man.sequencia.flatMap(e => (e.arquivos ?? []).map(a => a.arquivo)), ...manL.migrations.flatMap(e => e.arquivos.map(a => a.arquivo))];
  for (const a of lista) { fs.mkdirSync(path.dirname(path.join(d, a)), {recursive: true}); fs.copyFileSync(path.join(raiz, a), path.join(d, a)); }
  return d;
}
test('adulteração: manifesto, SQL do pacote, SQL do lançamento ou aplicador do lançamento são recusados', () => {
  const casos = [[m.MANIFESTO, /MANIFESTO_DIVERGENTE/], ['database/migrations/20261011_082_wall_e_atendimento.sql', /SQL_DIVERGENTE/],
    ['database/checks/20261009_074a_postcheck.sql', /SQL_DIVERGENTE/], ['scripts/migrations-lancamento-production.cjs', /APLICADOR_LANCAMENTO_DIVERGENTE/]];
  for (const [arquivo, erro] of casos) {
    const d = copiaRaiz();
    try { fs.appendFileSync(path.join(d, arquivo), '\n-- alterado\n'); assert.throws(() => m.carregar(d), erro, arquivo); }
    finally { fs.rmSync(d, {recursive: true, force: true}); }
  }
  const d = copiaRaiz();
  try { m.carregar(d); } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('CRLF no disco não muda o hash (normalização LF, como no lançamento)', () => {
  const d = copiaRaiz();
  try {
    const a = path.join(d, 'database/migrations/20261001_060_whatsapp_atendimento.sql');
    fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.equal(m.carregar(d).sequencia.length, 15);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

const ENV = {RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: 'postgresql://usuario_teste:senha_teste@dpg-dak750gae00c73fudmg0-a/kidmais_production'};
test('trava de alvo: serviço, ambiente, TLS, host interno exato, banco, porta e URL sem query', () => {
  const o = m.alvo(ENV);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  for (const [k, v, erro] of [['RENDER', undefined, /FORA_DO_RENDER/], ['RENDER_SERVICE_ID', 'srv-daif418ae00c73e8k2gg', /SERVICO_RECUSADO/],
    ['KIDMAIS_DEPLOY_ENV', 'staging', /AMBIENTE_RECUSADO/], ['DATABASE_SSL', 'false', /TLS_OBRIGATORIO/],
    ['DATABASE_URL', 'postgresql://u:s@dpg-dak750gae00c73fudmg0-a.oregon-postgres.render.com/kidmais_production', /HOST_RECUSADO/],
    ['DATABASE_URL', 'postgresql://u:s@dpg-dak750gae00c73fudmg0-a/kidmais_staging_1z91', /BANCO_RECUSADO/],
    ['DATABASE_URL', 'postgresql://u:s@dpg-dak750gae00c73fudmg0-a:6543/kidmais_production', /PORTA_RECUSADA/],
    ['DATABASE_URL', 'postgresql://u:s@dpg-dak750gae00c73fudmg0-a/kidmais_production?sslmode=disable', /CONNECTION_QUERY_REJECTED/],
    ['DATABASE_URL', 'nao e url', /URL_RECUSADA/]]) {
    assert.throws(() => m.alvo({...ENV, [k]: v}), erro, k);
  }
});

const ID = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true, pg_major: 18, search_path: '"$user", public', schema_do_usuario: false};
test('identidade vista pelo servidor: banco, TLS, versão TLS, rede privada, PostgreSQL 18, search_path padrão', () => {
  assert.equal(m.conferirIdentidade(ID).banco, 'kidmais_production');
  for (const [k, v, erro] of [['db', 'outro', /BANCO_DIVERGENTE/], ['tls', false, /SEM_TLS/], ['tls_versao', 'TLSv1.1', /TLS_VERSAO_RECUSADA/],
    ['servidor_privado', false, /SERVIDOR_FORA_DA_REDE_PRIVADA/], ['pg_major', 17, /VERSAO_POSTGRES_DIVERGENTE/],
    ['search_path', 'public, pg_catalog', /SEARCH_PATH_DIVERGENTE/], ['schema_do_usuario', true, /SCHEMA_DO_USUARIO_EXISTE/]]) {
    assert.throws(() => m.conferirIdentidade({...ID, [k]: v}), erro, k);
  }
});

test('interruptores de abertura: só nomes, ligado = "true" (como o código lê)', () => {
  assert.deepEqual(m.flagsLigadas({}), []);
  assert.deepEqual(m.flagsLigadas({CADASTRO_PUBLICO_ATIVO: ' TRUE ', MARKETING_SITES_PUBLICOS: 'true', WHATSAPP_ATENDIMENTO_ENABLED: 'false'}),
    ['CADASTRO_PUBLICO_ATIVO', 'MARKETING_SITES_PUBLICOS']);
  for (const k of ['ASSINATURA_PLANOS_ATIVOS', 'COTACAO_PUBLICA_POR_EMPRESA', 'WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED', 'MARKETING_AUTOMACOES_ENABLED', 'MARKETING_DOMINIOS_PERSONALIZADOS'])
    assert.deepEqual(m.flagsLigadas({[k]: 'true'}), [k]);
});

test('molduras: migration com um BEGIN/COMMIT; check só leitura (comentários e literais não contam); corpo intacto', () => {
  for (const e of sequencia) for (const a of e.arquivos) {
    const c = m.corpo(a.sql, a.tipo);
    assert.equal((c.match(/\$\$/g) || []).length, (a.sql.match(/\$\$/g) || []).length, a.arquivo);
  }
  assert.throws(() => m.corpo('BEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;', 'migration'), /MOLDURA_MIGRATION_DIVERGENTE/);
  assert.throws(() => m.corpo('SELECT 1;', 'migration'), /MOLDURA_MIGRATION_DIVERGENTE/);
  assert.throws(() => m.corpo('BEGIN;\nSELECT 1;\nCOMMIT;', 'postcheck'), /MOLDURA_CHECK_DIVERGENTE/);
  assert.throws(() => m.corpo('DELETE FROM empresas;', 'postcheck'), /CHECK_NAO_LEITURA/);
  assert.throws(() => m.corpo('SELECT 1; update empresas set nome = 1;', 'precheck'), /CHECK_NAO_LEITURA/);
  assert.equal(m.corpo("-- BEFORE UPDATE OR DELETE\nSELECT 'DROP TABLE x';", 'postcheck'), "-- BEFORE UPDATE OR DELETE\nSELECT 'DROP TABLE x';");
});

const PRODUCAO = Object.fromEntries(ORDEM.map(id => [id, ['079', '084'].includes(id) ? 'COMPLETA' : 'AUSENTE']));
test('plano a partir do estado lido em produção: lançamento 074a–078, 079/084 só postcheck, depois 060…086', () => {
  const p = m.planoEtapas(sequencia, PRODUCAO);
  assert.deepEqual(p.map(x => `${x.id}:${x.acao}`), ['074a:APLICAR_LANCAMENTO', '075:APLICAR_LANCAMENTO', '076:APLICAR_LANCAMENTO', '077:APLICAR_LANCAMENTO',
    '078:APLICAR_LANCAMENTO', '079:POSTCHECK', '084:POSTCHECK', '060:APLICAR', '065:APLICAR', '080:APLICAR', '081:APLICAR', '082:APLICAR', '083:APLICAR', '085:APLICAR', '086:APLICAR']);
  const tudo = Object.fromEntries(ORDEM.map(id => [id, 'COMPLETA']));
  assert.ok(m.planoEtapas(sequencia, tudo).every(x => x.acao === 'POSTCHECK'));
});
test('plano recusa: parcial, 079/084 ausentes, ordem quebrada (dependência ausente) e privilégio faltante', () => {
  assert.throws(() => m.planoEtapas(sequencia, {...PRODUCAO, '082': 'PARCIAL'}), /APLICACAO_PARCIAL 082/);
  assert.throws(() => m.planoEtapas(sequencia, {...PRODUCAO, '084': 'AUSENTE'}), /PRESENTE_ESPERADA_AUSENTE 084/);
  assert.throws(() => m.planoEtapas(sequencia, {...PRODUCAO, '079': 'AUSENTE'}), /PRESENTE_ESPERADA_AUSENTE 079/);
  assert.throws(() => m.planoEtapas(sequencia, {...PRODUCAO, '081': 'COMPLETA'}), /ORDEM_QUEBRADA 081 presente depois de 074a ausente/);
  assert.throws(() => m.planoEtapas(sequencia, {...PRODUCAO, '078': 'COMPLETA'}), /ORDEM_QUEBRADA 078/);
  assert.throws(() => m.planoEtapas(sequencia, PRODUCAO, ['083:dono_whatsapp_conexoes']), /SEM_PRIVILEGIO 083:dono_whatsapp_conexoes/);
});
test('privilégios exigidos só das migrations ausentes', () => {
  const tudo = {criar: true, tabelas: Object.fromEntries(['empresa_assinaturas', 'clientes', 'buffet_categorias', 'buffet_itens', 'pacote_buffet_categorias',
    'pacote_buffet_itens', 'pacote_itens_especificos', 'adicionais', 'fechamento_buffet_escolhas', 'whatsapp_conexoes', 'whatsapp_onboarding_tentativas'].map(t => [t, true])),
  funcoes: {'kidmais_068_assinatura_guarda()': true, 'kidmais_whatsapp_conexao_proteger()': true, 'kidmais_whatsapp_tentativa_proteger()': true},
  referencias: Object.fromEntries(['empresas', 'usuarios_administrativos', 'empresa_assinaturas', 'estabelecimentos', 'memberships', 'clientes', 'fechamentos'].map(t => [t, true]))};
  assert.deepEqual(m.faltasDePrivilegio(PRODUCAO, tudo), []);
  assert.deepEqual(m.faltasDePrivilegio(PRODUCAO, {...tudo, tabelas: {...tudo.tabelas, whatsapp_conexoes: false}}), ['083:dono_whatsapp_conexoes']);
  assert.ok(m.faltasDePrivilegio(PRODUCAO, {...tudo, criar: false}).includes('060:CREATE_public'));
  const so083Ausente = Object.fromEntries(ORDEM.map(id => [id, id === '083' ? 'AUSENTE' : 'COMPLETA']));
  assert.deepEqual(m.faltasDePrivilegio(so083Ausente, {...tudo, tabelas: {...tudo.tabelas, empresa_assinaturas: false}}), []);
});
test('estado legível: colunas pelo catálogo (pg_attribute), nunca information_schema', () => {
  assert.doesNotMatch(m.SQL_ESTADO, /information_schema/);
  assert.throws(() => m.lerEstado({}), /ESTADO_ILEGIVEL/);
  const linha = Object.fromEntries(ORDEM.flatMap(id => [['c' + id, false], ['v' + id, id === '060']]));
  assert.equal(m.lerEstado(linha)['060'], 'PARCIAL');
});

// ---------- cliente simulado ----------
/** Banco simulado: estado por migration; migration "commitada" só no COMMIT; postcheck/precheck configuráveis para falhar. */
function banco({estado = {...PRODUCAO}, id = ID, falharPostcheck = null, falharPrecheckBool = null, trava = true, privilegioOk = true} = {}) {
  const corpos = new Map(sequencia.flatMap(e => e.arquivos.map(a => [m.corpo(a.sql, a.tipo), {id: e.id, tipo: a.tipo}])));
  const s = {estado, chamadas: [], pendente: null, somenteLeitura: false};
  s.query = async sql => {
    s.chamadas.push(sql);
    if (sql === 'BEGIN TRANSACTION READ ONLY') { s.somenteLeitura = true; return {rows: []}; }
    if (sql === 'BEGIN') { s.somenteLeitura = false; s.pendente = null; return {rows: []}; }
    if (sql === 'SET TRANSACTION READ ONLY') { s.somenteLeitura = true; return {rows: []}; }
    if (sql === 'COMMIT') { if (s.pendente) s.estado[s.pendente] = 'COMPLETA'; s.pendente = null; return {rows: []}; }
    if (sql === 'ROLLBACK') { s.pendente = null; return {rows: []}; }
    if (sql.startsWith('SET LOCAL')) return {rows: []};
    if (sql === m.SQL_IDENTIDADE) return {rows: [id]};
    if (sql === m.SQL_TRAVA) return {rows: [{trava}]};
    if (sql === m.SQL_SOLTAR) return {rows: [{solta: true}]};
    if (sql === m.SQL_ESTADO) return {rows: [Object.fromEntries(ORDEM.flatMap(x => [['c' + x, s.estado[x] === 'COMPLETA'], ['v' + x, s.estado[x] !== 'AUSENTE']]))]};
    if (sql === m.SQL_PRIVILEGIOS) return {rows: [{criar: privilegioOk, papel_trocado: true, tabelas: new Proxy({}, {get: () => privilegioOk}), funcoes: new Proxy({}, {get: () => privilegioOk}), referencias: new Proxy({}, {get: () => privilegioOk})}]};
    if (sql === m.SQL_SITUACAO) return {rows: [{empresas: 1, kidmais: 1}]};
    const x = corpos.get(sql);
    assert.ok(x, 'SQL inesperado: ' + sql.slice(0, 80));
    if (x.tipo === 'migration') { assert.equal(s.somenteLeitura, false, 'migration em transação de leitura'); s.pendente = x.id; return {rows: []}; }
    assert.equal(s.somenteLeitura, true, `${x.tipo} ${x.id} fora de READ ONLY`);
    if (x.tipo === 'postcheck' && falharPostcheck === x.id) throw new Error('POSTCHECK_SIMULADO_FALHOU ' + x.id);
    if (x.tipo === 'precheck' && falharPrecheckBool === x.id) return {rows: [{tem_085: true, automacoes_ausentes: false}]};
    return {rows: x.tipo === 'precheck' ? [{ok: true}] : []};
  };
  return s;
}
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mig-prod-marcadores-'));
const lancamentoSimulado = (db, falhar = null) => { const chamados = []; const f = async id => { chamados.push(id); if (id === falhar) return {ok: false, erro: 'FALHA_SIMULADA'}; db.estado[id] = 'COMPLETA'; return {ok: true, saida: {id, resultado: 'APLICADA_POSTCHECK_PASS'}}; }; f.chamados = chamados; return f; };
const aplicar = (db, dir, extra = {}) => m.aplicarNoCliente(db, {sequencia, backup: '/opt/render/project/src/data/lancamento-venda-20261011/backup-x.json', dir, ...extra});

test('aplicação completa: lançamento na ordem, oito migrations com marcador, cada uma BEGIN → corpo → READ ONLY → postcheck → COMMIT', async () => {
  const db = banco(), dir = temp(), lancamento = lancamentoSimulado(db);
  try {
    const r = await aplicar(db, dir, {lancamento});
    assert.equal(r.resultado, 'PASS', JSON.stringify(r.falha));
    assert.deepEqual(lancamento.chamados, ['074a', '075', '076', '077', '078']);
    assert.deepEqual(r.etapas.map(e => e.resultado), [...Array(5).fill('APLICADA_POSTCHECK_PASS'), 'JA_APLICADA_POSTCHECK_PASS', 'JA_APLICADA_POSTCHECK_PASS', ...Array(8).fill('APLICADA_POSTCHECK_PASS')]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['060', '065', '080', '081', '082', '083', '085', '086'].map(id => `migration-${id}.json`).sort());
    for (const f of fs.readdirSync(dir)) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).situacao, 'COMMIT_CONFIRMADO', f);
    const i = db.chamadas.indexOf(m.corpo(sequencia.find(e => e.id === '085').arquivos[1].sql, 'migration'));
    assert.deepEqual(db.chamadas.slice(i - 3, i), ['BEGIN', "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '120s'"]);
    assert.equal(db.chamadas[i + 1], 'SET TRANSACTION READ ONLY');
    assert.equal(db.chamadas.at(-1), m.SQL_SOLTAR, 'trava liberada');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('falha no postcheck da 081: ROLLBACK, para na 081, marcador FALHA; repetir sem retomada recusa; retomada explícita conclui', async () => {
  const db = banco({falharPostcheck: '081'}), dir = temp();
  try {
    const r = await aplicar(db, dir, {lancamento: lancamentoSimulado(db)});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, '081'); assert.match(r.falha.mensagem, /POSTCHECK_SIMULADO_FALHOU 081/);
    assert.equal(db.estado['081'], 'AUSENTE'); assert.equal(db.estado['080'], 'COMPLETA'); assert.equal(db.estado['082'], 'AUSENTE');
    assert.ok(!r.etapas.some(e => e.id === '082'), 'nada depois da falha');
    const i = db.chamadas.lastIndexOf('SET TRANSACTION READ ONLY');
    assert.ok(db.chamadas.slice(i).includes('ROLLBACK') && !db.chamadas.slice(i).includes('COMMIT'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'migration-081.json'), 'utf8')).situacao, 'FALHA');
    const db2 = banco({estado: db.estado}), r2 = await aplicar(db2, dir, {lancamento: lancamentoSimulado(db2)});
    assert.equal(r2.resultado, 'FALHA'); assert.match(r2.falha.mensagem, /TENTATIVA_ANTERIOR_REVISAR migration-081\.json/);
    assert.ok(!db2.chamadas.includes('BEGIN'), 'recusa antes de qualquer escrita');
    const db3 = banco({estado: db.estado}), r3 = await aplicar(db3, dir, {lancamento: lancamentoSimulado(db3), retomar: '081'});
    assert.equal(r3.resultado, 'PASS', JSON.stringify(r3.falha));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'migration-081.tentativa-2.json'), 'utf8')).situacao, 'COMMIT_CONFIRMADO');
    await assert.rejects(async () => { const x = await aplicar(banco({estado: {...db3.estado, '082': 'AUSENTE', '083': 'AUSENTE', '085': 'AUSENTE', '086': 'AUSENTE'}}), dir, {lancamento: async () => ({ok: true}), retomar: '082'}); if (x.resultado !== 'PASS') throw new Error(x.falha.mensagem); }, /JA_CONFIRMADA migration-082\.json/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('retomada só de migration deste pacote ainda ausente', async () => {
  const db = banco({estado: Object.fromEntries(ORDEM.map(id => [id, 'COMPLETA']))}), dir = temp();
  try { const r = await aplicar(db, dir, {retomar: '081'}); assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /RETOMADA_RECUSADA 081/); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
  assert.throws(() => m.modo(['--retomar-autorizado', '084', '--backup', 'x']), /USO_RECUSADO/);
  assert.throws(() => m.modo(['--retomar-autorizado', '076', '--backup', 'x']), /USO_RECUSADO/);
  assert.equal(m.modo(['--retomar-autorizado', '086', '--backup', 'x']).retomar, '086');
});

test('falha do aplicador do lançamento (076) para a sequência antes da 077 e de qualquer migration deste pacote', async () => {
  const db = banco(), dir = temp(), lancamento = lancamentoSimulado(db, '076');
  try {
    const r = await aplicar(db, dir, {lancamento});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, '076'); assert.match(r.falha.mensagem, /LANCAMENTO_FALHOU 076 FALHA_SIMULADA/);
    assert.deepEqual(lancamento.chamados, ['074a', '075', '076']); assert.deepEqual(fs.readdirSync(dir), []); assert.ok(!db.chamadas.includes('BEGIN'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('precheck booleano falso (085) recusa antes do BEGIN e marca FALHA', async () => {
  const db = banco({falharPrecheckBool: '085'}), dir = temp();
  try {
    const r = await aplicar(db, dir, {lancamento: lancamentoSimulado(db)});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.falha.etapa, '085'); assert.match(r.falha.mensagem, /PRECHECK_RECUSOU 085: automacoes_ausentes/);
    assert.equal(db.estado['085'], 'AUSENTE'); assert.equal(db.estado['083'], 'COMPLETA');
    const corpo085 = m.corpo(sequencia.find(e => e.id === '085').arquivos[1].sql, 'migration');
    assert.ok(!db.chamadas.includes(corpo085));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('recusas antes de qualquer escrita: identidade divergente, execução concorrente, parcial, sem privilégio', async () => {
  for (const [opcoes, erro] of [[{id: {...ID, db: 'kidmais_staging_1z91'}}, /BANCO_DIVERGENTE/], [{trava: false}, /EXECUCAO_CONCORRENTE/],
    [{estado: {...PRODUCAO, '060': 'PARCIAL'}}, /APLICACAO_PARCIAL 060/], [{privilegioOk: false}, /SEM_PRIVILEGIO/]]) {
    const db = banco(opcoes), dir = temp(), lancamento = lancamentoSimulado(db);
    try {
      let r;
      try { r = await aplicar(db, dir, {lancamento}); } catch (e) { r = {resultado: 'FALHA', falha: {mensagem: e.message}}; }
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, erro);
      assert.ok(!db.chamadas.includes('BEGIN')); assert.deepEqual(lancamento.chamados, []); assert.deepEqual(fs.readdirSync(dir).length, 0);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('tudo já aplicado: só postchecks READ ONLY, nenhum BEGIN de escrita, nenhum marcador, nenhum processo do lançamento', async () => {
  const db = banco({estado: Object.fromEntries(ORDEM.map(id => [id, 'COMPLETA']))}), dir = temp(), lancamento = lancamentoSimulado(db);
  try {
    const r = await aplicar(db, dir, {lancamento});
    assert.equal(r.resultado, 'PASS'); assert.ok(r.etapas.every(e => e.resultado === 'JA_APLICADA_POSTCHECK_PASS'));
    assert.ok(!db.chamadas.includes('BEGIN')); assert.deepEqual(lancamento.chamados, []); assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('resposta do COMMIT perdida: marcador ficou e o schema está completo → postcheck somente leitura, sem nova escrita', async () => {
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'migration-060.json'), JSON.stringify({situacao: 'COMMIT_ENVIADO'}));
    const estado = Object.fromEntries(ORDEM.map(id => [id, ['085', '086'].includes(id) ? 'AUSENTE' : 'COMPLETA']));
    const db = banco({estado}), r = await aplicar(db, dir, {lancamento: lancamentoSimulado(db)});
    assert.equal(r.resultado, 'PASS'); assert.equal(r.etapas.find(e => e.id === '060').resultado, 'JA_APLICADA_POSTCHECK_PASS');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('conferência: somente leitura, precheck só da primeira ausente, postcheck das presentes, RECUSARIA com flag ligada', async () => {
  const db = banco();
  const r = await m.conferirNoCliente(db, {sequencia, env: {}});
  assert.equal(r.resultado, 'CONFERIDO');
  assert.deepEqual(r.verificacoes, [{id: '074a', precheck: 'PASS'}, {id: '079', postcheck: 'PASS'}, {id: '084', postcheck: 'PASS'}]);
  assert.ok(!db.chamadas.includes('BEGIN') && !db.chamadas.includes('COMMIT'));
  assert.ok(!db.chamadas.includes(m.SQL_TRAVA), 'conferência não toma a trava');
  const r2 = await m.conferirNoCliente(banco(), {sequencia, env: {CADASTRO_PUBLICO_ATIVO: 'true'}});
  assert.equal(r2.resultado, 'RECUSARIA'); assert.deepEqual(r2.flagsLigadas, ['CADASTRO_PUBLICO_ATIVO']);
  const r3 = await m.conferirNoCliente(banco({estado: {...PRODUCAO, '080': 'COMPLETA'}}), {sequencia, env: {}});
  assert.equal(r3.resultado, 'RECUSARIA'); assert.match(r3.planoRecusado, /ORDEM_QUEBRADA/);
  const r4 = await m.conferirNoCliente(banco({estado: Object.fromEntries(ORDEM.map(id => [id, 'COMPLETA']))}), {sequencia, env: {}});
  assert.equal(r4.verificacoes.length, 15); assert.ok(r4.verificacoes.every(v => v.postcheck === 'PASS'));
});

test('principal: plano sem conexão; recusas antes de conectar (fora do Render, flag ligada, registro de backup inválido, disco)', async () => {
  let construidos = 0; const Client = class { constructor() { construidos++; } };
  const deps = {Client, disco: () => {}, lancamento: {...lanc, conferirBackup: async () => ({criadoEm: 'x', pitrConferidoEm: 'y'})}};
  const p = await m.principal([], {}, deps); assert.equal(p.codigo, 0); assert.equal(p.saida.conecta, false); assert.equal(p.saida.sequencia.length, 15);
  await assert.rejects(m.principal(['--conferir'], {}, deps), /FORA_DO_RENDER/);
  await assert.rejects(m.principal(['--aplicar-autorizado', '--backup', '/opt/render/project/src/data/lancamento-venda-20261011/backup-a.json'], {...ENV, MARKETING_AUTOMACOES_ENABLED: 'true'}, deps), /FLAG_LIGADA MARKETING_AUTOMACOES_ENABLED/);
  await assert.rejects(m.principal(['--aplicar-autorizado', '--backup', '/tmp/backup-a.json'], ENV, deps), /REGISTRO_BACKUP_INVALIDO/);
  await assert.rejects(m.principal(['--aplicar-autorizado', '--backup', '/opt/render/project/src/data/lancamento-venda-20261011/backup-a.json'], ENV, {...deps, disco: () => { throw new Error('DISCO_PERSISTENTE_AUSENTE'); }}), /DISCO_PERSISTENTE_AUSENTE/);
  await assert.rejects(m.principal(['--aplicar-autorizado', '--backup', '/opt/render/project/src/data/lancamento-venda-20261011/backup-a.json'], ENV, {...deps, lancamento: {...lanc, conferirBackup: async () => { throw new Error('BACKUP_ANTIGO'); }}}), /BACKUP_ANTIGO/);
  assert.equal(construidos, 0, 'nenhum cliente criado nas recusas');
  for (const argv of [['--aplicar-autorizado'], ['--aplicar-autorizado', '--backup'], ['--conferir', '--aplicar-autorizado'], ['--retomar-autorizado', '081'], ['x']])
    assert.throws(() => m.modo(argv), /USO_RECUSADO/, argv.join(' '));
});

test('registro de backup do lançamento: conferido pelo verificador revisado (fora da pasta fixa recusado)', async () => {
  await assert.rejects(lanc.conferirBackup('C:/tmp/backup.json'), /REGISTRO_FORA_DO_DISCO/);
  const d = temp();
  try {
    fs.writeFileSync(path.join(d, 'backup-a1.json'), JSON.stringify({criadoEm: new Date(Date.now() - 3600000).toISOString(), pitrConferidoEm: new Date().toISOString(),
      manifestoSha256: lanc.HASH_MANIFESTO, arquivoIntegralmenteLido: true}));
    fs.writeFileSync(path.join(d, 'migration-074a.json'), '{}');
    const r = m.registrosBackup(d, Date.now(), fs, lanc.HASH_MANIFESTO);
    assert.equal(r.length, 1); assert.equal(r[0].idadeHoras, 1); assert.equal(r[0].pacoteConfere, true);
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
});

test('processo filho do lançamento: só PASS com saída JSON da mesma migration aplicada; erro curto sem URL', () => {
  const exec = (status, stdout, stderr = '', extra = {}) => () => ({status, stdout, stderr, ...extra});
  assert.equal(m.rodarLancamento('075', 'b', {executar: exec(0, '{"id":"075","resultado":"APLICADA_POSTCHECK_PASS"}\n')}).ok, true);
  assert.equal(m.rodarLancamento('075', 'b', {executar: exec(0, '{"id":"076","resultado":"APLICADA_POSTCHECK_PASS"}')}).ok, false);
  assert.equal(m.rodarLancamento('075', 'b', {executar: exec(0, '{"id":"075","resultado":"JA_APLICADA_POSTCHECK_PASS"}')}).ok, false);
  const r = m.rodarLancamento('075', 'b', {executar: exec(1, '', 'falhou em postgresql://u:s@h/db')});
  assert.equal(r.ok, false); assert.doesNotMatch(r.erro, /postgresql:\/\//);
  assert.equal(m.rodarLancamento('075', 'b', {executar: exec(null, '', '', {signal: 'SIGTERM'})}).ok, false);
  let args; m.rodarLancamento('077', '/opt/x.json', {executar: (_b, a) => { args = a; return {status: 0, stdout: '{"id":"077","resultado":"APLICADA_POSTCHECK_PASS"}'}; }});
  assert.deepEqual(args.slice(1), ['--aplicar-migration-autorizada', '077', '--backup', '/opt/x.json']);
});

test('pacote do lançamento continua válido: hashes do manifesto, 079 já presente vira só postcheck, comandos P1/P2 com os arquivos atuais', () => {
  const plano = lanc.carregar(raiz); assert.deepEqual(plano.map(e => e.id), ['074a', '075', '076', '077', '078', '079']);
  for (const arq of ['docs/evidencias/backup-production-comando-codex-20261011.txt', 'docs/evidencias/cutover-production-comando-20261013.txt']) {
    const texto = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const lista = JSON.parse(/const (?:arquivos|pacote)=(\[.*?\]);/s.exec(texto)[1]);
    for (const f of lista) {
      const bruto = Buffer.from(f.base64, 'base64');
      assert.equal(sha(bruto), f.sha256, arq + ' ' + (f.rel ?? f.nome));
      const rel = f.rel ?? 'scripts/' + f.nome;
      assert.equal(sha(lf(rel)), f.sha256, 'arquivo atual igual ao embutido: ' + rel);
    }
  }
});
