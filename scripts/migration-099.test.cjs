/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 099 de PRODUÇÃO com cliente simulado (transação com ROLLBACK/COMMIT de verdade no estado simulado): trava
// de alvo e identidade, hashes, estado ausente/completa/parcial, dono das tabelas e funções, pré-condição vínculo/versão,
// transação única sob trava exclusiva, prova de preservação, situação do COMMIT, marcador anti-repetição, conferência só
// leitura e códigos de saída. Sem rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-099-comum.cjs');
const prod = require('./migration-099-production.cjs');
const stg = require('./migration-099-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV_PROD = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ID_PROD = {db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true};
const BACKUP = 'dump 2026-11-01T03:00Z sha 1234abcd PITR';
const ler = nome => { const [, a, h] = comum.ETAPAS.find(e => e[0] === nome); return comum.lerRevisado(raiz, a, h); };
const DDL = comum.semTransacao(ler('migration 099'));
const AUSENTE = Object.freeze({dependencias: true, restricao: false, restricao_def: null, indice: false, indice_definicao: false, colunas_nulaveis: 0,
  corpo_vinculo: false, corpo_autorizacao: false, corpo_vinculo_073: true, corpo_autorizacao_088: true, dono: true, pode_criar: true, plpgsql: true, papel_trocado: true});
/** Forma que o servidor reconstrói para o CHECK da 099 (pg_get_constraintdef): cada folha entre parênteses. */
const DEF_RECONSTRUIDA = 'CHECK ((((festa_id IS NULL) AND (cliente_id IS NULL) AND (versao_contrato_id IS NULL) AND (estabelecimento_id IS NULL) AND (editor_hash IS NULL)) OR ((festa_id IS NOT NULL) AND (cliente_id IS NOT NULL) AND (versao_contrato_id IS NOT NULL))))';
const COMPLETA = Object.freeze({...AUSENTE, restricao: true, restricao_def: DEF_RECONSTRUIDA, indice: true, indice_definicao: true, colunas_nulaveis: 4,
  corpo_vinculo: true, corpo_autorizacao: true, corpo_vinculo_073: false, corpo_autorizacao_088: false});
const RETRATO = Object.freeze({convites: 40, convites_avulsos: 0, resumo_convites: 'abc', autorizacoes: 7, resumo_autorizacoes: 'def'});
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), {code});

/**
 * Cliente simulado com transação: BEGIN (escrita) tira um retrato do estado; ROLLBACK o restaura; COMMIT o confirma. O DDL
 * (texto real da 099 sem BEGIN/COMMIT) torna o estado completo e cria um avulso no retrato só se `mexer` for verdadeiro.
 * Opções: `inicial`, `falharEm` (trecho) + `erro`, `incompativeis` (o check vínculo/versão recusa), `erroCommit`,
 * `estadoNaTrava` (o estado lido sob a trava), `mexer` (o retrato muda depois do DDL).
 */
function clienteFalso({inicial = AUSENTE, identidade = ID_PROD, falharEm, erro, incompativeis = 0, erroCommit, estadoNaTrava, mexer} = {}) {
  const log = []; let ro = false, emTx = false, salvo = null, estado = {...inicial}, retrato = {...RETRATO};
  const C = class {
    on() {} async connect() {} async end() {}
    async query(sql) {
      log.push({sql, ro, emTx});
      if (sql === 'BEGIN TRANSACTION READ ONLY') { ro = true; return {rows: []}; }
      if (sql === 'BEGIN') { emTx = true; salvo = {estado: {...estado}, retrato: {...retrato}}; return {rows: []}; }
      if (sql === 'ROLLBACK') { if (emTx && salvo) ({estado, retrato} = {estado: salvo.estado, retrato: salvo.retrato}); ro = false; emTx = false; salvo = null; return {rows: []}; }
      if (sql === 'COMMIT') { if (erroCommit) { emTx = false; throw erroCommit; } emTx = false; salvo = null; return {rows: []}; }
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada em ' + falharEm);
      if (sql.startsWith('SELECT current_database()')) return {rows: [identidade]};
      if (sql === comum.SQL_ESTADO) return {rows: [emTx && estadoNaTrava && !log.some(x => x.sql === DDL) ? {...estadoNaTrava} : {...estado}]};
      if (sql === comum.SQL_RETRATO) return {rows: [{...retrato}]};
      if (sql === comum.SQL_INCOMPATIVEIS) return {rows: [{incompativeis}]};
      if (sql === ler('vinculo-versao 099') && incompativeis > 0) throw erroPg('P0001', `099: ${incompativeis} convite(s) vinculado(s) que a regra nova recusaria em qualquer atualização`);
      if (sql === DDL) { assert.ok(emTx && !ro, 'DDL só dentro da transação de escrita'); estado = {...COMPLETA}; if (mexer) retrato = {...retrato, convites_avulsos: 1}; }
      return {rows: []};
    }
  };
  C.log = log; C.estado = () => estado;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-099-prod-'));
const semDisco = () => {};
const executar = (dir, opcoes = {}) => prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: clienteFalso(opcoes), disco: semDisco});
const escritasForaDeRO = log => log.filter(x => !x.ro && !/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|SET LOCAL)/.test(x.sql) && x.sql !== 'BEGIN' && x.sql !== 'COMMIT'
  && !x.sql.startsWith('SELECT current_database()') && x.sql !== comum.SQL_ESTADO && x.sql !== comum.SQL_RETRATO);

test('hashes dos 4 SQL conferem (CRLF normalizado); o DDL roda sem BEGIN/COMMIT do arquivo; divergente é recusado', () => {
  for (const [, arquivo, hash] of comum.ETAPAS)
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), hash, arquivo);
  assert.deepEqual(comum.ETAPAS.map(e => e[0]), ['precheck 099', 'vinculo-versao 099', 'migration 099', 'postcheck 099']);
  // Os três SQL da 099 são os mesmos do aplicador de staging (já usado em 24/10): nada da 099 mudou.
  assert.deepEqual(comum.ETAPAS.filter(e => e[0] !== 'vinculo-versao 099').map(e => e[2]), stg.HASHES);
  assert.throws(() => comum.lerRevisado(raiz, comum.ETAPAS[2][1], 'f'.repeat(64)), /ARQUIVO_DIVERGENTE/);
  assert.doesNotMatch(DDL, /^\s*(BEGIN|COMMIT);\s*$/m); assert.match(DDL, /ALTER TABLE convites ALTER COLUMN festa_id DROP NOT NULL/);
  assert.equal(DDL.split('\n').length, ler('migration 099').split('\n').length - 2, 'só as duas linhas de transação saem');
  assert.throws(() => comum.semTransacao('SELECT 1;'), /MIGRATION_SEM_BEGIN_UNICO/);
  assert.throws(() => comum.semTransacao('BEGIN;\nSELECT 1;'), /MIGRATION_SEM_COMMIT_UNICO/);
});

test('pré-condição vínculo/versão: somente leitura, mesma condição do corpo novo da 099, recusa com contagem e sem ids', () => {
  const sql = ler('vinculo-versao 099'), mig = ler('migration 099');
  const codigo = sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(codigo, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/);
  // A condição do gatilho novo (festa → contrato → fechamento, empresa, cliente, estabelecimento e versão do contrato).
  for (const trecho of ['JOIN contratos c ON c.id=f.contrato_id JOIN fechamentos fe ON fe.id=c.fechamento_id', 'fe.estabelecimento_id IS NOT DISTINCT FROM',
    'v.id=', 'v.contrato_id=c.id']) { assert.ok(sql.includes(trecho), trecho); assert.ok(mig.includes(trecho), 'migration ' + trecho); }
  assert.match(sql, /festa_id IS NOT NULL/); assert.match(sql, /RAISE EXCEPTION '099: % convite/);
  assert.doesNotMatch(sql, /RAISE[^;]*\b(id|cv\.id)\b,/);
  assert.ok(comum.SQL_INCOMPATIVEIS.includes('v.contrato_id=c.id') && comum.SQL_INCOMPATIVEIS.includes('count(*)::int AS incompativeis'));
});

test('trava de alvo e identidade de produção; o adaptador de staging recusa produção', () => {
  assert.deepEqual(prod.alvo(ENV_PROD).ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'});
  assert.equal(prod.alvo(ENV_PROD).application_name, 'kidmais-migration-099-production');
  for (const [delta, e] of [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/],
    [{DATABASE_URL: URL_PROD.replace('kidmais_production', 'kidmais_manager')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('dpg-dak750gae00c73fudmg0-a', 'dpg-daidko3m8hqs73ce4jt0-a')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace(':5432/', ':6543/')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/],
    [{DATABASE_URL: 'x'}, /URL_RECUSADA/]]) assert.throws(() => prod.alvo({...ENV_PROD, ...delta}), e);
  let msg = ''; try { prod.alvo({...ENV_PROD, DATABASE_URL: URL_PROD + '?password=SEGREDO'}); } catch (x) { msg = String(x.message); }
  assert.match(msg, /^[A-Z_]+$/);
  assert.deepEqual(prod.identidade(ID_PROD), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true});
  for (const [delta, e] of [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/],
    [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/]]) assert.throws(() => prod.identidade({...ID_PROD, ...delta}), e);
  assert.throws(() => stg.alvo(ENV_PROD), /SERVICO_RECUSADO|srv-daif418ae00c73e8k2gg/);
  assert.throws(() => prod.exigirDisco(path.join(os.tmpdir(), 'nao-existe-099-prod')), /DISCO_PERSISTENTE_AUSENTE/);
});

test('estado e privilégio: dono (current_user) das 2 tabelas e 2 funções; corpos 073/088 → 099 pelos hashes dos checks', () => {
  for (const nome of [...comum.ALTERADAS, ...comum.FUNCOES]) assert.ok(comum.SQL_ESTADO.includes(`'${nome}'`), nome);
  assert.match(comum.SQL_ESTADO, /pg_has_role\(current_user, d, 'USAGE'\)/); assert.match(comum.SQL_ESTADO, /count\(\*\)=4/);
  assert.match(comum.SQL_ESTADO, /\(session_user <> current_user\) AS papel_trocado|session_user <> current_user AS papel_trocado/);
  assert.doesNotMatch(comum.SQL_ESTADO, /\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/);
  const pre = ler('precheck 099'), pos = ler('postcheck 099');
  assert.ok(pre.includes(comum.CORPOS.vinculo.antes) && pre.includes(comum.CORPOS.autorizacao.antes), 'corpos 073/088 = os do precheck');
  assert.ok(pos.includes(comum.CORPOS.vinculo.depois) && pos.includes(comum.CORPOS.autorizacao.depois), 'corpos 099 = os do postcheck');
  const p = (e) => comum.planoEtapas(comum.lerEstado(e));
  assert.deepEqual(p(AUSENTE), comum.ETAPAS.map(e => e[0])); assert.deepEqual(p(COMPLETA), ['postcheck 099']);
  assert.deepEqual(p({...COMPLETA, dono: false}), ['postcheck 099'], 'aplicada: dono não conta');
  assert.throws(() => p({...AUSENTE, dono: false}), /SEM_PRIVILEGIO_099 DONO/);
  assert.throws(() => p({...AUSENTE, dependencias: false}), /DEPENDENCIA_AUSENTE_073_088/);
  assert.throws(() => p({...AUSENTE, corpo_vinculo_073: false}), /CORPO_ANTERIOR_DIVERGENTE_099/);
  for (const k of comum.OBJETOS) {
    assert.throws(() => p({...AUSENTE, [k]: true}), /APLICACAO_PARCIAL_099/, k);
    assert.throws(() => p({...COMPLETA, [k]: false}), /APLICACAO_PARCIAL_099/, k + ' faltando');
  }
  assert.throws(() => comum.lerEstado({...AUSENTE, dono: 'sim'}), /ESTADO_ILEGIVEL dono/);
  assert.throws(() => comum.lerEstado({...AUSENTE, colunas_nulaveis: true}), /ESTADO_ILEGIVEL colunas_nulaveis/);
  assert.throws(() => comum.lerEstado({...AUSENTE, colunas_nulaveis: 5}), /ESTADO_ILEGIVEL colunas_nulaveis/);
});

test('revisão do B-2 (P2-1): completa exige a DEFINIÇÃO revisada do CHECK e do índice; nome com definição divergente é parcial', () => {
  const p = (e) => comum.planoEtapas(comum.lerEstado(e));
  for (const [k, delta, rotulo] of [['restricao_definicao', {restricao_def: 'CHECK (true)'}, 'CHECK com outra expressão'],
    ['restricao_definicao', {restricao_def: null}, 'CHECK não validado (a leitura filtra convalidated)'],
    ['indice_definicao', {indice_definicao: false}, 'índice com outras colunas, inválido ou único']]) {
    const e = comum.lerEstado({...COMPLETA, ...delta});
    assert.equal(e.m099, 'parcial', rotulo); assert.deepEqual(e.divergencias, [k], rotulo);
    assert.throws(() => p({...COMPLETA, ...delta}), new RegExp('APLICACAO_PARCIAL_099 ' + k), rotulo);
  }
  assert.throws(() => comum.lerEstado({...COMPLETA, restricao_def: 42}), /ESTADO_ILEGIVEL restricao_def/);
  assert.match(comum.SQL_ESTADO, /contype='c' AND convalidated/);
  assert.match(comum.SQL_ESTADO, /i\.indisvalid AND i\.indisready AND NOT i\.indisunique/);
  assert.match(comum.SQL_ESTADO, /i\.indrelid=to_regclass\('public\.convites'\)/);
  assert.ok(new RegExp(comum.DEF_INDICE).test('CREATEINDEXconvites_empresa_atualizadoONpublic.convitesUSINGbtreeempresa_id,atualizado_emDESC,id'),
    'forma do pg_get_indexdef sem parênteses/espaços');
  assert.match(ler('migration 099'), /CREATE INDEX convites_empresa_atualizado ON convites\(empresa_id,atualizado_em DESC,id\);/);
  for (const errado of ['CREATEINDEXconvites_empresa_atualizadoONpublic.convitesUSINGbtreeempresa_id,id', 'CREATEUNIQUEINDEXconvites_empresa_atualizadoONpublic.convitesUSINGbtreeempresa_id,atualizado_emDESC,id'])
    assert.ok(!new RegExp(comum.DEF_INDICE).test(errado), errado);
});

test('revisão do B-2 (rodadas 2 e 3, P2): CHECK analisado LOCALMENTE (gramática fechada + tabela-verdade); nada do catálogo é executado', () => {
  assert.equal(comum.TABELA_VERDADE.length, 32);
  assert.equal(comum.TABELA_VERDADE.filter(x => x.esperado).length, 5, 'vínculo vazio + festa/cliente/versão com estabelecimento/editor livres');
  const valida = comum.definicaoCheck099Valida;
  // A expressão da migration (como escrita) e a forma reconstruída pelo servidor são aceitas.
  const daMigration = ler('migration 099').match(/ADD CONSTRAINT convite_avulso_vinculo_completo (CHECK \([\s\S]*?\));\nALTER TABLE convite_ia/)[1];
  assert.ok(valida(daMigration), 'expressão da migration'); assert.ok(valida(DEF_RECONSTRUIDA), 'forma reconstruída');
  // Rodada 2: mesmo texto sem parênteses, agrupamento diferente → recusada pela tabela-verdade.
  const A = '(festa_id IS NULL AND cliente_id IS NULL AND versao_contrato_id IS NULL AND estabelecimento_id IS NULL AND editor_hash IS NULL)';
  const divergente = `CHECK ((${A} OR festa_id IS NOT NULL) AND cliente_id IS NOT NULL AND versao_contrato_id IS NOT NULL)`;
  assert.equal(divergente.replace(/[()\s]/g, ''), daMigration.replace(/[()\s]/g, ''), 'colide sem parênteses (cenário da rodada 2)');
  assert.equal(valida(divergente), false, 'agrupamento divergente');
  for (const outra of ['CHECK (festa_id IS NULL OR festa_id IS NOT NULL)', 'CHECK (festa_id IS NOT NULL AND cliente_id IS NOT NULL AND versao_contrato_id IS NOT NULL)',
    `CHECK (${A} OR (festa_id IS NOT NULL AND cliente_id IS NOT NULL))`]) assert.equal(valida(outra), false, outra);
  // Rodada 3: chamadas de função (sem e com argumentos), nomes concatenados e o resto fora da gramática → recusados.
  for (const proibida of ['CHECK ((festa_id() IS NULL))', 'CHECK ((festa_id(cliente_id) IS NULL))', 'CHECK ((festa_idfesta_id() IS NULL))',
    'CHECK ((festa_idfesta_id IS NULL))', `CHECK (${A} OR pg_sleep(1) IS NULL)`, 'CHECK (true)', 'CHECK (1 = 1)', `CHECK (${A} OR festa_id = cliente_id)`,
    `CHECK (${A} OR (SELECT 1) IS NULL)`, `CHECK (${A} OR "festa_id" IS NULL)`, `CHECK (${A}) -- comentário`, `CHECK (${A}); SELECT 1`,
    `CHECK (${A} OR festa_id::text IS NULL)`, `CHECK (${A} OR public.festa_id IS NULL)`, 'CHECK ()', 'CHECK ((festa_id IS NULL)', 'CHECK (festa_id IS NULL))',
    'CHECK (festa_id IS NOT NOT NULL)', 'CHECK (festa_id IS NULL AND)', 'CHECK (IS NULL)', 'festa_id IS NULL', null, 42,
    // Sobra depois de uma expressão correta: a gramática exige consumir todos os tokens.
    DEF_RECONSTRUIDA + ')', DEF_RECONSTRUIDA + ' festa_id IS NULL', DEF_RECONSTRUIDA + ' ('])
    assert.equal(valida(proibida), false, String(proibida));
  for (const [expressao, motivo] of [['festa_id() IS NULL', /CHECK_GRAMATICA_RECUSADA/], ['festa_idfesta_id() IS NULL', /CHECK_TOKEN_RECUSADO/],
    ['festa_id(cliente_id) IS NULL', /CHECK_GRAMATICA_RECUSADA/], ['pg_sleep(1) IS NULL', /CHECK_TOKEN_RECUSADO/]])
    assert.throws(() => comum.arvoreCheck(expressao), motivo, expressao);
  // O SQL só LÊ a definição (texto); não há avaliação dinâmica no servidor.
  assert.match(comum.SQL_ESTADO, /\(SELECT pg_get_constraintdef\(oid\) FROM pg_constraint WHERE conrelid=to_regclass\('public\.convites'\) AND conname='convite_avulso_vinculo_completo'\s+AND contype='c' AND convalidated\) AS restricao_def/);
  for (const proibido of ['query_to_xml', 'xpath', 'EXECUTE', 'format(']) assert.ok(!comum.SQL_ESTADO.includes(proibido), proibido);
});

test('revisão do B-2 (P3): nulabilidade parcial (1 a 3 colunas) sem outros objetos é parcial, não ausente', () => {
  for (const n of [1, 2, 3]) {
    const e = comum.lerEstado({...AUSENTE, colunas_nulaveis: n});
    assert.equal(e.m099, 'parcial', String(n)); assert.deepEqual(e.divergencias, ['restricao', 'indice', 'corpo_vinculo', 'corpo_autorizacao', `colunas_nulaveis ${n}/4`]);
    assert.throws(() => comum.planoEtapas(e), /APLICACAO_PARCIAL_099/);
    assert.equal(comum.lerEstado({...COMPLETA, colunas_nulaveis: n}).m099, 'parcial', 'completa com ' + n + ' colunas');
  }
  assert.equal(comum.lerEstado(AUSENTE).m099, 'ausente'); assert.equal(comum.lerEstado(COMPLETA).m099, 'completa');
  for (const [t, c] of comum.COLUNAS) assert.ok(comum.SQL_ESTADO.includes(`('${t}','${c}')`), t + '.' + c);
});

test('revisão do B-2 (P2-2): além de dono, CREATE em public e USAGE em plpgsql, exigidos só quando ausente', () => {
  const p = (e) => comum.planoEtapas(comum.lerEstado(e));
  assert.throws(() => p({...AUSENTE, pode_criar: false}), /SEM_PRIVILEGIO_099 CREATE$/);
  assert.throws(() => p({...AUSENTE, plpgsql: false}), /SEM_PRIVILEGIO_099 PLPGSQL$/);
  assert.throws(() => p({...AUSENTE, dono: false, pode_criar: false, plpgsql: false}), /SEM_PRIVILEGIO_099 DONO CREATE PLPGSQL$/);
  assert.deepEqual(p({...COMPLETA, dono: false, pode_criar: false, plpgsql: false}), ['postcheck 099'], 'aplicada: só confere');
  assert.match(comum.SQL_ESTADO, /has_schema_privilege\(current_user,'public','CREATE'\) AS pode_criar/);
  assert.match(comum.SQL_ESTADO, /has_language_privilege\(current_user,'plpgsql','USAGE'\)/);
});

test('modo: plano, conferência e aplicação só com --backup e registro seguro', () => {
  assert.deepEqual(comum.modo([]), {modo: 'plano'}); assert.deepEqual(comum.modo(['--conferir-099']), {modo: 'conferir'});
  assert.deepEqual(comum.modo(['--aplicar-099-autorizado', '--backup', BACKUP]), {modo: 'aplicar', backup: BACKUP});
  assert.throws(() => comum.modo(['--aplicar-099-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => comum.modo(['--aplicar-099-autorizado', '--backup', 'x;rm -rf /']), /BACKUP_INVALIDO/);
  assert.throws(() => comum.modo(['--conferir-099', '--backup', BACKUP]), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => comum.modo(['--aplicar-097-autorizado', '--backup', BACKUP]), /ARGUMENTOS_RECUSADOS/);
});

test('conferência: só leitura e nada no disco; precheck + vínculo/versão quando ausente; incompatíveis recusam (código 3); aplicada passa pelo postcheck', async () => {
  const gravacoes = [], orig = {w: fs.writeFileSync, m: fs.mkdirSync};
  fs.writeFileSync = (...a) => { gravacoes.push(String(a[0])); return orig.w(...a); }; fs.mkdirSync = (...a) => { gravacoes.push(String(a[0])); return orig.m(...a); };
  try {
    const C = clienteFalso();
    const {codigo, saida: r} = await prod.principal(['--conferir-099'], ENV_PROD, {Client: C});
    assert.equal(codigo, 0, JSON.stringify(r)); assert.equal(r.resultado, 'PRONTA_PARA_APLICAR');
    assert.deepEqual(r.checks, {'precheck 099': 'PASS', 'vinculo-versao 099': 'PASS'});
    assert.equal(r.contagens.incompativeis, 0); assert.equal(r.contagens.convites, 40); assert.ok(!('resumo_convites' in r.contagens));
    assert.ok(C.log.every(x => x.ro || /^(BEGIN TRANSACTION READ ONLY|ROLLBACK)$/.test(x.sql)), 'tudo em READ ONLY');
    assert.ok(!C.log.some(x => x.sql === DDL || x.sql === 'BEGIN' || x.sql === 'COMMIT'));
    const I = clienteFalso({incompativeis: 3});
    const x = await prod.principal(['--conferir-099'], ENV_PROD, {Client: I});
    assert.equal(x.codigo, 3); assert.equal(x.saida.resultado, 'RECUSARIA'); assert.equal(x.saida.contagens.incompativeis, 3);
    assert.equal(x.saida.checks['vinculo-versao 099'], 'RECUSA'); assert.match(x.saida.motivo, /3 convite\(s\) vinculado\(s\)/);
    const A = await prod.principal(['--conferir-099'], ENV_PROD, {Client: clienteFalso({inicial: COMPLETA})});
    assert.equal(A.codigo, 0); assert.equal(A.saida.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(A.saida.checks, {'postcheck 099': 'PASS'});
    for (const [inicial, motivo] of [[{...AUSENTE, indice: true}, /APLICACAO_PARCIAL_099/], [{...AUSENTE, dono: false}, /SEM_PRIVILEGIO_099 DONO/],
      [{...AUSENTE, pode_criar: false}, /SEM_PRIVILEGIO_099 CREATE/], [{...AUSENTE, plpgsql: false}, /SEM_PRIVILEGIO_099 PLPGSQL/], [{...AUSENTE, colunas_nulaveis: 2}, /APLICACAO_PARCIAL_099/]]) {
      const y = await prod.principal(['--conferir-099'], ENV_PROD, {Client: clienteFalso({inicial})});
      assert.equal(y.codigo, 3); assert.match(y.saida.motivo, motivo);
    }
  } finally { fs.writeFileSync = orig.w; fs.mkdirSync = orig.m; }
  assert.deepEqual(gravacoes, []);
  assert.equal((await prod.conferir({env: ENV_PROD, Client: clienteFalso({identidade: {...ID_PROD, db: 'outro'}})})).resultado, 'FALHA');
  await assert.rejects(prod.principal(['--conferir-099'], {...ENV_PROD, RENDER_SERVICE_ID: 'srv-x'}, {Client: clienteFalso()}), /SERVICO_RECUSADO/);
});

test('aplicação: transação única sob trava exclusiva, na ordem; DDL depois do precheck/vínculo e antes do postcheck; COMMIT confirmado; sem repetição', async () => {
  const dir = tmp();
  try {
    await assert.rejects(prod.executar({env: ENV_PROD, dir, Client: clienteFalso(), disco: semDisco}), /BACKUP_OBRIGATORIO/);
    assert.deepEqual(fs.readdirSync(dir), []);
    const C = clienteFalso();
    const {codigo, saida: r} = await prod.principal(['--aplicar-099-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: C, disco: semDisco});
    assert.equal(codigo, 0, JSON.stringify(r)); assert.equal(r.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(r.commit, 'CONFIRMADO');
    assert.deepEqual(r.etapas, ['trava', 'precheck 099', 'vinculo-versao 099', 'migration 099', 'postcheck 099']);
    const i = s => C.log.findIndex(x => x.sql === s), ic = t => C.log.findIndex(x => x.sql.includes(t));
    const ordem = [i('BEGIN'), ic('pg_advisory_xact_lock(990024)'), i(ler('precheck 099')), i(ler('vinculo-versao 099')), i(DDL), i(ler('postcheck 099')), i('COMMIT')];
    assert.ok(ordem.every((v, k) => v >= 0 && (k === 0 || v > ordem[k - 1])), 'ordem: ' + ordem.join(','));
    assert.match(C.log[ic('pg_advisory_xact_lock')].sql, /LOCK TABLE convites, convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE/);
    assert.match(C.log[i('BEGIN') + 1].sql, /SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'/);
    // Entre BEGIN e COMMIT tudo é a mesma transação de escrita (nada em READ ONLY no meio).
    assert.ok(C.log.slice(i('BEGIN'), i('COMMIT')).every(x => !x.ro), 'transação única');
    assert.equal(C.log.filter(x => x.sql === DDL).length, 1);
    assert.deepEqual(r.retratoDepois, r.retratoAntes);
    const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
    assert.equal(marcador.situacao, 'CONCLUIDA'); assert.equal(marcador.commit, 'CONFIRMADO'); assert.equal(marcador.ambiente, 'production'); assert.equal(marcador.backup, BACKUP);
    assert.ok(!JSON.stringify(marcador).includes('SENHA_FALSA') && !JSON.stringify(marcador).includes('postgresql://'));
    const D = clienteFalso();
    await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: D, disco: semDisco}), /TENTATIVA_ANTERIOR_REVISAR/);
    assert.equal(D.log.length, 0, 'repetição recusada antes de conectar');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('recusas DENTRO da transação desfazem tudo e o DDL nunca é enviado (ou é desfeito): vínculo/versão, precheck, estado mudado, preservação', async () => {
  for (const [rotulo, opcoes, etapaFalha, mensagem, ddlEnviado] of [
    ['convites incompatíveis', {incompativeis: 2}, 'vinculo-versao 099', /2 convite\(s\)/, false],
    ['precheck recusa', {falharEm: '099: dependências 073/088 ausentes', erro: erroPg('P0001', '099: aplicação anterior ou parcial')}, 'precheck 099', /aplicação anterior/, false],
    ['estado mudou sob a trava', {estadoNaTrava: COMPLETA}, 'trava', /ESTADO_MUDOU_ANTES_DA_TRAVA/, false],
    ['retrato mudou depois do DDL', {mexer: true}, 'postcheck 099', /PRESERVACAO_DIVERGENTE convites_avulsos/, true],
    ['lock_timeout na trava', {falharEm: 'pg_advisory_xact_lock', erro: erroPg('55P03', 'canceling statement due to lock timeout')}, 'trava', /lock timeout/, false]]) {
    const dir = tmp();
    try {
      const C = clienteFalso(opcoes);
      const {codigo, saida: r} = await prod.principal(['--aplicar-099-autorizado', '--backup', BACKUP], ENV_PROD, {dir, Client: C, disco: semDisco});
      assert.equal(codigo, 2, rotulo); assert.equal(r.resultado, 'FALHA', rotulo); assert.equal(r.falha.etapa, etapaFalha, rotulo);
      assert.match(r.falha.mensagem, mensagem, rotulo); assert.equal(r.commit, 'NAO_ENVIADO', rotulo); assert.equal(r.migracaoCommitada, false, rotulo);
      assert.equal(C.log.some(x => x.sql === DDL), ddlEnviado, rotulo + ': DDL enviado?');
      assert.ok(!C.log.some(x => x.sql === 'COMMIT'), rotulo + ': sem COMMIT'); assert.ok(C.log.some(x => x.sql === 'ROLLBACK' && x.emTx), rotulo + ': ROLLBACK da transação');
      assert.equal(C.estado().restricao, false, rotulo + ': estado do banco simulado inalterado');
      const marcador = JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8'));
      assert.equal(marcador.situacao, 'FALHA'); assert.equal(marcador.commit, 'NAO_ENVIADO');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('falha no COMMIT: erro do servidor = desfeita; conexão perdida, 57014 ou sem SQLSTATE = INDETERMINADO (conferir, não repetir)', async () => {
  for (const [erro, commit, commitada] of [[erroPg('23514', 'check violation'), 'DESFEITA_PELO_SERVIDOR', false],
    [new Error('Connection terminated unexpectedly'), 'INDETERMINADO', null], [erroPg('08006'), 'INDETERMINADO', null], [erroPg('57014'), 'INDETERMINADO', null]]) {
    const dir = tmp();
    try {
      const r = await executar(dir, {erroCommit: erro});
      assert.equal(r.resultado, 'FALHA'); assert.equal(r.commit, commit, String(erro.code)); assert.equal(r.migracaoCommitada, commitada);
      assert.match(r.reconciliar, /--conferir-099/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, comum.MARCADOR), 'utf8')).commit, commit);
      await assert.rejects(executar(dir), /TENTATIVA_ANTERIOR_REVISAR/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});

test('já aplicada: só o postcheck em READ ONLY, nenhuma transação de escrita; recusa por estado não abre transação; disco ausente recusa', async () => {
  const dir = tmp();
  try {
    const C = clienteFalso({inicial: COMPLETA});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'JA_APLICADA_POSTCHECK_PASS'); assert.deepEqual(r.etapas, ['postcheck 099']);
    assert.ok(!C.log.some(x => x.sql === 'BEGIN' || x.sql === DDL)); assert.deepEqual(escritasForaDeRO(C.log), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  const dir2 = tmp();
  try {
    const C = clienteFalso({inicial: {...AUSENTE, dono: false}});
    const r = await prod.executar({env: ENV_PROD, backup: BACKUP, dir: dir2, Client: C, disco: semDisco});
    assert.equal(r.resultado, 'FALHA'); assert.match(r.falha.mensagem, /SEM_PRIVILEGIO_099 DONO/); assert.ok(!C.log.some(x => x.sql === 'BEGIN'));
  } finally { fs.rmSync(dir2, {recursive: true, force: true}); }
  await assert.rejects(prod.executar({env: ENV_PROD, backup: BACKUP, dir: tmp(), Client: clienteFalso(), disco: () => assert.fail('DISCO_PERSISTENTE_AUSENTE')}), /DISCO_PERSISTENTE_AUSENTE/);
});

test('plano sem conexão: 4 arquivos com sha, ordem antes do código, paradas e nunca o down', async () => {
  const {codigo, saida} = await prod.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.ambiente, 'production'); assert.equal(saida.marcador, 'migration-099.json');
  assert.deepEqual(saida.arquivos.map(a => a.sha256), comum.ETAPAS.map(e => e[2]));
  assert.ok(saida.ordem.findIndex(o => o.includes('--aplicar-099-autorizado')) < saida.ordem.findIndex(o => /deploy do código de Convites avulsos/.test(o)), '099 antes do código');
  assert.ok(saida.preRequisitos.some(p => /versão fora do contrato/.test(p)) && saida.preRequisitos.some(p => /dono de convites/.test(p)));
  assert.ok(saida.nuncaExecuta.includes('down 099') && saida.paradas.some(p => /INDETERMINADO/.test(p)));
  assert.ok(!saida.arquivos.some(a => a.arquivo.includes('rollback')));
  assert.equal(prod.DIR, '/opt/render/project/src/data/convites-avulsos-099-producao');
});
