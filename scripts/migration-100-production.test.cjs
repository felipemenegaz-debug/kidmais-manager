/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 100 de PRODUÇÃO (B-3) com cliente simulado: trava de alvo e identidade de produção (TLS obrigatório,
// identidade provada no servidor), disco persistente, cruzamento com staging, ordem do runbook (depois do E6, autorização
// própria, CONFERIR da 094 com a integridade composta), conferência só leitura, aplicação com marcador próprio de
// produção, recusa sem a 094 e com a 098, pares no mesmo horário e COMMIT indeterminado. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comum = require('./migration-100-comum.cjs');
const c094 = require('./migration-092-094-comum.cjs');
const prod = require('./migration-100-production.cjs');
const stg = require('./migration-100-staging.cjs');
const ev108 = require('./migration-108-evidencias.cjs');
const retrato108 = require('./migration-108-retrato.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ENV_STG = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', DATABASE_SSL: 'false',
  DATABASE_URL: 'postgresql://usuario:SENHA_FALSA@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91'});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const BACKUP = 'dump 2026-11-01T03:00Z sha 1234abcd PITR';
const H094 = c094.CORPO_CONFLITO_094, H100 = c094.CORPO_CONFLITO_100;
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return c094.lerRevisado(raiz, a, h); };
const MIGRATION = ler('migration 100');
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});
const estado = (extra = {}) => ({d100: true, corpo: H094, dono: true, pode_criar: true, linguagem: true, tipos: true, papel_trocado: true, ...extra});
const inventario = (extra = {}) => ({horarios_capacidade_maior: 0, pares_mesmo_horario: 0, ocupacoes_futuras_um_salao: 4, ...extra});
const PLANO_AUSENTE = ['precheck 100', 'migration 100', 'postcheck 100', 'integridade 094 apos 100'];

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
/** Cliente simulado (mesmo desenho da suíte de staging): a migration real troca o corpo para o da 100. */
function clienteFalso({inicial = estado(), inv = inventario(), identidade = ID_PROD, falharEm, erro, evidencias = SEM_108, prova = PROVA_INTEGRA, exigirFalsa = true} = {}) {
  const log = []; let ro = false; const atual = {...inicial};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') ro = true;
      log.push({sql, ro});
      if (sql === 'ROLLBACK' || sql === 'COMMIT') ro = false;
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql === prod.SQL_IDENTIDADE) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...atual}]};
      if (sql === comum.SQL_INVENTARIO) return {rows: [{...inv}]};
      if (sql === ev108.SQL_EVIDENCIA_108) return {rows: [{...evidencias}]};
      if (ehProva({sql})) { assert.ok(!exigirFalsa || sql.includes(SQL_PROVA_FALSA), 'a prova envolve o SQL do gerador'); return {rows: [{...prova}]}; }
      if (sql === MIGRATION) { assert.equal(ro, false, 'migration nunca dentro de READ ONLY'); atual.corpo = H100; }
      return {rows: []};
    }
  };
  C.log = log;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-100-prod-'));
const semDisco = () => {};
const escritas = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|COMMIT|SET LOCAL)/.test(x.sql));

test('trava de alvo de produção: serviço, ambiente, TLS obrigatório (certificado conforme o serviço), host, banco, porta, URL sem query', () => {
  const o = prod.alvo(ENV_PROD);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(o.application_name, 'kidmais-migration-100-production');
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
  assert.throws(() => prod.alvo(ENV_STG), /SERVICO_RECUSADO/);
  assert.equal(prod.DIR, '/opt/render/project/src/data/agenda-um-salao-100-producao');
  assert.notEqual(prod.DIR, stg.DIR);
});

test('identidade provada pelo servidor: banco de produção, TLS ativo 1.2/1.3 e servidor em rede privada; disco persistente', () => {
  assert.deepEqual(prod.identidade(ID_PROD), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
  assert.equal(prod.identidade({...ID_PROD, tls_versao: 'TLSv1.2'}).tlsVersao, 'TLSv1.2');
  for (const [delta, erro] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls: null}, /SEM_TLS/],
    [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/], [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]])
    assert.throws(() => prod.identidade({...ID_PROD, ...delta}), erro);
  assert.throws(() => prod.identidade(undefined), /BANCO_DIVERGENTE/);
  assert.match(prod.SQL_IDENTIDADE, /pg_stat_ssl/); assert.match(prod.SQL_IDENTIDADE, /inet_server_addr\(\)/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-100-prod')), /DISCO_PERSISTENTE_AUSENTE/);
  const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
  assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
  assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/, 'mesmo dispositivo do pai = disco efêmero');
  assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
});

test('conferência de produção: identidade de produção, só leitura, nada no disco; ausente = precheck + inventário; completa = postcheck + integridade composta', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const Pronta = clienteFalso();
    const r = await prod.conferir({env: ENV_PROD, Client: Pronta});
    assert.equal(r.resultado, 'PRONTA_PARA_APLICAR', JSON.stringify(r));
    assert.deepEqual(r.conexao, {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
    assert.deepEqual(r.plano, PLANO_AUSENTE); assert.deepEqual(r.inventario, inventario());
    assert.deepEqual(escritas(Pronta.log), []); assert.ok(!Pronta.log.some(x => x.sql === MIGRATION));
    const Aplicada = clienteFalso({inicial: estado({corpo: H100})});
    const j = await prod.conferir({env: ENV_PROD, Client: Aplicada});
    assert.equal(j.resultado, 'JA_APLICADA_INTEGRIDADE_PASS', JSON.stringify(j));
    assert.deepEqual(j.checks, {'postcheck 100': 'PASS', 'integridade 094 apos 100': 'PASS'});
    assert.ok(Aplicada.log.some(x => x.ro && x.sql === ler('integridade 094 apos 100')));
    assert.deepEqual(escritas(Aplicada.log), []);
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, [], 'a conferência não grava arquivos');
  // Identidade de staging (ou sem TLS) numa conexão de produção: FALHA, sem ler estado.
  for (const id of [{...ID_PROD, db: 'kidmais_staging_1z91'}, {...ID_PROD, tls: false}]) {
    const C = clienteFalso({identidade: id});
    const x = await prod.principal(['--conferir-100'], ENV_PROD, {Client: C});
    assert.equal(x.codigo, 2); assert.equal(x.saida.resultado, 'FALHA'); assert.ok(!JSON.stringify(x).includes('SENHA_FALSA'));
    assert.ok(!C.log.some(l => l.sql === comum.SQL_ESTADO), 'estado não lido');
  }
  await assert.rejects(prod.principal(['--conferir-100'], ENV_STG, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('produção recusa (código 3, nada escrito): sem a 094, com a 098 ou deriva, sem dono/CREATE e com pares no mesmo horário', async () => {
  for (const [opcoes, motivo] of [[{inicial: estado({corpo: null})}, /DEPENDENCIA_AUSENTE_100 094/], [{inicial: estado({corpo: 'b'.repeat(64)})}, /CORPO_DIVERGENTE_100/],
    [{inicial: estado({d100: false})}, /DEPENDENCIA_AUSENTE_100 093\/094\/062/], [{inicial: estado({dono: false, pode_criar: false})}, /SEM_PRIVILEGIO_100 DONO CREATE/],
    [{inv: inventario({pares_mesmo_horario: 2})}, /CONFLITOS_PREEXISTENTES_100 2/]]) {
    const C = clienteFalso(opcoes);
    const x = await prod.principal(['--conferir-100'], ENV_PROD, {Client: C});
    assert.equal(x.codigo, 3, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
    assert.deepEqual(escritas(C.log), []);
    const dir = tmp();
    try {
      const A = clienteFalso(opcoes);
      const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: A, disco: semDisco});
      assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, motivo); assert.equal(r.commit, null);
      assert.deepEqual(escritas(A.log), [], 'aplicação recusa antes da migration');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('aplicação em produção: backup obrigatório, disco exigido antes de conectar, 4 etapas, só a migration escreve, marcador de produção exclusivo', async () => {
  await assert.rejects(prod.principal(['--aplicar-100-autorizado'], ENV_PROD, {Client: clienteFalso()}), /BACKUP_OBRIGATORIO/);
  let conectou = false;
  const Espia = class extends clienteFalso() { async connect() { conectou = true; } };
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: Espia}), /DISCO_PERSISTENTE_AUSENTE/);
  assert.equal(conectou, false, 'disco padrão do adaptador (ausente fora do Render) recusa antes de conectar');
  const dir = tmp();
  try {
    const C = clienteFalso();
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS', JSON.stringify(r));
    assert.deepEqual(r.etapas, PLANO_AUSENTE); assert.equal(r.commit, 'CONFIRMADO');
    assert.deepEqual(escritas(C.log).map(x => x.sql), [MIGRATION]);
    const m = JSON.parse(fs.readFileSync(r.marcador, 'utf8'));
    assert.equal(path.basename(r.marcador), 'migration-100.json');
    assert.equal(m.ambiente, 'production'); assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.backup, BACKUP);
    assert.deepEqual(m.conexao, {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
    assert.ok(!fs.readFileSync(r.marcador, 'utf8').includes('SENHA_FALSA'));
    await assert.rejects(prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD, {Client: clienteFalso(), dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('falha no COMMIT da 100 em produção: classe 57/08 ou sem resposta = INDETERMINADO, erro do servidor = desfeita; código 2, nunca repetir', async () => {
  for (const [erro, esperado] of [[erroPg('40P01'), 'DESFEITA_PELO_SERVIDOR'], [erroPg('57P01'), 'INDETERMINADO'], [new Error('Connection terminated unexpectedly'), 'INDETERMINADO']]) {
    const dir = tmp();
    try {
      const x = await prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD,
        {Client: clienteFalso({falharEm: 'CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao', erro}), dir, disco: semDisco});
      assert.equal(x.codigo, 2); assert.equal(x.saida.commit, esperado); assert.match(x.saida.reconciliar, /--conferir-100/);
      assert.equal(JSON.parse(fs.readFileSync(x.saida.marcador, 'utf8')).situacao, 'FALHA');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('P2 da revisão: marcador que deixa de gravar (ENOSPC) depois de conectar = FALHA código 2 com o COMMIT conhecido, nunca código 1; não repete', async () => {
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'});
  // [rótulo, opções do cliente, quando o disco "enche" (pelo log do cliente ou pelo conteúdo gravado), commit esperado].
  // Uma vez cheio, o disco continua cheio em todas as gravações seguintes (inclusive a do tratamento da falha).
  for (const [rotulo, opcoes, gatilho, esperado] of [
    ['COMMIT confirmado', {}, log => log.some(x => x.sql === MIGRATION), 'CONFIRMADO'],
    ['COMMIT indeterminado', {falharEm: 'CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao', erro: erroPg('57P01')}, log => log.some(x => x.sql === MIGRATION), 'INDETERMINADO'],
    ['COMMIT desfeito', {falharEm: 'CREATE OR REPLACE FUNCTION public.kidmais094_conflito_ocupacao', erro: erroPg('40P01')}, log => log.some(x => x.sql === MIGRATION), 'DESFEITA_PELO_SERVIDOR'],
    ['antes da migration', {}, log => log.some(x => x.sql === comum.SQL_ESTADO), null],
    // Re-revisão (P3): a falha começa EXATAMENTE na gravação CONCLUIDA — todas as etapas já registradas com sucesso.
    ['sucesso completo, só a gravação CONCLUIDA falha', {}, (log, dados) => JSON.parse(String(dados)).situacao === 'CONCLUIDA', 'CONFIRMADO']]) {
    const dir = tmp(), C = clienteFalso(opcoes), orig = fs.writeFileSync;
    const marcador = path.join(dir, 'migration-100.json');
    let cheio = false, falhas = 0;
    fs.writeFileSync = (f, dados, ...a) => {
      if (String(f) === marcador && (cheio || gatilho(C.log, dados))) { cheio = true; falhas++; throw enospc(); }
      return orig(f, dados, ...a);
    };
    let x;
    try { x = await prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD, {Client: C, dir, disco: semDisco}); }
    finally { fs.writeFileSync = orig; }
    try {
      assert.equal(x.codigo, 2, rotulo + ' ' + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'FALHA', rotulo);
      assert.equal(x.saida.commit, esperado, rotulo); assert.equal(x.saida.marcadorAtualizado, false, rotulo);
      assert.match(x.saida.erroMarcador, /ENOSPC/, rotulo); assert.match(x.saida.aviso, /^MARCADOR_DESATUALIZADO/, rotulo);
      assert.match(x.saida.reconciliar, /--conferir-100/, rotulo);
      assert.ok(!JSON.stringify(x.saida).includes('SENHA_FALSA'), rotulo);
      // O marcador antigo continua no disco (EM_ANDAMENTO, nunca CONCLUIDA) e impede a repetição.
      const gravado = JSON.parse(fs.readFileSync(marcador, 'utf8'));
      assert.equal(gravado.situacao, 'EM_ANDAMENTO', rotulo);
      assert.ok(falhas >= 2, rotulo + ': a gravação do tratamento da falha também foi tentada e falhou');
      if (rotulo.includes('CONCLUIDA')) {
        // Fronteira exata: as 4 etapas e o estado final já tinham sido registrados; só a gravação CONCLUIDA falhou.
        assert.equal(falhas, 2, rotulo + ': só a CONCLUIDA e a do tratamento falharam');
        assert.deepEqual(gravado.etapas.map(e => [e.nome, e.ok]), PLANO_AUSENTE.map(n => [n, true]), rotulo);
        assert.equal(gravado.resultado, 'APLICADA_POSTCHECK_PASS', rotulo); assert.equal(gravado.estadoDepois.m100, 'completa', rotulo);
        assert.match(x.saida.falha.mensagem, /ENOSPC/, rotulo);
      }
      const n = C.log.filter(l => l.sql === MIGRATION).length;
      await assert.rejects(prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD, {Client: C, dir, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/, rotulo);
      assert.equal(C.log.filter(l => l.sql === MIGRATION).length, n, rotulo + ': a migration não roda de novo');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  // Com o marcador gravável, a FALHA informa marcadorAtualizado = true e não traz aviso.
  const dir = tmp();
  try {
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: clienteFalso({inv: inventario({pares_mesmo_horario: 1})}), disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.marcadorAtualizado, true); assert.equal(r.aviso, undefined);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('plano de produção sem conexão: alvo de produção, registro próprio, ordem depois do E6 com autorização da 100 e CONFERIR da 094; nunca o down', async () => {
  const {codigo, saida} = await prod.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production');
  assert.deepEqual(saida.alvo, prod.ALVO); assert.equal(saida.registro, prod.DIR);
  assert.deepEqual(saida.arquivos.map(a => a.sha256), [...comum.ETAPAS, c094.INTEGRIDADE_094_APOS_108].map(e => e[2]));
  assert.deepEqual(saida.corpos, {ausente: H094, completa: H100, substituida_108: c094.CORPO_CONFLITO_108});
  assert.deepEqual(saida.ordem, [...prod.ORDEM]);
  assert.match(saida.ordem[0], /^E6 concluído: código novo publicado .*094 aplicada, --conferir-094 PASS$/);
  assert.ok(saida.ordem.indexOf('--conferir-100') < saida.ordem.indexOf('--aplicar-100-autorizado'));
  assert.ok(saida.ordem.some(o => /backup restaurável de production .*PITR/.test(o)) && saida.ordem.includes('autorização de Felipe para a 100'));
  assert.ok(saida.ordem.some(o => /imediatamente antes/.test(o)) && saida.ordem.some(o => /janela combinada/.test(o)));
  assert.match(saida.ordem.at(-1), /--conferir-094: integridade da 094 com o corpo da 100/);
  assert.ok(!saida.ordem.some(o => /staging/.test(o)), 'nada da ordem de staging');
  assert.ok(saida.nuncaExecuta.includes('down 100') && !saida.arquivos.some(a => a.arquivo.includes('rollback')));
  // Staging mantém a ordem dele (a de produção não vaza para o adaptador de staging).
  const s = (await stg.principal([], {})).saida;
  assert.match(s.ordem[0], /^deploy do código/); assert.ok(s.ordem.some(o => /backup restaurável de staging/.test(o)));
});

// C-F1: produção que JÁ tem a 108. Os casos passam pelo adaptador de produção (prod.principal), que encaminha a prova
// (env do serviço, sem override de teste) ao núcleo; a 100 nunca é reaplicada sobre a 108.
const H108 = c094.CORPO_CONFLITO_108;
const APOS_108 = () => c094.lerRevisado(raiz, c094.INTEGRIDADE_094_APOS_108[1], c094.INTEGRIDADE_094_APOS_108[2]);
const nada100 = log => !log.some(l => l.sql === MIGRATION || l.sql === comum.SQL_INVENTARIO || l.sql === ler('postcheck 100') || l.sql === ler('integridade 094 apos 100'));

test('C-F1: produção com a 108 íntegra: CONFERIR e APLICAR = JA_APLICADA_SUBSTITUIDA_108 (código 0); a 100 nunca é reaplicada, nem sem dono/CREATE', async () => {
  await comProvaFalsa(async () => {
    for (const inicial of [estado({corpo: H108}), estado({corpo: H108, dono: false, pode_criar: false})]) {
      const C = clienteFalso({inicial, evidencias: COM_108});
      const x = await prod.principal(['--conferir-100'], ENV_PROD, {Client: C});
      assert.equal(x.codigo, 0, JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'JA_APLICADA_SUBSTITUIDA_108');
      assert.deepEqual(x.saida.checks, {'prova 108': 'INTEGRA', 'integridade 094 apos 108': 'PASS'});
      assert.deepEqual(x.saida.plano, ['prova 108', 'integridade 094 apos 108']);
      const i = C.log.findIndex(ehProva);
      assert.ok(i > 0 && C.log[i].ro && C.log.slice(i - 4, i).some(l => l.sql === 'SET LOCAL search_path = pg_catalog'), 'prova READ ONLY com pg_catalog');
      assert.ok(C.log.findIndex(l => l.ro && l.sql === APOS_108()) > i, 'integridade após a 108 depois da prova');
      assert.ok(nada100(C.log), 'sem inventário, migration, postcheck ou integridade após a 100'); assert.deepEqual(escritas(C.log), []);
      const dir = tmp();
      try {
        const A = clienteFalso({inicial, evidencias: COM_108});
        const e = await prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: A, disco: semDisco});
        assert.equal(e.codigo, 0, JSON.stringify(e.saida)); assert.equal(e.saida.resultado, 'JA_APLICADA_SUBSTITUIDA_108'); assert.equal(e.saida.commit, null);
        assert.deepEqual(e.saida.checks, {'prova 108': 'INTEGRA', 'integridade 094 apos 108': 'PASS'});
        assert.ok(nada100(A.log), 'a 100 nunca é reaplicada sobre a 108'); assert.deepEqual(escritas(A.log), []);
        const m = JSON.parse(fs.readFileSync(e.saida.marcador, 'utf8'));
        assert.equal(path.basename(e.saida.marcador), 'migration-100.json'); assert.equal(m.ambiente, 'production');
        assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.resultado, 'JA_APLICADA_SUBSTITUIDA_108');
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
  });
});

test('C-F1: produção com a 108 não íntegra, parcial ou corpo desconhecido: RECUSARIA (código 3) / FALHA (código 2), a 100 nunca é aplicada', async () => {
  const casos = [
    [{inicial: estado({corpo: H108}), evidencias: COM_108, prova: {...PROVA_INTEGRA, integra: false, motivos: ['MARCADOR_108', 'RETRATO_F2']}}, /^SUBSTITUIDA_108_NAO_INTEGRA MARCADOR_108 RETRATO_F2$/, true],
    [{inicial: estado({corpo: H108}), evidencias: COM_108, prova: {...PROVA_INTEGRA, integra: false, motivos: ['FUNCOES_098_CORPO', 'GATILHOS_098']}}, /^SUBSTITUIDA_108_NAO_INTEGRA FUNCOES_098_CORPO GATILHOS_098$/, true],
    [{inicial: estado({corpo: H108}), evidencias: COM_108, prova: {...PROVA_INTEGRA, search_path: 'public'}}, /SESSAO_PROVA_108 search_path/, true],
    [{inicial: estado({corpo: H094}), evidencias: {...SEM_108, marcador_108: true}}, /^EVIDENCIA_108_PARCIAL marcador_108$/, false],
    [{inicial: estado({corpo: H100}), evidencias: {...SEM_108, corpos_108: 1, funcoes_098_108: 3}}, /^EVIDENCIA_108_PARCIAL corpos_108 funcoes_098_108$/, false],
    [{inicial: estado({corpo: 'b'.repeat(64)}), evidencias: COM_108}, /^CORPO_DIVERGENTE_100/, false]];
  await comProvaFalsa(async () => {
    for (const [opcoes, motivo, comProva] of casos) {
      const C = clienteFalso(opcoes);
      const x = await prod.principal(['--conferir-100'], ENV_PROD, {Client: C});
      assert.equal(x.codigo, 3, String(motivo) + ' ' + JSON.stringify(x.saida)); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.match(x.saida.motivo, motivo);
      assert.equal(C.log.some(ehProva), comProva, String(motivo) + ': prova só com o corpo da 108');
      assert.ok(nada100(C.log) && !C.log.some(l => l.sql === APOS_108()), String(motivo)); assert.deepEqual(escritas(C.log), []);
      const dir = tmp();
      try {
        const A = clienteFalso(opcoes);
        const e = await prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: A, disco: semDisco});
        assert.equal(e.codigo, 2, String(motivo)); assert.match(e.saida.falha.mensagem, solto(motivo)); assert.equal(e.saida.commit, null);
        assert.ok(nada100(A.log), String(motivo) + ': a 100 nunca é aplicada'); assert.deepEqual(escritas(A.log), []);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    }
  });
});

test('C-F1: a prova da 108 em produção vem do adaptador: F2 não medido recusa sem consultar; override de retratos de teste sempre recusado', async () => {
  const C = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108});
  const x = await comF2Pendente(() => prod.principal(['--conferir-100'], ENV_PROD, {Client: C}));
  assert.equal(x.codigo, 3); assert.match(x.saida.motivo, /^SUBSTITUIDA_108_NAO_INTEGRA PROVA_108_INDISPONIVEL RETRATO_108_NAO_MEDIDO/);
  assert.ok(!C.log.some(ehProva));
  for (const valor of overrides()) {
    const env = {...ENV_PROD, [ev108.ENV_RETRATOS_TESTE]: valor};
    const S = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108, exigirFalsa: false});
    const s = await prod.principal(['--conferir-100'], env, {Client: S});
    assert.equal(s.codigo, 3); assert.match(s.saida.motivo, /^RETRATOS_DE_TESTE_RECUSADOS/); assert.ok(!S.log.some(ehProva));
    const dir = tmp();
    try {
      const A = clienteFalso({inicial: estado({corpo: H108}), evidencias: COM_108, exigirFalsa: false});
      const e = await prod.principal(['--aplicar-100-autorizado', '--backup', BACKUP], env, {dir, Client: A, disco: semDisco});
      assert.equal(e.codigo, 2); assert.match(e.saida.falha.mensagem, /RETRATOS_DE_TESTE_RECUSADOS/); assert.ok(nada100(A.log)); assert.deepEqual(escritas(A.log), []);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});
