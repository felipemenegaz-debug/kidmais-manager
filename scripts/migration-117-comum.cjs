/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 117 (atendimento WhatsApp multiempresa, E-ME1 do plano "Plano Atendimento WhatsApp
// multiempresa 20261104" r6.1; código r3+r3b APROVADO pelo Astra e LIVE em staging pela #330) — staging
// (scripts/migration-117-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo desenho do aplicador da 116
// (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no disco persistente, códigos
// 0/1/2/3), para UMA migration que só ACRESCENTA:
//   - a 117 cria whatsapp_atendimento_rodizio (FK para empresas) e whatsapp_atendimento_status_colisoes, e o índice de busca
//     por identificador whatsapp_atendimento_mensagens_ambiente_provedor_idx. Travas, sob lock_timeout 5 s e
//     statement_timeout 60 s do próprio SQL (SET LOCAL): SHARE em whatsapp_atendimento_mensagens (o CREATE INDEX, não
//     concorrente porque roda na transação: escritas nas mensagens esperam a construção) e SHARE ROW EXCLUSIVE em empresas
//     (a FK nova). Nenhuma linha existente é escrita;
//   - compatibilidade: o código publicado (#330) funciona sem a 117 (modo efetivo PILOTO; status pela correlação legada com
//     contagem de unicidade) e com ela, com a chave WHATSAPP_ATENDIMENTO_MULTIEMPRESA desligada (PILOTO; a marca de colisão
//     de status passa a ser gravada também no PILOTO). Não há corte de consumidores nem sessão a drenar;
//   - estado só pelo catálogo: os 3 objetos da 117 (2 tabelas e o índice). Nenhum = ausente; todos = presente (o postcheck
//     decide entre completa e divergente); qualquer outro número = PARCIAL (recusa);
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final → na MESMA transação: prova de preservação (nenhuma
//     linha de empresas nem de whatsapp_atendimento_mensagens escrita por esta transação: xmin diferente do xid dela) e o
//     postcheck → COMMIT só com tudo PASS → postcheck de novo (READ ONLY);
//   - situação do COMMIT: falha no corpo ou nas verificações = NAO_COMMITADA (o COMMIT nunca foi enviado); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão INDETERMINADO (reconciliar pela
//     conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não grava
//     no banco nem no disco.
// Rodada 2 (parecer Astra r1, 04/11):
//   - P1: a chave WHATSAPP_ATENDIMENTO_MULTIEMPRESA do processo (o Web Shell herda o env do web) precisa estar DESLIGADA
//     (ausente ou "false"): com "true" o COMMIT da 117 tornaria o MULTI elegível antes da autorização própria; valor
//     inválido também recusa (corrigir o env antes). A aplicação recusa ANTES de criar o marcador; a conferência informa
//     a chave e devolve RECUSARIA;
//   - P2: SQLSTATE só de resposta do servidor (erro do pg com severity); erro de transporte do Node (EPIPE, ECONNRESET…) no
//     COMMIT = INDETERMINADO;
//   - P2: índices da 117 (das 2 tabelas novas e o de busca) precisam estar válidos, prontos e ativos (pg_index indisvalid,
//     indisready, indislive): inválido recusa pelo nome, no estado e dentro da transação antes do COMMIT;
//   - P3: USAGE em public é conferido ANTES de qualquer to_regclass qualificado (que falharia sem ele), para a recusa
//     nominal SEM_PRIVILEGIO_LEITURA USAGE_PUBLIC.
// Nunca executa o down. Rollback (manual, autorização própria): só depois da chave desligada e do critério de corte do §6
// (lib/whatsapp/atendimento/rollback-multiempresa.ts); o down apaga só tabelas de controle.
// O postcheck exige whatsapp_atendimento_rodizio VAZIA (a chave continua desligada): depois de ligar a chave, a conferência
// deste aplicador passa a RECUSARIA por desenho — ele serve à janela de aplicação, não ao acompanhamento posterior.
// Saída só com nomes de etapas, booleanos, a versão do servidor, contagens (mensagens por ambiente e direção e, com a 117,
// linhas das tabelas novas) e nomes de divergências. Nunca lê conteúdo, telefone nem identificador de mensagem.
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`):
//   sempre: USAGE em public e SELECT em whatsapp_atendimento_mensagens (precheck, contagens e preservação) e em empresas
//           (preservação);
//   117 ausente: DONO de whatsapp_atendimento_mensagens (CREATE INDEX), REFERENCES em empresas (FK), CREATE em public (2
//                tabelas) e USAGE em plpgsql (blocos DO da migration e do precheck);
//   117 presente: SELECT nas 2 tabelas novas (postcheck e contagens) e USAGE em plpgsql (bloco DO do postcheck).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-117';
const FLAG_APLICAR = '--aplicar-117-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-117.json';
const ETAPAS = Object.freeze([
  ['precheck 117', 'database/checks/20261104_117_precheck.sql', 'c16cf8bdf6d17b4d85948a8dcc1440afdec36dd04ebb807af3df3adcbd78ac26'],
  ['migration 117', 'database/migrations/20261104_117_atendimento_multiempresa.sql', '692c05e8a12b15a349cef0f63062027c9adec5babd23ca92135f78d96eb3d582'],
  ['postcheck 117', 'database/checks/20261104_117_postcheck.sql', '4a6f5a3277604e001ca3930d8c007d48c45a6698909e9be67999b2cc22839ae9'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);

/** Os 3 objetos da 117, por grupo (o estado conta cada grupo pelo catálogo). */
const OBJETOS = Object.freeze({
  tabelas: Object.freeze(['whatsapp_atendimento_rodizio', 'whatsapp_atendimento_status_colisoes']),
  indices: Object.freeze(['whatsapp_atendimento_mensagens_ambiente_provedor_idx']),
});
const TOTAL_OBJETOS = Object.values(OBJETOS).reduce((t, x) => t + x.length, 0);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const EMP = "to_regclass('public.empresas')";
const MSG = "to_regclass('public.whatsapp_atendimento_mensagens')";
const STA = "to_regclass('public.whatsapp_atendimento_status')";
const ROD = "to_regclass('public.whatsapp_atendimento_rodizio')";
const COL = "to_regclass('public.whatsapp_atendimento_status_colisoes')";
const dono = rel => `coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${rel}), false)`;
/** Índices da 117 que NÃO estão válidos, prontos e ativos: os das 2 tabelas novas e o de busca (só nomes). */
const INDICES_INVALIDOS = `(SELECT coalesce(array_agg(i.relname::text ORDER BY i.relname), '{}'::text[]) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE (x.indrelid IN (${ROD}, ${COL}) OR x.indexrelid = to_regclass('public.whatsapp_atendimento_mensagens_ambiente_provedor_idx'))
      AND NOT (x.indisvalid AND x.indisready AND x.indislive))`;
const SQL_INDICES_INVALIDOS = `/* indices-117 */ SELECT ${INDICES_INVALIDOS} AS invalidos`;
/** Antes do estado: USAGE em public (sem ele, to_regclass('public.…') falha antes da recusa nominal). */
const SQL_USAGE_PUBLIC = "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public";
const privilegio = (rel, p) => `coalesce((SELECT has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = ${rel}), false)`;

/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${EMP} IS NOT NULL) AS empresas,
  (${MSG} IS NOT NULL) AS mensagens,
  (${STA} IS NOT NULL) AS status,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.tabelas)}]) t WHERE to_regclass('public.' || t) IS NOT NULL)::int AS tabelas,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.indices)}]) i WHERE to_regclass('public.' || i) IS NOT NULL)::int AS indices,
  ${INDICES_INVALIDOS} AS indices_invalidos,
  ${dono(MSG)} AS dono_mensagens,
  ${privilegio(EMP, 'REFERENCES')} AS referencias_empresas,
  ${privilegio(EMP, 'SELECT')} AS ler_empresas,
  ${privilegio(MSG, 'SELECT')} AS ler_mensagens,
  ${privilegio(ROD, 'SELECT')} AS ler_rodizio,
  ${privilegio(COL, 'SELECT')} AS ler_colisoes,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  (session_user <> current_user) AS papel_trocado`;
const BOOLEANOS = Object.freeze(['empresas', 'mensagens', 'status', 'dono_mensagens', 'referencias_empresas', 'ler_empresas', 'ler_mensagens',
  'ler_rodizio', 'ler_colisoes', 'usar_public', 'pode_criar', 'plpgsql', 'papel_trocado']);
const GRUPOS = Object.freeze(Object.keys(OBJETOS));
/** As 2 tabelas existentes que a 117 trava e nunca pode escrever. */
const PRESERVADAS = Object.freeze(['empresas', 'whatsapp_atendimento_mensagens']);
/**
 * Prova de preservação, DENTRO da transação da migration, sob as travas: nenhuma linha das 2 tabelas existentes tem xmin
 * igual ao xid desta transação (o índice novo não reescreve a tabela; FK nova não toca a tabela referenciada).
 */
const SQL_PRESERVACAO = `/* preservacao-117 */ SELECT
${PRESERVADAS.map(t => `  (SELECT count(*) FROM public.${t} WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int AS ${t}`).join(',\n')}`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado lido: ausente (0 objetos) | presente (3; o postcheck decide) | parcial (qualquer outro). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', ...GRUPOS]) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  for (const k of GRUPOS) assert.ok(e[k] <= OBJETOS[k].length, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  assert.ok(Array.isArray(e.indices_invalidos) && e.indices_invalidos.every(x => typeof x === 'string'), 'ESTADO_ILEGIVEL indices_invalidos');
  s.indices_invalidos = [...e.indices_invalidos];
  s.objetos = GRUPOS.reduce((t, k) => t + e[k], 0);
  s.m117 = s.objetos === 0 ? 'ausente' : s.objetos === TOTAL_OBJETOS ? 'presente' : 'parcial';
  if (s.m117 === 'parcial') s.divergencias = GRUPOS.filter(k => e[k] !== OBJETOS[k].length).map(k => `${k} ${e[k]}/${OBJETOS[k].length}`);
  return s;
}

/** Guardas antes de qualquer leitura de dados: tabelas exigidas (empresas e 060), aplicação parcial e privilégios de cada caso. */
function exigirCatalogo(s) {
  for (const [k, t] of [['empresas', 'empresas'], ['mensagens', 'whatsapp_atendimento_mensagens'], ['status', 'whatsapp_atendimento_status']])
    assert.ok(s[k], 'TABELA_AUSENTE ' + t);
  assert.notEqual(s.m117, 'parcial', 'APLICACAO_PARCIAL_117 ' + (s.divergencias ?? []).join(', '));
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_mensagens && 'SELECT_MENSAGENS', !s.ler_empresas && 'SELECT_EMPRESAS'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  if (s.m117 === 'ausente') {
    const falta = [!s.dono_mensagens && 'DONO_MENSAGENS', !s.referencias_empresas && 'REFERENCES_EMPRESAS', !s.pode_criar && 'CREATE', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_117 ' + falta.join(' '));
  }
  // Presente: o postcheck (bloco DO) e as contagens leem as 2 tabelas da 117.
  if (s.m117 === 'presente') {
    assert.ok(s.indices_invalidos.length === 0, 'INDICE_INVALIDO_117 ' + s.indices_invalidos.join(' '));
    const falta = [!s.ler_rodizio && 'SELECT_RODIZIO', !s.ler_colisoes && 'SELECT_COLISOES', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_117_PRESENTE ' + falta.join(' '));
  }
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m117 === 'presente' ? ['postcheck 117'] : ['precheck 117', 'migration 117', 'postcheck 117'];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (regra da 109/112/116, com 40003 indeterminado). SQLSTATE só de RESPOSTA
 * do servidor (erro do pg: severity presente, sem syscall/errno): erro de transporte do Node com código de 5 letras (EPIPE)
 * não é SQLSTATE e fica INDETERMINADO (P2 da revisão r1).
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
/** P1: DESLIGADA (ausente ou "false") | LIGADA ("true") | INVALIDA (qualquer outro valor). Só DESLIGADA permite a 117. */
function estadoChave(env) {
  const v = env?.WHATSAPP_ATENDIMENTO_MULTIEMPRESA;
  return v === undefined || v === 'false' ? 'DESLIGADA' : v === 'true' ? 'LIGADA' : 'INVALIDA';
}
const exigirChaveDesligada = chave => assert.ok(chave === 'DESLIGADA', 'CHAVE_MULTIEMPRESA_NAO_DESLIGADA ' + chave);
const SQL_MENSAGENS = "SELECT ambiente::text || ':' || direcao::text AS chave, count(*)::int AS n FROM public.whatsapp_atendimento_mensagens GROUP BY 1 ORDER BY 1";
const SQL_NOVAS = `SELECT (SELECT count(*) FROM public.whatsapp_atendimento_rodizio)::int AS rodizio,
  (SELECT count(*) FROM public.whatsapp_atendimento_status_colisoes)::int AS colisoes`;
const mapa = rows => Object.fromEntries(rows.map(x => [x.chave, x.n]));
/** Contagens informativas (sem ids nem conteúdo): mensagens por ambiente e direção e, com a 117, linhas das tabelas novas. */
async function contagens(db, m117) {
  const c = {mensagensPorAmbienteDirecao: mapa((await somenteLeitura(db, SQL_MENSAGENS)).rows)};
  if (m117 === 'presente') c.novas = (await somenteLeitura(db, SQL_NOVAS)).rows[0];
  return c;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano, contagens e, em READ ONLY, o
 * precheck (ausente) ou o postcheck (presente).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade, chave}) {
  const r = {modo: 'conferencia', chave};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  try { r.estado = await estadoAtual(db, {guardar: false}); }
  catch (e) { if (!/^SEM_PRIVILEGIO_LEITURA /.test(e?.message ?? '')) throw e; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  try { exigirChaveDesligada(chave); r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const presente = r.estado.m117 === 'presente';
  r.contagens = await contagens(db, r.estado.m117);
  r.checks = {};
  const nome = presente ? 'postcheck 117' : 'precheck 117';
  try { const [, arquivo, hash] = etapa(nome); await somenteLeitura(db, corpoSomenteLeitura(lerRevisado(raiz, arquivo, hash), nome)); r.checks[nome] = 'PASS'; }
  catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = presente ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration sem o COMMIT final; preservação e postcheck dentro da transação; COMMIT só com tudo PASS. Registra a situação
 * do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration 117'), 'migration 117'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    const p = (await db.query(SQL_PRESERVACAO)).rows[0];
    assert.ok(p && PRESERVADAS.every(t => p[t] === 0), 'PRESERVACAO_117 ' + PRESERVADAS.map(t => `${t}=${p?.[t]}`).join(' '));
    passo.antesDoCommit.preservacao = 'PASS';
    const inv = (await db.query(SQL_INDICES_INVALIDOS)).rows[0]?.invalidos;
    assert.ok(Array.isArray(inv) && inv.length === 0, 'INDICE_INVALIDO_117 ' + (Array.isArray(inv) ? inv.join(' ') : 'ilegivel'));
    passo.antesDoCommit.indices = 'PASS';
    await db.query(corpoSomenteLeitura(sqls.get('postcheck 117'), 'postcheck 117'));
    passo.antesDoCommit['postcheck 117'] = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_117'); }
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
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, chave, registrar = () => {}}) {
  exigirChaveDesligada(chave);
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  semCommitFinal(sqls.get('migration 117'), 'migration 117');
  for (const nome of ['precheck 117', 'postcheck 117']) corpoSomenteLeitura(sqls.get(nome), nome);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes.m117);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 117') {
      await migrarComVerificacao(db, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false})).m117, 'presente', 'ESTADO_DEPOIS_117');
    } else await somenteLeitura(db, corpoSomenteLeitura(sqls.get(nome), nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m117, 'presente', 'ESTADO_FINAL_117');
  r.contagensDepois = await contagens(db, 'presente');
  r.resultado = r.plano.includes('migration 117') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['117', x.commit]));
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

/** Fábrica do aplicador de um ambiente (mesmo contrato dos aplicadores 092–116: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      provaNoAlvo: 'preservação (nenhuma linha de empresas nem de whatsapp_atendimento_mensagens escrita pela transação), índices da 117 válidos/prontos/ativos e postcheck DENTRO da transação da 117, antes do COMMIT; depois, o postcheck em READ ONLY',
      prazos: 'lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['117: nenhum dos 3 objetos presente (precheck: 060 aplicada)',
        '117: current_user DONO de whatsapp_atendimento_mensagens, com REFERENCES e SELECT em empresas, SELECT em whatsapp_atendimento_mensagens, USAGE e CREATE em public e USAGE em plpgsql',
        'código da E-ME1 (#330, compatível com e sem a 117) publicado no web e no worker; WHATSAPP_ATENDIMENTO_MULTIEMPRESA DESLIGADA (ausente ou "false") no web: "true" ou valor inválido recusa antes do marcador'],
      ordem: ['conferir no Render o commit do web (com este aplicador) e os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL deste ambiente comprovado (PITR disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 117 neste ambiente',
        'janela curta, fora do minuto do cron de reconciliação (a cada 5 min): sem DDL concorrente; escritas em whatsapp_atendimento_mensagens e em empresas esperam a transação (lock_timeout 5 s; o worker não precisa parar)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência funcional logada: Atendimento WhatsApp da empresa piloto igual (modo PILOTO, chave desligada); logs do web sem erro da 117'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou conferência RECUSARIA depois de CONFIRMADO: parar, preservar saída e marcador, reconciliar e só então decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-117.<horario>.json'],
      recuperacao: ['com a chave ainda desligada: nada a fazer no código (PILOTO com ou sem a 117)',
        'database/rollback/20261104_117_atendimento_multiempresa_down.sql só com autorização própria, chave desligada e o critério de corte do §6 cumprido (rollback-multiempresa.ts)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 117', 'alteração de env', 'deploy', 'restart', 'ligar WHATSAPP_ATENDIMENTO_MULTIEMPRESA',
        'escrita em empresas ou em whatsapp_atendimento_mensagens']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), chave: estadoChave(env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    const chave = estadoChave(env); exigirChaveDesligada(chave);
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-117\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), chave,
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

module.exports = {ETAPAS, OBJETOS, TOTAL_OBJETOS, PRESERVADAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_PRESERVACAO,
  SQL_INDICES_INVALIDOS, SQL_USAGE_PUBLIC, estadoChave,
  SQL_MENSAGENS, SQL_NOVAS, lerEstado, exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, corpoSomenteLeitura,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
