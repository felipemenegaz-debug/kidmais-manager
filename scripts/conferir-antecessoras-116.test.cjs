/* eslint-disable @typescript-eslint/no-require-imports */
// Ramo m116 do conferir-antecessoras e declaração da flag da franquia (plano "Staging em dia antes da 129", §3.2, §7.2,
// §8.1, §8.2). Unitários com fakes (sem banco) e estáticos; a prova contra o PG está em registro-migrations-banco.staging.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const ca = require('./conferir-antecessoras.cjs');
const reg = require('./registro-migrations-banco.cjs');

const raiz = path.resolve(__dirname, '..');
const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8').replace(/\r\n/g, '\n');
const OK = 'JA_APLICADA_POSTCHECK_PASS';
const [MOTIVO_CICLO, MOTIVO_PENDENCIA] = ca.MOTIVOS_DADOS_116;
const MOTIVO_OPERACAO = '116 operacao: pendência de contratação não confirmada';
const SQL_OPERACAO = /116 operacao: pendência de contratação não confirmada/;
const ENV_STG = Object.freeze({KIDMAIS_DEPLOY_ENV: 'staging', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'});
const ENV_PRD = Object.freeze({KIDMAIS_DEPLOY_ENV: 'production', RENDER_SERVICE_ID: require('./migration-116-production.cjs').ALVO.servico});
const DECL_STG = 'staging cron srv-x env conferida 2026-11-22T20:00Z';
const DECL_PRD = 'production cron srv-y env conferida 2026-11-22T20:00Z';

function fabricaClient({operacao = 'pass'} = {}) {
  const instancias = [];
  class Fake {
    constructor(cfg) { this.cfg = cfg; this.sqls = []; this.fechado = false; instancias.push(this); }
    on() {} async connect() {} async end() { this.fechado = true; }
    async query(sql) {
      this.sqls.push(sql);
      if (SQL_OPERACAO.test(sql)) {
        if (operacao === 'pass') return {rows: [{banco: 'x', aprovado: true}]};
        if (operacao === 'sem-aprovado') return {rows: [{banco: 'x'}]};
        throw new Error(operacao);
      }
      return {rows: []};
    }
  }
  return {Client: Fake, instancias};
}
const modulo = {alvo: () => ({host: 'falso'}), identidade: l => l, SQL_IDENTIDADE: 'SELECT 1'};
const ambiente116 = {production: modulo, staging: modulo};
/** Todos os ids, salvo a 116, OK por fakes. */
function conferenciasOk() {
  const c = {};
  for (const {id, tipo} of ca.TABELA) {
    if (id === '116') continue;
    c[id] = tipo === 'p122' ? async () => ({codigo: 0, saida: {resultado: OK}}) : async () => ({resultado: OK});
  }
  return c;
}
const dados = (motivo, extra = {}) => ({resultado: 'RECUSARIA', motivo, estado: {m116: 'presente'}, checks: {'postcheck 116': 'FALHOU'}, ...extra});
async function rodar({r116, operacao, flagFranquia, ambiente = 'staging', env = ambiente === 'staging' ? ENV_STG : ENV_PRD} = {}) {
  const f = fabricaClient({operacao});
  let recebido;
  const conferirNoCliente116 = async (db, o) => { recebido = {db, o}; if (r116 instanceof Error) throw r116; return r116; };
  const out = await ca.conferir({ambiente, env, flagFranquia, deps: {Client: f.Client, ambiente116, conferirNoCliente116, conferencias: conferenciasOk()}});
  return {...out, f, recebido, l116: out.linhas.find(l => l.startsWith('116 '))};
}
const operacaoRodou = f => f.instancias.some(i => i.sqls.some(s => SQL_OPERACAO.test(s)));

test('8.2: 116 íntegra ⇒ OK sem olhar a declaração (sem e com o argumento, nos dois ambientes, a mesma saída)', async () => {
  for (const [ambiente, decl] of [['staging', DECL_STG], ['production', DECL_PRD]]) {
    const sem = await rodar({ambiente, r116: {resultado: OK}});
    const com = await rodar({ambiente, r116: {resultado: OK}, flagFranquia: decl});
    for (const o of [sem, com]) { assert.equal(o.codigo, 0); assert.equal(o.l116, '116 JA_APLICADA_POSTCHECK_PASS'); assert.ok(!operacaoRodou(o.f)); }
    assert.deepEqual(sem.linhas, com.linhas);
  }
});

test('7.2: ramo de dados sem a declaração ⇒ 116 PENDENTE FLAG_NAO_DECLARADA <motivo>, sem a operação', async () => {
  for (const motivo of [MOTIVO_CICLO, MOTIVO_PENDENCIA]) {
    const o = await rodar({r116: dados(motivo)});
    assert.equal(o.codigo, 3); assert.deepEqual(o.pendentes, ['116']);
    assert.equal(o.l116, '116 PENDENTE FLAG_NAO_DECLARADA ' + motivo);
    assert.ok(!operacaoRodou(o.f));
  }
});

test('7.2: ramo de dados com a declaração ⇒ operação na MESMA conexão ⇒ PRESENTE_OPERACAO_PASS flag=declarada', async () => {
  for (const motivo of [MOTIVO_CICLO, MOTIVO_PENDENCIA]) {
    const o = await rodar({r116: dados(motivo), flagFranquia: DECL_STG});
    assert.equal(o.codigo, 0, o.linhas.join('\n'));
    assert.equal(o.l116, `116 PRESENTE_OPERACAO_PASS flag=declarada "${DECL_STG}"`);
    assert.equal(o.f.instancias.length, 1, 'uma conexão só para a 116');
    assert.equal(o.recebido.db, o.f.instancias[0]);
    assert.ok(operacaoRodou(o.f)); assert.ok(o.f.instancias[0].fechado);
    const i = o.f.instancias[0].sqls.findIndex(s => SQL_OPERACAO.test(s));
    assert.equal(o.f.instancias[0].sqls[i - 4], 'BEGIN TRANSACTION READ ONLY');
    assert.equal(o.f.instancias[0].sqls[i + 1], 'ROLLBACK');
  }
});

test('7.2: operação reprovada (pendência de contratação não confirmada) ou sem aprovado ⇒ pendente com o motivo da operação', async () => {
  const o = await rodar({r116: dados(MOTIVO_CICLO), flagFranquia: DECL_STG, operacao: MOTIVO_OPERACAO});
  assert.equal(o.codigo, 3); assert.equal(o.l116, '116 PENDENTE ' + MOTIVO_OPERACAO);
  const s = await rodar({r116: dados(MOTIVO_PENDENCIA), flagFranquia: DECL_STG, operacao: 'sem-aprovado'});
  assert.equal(s.l116, '116 PENDENTE OPERACAO_SEM_APROVADO');
  const e = await rodar({r116: dados(MOTIVO_CICLO), flagFranquia: DECL_STG, operacao: '116 postcheck: definição das tabelas novas divergente: {...}'});
  assert.match(e.l116, /^116 PENDENTE 116 postcheck: definição das tabelas novas divergente/);
});

test('igualdade completa: motivo diferente, 116 parcial, postcheck não FALHOU ou PRONTA ⇒ pendente com o motivo original, sem operação, mesmo com a declaração', async () => {
  const casos = [
    [dados(MOTIVO_CICLO + ' '), /^116 PENDENTE RECUSARIA 116 postcheck: ia_credito_franquias_ciclo deveria estar vazia \(flag desligada\)$/],
    [dados('116 postcheck: definição das tabelas novas divergente: {}'), /^116 PENDENTE RECUSARIA 116 postcheck: definição das tabelas novas divergente/],
    [dados(MOTIVO_CICLO, {estado: {m116: 'parcial'}}), /^116 PENDENTE RECUSARIA /],
    [dados(MOTIVO_CICLO, {checks: {'precheck 116': 'FALHOU'}}), /^116 PENDENTE RECUSARIA /],
    [dados(MOTIVO_CICLO, {resultado: 'FALHA'}), /^116 PENDENTE FALHA /],
    [{resultado: 'PRONTA_PARA_APLICAR', estado: {m116: 'ausente'}}, /^116 PENDENTE PRONTA_PARA_APLICAR$/],
    [{resultado: 'RECUSARIA', motivo: 'APLICACAO_PARCIAL_116 tabelas 1/2'}, /^116 PENDENTE RECUSARIA APLICACAO_PARCIAL_116/],
    [new Error('IDENTIDADE_RECUSADA banco'), /^116 PENDENTE ERRO IDENTIDADE_RECUSADA banco$/],
  ];
  for (const [r116, re] of casos) {
    const o = await rodar({r116, flagFranquia: DECL_STG});
    assert.equal(o.codigo, 3); assert.match(o.l116, re); assert.ok(!operacaoRodou(o.f), o.l116);
  }
});

test('8.1: lerDeclaracaoFlag: só o ambiente da chamada e do alvo (KIDMAIS_DEPLOY_ENV e serviço); formato fechado', () => {
  assert.equal(ca.lerDeclaracaoFlag(undefined, 'staging', ENV_STG), null);
  assert.deepEqual({...ca.lerDeclaracaoFlag(DECL_STG, 'staging', ENV_STG)}, {ambiente: 'staging', registro: DECL_STG.slice(8), texto: DECL_STG});
  assert.deepEqual({...ca.lerDeclaracaoFlag(DECL_PRD, 'production', ENV_PRD)}.ambiente, 'production');
  const outro = /^Error: FLAG_DECLARADA_OUTRO_AMBIENTE /;
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'production', ENV_PRD), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_PRD, 'staging', ENV_STG), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'staging', ENV_PRD), outro);
  // Declaração e alvo do mesmo ambiente, chamada de outro (mutante M6: sem a comparação com --ambiente).
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_PRD, 'staging', ENV_PRD), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'production', ENV_STG), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'staging', {...ENV_STG, KIDMAIS_DEPLOY_ENV: 'production'}), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'staging', {...ENV_STG, RENDER_SERVICE_ID: ENV_PRD.RENDER_SERVICE_ID}), outro);
  assert.throws(() => ca.lerDeclaracaoFlag(DECL_STG, 'staging', {}), outro);
  for (const ruim of ['', 'staging', 'staging curto', 'Staging cron conferida ok', 'local cron conferida ok', 'staging cron;rm -rf conferida', 'staging ' + 'x'.repeat(121), 'staging  cron conferida'])
    assert.throws(() => ca.lerDeclaracaoFlag(ruim, 'staging', ENV_STG), /^Error: FLAG_DECLARACAO_INVALIDA|^Error: FLAG_DECLARADA_OUTRO_AMBIENTE/, ruim);
});

test('8.1: declaração de outro ambiente no conferidor ⇒ código 1 antes de conectar, 116 nunca OK', async () => {
  for (const [ambiente, env, decl] of [['production', ENV_PRD, DECL_STG], ['staging', ENV_STG, DECL_PRD], ['staging', ENV_PRD, DECL_STG]]) {
    const f = fabricaClient();
    const out = await ca.conferir({ambiente, env, flagFranquia: decl, deps: {Client: f.Client, ambiente116, conferencias: conferenciasOk(),
      conferirNoCliente116: async () => dados(MOTIVO_CICLO)}});
    assert.equal(out.codigo, 1); assert.match(out.linhas[0], /^RECUSADO FLAG_DECLARADA_OUTRO_AMBIENTE /);
    assert.ok(out.pendentes.includes('116')); assert.equal(f.instancias.length, 0);
    const p = await ca.principal(['--ambiente', ambiente, '--franquia-flag-ligada', decl], env, {Client: f.Client});
    assert.equal(p.codigo, 1); assert.equal(f.instancias.length, 0);
  }
});

test('P2-3: conferir116 exportado valida a declaração (texto) contra o ambiente e o alvo antes de criar o cliente', async () => {
  const casos = [
    ['staging', ENV_STG, DECL_PRD, /^Error: FLAG_DECLARADA_OUTRO_AMBIENTE /],
    ['production', ENV_PRD, DECL_STG, /^Error: FLAG_DECLARADA_OUTRO_AMBIENTE /],
    ['staging', ENV_PRD, DECL_STG, /^Error: FLAG_DECLARADA_OUTRO_AMBIENTE /],
    ['staging', ENV_STG, true, /^Error: FLAG_DECLARACAO_INVALIDA/],
    ['staging', ENV_STG, {ambiente: 'staging', registro: 'x', texto: DECL_STG}, /^Error: FLAG_DECLARACAO_INVALIDA/],
    ['staging', ENV_STG, 'staging      ', /^Error: FLAG_DECLARACAO_INVALIDA/],
    ['local', ENV_STG, DECL_STG, /^Error: AMBIENTE_RECUSADO/],
  ];
  for (const [ambiente, env, declaracao, re] of casos) {
    const f = fabricaClient();
    await assert.rejects(ca.conferir116({ambiente, env, declaracao, deps: {Client: f.Client, ambiente116, conferirNoCliente116: async () => dados(MOTIVO_CICLO)}}), re, String(declaracao));
    assert.equal(f.instancias.length, 0, 'nenhum cliente criado');
  }
  // A operação não é exportada: só se chega a ela pela declaração validada.
  assert.equal(ca.operacao116, undefined);
  const f = fabricaClient();
  const ok = await ca.conferir116({ambiente: 'staging', env: ENV_STG, declaracao: DECL_STG, deps: {Client: f.Client, ambiente116, conferirNoCliente116: async () => dados(MOTIVO_CICLO)}});
  assert.equal(ok.linha, `116 PRESENTE_OPERACAO_PASS flag=declarada "${DECL_STG}"`);
  const sem = await ca.conferir116({ambiente: 'staging', env: ENV_STG, deps: {Client: fabricaClient().Client, ambiente116, conferirNoCliente116: async () => dados(MOTIVO_CICLO)}});
  assert.equal(sem.linha, '116 PENDENTE FLAG_NAO_DECLARADA ' + MOTIVO_CICLO);
});

test('principal do conferidor: --franquia-flag-ligada só depois de --ambiente; outros formatos recusados', async () => {
  assert.deepEqual(ca.modo(['--ambiente', 'staging', '--franquia-flag-ligada', DECL_STG]), {ambiente: 'staging', flagFranquia: DECL_STG});
  for (const argv of [['--franquia-flag-ligada', DECL_STG, '--ambiente', 'staging'], ['--ambiente', 'staging', '--franquia-flag-ligada'], ['--ambiente', 'staging', '--flag', DECL_STG]])
    assert.throws(() => ca.modo(argv), /ARGUMENTOS_RECUSADOS/);
});

test('8.1: bootstrap da 129 aceita a declaração e recusa a de outro ambiente antes de conectar (código 1, sem linha da 129)', async () => {
  const B = 'pitr staging 2026-11-22T20:00Z';
  assert.deepEqual(reg.modo(['--ambiente', 'staging', '--aplicar-129-bootstrap-autorizado', '--backup', B, '--franquia-flag-ligada', DECL_STG]),
    {ambiente: 'staging', modo: 'bootstrap', backup: B, flagFranquia: DECL_STG});
  assert.throws(() => reg.modo(['--ambiente', 'staging', '--aplicar-129-bootstrap-autorizado', '--backup', B, '--flag', DECL_STG]), /ARGUMENTOS_RECUSADOS/);
  let conexoes = 0;
  class C { constructor() { conexoes++; } on() {} async connect() {} async end() {} async query() { return {rows: []}; } }
  for (const [amb, env, decl] of [['production', ENV_PRD, DECL_STG], ['staging', ENV_STG, DECL_PRD]]) {
    const linhas = [];
    const r = await reg.principal(['--ambiente', amb, '--aplicar-129-bootstrap-autorizado', '--backup', B, '--franquia-flag-ligada', decl], env,
      {Client: C, out: t => linhas.push(t), antecessoras: async () => assert.fail('não chega às antecessoras')});
    assert.equal(r.codigo, 1); assert.match(linhas.join('\n'), /RECUSADO FLAG_DECLARADA_OUTRO_AMBIENTE/);
  }
  assert.equal(conexoes, 0);
});

test('bootstrap repassa a declaração ao conferidor (função injetada recebe {flagFranquia})', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'registro-migrations-banco.cjs'), 'utf8');
  assert.match(fonte, /async function bootstrap129\(ctx, \{backup, flagFranquia\}\)/);
  assert.ok(fonte.includes('(amb, {flagFranquia});'));
  assert.ok(fonte.includes("if (m.flagFranquia !== undefined) require('./conferir-antecessoras.cjs').lerDeclaracaoFlag(m.flagFranquia, m.ambiente, env);"));
});

// ---------- estáticos ----------
test('estático: 116_operacao.sql = postcheck com os blocos estruturais inteiros e só a troca dos dois blocos de dados; sha256 fixado', () => {
  const [, arquivo, hash] = ca.OPERACAO_116;
  const op = ler(arquivo), pos = ler('database/checks/20261103_116_postcheck.sql');
  assert.equal(createHash('sha256').update(op, 'utf8').digest('hex'), hash);
  // O postcheck ainda é o revisado pelo núcleo (se mudar, a operação tem de ser refeita).
  const comum = require('./migration-116-comum.cjs');
  const [, arqPos, hashPos] = comum.ETAPAS.find(e => e[0] === 'postcheck 116');
  assert.equal(createHash('sha256').update(ler(arqPos), 'utf8').digest('hex'), hashPos);
  const lp = pos.split('\n'), lo = op.split('\n');
  const corpoP = lp.slice(lp.indexOf('BEGIN TRANSACTION READ ONLY;')), corpoO = lo.slice(lo.indexOf('BEGIN TRANSACTION READ ONLY;'));
  assert.ok(lo.slice(0, lo.indexOf('BEGIN TRANSACTION READ ONLY;')).every(l => l.startsWith('--')), 'antes da moldura só comentário');
  const i = corpoP.indexOf('  IF EXISTS (SELECT 1 FROM ia_credito_franquias_ciclo)');
  assert.deepEqual(corpoP.slice(i, i + 6), [
    '  IF EXISTS (SELECT 1 FROM ia_credito_franquias_ciclo)',
    `    THEN RAISE EXCEPTION '${MOTIVO_CICLO}'; END IF;`,
    '  IF EXISTS (SELECT 1 FROM ia_credito_franquia_pendencias p',
    '             WHERE p.processada_em IS NOT NULL OR p.tentativas <> 0 OR p.ultimo_motivo IS NOT NULL',
    "                OR NOT EXISTS (SELECT 1 FROM assinatura_contratacoes h WHERE h.empresa_id = p.empresa_id AND h.id = p.contratacao_id AND h.estado = 'CONFIRMADA'))",
    `    THEN RAISE EXCEPTION '${MOTIVO_PENDENCIA}'; END IF;`,
  ]);
  const novo = [
    '  IF EXISTS (SELECT 1 FROM ia_credito_franquia_pendencias p',
    "             WHERE NOT EXISTS (SELECT 1 FROM assinatura_contratacoes h WHERE h.empresa_id = p.empresa_id AND h.id = p.contratacao_id AND h.estado = 'CONFIRMADA'))",
    `    THEN RAISE EXCEPTION '${MOTIVO_OPERACAO}'; END IF;`,
  ];
  assert.deepEqual(corpoO, [...corpoP.slice(0, i), ...novo, ...corpoP.slice(i + 6)]);
  assert.ok(!/franquias_ciclo\)/.test(op) && !/processada_em IS NOT NULL/.test(op));
  // Os blocos estruturais seguem com as mesmas exceções do postcheck.
  for (const m of ['definição das tabelas novas divergente', 'função do gatilho de só inserção divergente', 'CHECK de tipo das notificações divergente'])
    assert.ok(op.includes(`'116 postcheck: ${m}`), m);
});

test('estático: ramo m116 usa só conferirNoCliente e corpoSomenteLeitura da 116-comum, uma conexão, sem disco', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'conferir-antecessoras.cjs'), 'utf8');
  const c116 = fonte.slice(fonte.indexOf('async function conferir116('), fonte.indexOf('/** Entrada do bootstrap da 129'));
  assert.equal((c116.match(/new Client\(/g) ?? []).length, 1);
  assert.match(c116, /await conferirNoCliente\(db, \{/);
  assert.match(c116, /await operacao116\(db, flag,/);
  assert.ok(!/exigirDisco|disco\s*\(|estadoAtual/.test(c116));
  const op = fonte.slice(fonte.indexOf('async function operacao116('), fonte.indexOf('async function conferir116('));
  assert.ok(!/new Client|\.connect\(/.test(op));
  // Ordem: OK antes de qualquer olhar para a declaração (8.2).
  assert.ok(c116.indexOf('if (r?.resultado === OK)') < c116.indexOf('if (!flag)'));
  const semDisco = fs.readFileSync(path.join(__dirname, 'migration-116-comum.cjs'), 'utf8');
  const cn = semDisco.slice(semDisco.indexOf('async function conferirNoCliente('), semDisco.indexOf('async function migrarComVerificacao('));
  assert.ok(!/exigirDisco|disco\s*\(/.test(cn));
});

test('8.4 (parte estática): chaves do adaptador e do registro são distintas e vêm das constantes', () => {
  const s = require('./migration-generico-staging.cjs');
  const todas = [...s.CHAVES_TRAVA, ...reg.CHAVES_TRAVA];
  assert.equal(new Set(todas).size, todas.length);
  assert.deepEqual([...reg.CHAVES_TRAVA].sort(), ['production:129', 'production:130', 'production:131', 'production:132', 'production:133', 'staging:129', 'staging:130', 'staging:131', 'staging:132', 'staging:133']);
});
