/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 118 (cota de leitura de documentos da importação de contratos, L2 do plano "Importação de
// contratos em lote 20261031"; código r4 APROVADO pelo Astra e LIVE em staging pela #354, 9691392c) — staging
// (scripts/migration-118-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo desenho dos aplicadores da 116 e
// da 117 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no disco persistente, códigos
// 0/1/2/3), para UMA migration que só ACRESCENTA:
//   - a 118 cria 2 funções de tempo (kidmais_118_janela_migracao, kidmais_118_periodo_mensal), ia_importacao_cotas (FK para
//     empresas), ia_importacao_usos (FK para ia_importacao_cotas e para ia_documentos(id, empresa_id)), 2 índices parciais
//     nos usos, a função de guarda kidmais_118_guarda e os 2 gatilhos. Travas, sob lock_timeout 5 s e statement_timeout 60 s
//     do próprio SQL (SET LOCAL): SHARE ROW EXCLUSIVE em empresas e em ia_documentos (as FKs novas): uploads de documento e
//     escritas em empresas esperam a transação. Nenhuma linha existente é escrita;
//   - compatibilidade: o código publicado (#354) funciona sem a 118 (recusa a leitura com COTA_INDISPONIVEL antes de
//     qualquer trabalho caro, salvo a dispensa IMPORTACAO_COTA_DISPENSADA no web de staging) e com ela (cota sempre
//     aplicada: a dispensa só cobre a AUSÊNCIA das tabelas). Não há corte de consumidores nem sessão a drenar; depois do
//     COMMIT, o código já pode reservar (as tabelas novas podem ganhar linhas a qualquer momento);
//   - estado só pelo catálogo: os 7 objetos da 118 (2 tabelas, 2 índices parciais, 3 funções). Nenhum = ausente; todos =
//     presente (o postcheck decide entre completa e divergente); qualquer outro número = PARCIAL (recusa);
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final → na MESMA transação: prova de preservação (nenhuma
//     linha de empresas nem de ia_documentos escrita por esta transação: xmin diferente do xid dela), índices válidos e o
//     postcheck → COMMIT só com tudo PASS → postcheck de novo (READ ONLY);
//   - situação do COMMIT: falha no corpo ou nas verificações = NAO_COMMITADA (o COMMIT nunca foi enviado); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE de resposta do servidor fora de 08/57/58/XX e diferente de 40003, senão
//     INDETERMINADO (reconciliar pela conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não grava
//     no banco nem no disco. USAGE em public é conferido ANTES de qualquer to_regclass qualificado.
// Dispensa IMPORTACAO_COTA_DISPENSADA: só INFORMADA (AUSENTE | ESTE_SERVICO | OUTRO_VALOR); não muda nada na 118. Com a 118
// presente ela fica inerte; removê-la do env é decisão e autorização à parte.
// Nunca executa o down. O down (database/rollback/20261104_118_importacao_cotas_down.sql) só vale SEM histórico de cota (recusa
// com qualquer linha); depois do primeiro uso, o rollback operacional é desligar o grupo CONTRACT_IMPORT (nunca a dispensa).
// Saída só com nomes de etapas, booleanos, a versão do servidor, contagens (documentos e, com a 118, linhas das tabelas novas
// por estado) e nomes de divergências. Nunca lê conteúdo de documento, sha256, empresa nem operação.
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`):
//   sempre: USAGE em public, SELECT em empresas (preservação) e em ia_documentos (precheck, contagens e preservação);
//   118 ausente: REFERENCES em empresas e em ia_documentos (FKs), CREATE em public (tabelas e funções) e USAGE em plpgsql
//                (blocos DO e a função de guarda) e em sql (funções de tempo);
//   118 presente: SELECT nas 2 tabelas novas (postcheck e contagens) e USAGE em plpgsql (bloco DO do postcheck).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-118';
const FLAG_APLICAR = '--aplicar-118-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-118.json';
const ETAPAS = Object.freeze([
  ['precheck 118', 'database/checks/20261104_118_precheck.sql', '76bbf46d76c88d02c61c9ba9604dd609bab6448c50e816050227dbac0881758c'],
  ['migration 118', 'database/migrations/20261104_118_importacao_cotas.sql', 'a2414dec0d9e78aa3d9eab5bec90c88b52874c01311c75fbb12c76dd4dd48033'],
  ['postcheck 118', 'database/checks/20261104_118_postcheck.sql', 'e71a94c9ff8b848e729b2c89e7495395c0af9b07faca9dbd365dbfc2dad204bc'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);

/** Os 7 objetos da 118, por grupo (o estado conta cada grupo pelo catálogo; funções pela assinatura). */
const OBJETOS = Object.freeze({
  tabelas: Object.freeze(['ia_importacao_cotas', 'ia_importacao_usos']),
  indices: Object.freeze(['ia_importacao_usos_vivo_uk', 'ia_importacao_usos_periodo_idx']),
  funcoes: Object.freeze(['kidmais_118_janela_migracao(timestamptz,timestamptz)', 'kidmais_118_periodo_mensal(timestamptz)', 'kidmais_118_guarda()']),
});
const TOTAL_OBJETOS = Object.values(OBJETOS).reduce((t, x) => t + x.length, 0);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const EMP = "to_regclass('public.empresas')";
const DOC = "to_regclass('public.ia_documentos')";
const COT = "to_regclass('public.ia_importacao_cotas')";
const USO = "to_regclass('public.ia_importacao_usos')";
/** Índices das 2 tabelas novas que NÃO estão válidos, prontos e ativos (só nomes). */
const INDICES_INVALIDOS = `(SELECT coalesce(array_agg(i.relname::text ORDER BY i.relname), '{}'::text[]) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid IN (${COT}, ${USO}) AND NOT (x.indisvalid AND x.indisready AND x.indislive))`;
const SQL_INDICES_INVALIDOS = `/* indices-118 */ SELECT ${INDICES_INVALIDOS} AS invalidos`;
/** Antes do estado: USAGE em public (sem ele, to_regclass('public.…') falha antes da recusa nominal). */
const SQL_USAGE_PUBLIC = "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public";
const privilegio = (rel, p) => `coalesce((SELECT has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = ${rel}), false)`;

/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${EMP} IS NOT NULL) AS empresas,
  (${DOC} IS NOT NULL) AS documentos,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.tabelas)}]) t WHERE to_regclass('public.' || t) IS NOT NULL)::int AS tabelas,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.indices)}]) i WHERE to_regclass('public.' || i) IS NOT NULL)::int AS indices,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.funcoes)}]) f WHERE to_regprocedure('public.' || f) IS NOT NULL)::int AS funcoes,
  ${INDICES_INVALIDOS} AS indices_invalidos,
  ${privilegio(EMP, 'REFERENCES')} AS referencias_empresas,
  ${privilegio(DOC, 'REFERENCES')} AS referencias_documentos,
  ${privilegio(EMP, 'SELECT')} AS ler_empresas,
  ${privilegio(DOC, 'SELECT')} AS ler_documentos,
  ${privilegio(COT, 'SELECT')} AS ler_cotas,
  ${privilegio(USO, 'SELECT')} AS ler_usos,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  coalesce(has_language_privilege(current_user, 'sql', 'USAGE'), false) AS linguagem_sql,
  (session_user <> current_user) AS papel_trocado`;
const BOOLEANOS = Object.freeze(['empresas', 'documentos', 'referencias_empresas', 'referencias_documentos', 'ler_empresas', 'ler_documentos',
  'ler_cotas', 'ler_usos', 'usar_public', 'pode_criar', 'plpgsql', 'linguagem_sql', 'papel_trocado']);
const GRUPOS = Object.freeze(Object.keys(OBJETOS));
/** gen_random_uuid() (default de ia_importacao_usos.id) é do núcleo a partir do PostgreSQL 13. */
const VERSAO_MINIMA = 130000;
/** As 2 tabelas existentes que a 118 trava (FKs novas) e nunca pode escrever. */
const PRESERVADAS = Object.freeze(['empresas', 'ia_documentos']);
/**
 * Prova de preservação, DENTRO da transação da migration, sob as travas: nenhuma linha das 2 tabelas existentes tem xmin
 * igual ao xid desta transação (FK nova não toca a tabela referenciada).
 */
const SQL_PRESERVACAO = `/* preservacao-118 */ SELECT
${PRESERVADAS.map(t => `  (SELECT count(*) FROM public.${t} WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int AS ${t}`).join(',\n')}`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado lido: ausente (0 objetos) | presente (7; o postcheck decide) | parcial (qualquer outro). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', ...GRUPOS]) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  for (const k of GRUPOS) assert.ok(e[k] <= OBJETOS[k].length, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  assert.ok(Array.isArray(e.indices_invalidos) && e.indices_invalidos.every(x => typeof x === 'string'), 'ESTADO_ILEGIVEL indices_invalidos');
  s.indices_invalidos = [...e.indices_invalidos];
  s.objetos = GRUPOS.reduce((t, k) => t + e[k], 0);
  s.m118 = s.objetos === 0 ? 'ausente' : s.objetos === TOTAL_OBJETOS ? 'presente' : 'parcial';
  if (s.m118 === 'parcial') s.divergencias = GRUPOS.filter(k => e[k] !== OBJETOS[k].length).map(k => `${k} ${e[k]}/${OBJETOS[k].length}`);
  return s;
}

/** Guardas antes de qualquer leitura de dados: tabelas exigidas (empresas e 055c), versão, parcial e privilégios de cada caso. */
function exigirCatalogo(s) {
  for (const [k, t] of [['empresas', 'empresas'], ['documentos', 'ia_documentos']]) assert.ok(s[k], 'TABELA_AUSENTE ' + t);
  assert.notEqual(s.m118, 'parcial', 'APLICACAO_PARCIAL_118 ' + (s.divergencias ?? []).join(', '));
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_documentos && 'SELECT_DOCUMENTOS', !s.ler_empresas && 'SELECT_EMPRESAS'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  if (s.m118 === 'ausente') {
    assert.ok(s.versao_pg >= VERSAO_MINIMA, 'VERSAO_PG_ANTIGA ' + s.versao_pg);
    const falta = [!s.referencias_empresas && 'REFERENCES_EMPRESAS', !s.referencias_documentos && 'REFERENCES_DOCUMENTOS', !s.pode_criar && 'CREATE',
      !s.plpgsql && 'LINGUAGEM', !s.linguagem_sql && 'LINGUAGEM_SQL'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_118 ' + falta.join(' '));
  }
  // Presente: o postcheck (bloco DO) e as contagens leem as 2 tabelas da 118.
  if (s.m118 === 'presente') {
    assert.ok(s.indices_invalidos.length === 0, 'INDICE_INVALIDO_118 ' + s.indices_invalidos.join(' '));
    const falta = [!s.ler_cotas && 'SELECT_COTAS', !s.ler_usos && 'SELECT_USOS', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_118_PRESENTE ' + falta.join(' '));
  }
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m118 === 'presente' ? ['postcheck 118'] : ['precheck 118', 'migration 118', 'postcheck 118'];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (regra da 109/112/116/117, com 40003 indeterminado). SQLSTATE só de
 * RESPOSTA do servidor (erro do pg: severity presente, sem syscall/errno): erro de transporte do Node fica INDETERMINADO.
 */
function commitNaFalha(e) {
  const resposta = typeof e?.severity === 'string' && e.syscall === undefined && e.errno === undefined;
  const sqlstate = resposta && typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) && sqlstate !== '40003' ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}
/** O arquivo revisado sem o COMMIT final: uma única transação (um BEGIN, um COMMIT), terminando exatamente em COMMIT. */
function semCommitFinal(sql, nome) {
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.ok(sql.endsWith('\nCOMMIT;\n'), 'TRANSACAO_INESPERADA ' + nome);
  return sql.slice(0, -'COMMIT;\n'.length);
}
/** Precheck e postcheck têm a própria moldura (BEGIN TRANSACTION READ ONLY … ROLLBACK); o aplicador envia só o CORPO. */
function corpoSomenteLeitura(sql, nome) {
  assert.equal((sql.match(/^BEGIN TRANSACTION READ ONLY;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^ROLLBACK;$/gm) ?? []).length, 1, 'MOLDURA_INESPERADA ' + nome);
  assert.equal((sql.match(/^(?:BEGIN;|COMMIT;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE)/gm) ?? []).length, 0, 'MOLDURA_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN TRANSACTION READ ONLY;\n');
  assert.ok(sql.endsWith('\nROLLBACK;\n') && i >= 0, 'MOLDURA_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN TRANSACTION READ ONLY;\n'.length, -'ROLLBACK;\n'.length);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Estado → guardas. Sem guardas (`guardar` false) na conferência e na releitura depois de um COMMIT. */
async function estadoAtual(db, {guardar = true} = {}) {
  const u = (await somenteLeitura(db, SQL_USAGE_PUBLIC)).rows[0];
  assert.equal(typeof u?.usar_public, 'boolean', 'ESTADO_ILEGIVEL usar_public');
  assert.ok(u.usar_public, 'SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC');
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
/** Só informação: AUSENTE | ESTE_SERVICO (igual a RENDER_SERVICE_ID) | OUTRO_VALOR. Nunca o valor. Não decide nada. */
function estadoDispensa(env) {
  const v = env?.IMPORTACAO_COTA_DISPENSADA;
  if (v === undefined || v === '') return 'AUSENTE';
  return env.RENDER_SERVICE_ID && v === env.RENDER_SERVICE_ID ? 'ESTE_SERVICO' : 'OUTRO_VALOR';
}
const SQL_DOCUMENTOS = 'SELECT count(*)::int AS documentos FROM public.ia_documentos';
const SQL_NOVAS = `SELECT (SELECT count(*) FROM public.ia_importacao_cotas)::int AS cotas,
  (SELECT count(*) FROM public.ia_importacao_usos WHERE estado = 'RESERVADA')::int AS reservadas,
  (SELECT count(*) FROM public.ia_importacao_usos WHERE estado = 'CONSUMIDA')::int AS consumidas,
  (SELECT count(*) FROM public.ia_importacao_usos WHERE estado = 'LIBERADA')::int AS liberadas`;
/** Contagens informativas (sem ids nem conteúdo): documentos e, com a 118, linhas das tabelas novas por estado. */
async function contagens(db, m118) {
  const c = {documentos: (await somenteLeitura(db, SQL_DOCUMENTOS)).rows[0]?.documentos};
  if (m118 === 'presente') c.novas = (await somenteLeitura(db, SQL_NOVAS)).rows[0];
  return c;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano, contagens e, em READ ONLY, o
 * precheck (ausente) ou o postcheck (presente).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade, dispensa}) {
  const r = {modo: 'conferencia', dispensa};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  try { r.estado = await estadoAtual(db, {guardar: false}); }
  catch (e) { if (!/^SEM_PRIVILEGIO_LEITURA /.test(e?.message ?? '')) throw e; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const presente = r.estado.m118 === 'presente';
  r.contagens = await contagens(db, r.estado.m118);
  r.checks = {};
  const nome = presente ? 'postcheck 118' : 'precheck 118';
  try { const [, arquivo, hash] = etapa(nome); await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); r.checks[nome] = 'PASS'; }
  catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = presente ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration sem o COMMIT final; preservação, índices e postcheck dentro da transação; COMMIT só com tudo PASS. Registra a
 * situação do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration 118'), 'migration 118'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    const p = (await db.query(SQL_PRESERVACAO)).rows[0];
    assert.ok(p && PRESERVADAS.every(t => p[t] === 0), 'PRESERVACAO_118 ' + PRESERVADAS.map(t => `${t}=${p?.[t]}`).join(' '));
    passo.antesDoCommit.preservacao = 'PASS';
    const inv = (await db.query(SQL_INDICES_INVALIDOS)).rows[0]?.invalidos;
    assert.ok(Array.isArray(inv) && inv.length === 0, 'INDICE_INVALIDO_118 ' + (Array.isArray(inv) ? inv.join(' ') : 'ilegivel'));
    passo.antesDoCommit.indices = 'PASS';
    await db.query(corpoSomenteLeitura(sqls.get('postcheck 118'), 'postcheck 118'));
    passo.antesDoCommit['postcheck 118'] = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_118'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration sem COMMIT → verificações na transação → COMMIT →
 * postcheck (READ ONLY). O estado é relido aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  semCommitFinal(sqls.get('migration 118'), 'migration 118');
  for (const nome of ['precheck 118', 'postcheck 118']) corpoSomenteLeitura(sqls.get(nome), nome);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes.m118);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 118') {
      await migrarComVerificacao(db, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false})).m118, 'presente', 'ESTADO_DEPOIS_118');
    } else await somenteLeitura(db, corpoSomenteLeitura(sqls.get(nome), nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m118, 'presente', 'ESTADO_FINAL_118');
  r.contagensDepois = await contagens(db, 'presente');
  r.resultado = r.plano.includes('migration 118') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['118', x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/** Fábrica do aplicador de um ambiente (mesmo contrato dos aplicadores 092–117: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      provaNoAlvo: 'preservação (nenhuma linha de empresas nem de ia_documentos escrita pela transação), índices da 118 válidos/prontos/ativos e postcheck DENTRO da transação da 118, antes do COMMIT; depois, o postcheck em READ ONLY',
      prazos: 'lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['118: nenhum dos 7 objetos presente (precheck: empresas, 055c com ia_documentos_empresa_uk); PostgreSQL 13 ou mais novo',
        '118: current_user com REFERENCES em empresas e em ia_documentos, SELECT em empresas e em ia_documentos, USAGE e CREATE em public e USAGE em plpgsql e em sql',
        'código da L2 (#354, compatível com e sem a 118) publicado no web; IMPORTACAO_COTA_DISPENSADA só é informada (com a 118 presente fica inerte)'],
      ordem: ['conferir no Render o commit do web (com este aplicador) e os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL deste ambiente comprovado (PITR disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 118 neste ambiente',
        'janela curta, sem importação em andamento: sem DDL concorrente; uploads de documento (ia_documentos) e escritas em empresas esperam a transação (lock_timeout 5 s)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência funcional logada: importação de um contrato sintético conta 1 leitura (sem 503 COTA_INDISPONIVEL); logs do web sem erro da 118'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou conferência RECUSARIA depois de CONFIRMADO: parar, preservar saída e marcador, reconciliar e só então decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-118.<horario>.json'],
      recuperacao: ['sem nenhuma leitura contada: database/rollback/20261104_118_importacao_cotas_down.sql, com autorização própria (recusa com qualquer linha de cota)',
        'depois do primeiro uso: desligar o grupo CONTRACT_IMPORT (o histórico de cota é preservado; nunca dispensar a cota)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 118', 'alteração de env', 'deploy', 'restart', 'ligar ou remover IMPORTACAO_COTA_DISPENSADA',
        'escrita em empresas ou em ia_documentos']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), dispensa: estadoDispensa(env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-118\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, dispensa: estadoDispensa(env), situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      salvar({...ultimo, situacao: 'FALHA', falha, ...situacao});
      return {resultado: 'FALHA', marcador, falha, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {ETAPAS, OBJETOS, TOTAL_OBJETOS, PRESERVADAS, VERSAO_MINIMA, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO,
  SQL_PRESERVACAO, SQL_INDICES_INVALIDOS, SQL_USAGE_PUBLIC, estadoDispensa, SQL_DOCUMENTOS, SQL_NOVAS, lerEstado, exigirCatalogo, planoEtapas,
  commitNaFalha, semCommitFinal, corpoSomenteLeitura, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
