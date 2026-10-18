/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador manual das migrations 085 (Marketing base) e 086 (automações de Marketing) somente no PostgreSQL do serviço
// de staging. Derivado dos aplicadores 083/084: mesma trava de alvo, identidade da conexão, disco persistente, arquivos
// revisados por hash e registro por tentativa (sem tabela de controle). Diferenças: duas migrations em sequência, cada
// uma atômica no próprio arquivo; estado ausente/completa/parcial derivado do schema; pré-requisitos 083 e 084;
// privilégios de criação; trava consultiva de sessão contra execução concorrente; agregados de Convites/WhatsApp
// preservados; retomada só por flag própria. Sem flag: PLANO (não lê DATABASE_URL, não conecta, não grava nada).
// Nunca executa down: recuperação é decisão humana (docs/MARKETING_APLICADOR_085_086_20261018.md).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {alvo:alvoBase} = require('./migration-078-staging.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const FLAG = '--aplicar-085-086-autorizado';
const FLAG_RETOMAR = '--retomar-085-086-autorizado';
const FLAG_CONFERIR = '--conferir-085-086';
const DIR = '/opt/render/project/src/data/atualizacao-staging-marketing-085-086';
const BASE = 'migration-085-086';
/** Chave fixa da trava consultiva de sessão (pg_try_advisory_lock(int, int)): aplicador 085/086. */
const TRAVA = Object.freeze([20261018, 85086]);
const ETAPAS = Object.freeze([
  ['precheck 085', 'database/checks/20261018_085_precheck.sql', '645e7b603da53aa35efca7683529f6bce29c4c7b64dca3de2bb73d546dfef677'],
  ['migration 085', 'database/migrations/20261018_085_marketing_base.sql', '45a839ad999ef06b6e806c58b04ec351544eac63cb026734dc6993c4b46bec91'],
  ['postcheck 085', 'database/checks/20261018_085_postcheck.sql', '1df5cb0f707c2b209997e2df07efea8a4919c694718213b464d86f8c5271a4bc'],
  ['precheck 086', 'database/checks/20261018_086_precheck.sql', '2fa5373aa597c6e94b5460d1b067cbcf8c342bfb50abc299b8566e3e0a62b020'],
  ['migration 086', 'database/migrations/20261018_086_marketing_automacoes.sql', 'e814fc164b09891ac3b431e326090b87ef665810d4ce92895b41825e976a1f37'],
  ['postcheck 086', 'database/checks/20261018_086_postcheck.sql', '4e38917f44db67d0af142d77ca390aa7450c2b4becff21a372fae25bb1e4399f'],
]);
const TABELAS_085 = Object.freeze(['marketing_membership_capacidades', 'marketing_origens_opcoes', 'marketing_sites', 'marketing_site_versoes',
  'marketing_site_imagens', 'marketing_dominios', 'marketing_dns_simulado', 'marketing_campanhas', 'marketing_contatos', 'marketing_atribuicoes',
  'marketing_eventos']);
const TABELAS_086 = Object.freeze(['marketing_automacao_regras', 'marketing_automacao_execucoes', 'marketing_automacao_eventos',
  'marketing_contato_preferencias', 'marketing_contato_preferencias_eventos', 'marketing_contato_autorizacoes', 'marketing_tarefas',
  'marketing_transporte_simulado']);
const REFERENCIADAS = Object.freeze(['empresas', 'estabelecimentos', 'memberships', 'clientes', 'fechamentos', 'usuarios_administrativos']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/**
 * Estado do schema, privilégios e agregados de preservação (leitura; sem ids nem dados de clientes). m083 e m084 usam
 * exatamente os critérios dos aplicadores de origem (migration-083/084-staging.cjs; o teste confere o texto).
 */
const SQL_ESTADO = `SELECT
  ((SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND column_name='empresa_id'
     AND table_name IN ('whatsapp_conexoes','whatsapp_onboarding_tentativas'))
   AND to_regclass('public.whatsapp_conexoes_empresa_configurada_uk') IS NOT NULL
   AND to_regclass('public.whatsapp_conexoes_ambiente_configurada_uk') IS NULL) AS m083,
  ((SELECT count(*)=7 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
     AND column_name IN ('etapas_registradas','enviado_em','recebido_em','resultado_pendente','falha_classe','falha_diagnostico','falha_detalhes'))
   AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convite_geracoes') AND conname='convite_geracoes_etapas_consistentes')) AS m084,
  (SELECT count(*) FROM unnest(ARRAY[${lista(TABELAS_085)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)::int AS tabelas_085,
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'kidmais085\\_%')::int AS funcoes_085,
  (SELECT count(*) FROM unnest(ARRAY[${lista(TABELAS_086)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)::int AS tabelas_086,
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'kidmais086\\_%')::int AS funcoes_086,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='marketing_aut_numero_saiu' AND tgrelid=to_regclass('public.clientes')) AS gatilho_086_clientes,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  coalesce(has_table_privilege(current_user,to_regclass('public.clientes'),'TRIGGER'), false) AS pode_gatilho_clientes,
  CASE WHEN to_regclass('public.convite_geracoes') IS NULL THEN NULL ELSE
    (SELECT coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) FROM (SELECT estado, count(*) n FROM convite_geracoes GROUP BY estado) e) END AS convites_estados,
  CASE WHEN to_regclass('public.whatsapp_conexoes') IS NULL THEN NULL ELSE (SELECT count(*) FROM whatsapp_conexoes)::int END AS whatsapp_conexoes`;
// Chamada pela lista (sem SQL dinâmico): a função recebe as duas chaves inteiras.
const SQL_TRAVA = `SELECT pg_try_advisory_lock(${TRAVA[0]}, ${TRAVA[1]}) AS trava`;
const SQL_SOLTAR = `SELECT pg_advisory_unlock(${TRAVA[0]}, ${TRAVA[1]}) AS solta`;

/** Trava de staging (078 → ensaio) + URL sem query. Recusa nomeada: a mensagem do assert ecoaria valores do ambiente. */
function alvo(env) {
  let opts;
  try { opts = alvoBase(env); } catch { throw new Error('ALVO_RECUSADO: serviço, ambiente, host, banco, porta ou TLS fora da trava de staging'); }
  assert.ok(new URL(opts.connectionString).search === '', 'CONNECTION_QUERY_REJECTED');
  return opts;
}
function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
/** Modo pelos argumentos: exatamente uma flag conhecida, ou nenhuma (plano). Qualquer outra combinação é recusada. */
function modo(argv) {
  const flags = argv.filter(x => x.startsWith('--')), outros = argv.filter(x => !x.startsWith('--'));
  assert.equal(outros.length, 0, 'ARGUMENTO_INESPERADO');
  if (flags.length === 0) return 'plano';
  assert.equal(flags.length, 1, 'FLAGS_COMBINADAS');
  const m = {[FLAG]:'aplicar', [FLAG_RETOMAR]:'retomar', [FLAG_CONFERIR]:'conferir'}[flags[0]];
  assert.ok(m, 'FLAG_DESCONHECIDA');
  return m;
}
/**
 * ausente | completa | parcial, pelas tabelas e funções de cada migration (cada uma é uma transação só); `gatilho` é o
 * gatilho que a 086 cria numa tabela existente (clientes): null quando a migration não cria nenhum.
 */
function estadoMigration(tabelas, funcoes, total, gatilho = null) {
  if (tabelas === 0 && funcoes === 0 && gatilho !== true) return 'ausente';
  if (tabelas === total && funcoes > 0 && gatilho !== false) return 'completa';
  return 'parcial';
}
function lerEstado(e) {
  for (const k of ['m083', 'm084', 'pode_criar', 'pode_referenciar', 'pode_gatilho_clientes', 'gatilho_086_clientes'])
    assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['tabelas_085', 'funcoes_085', 'tabelas_086', 'funcoes_086']) assert.ok(Number.isInteger(e[k]), 'ESTADO_ILEGIVEL ' + k);
  return {
    m083: e.m083, m084: e.m084,
    m085: estadoMigration(e.tabelas_085, e.funcoes_085, TABELAS_085.length),
    m086: estadoMigration(e.tabelas_086, e.funcoes_086, TABELAS_086.length, e.gatilho_086_clientes),
    pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar, pode_gatilho_clientes: e.pode_gatilho_clientes,
    preservacao: {convites_estados: e.convites_estados ?? null, whatsapp_conexoes: e.whatsapp_conexoes ?? null},
  };
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m083 && s.m084, 'PRE_REQUISITO_AUSENTE ' + (s.m083 ? '' : '083 ') + (s.m084 ? '' : '084'));
  assert.notEqual(s.m085, 'parcial', 'INSTALACAO_PARCIAL 085');
  assert.notEqual(s.m086, 'parcial', 'INSTALACAO_PARCIAL 086');
  assert.ok(!(s.m086 === 'completa' && s.m085 !== 'completa'), 'ESTADO_INCOERENTE 086 sem 085');
  if (s.m085 === 'ausente') assert.ok(s.pode_criar && s.pode_referenciar, 'SEM_PRIVILEGIO 085');
  if (s.m086 === 'ausente') assert.ok(s.pode_criar && s.pode_referenciar && s.pode_gatilho_clientes, 'SEM_PRIVILEGIO 086');
  const plano = [];
  plano.push(...(s.m085 === 'ausente' ? ['precheck 085', 'migration 085', 'postcheck 085'] : ['postcheck 085']));
  plano.push(...(s.m086 === 'ausente' ? ['precheck 086', 'migration 086', 'postcheck 086'] : ['postcheck 086']));
  return plano;
}
function linhasDe(resultado) { return (Array.isArray(resultado) ? resultado : [resultado]).flatMap(x => x?.rows ?? []); }
/** Prechecks devolvem uma linha de booleanos: todos precisam ser true. */
function exigirPrecheck(nome, resultado) {
  const linhas = linhasDe(resultado).filter(l => Object.values(l).every(v => typeof v === 'boolean'));
  assert.equal(linhas.length, 1, 'PRECHECK_ILEGIVEL ' + nome);
  const falsos = Object.entries(linhas[0]).filter(([, v]) => v !== true).map(([k]) => k);
  assert.equal(falsos.length, 0, `PRECHECK_RECUSOU ${nome}: ${falsos.join(',')}`);
  return linhas[0];
}
function arquivosTentativas(dir) {
  if (!fs.existsSync(dir)) return [];
  const n = x => x === BASE + '.json' ? 1 : Number(new RegExp('^' + BASE + '\\.tentativa-(\\d+)\\.json$').exec(x)?.[1] ?? NaN);
  return fs.readdirSync(dir).filter(x => Number.isInteger(n(x))).sort((a, b) => n(a) - n(b));
}
/** Primeira tentativa só sem anteriores; retomada só com anteriores e nenhuma concluída. */
function avaliarTentativas(dir, retomar) {
  const anteriores = arquivosTentativas(dir);
  if (!retomar) { assert.equal(anteriores.length, 0, 'TENTATIVA_ANTERIOR_REVISAR ' + (anteriores[0] ?? '')); return {numero:1, arquivo:BASE + '.json'}; }
  assert.ok(anteriores.length > 0, 'NADA_A_RETOMAR');
  for (const a of anteriores) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, a), 'utf8')); } catch { throw new Error('TENTATIVA_ILEGIVEL ' + a); }
    assert.notEqual(r.concluido, true, 'JA_CONCLUIDO ' + a);
  }
  const numero = anteriores.length + 1;
  return {numero, arquivo:`${BASE}.tentativa-${numero}.json`, anteriores};
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** Plano sem conexão: só lê os arquivos revisados (hash) e descreve fases e exigências. */
function plano({raiz = path.resolve(__dirname, '..')} = {}) {
  const arquivos = ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256:hash}; });
  return {resultado:'PLANO', conecta:false, arquivos,
    modos:{conferir:FLAG_CONFERIR, aplicar:FLAG, retomar:FLAG_RETOMAR},
    variaveisExigidas:['RENDER', 'RENDER_SERVICE_ID', 'KIDMAIS_DEPLOY_ENV', 'ASAAS_AMBIENTE', 'ASSINATURA_PLANOS_ATIVOS', 'DATABASE_URL', 'DATABASE_SSL'],
    alvo:{servico:'srv-daif418ae00c73e8k2gg', host:'dpg-daidko3m8hqs73ce4jt0-a', banco:'kidmais_staging_1z91'},
    preRequisitos:['083 aplicada', '084 aplicada', '085/086 ausentes ou completas (nunca parciais)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/'), 'TRIGGER em clientes (086)'],
    fases:['identidade', 'trava consultiva', 'estado', 'precheck 085', 'migration 085', 'estado', 'postcheck 085', 'precheck 086', 'migration 086', 'estado', 'postcheck 086', 'preservação'],
    registro:DIR, nuncaExecuta:['down 085/086', 'flags MARKETING_*', 'envio de mensagens']};
}

/** Conecta e confere a identidade; o cliente vai para `alvoDb.db` antes de conectar, para ser encerrado em qualquer falha. */
async function conectarConferido(Client, opts, env, alvoDb) {
  alvoDb.db = new Client(opts);
  await alvoDb.db.connect();
  return conferirIdentidade((await alvoDb.db.query(SQL_IDENTIDADE)).rows[0], env);
}
async function postcheck(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try { await db.query(sql); await db.query('COMMIT'); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

async function conferir({env, dir = DIR, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client, disco = () => exigirDisco()}) {
  const opts = alvo(env); disco();
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const n = fs.readdirSync(dir).filter(x => /^conferencia-085-086-\d+\.json$/.test(x)).length + 1;
  const arquivo = `conferencia-085-086-${n}.json`, r = {inicio:new Date().toISOString(), modo:'conferencia', verificacoes:[]};
  const c = {db:null};
  try {
    r.conexao = await conectarConferido(Client, opts, env, c);
    const {db} = c;
    r.estado = lerEstado((await db.query(SQL_ESTADO)).rows[0]);
    try { r.plano = planoEtapas(r.estado); } catch (e) { r.planoRecusado = curta(e); }
    for (const [m, pre, post] of [['m085', 'precheck 085', 'postcheck 085'], ['m086', 'precheck 086', 'postcheck 086']]) {
      if (r.estado[m] === 'completa') { await postcheck(db, sqls.get(post)); r.verificacoes.push({nome:post, ok:true}); }
      else if (r.estado[m] === 'ausente' && (m === 'm085' || r.estado.m085 === 'completa')) {
        exigirPrecheck(pre, await db.query(sqls.get(pre))); r.verificacoes.push({nome:pre, ok:true});
      }
    }
    r.resultado = r.planoRecusado ? 'RECUSARIA' : 'CONFERIDO';
  } catch (e) { if (c.db) await c.db.query('ROLLBACK').catch(() => {}); r.resultado = 'FALHA'; r.mensagem = curta(e); }
  finally { if (c.db) await c.db.end().catch(() => {}); }
  fs.writeFileSync(path.join(dir, arquivo), JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
  return {...r, arquivo};
}

async function executar({env, retomar = false, dir = DIR, raiz = path.resolve(__dirname, '..'), Client = require('pg').Client, disco = () => exigirDisco()}) {
  const opts = alvo(env); disco();
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const tentativa = avaliarTentativas(dir, retomar);
  const arquivo = path.join(dir, tentativa.arquivo);
  const r = {inicio:new Date().toISOString(), tentativa:tentativa.numero, retomada:retomar, anteriores:tentativa.anteriores ?? [], etapas:[]};
  fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
  const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
  const c = {db:null};
  let travado = false;
  try {
    r.etapas.push({nome:'conexao'}); r.conexao = await conectarConferido(Client, opts, env, c); r.etapas.at(-1).ok = true; salvar();
    const {db} = c;
    r.etapas.push({nome:'trava'}); travado = (await db.query(SQL_TRAVA)).rows[0]?.trava === true;
    assert.ok(travado, 'EXECUCAO_CONCORRENTE'); r.etapas.at(-1).ok = true; salvar();
    r.estadoAntes = lerEstado((await db.query(SQL_ESTADO)).rows[0]); r.plano = planoEtapas(r.estadoAntes); salvar();
    for (const nome of r.plano) {
      r.etapas.push({nome, inicio:new Date().toISOString()}); salvar();
      const sql = sqls.get(nome);
      if (nome.startsWith('precheck')) exigirPrecheck(nome, await db.query(sql));
      else if (nome.startsWith('postcheck')) await postcheck(db, sql);
      else {
        await db.query(sql);
        // A migration commitou dentro do próprio arquivo: o estado precisa estar completo antes do postcheck.
        const depois = lerEstado((await db.query(SQL_ESTADO)).rows[0]), m = nome.endsWith('085') ? 'm085' : 'm086';
        assert.equal(depois[m], 'completa', 'ESTADO_DEPOIS ' + nome);
      }
      Object.assign(r.etapas.at(-1), {ok:true, fim:new Date().toISOString()}); salvar();
    }
    r.estadoDepois = lerEstado((await db.query(SQL_ESTADO)).rows[0]);
    assert.ok(r.estadoDepois.m085 === 'completa' && r.estadoDepois.m086 === 'completa', 'ESTADO_FINAL');
    assert.deepEqual(r.estadoDepois.preservacao, r.estadoAntes.preservacao, 'INVARIANTE_ALTERADA');
    r.concluido = true; salvar();
    return {resultado:'PASS', arquivo:tentativa.arquivo, conexao:r.conexao, plano:r.plano, estadoAntes:r.estadoAntes, estadoDepois:r.estadoDepois,
      etapas:r.etapas.map(e => ({nome:e.nome, ok:e.ok === true}))};
  } catch (e) {
    if (c.db) await c.db.query('ROLLBACK').catch(() => {});
    r.falha = {etapa:r.etapas.at(-1)?.nome ?? 'CONEXAO', mensagem:curta(e)};
    r.migracoesCommitadas = r.etapas.filter(x => x.ok && x.nome.startsWith('migration')).map(x => x.nome);
    r.concluido = false; salvar();
    return {resultado:'FALHA', arquivo:tentativa.arquivo, falha:r.falha, migracoesCommitadas:r.migracoesCommitadas};
  } finally {
    if (c.db && travado) await c.db.query(SQL_SOLTAR).catch(() => {});
    if (c.db) await c.db.end().catch(() => {});
  }
}

/** Códigos de saída: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA registrada; 3 conferência RECUSARIA. */
const CODIGO = Object.freeze({PLANO:0, CONFERIDO:0, PASS:0, FALHA:2, RECUSARIA:3});
async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m === 'plano') return {codigo:0, saida:plano(deps)};
  const s = m === 'conferir' ? await conferir({env, ...deps}) : await executar({env, retomar:m === 'retomar', ...deps});
  return {codigo:CODIGO[s.resultado] ?? 2, saida:s};
}

if (require.main === module) {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
module.exports = {ETAPAS, FLAG, FLAG_RETOMAR, FLAG_CONFERIR, DIR, TRAVA, CODIGO, TABELAS_085, TABELAS_086, SQL_ESTADO, SQL_TRAVA, SQL_SOLTAR, alvo, modo,
  lerRevisado, estadoMigration, lerEstado, planoEtapas, exigirPrecheck, arquivosTentativas, avaliarTentativas, plano, conferir, executar, principal};
