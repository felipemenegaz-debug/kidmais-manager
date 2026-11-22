/* eslint-disable @typescript-eslint/no-require-imports */
// Testes do conferir-antecessoras (§3.6 e §4 do plano "Registro de migrations no banco 20261120").
// Unitários com fakes (sem banco) + estáticos + um teste com PG real descartável, só com KIDMAIS_REGISTRO_PG_PORTA
// (cluster_name kidmais_descartavel em 127.0.0.1; nunca 5432/5433; bancos próprios antecessoras_*, removidos no fim).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const ca = require('./conferir-antecessoras.cjs');

const raiz = path.resolve(__dirname, '..');
const ler = rel => fs.readFileSync(path.join(raiz, rel), 'utf8').replace(/\r\n/g, '\n');
const OK = 'JA_APLICADA_POSTCHECK_PASS';
const SQL_DIVERGENTE = /definição divergente/;

/** Cliente falso: registra cada instância e cada SQL; a conferência estrutural responde conforme `estrutura`. */
function fabricaClient({estrutura = 'pass'} = {}) {
  const instancias = [];
  class Fake {
    constructor(cfg) { this.cfg = cfg; this.sqls = []; this.fechado = false; instancias.push(this); }
    on() {}
    async connect() {}
    async end() { this.fechado = true; }
    async query(sql) {
      this.sqls.push(sql);
      if (SQL_DIVERGENTE.test(sql)) {
        if (estrutura === 'pass') return {rows: [{banco: 'x', colisoes: 0, aprovado: true}]};
        if (estrutura === 'sem-aprovado') return {rows: [{banco: 'x'}]};
        throw new Error('117 postcheck: definição divergente em whatsapp_atendimento_rodizio: {...}');
      }
      return {rows: []};
    }
  }
  return {Client: Fake, instancias};
}
const ambiente117 = {production: {alvo: () => ({host: 'falso'}), identidade: l => l, SQL_IDENTIDADE: 'SELECT 1'},
  staging: {alvo: () => ({host: 'falso'}), identidade: l => l, SQL_IDENTIDADE: 'SELECT 1'}};
/** Conferências falsas de todos os ids comuns: OK, salvo o que o teste substituir. */
function conferenciasOk(sobre = {}) {
  const c = {};
  for (const {id, tipo} of ca.TABELA) {
    if (tipo === 'm117') continue;
    c[id] = tipo === 'p122' ? async () => ({codigo: 0, saida: {resultado: OK}}) : async () => ({resultado: OK});
  }
  return {...c, ...sobre};
}
const estadoPresente = (extra = {}) => ({m117: 'presente', indices_invalidos: [], ...extra});
async function rodar({r117, estrutura, sobre, ambiente = 'staging'} = {}) {
  const f = fabricaClient({estrutura});
  let recebido;
  const conferirNoCliente117 = async (db, o) => { recebido = {db, o}; if (r117 instanceof Error) throw r117; return r117; };
  const out = await ca.conferir({ambiente, env: {}, deps: {Client: f.Client, ambiente117, conferirNoCliente117, conferencias: conferenciasOk(sobre)}});
  return {...out, f, recebido};
}
const linha117 = out => out.linhas.find(l => l.startsWith('117 '));
const estruturalRodou = f => f.instancias.some(i => i.sqls.some(s => SQL_DIVERGENTE.test(s)));

test('tudo OK ⇒ ANTECESSORAS_OK (0), uma linha por id na ordem da tabela', async () => {
  const out = await rodar({r117: {resultado: OK, chave: 'DESLIGADA'}});
  assert.equal(out.codigo, 0);
  assert.equal(out.final, 'ANTECESSORAS_OK');
  assert.deepEqual(out.pendentes, []);
  assert.deepEqual(out.linhas.map(l => l.split(' ')[0]), [...ca.IDS]);
  assert.equal(linha117(out), '117 JA_APLICADA_POSTCHECK_PASS chave=DESLIGADA');
  assert.equal(estruturalRodou(out.f), false);
  assert.deepEqual([...ca.IDS].sort(), ['110', '111', '112', '114', '115', '116', '117', '118', '120', '121', '122', '123', '124', '125', '126', '127', '128']);
});

test('122 PRONTA_PARA_APLICAR com código 0 ⇒ pendente (3)', async () => {
  const out = await rodar({r117: {resultado: OK, chave: 'DESLIGADA'}, sobre: {'122': async () => ({codigo: 0, saida: {resultado: 'PRONTA_PARA_APLICAR'}})}});
  assert.equal(out.codigo, 3);
  assert.deepEqual(out.pendentes, ['122']);
  assert.equal(out.final, 'ANTECESSORAS_PENDENTES 122');
  assert.match(out.linhas.find(l => l.startsWith('122 ')), /^122 PENDENTE codigo=0 PRONTA_PARA_APLICAR/);
});

test('122 JA_APLICADA com código diferente de 0 ⇒ pendente', async () => {
  const out = await rodar({r117: {resultado: OK, chave: 'DESLIGADA'}, sobre: {'122': async () => ({codigo: 2, saida: {resultado: OK}})}});
  assert.deepEqual(out.pendentes, ['122']);
});

test('genérico/módulo com PRONTA_PARA_APLICAR ou RECUSARIA ⇒ pendente com o motivo', async () => {
  const out = await rodar({r117: {resultado: OK, chave: 'DESLIGADA'}, sobre: {
    '110': async () => ({resultado: 'RECUSARIA', motivo: 'postcheck divergente'}),
    '112': async () => ({resultado: 'RECUSARIA', motivo: 'definição divergente da 112'}),
    '114': async () => ({resultado: 'RECUSARIA', motivo: 'KD114 ausente'}),
    '128': async () => ({resultado: 'PRONTA_PARA_APLICAR'})}});
  assert.deepEqual(out.pendentes, ['114', '112', '110', '128']);
  assert.equal(out.linhas.find(l => l.startsWith('110 ')), '110 PENDENTE RECUSARIA postcheck divergente');
  assert.equal(out.linhas.find(l => l.startsWith('128 ')), '128 PENDENTE PRONTA_PARA_APLICAR');
});

test('117 chave LIGADA ⇒ estrutural na mesma conexão ⇒ PRESENTE_ESTRUTURA_PASS chave=LIGADA', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA', estado: estadoPresente()}});
  assert.equal(linha117(out), '117 PRESENTE_ESTRUTURA_PASS chave=LIGADA');
  assert.equal(out.codigo, 0);
  assert.equal(out.f.instancias.length, 1, 'uma conexão só para a 117');
  assert.equal(out.recebido.db, out.f.instancias[0], 'conferirNoCliente e o estrutural no mesmo db');
  assert.ok(estruturalRodou(out.f));
  const sqls = out.f.instancias[0].sqls;
  const i = sqls.findIndex(s => SQL_DIVERGENTE.test(s));
  assert.equal(sqls[i - 4], 'BEGIN TRANSACTION READ ONLY');
  assert.equal(sqls[i + 1], 'ROLLBACK');
  assert.ok(!/rodízio não está vazio/.test(sqls[i]), 'estrutural sem o bloco do rodízio');
  assert.equal(out.recebido.o.chave, 'DESLIGADA', 'env {} ⇒ chave calculada DESLIGADA');
});

test('117 chave DESLIGADA com rodízio histórico ⇒ estrutural chave=DESLIGADA rodizio=historico', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo: ca.MOTIVO_RODIZIO, estado: estadoPresente(), checks: {'postcheck 117': 'FALHOU'}}});
  assert.equal(linha117(out), '117 PRESENTE_ESTRUTURA_PASS chave=DESLIGADA rodizio=historico');
  assert.equal(out.codigo, 0);
  assert.equal(out.final, 'ANTECESSORAS_OK');
});

test('117 DESLIGADA, rodízio com linha e índice divergente ⇒ pendente com o motivo original, sem estrutural', async () => {
  const motivo = '117 postcheck: índice de busca por identificador ausente ou divergente';
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo, estado: estadoPresente(), checks: {'postcheck 117': 'FALHOU'}}});
  assert.equal(linha117(out), `117 PENDENTE RECUSARIA chave=DESLIGADA ${motivo}`);
  assert.deepEqual(out.pendentes, ['117']);
  assert.equal(estruturalRodou(out.f), false);
  assert.ok(!/DIVERGENCIA_ESQUEMA/.test(linha117(out)));
});

test('117 DESLIGADA com coluna divergente (rodízio vazio) ⇒ pendente com o motivo original', async () => {
  const motivo = '117 postcheck: definição divergente em whatsapp_atendimento_rodizio: {}';
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo, estado: estadoPresente(), checks: {'postcheck 117': 'FALHOU'}}});
  assert.deepEqual(out.pendentes, ['117']);
  assert.equal(estruturalRodou(out.f), false);
});

test('117 chave INVALIDA com esquema íntegro ⇒ pendente, sem estrutural', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'INVALIDA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA INVALIDA', estado: estadoPresente()}});
  assert.equal(linha117(out), '117 PENDENTE RECUSARIA chave=INVALIDA CHAVE_MULTIEMPRESA_NAO_DESLIGADA INVALIDA');
  assert.equal(out.codigo, 3);
  assert.equal(estruturalRodou(out.f), false);
});

test('117 LIGADA com motivo diferente do exato ⇒ pendente (igualdade completa)', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA ', estado: estadoPresente()}});
  assert.deepEqual(out.pendentes, ['117']);
  assert.equal(estruturalRodou(out.f), false);
});

test('117 recusas antecipadas sem r.estado / sem r.checks ⇒ pendente sem TypeError, e o relatório segue', async () => {
  for (const r117 of [
    {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo: 'SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC'},
    {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo: 'INDICE_INVALIDO_117 whatsapp_atendimento_rodizio_pkey', estado: estadoPresente({indices_invalidos: ['whatsapp_atendimento_rodizio_pkey']})},
    {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo: ca.MOTIVO_RODIZIO, estado: estadoPresente()},
    {resultado: 'RECUSARIA', chave: 'DESLIGADA', motivo: ca.MOTIVO_RODIZIO, checks: {'postcheck 117': 'FALHOU'}},
  ]) {
    const out = await rodar({r117});
    assert.deepEqual(out.pendentes, ['117'], JSON.stringify(r117));
    assert.match(linha117(out), /^117 PENDENTE RECUSARIA chave=DESLIGADA /);
    assert.ok(!/TypeError/.test(linha117(out)));
    assert.equal(out.linhas.length, ca.IDS.length);
    assert.equal(estruturalRodou(out.f), false);
  }
});

test('117 LIGADA com índice inválido no r.estado ⇒ DIVERGENCIA_ESQUEMA INDICE_INVALIDO_117 (pendente)', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA', estado: estadoPresente({indices_invalidos: ['whatsapp_atendimento_mensagens_ambiente_provedor_idx']})}});
  assert.equal(linha117(out), '117 DIVERGENCIA_ESQUEMA INDICE_INVALIDO_117 whatsapp_atendimento_mensagens_ambiente_provedor_idx');
  assert.deepEqual(out.pendentes, ['117']);
  assert.equal(estruturalRodou(out.f), false);
});

test('117 LIGADA com 117 ausente/parcial ⇒ DIVERGENCIA_ESQUEMA ESTADO_117', async () => {
  const out = await rodar({r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA', estado: {m117: 'ausente', indices_invalidos: []}}});
  assert.equal(linha117(out), '117 DIVERGENCIA_ESQUEMA ESTADO_117 ausente');
});

test('117 LIGADA com estrutura divergente (índice de nome certo e colunas erradas) ⇒ DIVERGENCIA_ESQUEMA', async () => {
  const out = await rodar({estrutura: 'divergente', r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA', estado: estadoPresente()}});
  assert.match(linha117(out), /^117 DIVERGENCIA_ESQUEMA 117 postcheck: definição divergente/);
  assert.deepEqual(out.pendentes, ['117']);
  assert.equal(out.f.instancias[0].sqls.at(-1), 'ROLLBACK');
});

test('117 estrutural sem a linha aprovado=true ⇒ DIVERGENCIA_ESQUEMA', async () => {
  const out = await rodar({estrutura: 'sem-aprovado', r117: {resultado: 'RECUSARIA', chave: 'LIGADA', motivo: 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA LIGADA', estado: estadoPresente()}});
  assert.equal(linha117(out), '117 DIVERGENCIA_ESQUEMA ESTRUTURA_SEM_APROVADO');
});

test('117: erro do núcleo (identidade) ou do alvo ⇒ pendente com o motivo, demais ids seguem', async () => {
  const out = await rodar({r117: new Error('IDENTIDADE_RECUSADA BANCO')});
  assert.equal(linha117(out), '117 PENDENTE ERRO IDENTIDADE_RECUSADA BANCO');
  assert.equal(out.linhas.length, ca.IDS.length);
  assert.equal(out.f.instancias[0].fechado, true, 'conexão fechada');
  const f = fabricaClient();
  const out2 = await ca.conferir({ambiente: 'production', env: {}, deps: {Client: f.Client, conferencias: conferenciasOk(),
    ambiente117: {production: {...ambiente117.production, alvo: () => { throw new Error('FORA_DO_RENDER'); }}}}});
  assert.equal(out2.linhas.find(l => l.startsWith('117 ')), '117 PENDENTE ERRO FORA_DO_RENDER');
  assert.deepEqual(out2.pendentes, ['117']);
});

test('erro inesperado num id ⇒ só esse id pendente; disco acusado ⇒ CONFERENCIA_EXIGE_DISCO', async () => {
  const out = await rodar({r117: {resultado: OK, chave: 'DESLIGADA'}, sobre: {
    '120': async () => { throw new TypeError('x is not a function'); },
    '118': async () => { throw new Error('DISCO_PERSISTENTE_AUSENTE'); },
    '126': async () => ({resultado: 'FALHA', mensagem: 'DISCO_PERSISTENTE_AUSENTE'})}});
  assert.deepEqual(out.pendentes, ['118', '120', '126']);
  assert.equal(out.linhas.find(l => l.startsWith('120 ')), '120 PENDENTE ERRO x is not a function');
  assert.equal(out.linhas.find(l => l.startsWith('118 ')), '118 CONFERENCIA_EXIGE_DISCO ERRO DISCO_PERSISTENTE_AUSENTE');
  assert.equal(out.linhas.find(l => l.startsWith('126 ')), '126 CONFERENCIA_EXIGE_DISCO FALHA DISCO_PERSISTENTE_AUSENTE');
  assert.equal(out.linhas.length, ca.IDS.length);
});

test('ligação real dos módulos sem env de Render: todo id pendente pela recusa do alvo, nenhuma exceção nem disco', async () => {
  for (const ambiente of ca.AMBIENTES) {
    const f = fabricaClient();
    const out = await ca.conferir({ambiente, env: {}, deps: {Client: f.Client}});
    assert.equal(out.codigo, 3);
    assert.deepEqual(out.pendentes, [...ca.IDS]);
    assert.equal(f.instancias.length, 0, 'nenhuma conexão sem alvo válido');
    for (const l of out.linhas) { assert.match(l, /^\d{3} PENDENTE /, l); assert.ok(!/CONFERENCIA_EXIGE_DISCO|TypeError|is not a function|Cannot find module/.test(l), l); }
  }
});

test('ambiente e argumentos recusados ⇒ código 1', async () => {
  assert.equal((await ca.conferir({ambiente: 'prod', env: {}})).codigo, 1);
  const p = await ca.principal(['--ambiente', 'local'], {});
  assert.equal(p.codigo, 1);
  assert.match(p.linhas[0], /^RECUSADO ARGUMENTOS_RECUSADOS/);
  assert.equal((await ca.principal([], {})).codigo, 1);
});

test('principal imprime o final; contrato do bootstrap ({codigo, linhas, pendentes})', async () => {
  const f = fabricaClient();
  const p = await ca.principal(['--ambiente', 'staging'], {}, {Client: f.Client, ambiente117, conferencias: conferenciasOk(), conferirNoCliente117: async () => ({resultado: OK, chave: 'DESLIGADA'})});
  assert.equal(p.codigo, 0);
  assert.equal(p.linhas.at(-1), 'ANTECESSORAS_OK');
  const fonte = fs.readFileSync(path.join(__dirname, 'registro-migrations-banco.cjs'), 'utf8');
  // O bootstrap repassa ao conferidor o MESMO Client só quando injetado (teste §4.1 com os adaptadores reais); sem injeção, o padrão de cada módulo.
  assert.ok(fonte.includes("require('./conferir-antecessoras.cjs').conferir({ambiente: amb, env: ctx.env, deps: ctx.clientInjetado ? {Client: ctx.Client} : {}})"));
  assert.match(fonte, /clientInjetado: Boolean\(deps\.Client\)/);
});

// ---------- estáticos ----------
test('estático: 117_estrutura.sql = postcheck sem só o bloco do rodízio vazio; sha256 fixado', () => {
  const [, arquivo, hash] = ca.ESTRUTURA_117;
  const est = ler(arquivo), pos = ler('database/checks/20261104_117_postcheck.sql');
  assert.equal(createHash('sha256').update(est, 'utf8').digest('hex'), hash);
  const lp = pos.split('\n'), le = est.split('\n');
  assert.equal(lp.length, le.length + 1);
  const i = lp.findIndex((l, k) => l !== le[k]);
  assert.equal(lp[i], "  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_rodizio) THEN RAISE EXCEPTION '117 postcheck: rodízio não está vazio'; END IF;");
  assert.deepEqual([...lp.slice(0, i), ...lp.slice(i + 1)], le);
  assert.ok(!/rodizio\)|rodízio não está vazio/.test(est));
  // O postcheck ainda é o revisado pelo núcleo (se mudar, o estrutura tem de ser refeito).
  const comum = require('./migration-117-comum.cjs');
  const [, arqPos, hashPos] = comum.ETAPAS.find(e => e[0] === 'postcheck 117');
  assert.equal(createHash('sha256').update(ler(arqPos), 'utf8').digest('hex'), hashPos);
  // MOTIVO_RODIZIO é o texto do RAISE removido.
  assert.ok(lp[i].includes(`'${ca.MOTIVO_RODIZIO}'`));
});

const fonte = fs.readFileSync(path.join(__dirname, 'conferir-antecessoras.cjs'), 'utf8');
test('estático: sem exigirDisco nem estadoAtual no script', () => {
  assert.ok(!/exigirDisco/.test(fonte));
  assert.ok(!/estadoAtual/.test(fonte));
  assert.ok(!/\bdisco\s*\(/.test(fonte));
});

test('estático: da 117-comum só conferirNoCliente, corpoSomenteLeitura (e estadoChave para a chave do env)', () => {
  const usados = new Set([...fonte.matchAll(/(?<![-\w])comum\.(\w+)/g)].map(m => m[1]));
  assert.deepEqual([...usados].sort(), ['conferirNoCliente', 'corpoSomenteLeitura', 'estadoChave']);
  assert.equal((fonte.match(/require\('\.\/migration-117-comum\.cjs'\)/g) ?? []).length, 1);
  assert.ok(/const comum = require\('\.\/migration-117-comum\.cjs'\);/.test(fonte));
});

test('estático: o estrutural roda o 117_estrutura.sql no mesmo db da chamada a conferirNoCliente', () => {
  const corpo117 = fonte.slice(fonte.indexOf('async function conferir117('), fonte.indexOf('async function conferirId('));
  assert.match(corpo117, /const db = new Client\(cfg\)/);
  assert.match(corpo117, /await conferirNoCliente\(db, \{/);
  assert.match(corpo117, /await estrutural117\(db, r, ramo,/);
  assert.equal((corpo117.match(/new Client\(/g) ?? []).length, 1);
  const est = fonte.slice(fonte.indexOf('async function estrutural117('), fonte.indexOf('function ramo117('));
  assert.match(est, /somenteLeitura\(db, corpoSomenteLeitura\(lerRevisado\(raiz, arquivo, hash\), nome\)\)/);
  assert.match(est, /const s = r\.estado;/);
  assert.ok(!/new Client|\.connect\(/.test(est));
});

test('estático: as conferências chamadas não passam pelo disco', () => {
  const trecho = (rel, ini, fim) => { const t = fs.readFileSync(path.join(__dirname, rel), 'utf8'); const a = t.indexOf(ini), b = t.indexOf(fim, a); assert.ok(a >= 0 && b > a, rel); return t.slice(a, b); };
  const semDisco = (rel, s) => assert.ok(!/exigirDisco|disco\s*\(/.test(s), rel);
  semDisco('generico conferir', trecho('migration-generico-production.cjs', 'async function conferir(', 'async function executar('));
  semDisco('generico conferirNoCliente', trecho('migration-generico-production.cjs', 'async function conferirNoCliente(', 'async function migrarNaTransacao('));
  for (const id of ['112', '114', '116', '117', '118']) semDisco(id, trecho(`migration-${id}-comum.cjs`, 'async function conferir(', 'async function executar('));
  semDisco('117 conferirNoCliente', trecho('migration-117-comum.cjs', 'async function conferirNoCliente(', 'async function migrarComVerificacao('));
  semDisco('118 production', trecho('migration-118-production.cjs', 'async function conferir(', 'async function executar('));
  for (const id of ['123', '124', '125', '126', '127', '128']) semDisco(id, trecho(`migration-${id}-staging.cjs`, 'async function conferir(', 'async function executar('));
  const c122 = fs.readFileSync(path.join(__dirname, 'migration-122-comum.cjs'), 'utf8');
  const a = c122.indexOf("if(m==='conferir'){"), b = c122.indexOf('amb.exigirDisco()');
  assert.ok(a >= 0 && b > a);
  assert.match(c122.slice(a, b), /return \{codigo:0,saida:\{resultado:s==='presente'\?'JA_APLICADA_POSTCHECK_PASS':'PRONTA_PARA_APLICAR'\}\};[\s\S]*return \{codigo:2,[\s\S]*finally\{await db\.end\(\)\.catch\(\(\)=>\{\}\);\}\s*\}\s*$/);
  // Adaptadores de production (112/114/116/117 via prd.adaptar) não trocam o conferir do núcleo.
  const adaptar = trecho('conexao-production.cjs', 'function adaptar(', 'module.exports');
  assert.ok(!/conferir/.test(adaptar));
});

// ---------- PG real (opcional) ----------
const PORTA = Number(process.env.KIDMAIS_REGISTRO_PG_PORTA);
test('PG real: MOTIVO_RODIZIO fixado contra a mensagem do PG e a 117 com chave/rodízio/índice', {skip: !PORTA ? 'KIDMAIS_REGISTRO_PG_PORTA ausente' : false}, async () => {
  assert.ok(Number.isInteger(PORTA) && PORTA > 1024 && ![5432, 5433].includes(PORTA), 'PORTA_RECUSADA');
  assert.equal(process.env.DATABASE_URL, undefined, 'rodar com env -u DATABASE_URL');
  const {Client} = require('pg');
  const base = {host: '127.0.0.1', port: PORTA, user: 'kidmais_descartavel'};
  const banco = `antecessoras_117_${process.pid}`;
  const adm = new Client({...base, database: 'postgres'});
  await adm.connect();
  try {
    assert.equal((await adm.query('SHOW cluster_name')).rows[0].cluster_name, 'kidmais_descartavel');
    assert.equal(Number((await adm.query('SHOW port')).rows[0].port), PORTA);
    await adm.query(`DROP DATABASE IF EXISTS ${banco}`);
    await adm.query(`CREATE DATABASE ${banco}`);
    const cfg = {...base, database: banco};
    const prep = new Client(cfg); await prep.connect();
    try {
      await prep.query(`CREATE TABLE empresas (id uuid PRIMARY KEY);
        CREATE TABLE whatsapp_atendimento_mensagens (ambiente text NOT NULL, direcao text NOT NULL, provedor_id text);
        CREATE TABLE whatsapp_atendimento_status (provedor_id text)`);
      await prep.query(ler('database/migrations/20261104_117_atendimento_multiempresa.sql'));
    } finally { await prep.end(); }
    const comum = require('./migration-117-comum.cjs');
    const amb = {alvo: () => ({...cfg}), SQL_IDENTIDADE: 'SELECT current_database() AS db', identidade: l => { assert.equal(l.db, banco); return {banco: l.db}; }};
    const nucleo = async env => { const db = new Client(cfg); await db.connect(); try { return await comum.conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: amb.identidade, chave: comum.estadoChave(env)}); } finally { await db.end(); } };
    const so117 = async env => (await ca.conferir117({ambiente: 'staging', env, deps: {Client, ambiente117: {staging: amb}}})).linha;
    const exec = async sql => { const db = new Client(cfg); await db.connect(); try { await db.query(sql); } finally { await db.end(); } };

    assert.equal((await nucleo({})).resultado, OK);
    assert.equal(await so117({}), '117 JA_APLICADA_POSTCHECK_PASS chave=DESLIGADA');

    await exec("INSERT INTO empresas VALUES ('00000000-0000-0000-0000-000000000001'); INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ('00000000-0000-0000-0000-000000000001', 'staging', 1)");
    const r = await nucleo({});
    assert.equal(r.resultado, 'RECUSARIA');
    assert.equal(r.motivo, ca.MOTIVO_RODIZIO, 'MOTIVO_RODIZIO = texto real de curta() para a exceção do PG');
    assert.equal(r.checks['postcheck 117'], 'FALHOU');
    assert.equal(await so117({}), '117 PRESENTE_ESTRUTURA_PASS chave=DESLIGADA rodizio=historico');
    assert.equal(await so117({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true'}), '117 PRESENTE_ESTRUTURA_PASS chave=LIGADA');
    assert.match(await so117({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'sim'}), /^117 PENDENTE RECUSARIA chave=INVALIDA CHAVE_MULTIEMPRESA_NAO_DESLIGADA INVALIDA$/);

    // Índice de busca com o nome certo e colunas erradas.
    await exec('DROP INDEX whatsapp_atendimento_mensagens_ambiente_provedor_idx; CREATE INDEX whatsapp_atendimento_mensagens_ambiente_provedor_idx ON whatsapp_atendimento_mensagens (ambiente)');
    assert.equal(await so117({}), '117 PENDENTE RECUSARIA chave=DESLIGADA 117 postcheck: índice de busca por identificador ausente ou divergente');
    assert.equal(await so117({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true'}), '117 DIVERGENCIA_ESQUEMA 117 postcheck: índice de busca por identificador ausente ou divergente');
    // Índice de uma tabela da 117 com nome certo e colunas erradas (rodízio vazio): pendente pelo motivo original (DESLIGADA) / DIVERGENCIA_ESQUEMA (LIGADA).
    await exec(`DROP INDEX whatsapp_atendimento_mensagens_ambiente_provedor_idx; CREATE INDEX whatsapp_atendimento_mensagens_ambiente_provedor_idx ON whatsapp_atendimento_mensagens (ambiente, provedor_id) WHERE provedor_id IS NOT NULL;
      DELETE FROM whatsapp_atendimento_rodizio; DROP INDEX whatsapp_atendimento_rodizio_ordem_uq; CREATE UNIQUE INDEX whatsapp_atendimento_rodizio_ordem_uq ON whatsapp_atendimento_rodizio (ordem)`);
    assert.match(await so117({}), /^117 PENDENTE RECUSARIA chave=DESLIGADA 117 postcheck: definição divergente em whatsapp_atendimento_rodizio/);
    assert.match(await so117({WHATSAPP_ATENDIMENTO_MULTIEMPRESA: 'true'}), /^117 DIVERGENCIA_ESQUEMA 117 postcheck: definição divergente em whatsapp_atendimento_rodizio/);
  } finally {
    await adm.query(`DROP DATABASE IF EXISTS ${banco} WITH (FORCE)`).catch(() => {});
    await adm.end();
  }
});
