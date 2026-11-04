/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 116 (franquias de IA por plano, F1 do plano "Franquias de IA por plano 20261102", rev. 4.1;
// código F1 r3 APROVADO pelo Astra e LIVE no web de staging pela #319) — staging (scripts/migration-116-staging.cjs fixa o
// alvo, a identidade da conexão e o disco). Mesmo desenho do aplicador da 112 (alvo travado, TLS, hash fixado de cada SQL com
// CRLF normalizado, marcador exclusivo no disco persistente, códigos 0/1/2/3), para UMA migration que só ACRESCENTA:
//   - a 116 cria ia_credito_franquias_ciclo (só inserção, pelo gatilho), ia_credito_franquia_pendencias e a função do
//     gatilho, e troca o CHECK de tipo de ia_credito_notificacoes (+ FRANQUIA_80 e FRANQUIA_100). Travas, todas sob
//     lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL): ACCESS EXCLUSIVE em ia_credito_notificacoes
//     (DROP/ADD do CHECK, que valida as linhas existentes sem reescrever) e SHARE ROW EXCLUSIVE em ia_credito_carteiras,
//     ia_credito_lotes e assinatura_contratacoes (as FKs novas): escritas nessas quatro tabelas esperam a transação (curta).
//     Nenhuma linha existente é escrita;
//   - compatibilidade: o código publicado (F1, #319) funciona sem a 116 (caminho legado; a sincronização não registra
//     pendência) e com ela (CREDITOS_FRANQUIA_PLANO_ATIVO desligada = caminho legado; a sincronização passa a registrar a
//     pendência, que é só intenção). O código anterior à F1 (cron de staging) não lê as tabelas novas e só ganha tipos
//     novos aceitos no CHECK. Por isso não há corte de consumidores nem sessão a drenar;
//   - estado só pelo catálogo: os 5 objetos da 116 (2 tabelas, 1 função, 1 gatilho e os tipos FRANQUIA no CHECK das
//     notificações). Nenhum = ausente; todos = presente (o postcheck decide entre completa e divergente); qualquer outro
//     número = PARCIAL (recusa);
//   - aplicação: precheck (READ ONLY) → migration SEM o COMMIT final → na MESMA transação: prova de preservação (nenhuma
//     linha de ia_credito_notificacoes, ia_credito_lotes, ia_credito_carteiras nem assinatura_contratacoes escrita por esta
//     transação: xmin diferente do xid dela) e o postcheck → COMMIT só com tudo PASS → postcheck de novo (READ ONLY);
//   - situação do COMMIT: falha no corpo ou nas verificações = NAO_COMMITADA (o COMMIT nunca foi enviado); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão INDETERMINADO (reconciliar pela
//     conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não grava
//     no banco nem no disco.
// Nunca executa o down. Rollback (manual, autorização própria): só SEM trilha financeira (o down recusa se houver franquia
// reconhecida ou aviso FRANQUIA_80/100); depois disso, só correção para frente.
// O postcheck exige ia_credito_franquias_ciclo VAZIA (a flag continua desligada): depois de ligar a flag, a conferência deste
// aplicador passa a RECUSARIA por desenho — ele serve à janela de aplicação, não ao acompanhamento posterior.
// Saída só com nomes de etapas, booleanos, a versão do servidor, contagens (lotes por origem, notificações por tipo e, com a
// 116, linhas das tabelas novas) e nomes de divergências.
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`):
//   sempre: USAGE em public e SELECT em ia_credito_lotes e ia_credito_notificacoes (contagens e precheck) e em
//           assinatura_contratacoes (o postcheck confere a legitimidade das pendências);
//   116 ausente: DONO de ia_credito_notificacoes (troca do CHECK), REFERENCES em ia_credito_carteiras, ia_credito_lotes e
//                assinatura_contratacoes (FKs) e SELECT nas três (a criação da FK lê a tabela referenciada: o PG 18 real recusa
//                "permission denied for table ia_credito_carteiras" só com REFERENCES; SELECT em lotes e contratações já é
//                exigido sempre), CREATE em public (2 tabelas e a função) e USAGE em plpgsql.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-116';
const FLAG_APLICAR = '--aplicar-116-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-116.json';
const ETAPAS = Object.freeze([
  ['precheck 116', 'database/checks/20261103_116_precheck.sql', '273a03b6d9bdb823b01a72da38403460f62bb4cccc87150af8f34d53e62f4e72'],
  ['migration 116', 'database/migrations/20261103_116_franquias_ciclo.sql', 'd2fed662fd08ec1fb8ede390f75d12f10823f76512b1b0ff8bd749c86eafd7c2'],
  ['postcheck 116', 'database/checks/20261103_116_postcheck.sql', '1e1e01b2d415c746da6b46e6a26209cfdb3ac07e2bd9e81ba6acfe1fb2d86822'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);

/** Os 5 objetos da 116, por grupo (o estado conta cada grupo pelo catálogo). */
const OBJETOS = Object.freeze({
  tabelas: Object.freeze(['ia_credito_franquias_ciclo', 'ia_credito_franquia_pendencias']),
  funcoes: Object.freeze(['kidmais_116_somente_insercao()']),
  gatilhos: Object.freeze(['ia_credito_franquias_ciclo_116_somente_insercao']),
  tipos: Object.freeze(['ia_credito_notificacoes_tipo_check']),
});
const TOTAL_OBJETOS = Object.values(OBJETOS).reduce((t, x) => t + x.length, 0);
const lista = xs => xs.map(x => `'${x}'`).join(',');
const NOT = "to_regclass('public.ia_credito_notificacoes')";
const LOT = "to_regclass('public.ia_credito_lotes')";
const CAR = "to_regclass('public.ia_credito_carteiras')";
const CON = "to_regclass('public.assinatura_contratacoes')";
const FRC = "to_regclass('public.ia_credito_franquias_ciclo')";
const PEN = "to_regclass('public.ia_credito_franquia_pendencias')";
const dono = rel => `coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${rel}), false)`;
const privilegio = (rel, p) => `coalesce((SELECT has_table_privilege(current_user, oid, '${p}') FROM pg_class WHERE oid = ${rel}), false)`;

/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${NOT} IS NOT NULL) AS notificacoes,
  (${LOT} IS NOT NULL) AS lotes,
  (${CAR} IS NOT NULL) AS carteiras,
  (${CON} IS NOT NULL) AS contratacoes,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.tabelas)}]) t WHERE to_regclass('public.' || t) IS NOT NULL)::int AS tabelas,
  (SELECT count(*) FROM unnest(ARRAY[${lista(OBJETOS.funcoes)}]) f WHERE to_regprocedure('public.' || f) IS NOT NULL)::int AS funcoes,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${lista(OBJETOS.gatilhos)}))::int AS gatilhos,
  (SELECT count(*) FROM pg_constraint WHERE conrelid = ${NOT} AND conname IN (${lista(OBJETOS.tipos)})
     AND pg_get_constraintdef(oid) LIKE '%''FRANQUIA_80''%' AND pg_get_constraintdef(oid) LIKE '%''FRANQUIA_100''%')::int AS tipos,
  ${dono(NOT)} AS dono_notificacoes,
  ${privilegio(CAR, 'REFERENCES')} AS referencias_carteiras,
  ${privilegio(LOT, 'REFERENCES')} AS referencias_lotes,
  ${privilegio(CON, 'REFERENCES')} AS referencias_contratacoes,
  ${privilegio(LOT, 'SELECT')} AS ler_lotes,
  ${privilegio(NOT, 'SELECT')} AS ler_notificacoes,
  ${privilegio(CON, 'SELECT')} AS ler_contratacoes,
  ${privilegio(CAR, 'SELECT')} AS ler_carteiras,
  ${privilegio(FRC, 'SELECT')} AS ler_franquias_ciclo,
  ${privilegio(PEN, 'SELECT')} AS ler_pendencias,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  (session_user <> current_user) AS papel_trocado`;
const BOOLEANOS = Object.freeze(['notificacoes', 'lotes', 'carteiras', 'contratacoes', 'dono_notificacoes', 'referencias_carteiras', 'referencias_lotes',
  'referencias_contratacoes', 'ler_lotes', 'ler_notificacoes', 'ler_contratacoes', 'ler_carteiras', 'ler_franquias_ciclo', 'ler_pendencias', 'usar_public', 'pode_criar', 'plpgsql', 'papel_trocado']);
const GRUPOS = Object.freeze(Object.keys(OBJETOS));
/** As 4 tabelas existentes que a 116 trava e nunca pode escrever. */
const PRESERVADAS = Object.freeze(['ia_credito_notificacoes', 'ia_credito_lotes', 'ia_credito_carteiras', 'assinatura_contratacoes']);
/**
 * Prova de preservação, DENTRO da transação da migration, sob as travas: nenhuma linha das 4 tabelas existentes tem xmin
 * igual ao xid desta transação (a troca do CHECK valida sem reescrever; FK nova não toca a tabela referenciada).
 */
const SQL_PRESERVACAO = `/* preservacao-116 */ SELECT
${PRESERVADAS.map(t => `  (SELECT count(*) FROM public.${t} WHERE xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int AS ${t}`).join(',\n')}`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado lido: ausente (0 objetos) | presente (5; o postcheck decide) | parcial (qualquer outro). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', ...GRUPOS]) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  for (const k of GRUPOS) assert.ok(e[k] <= OBJETOS[k].length, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  s.objetos = GRUPOS.reduce((t, k) => t + e[k], 0);
  s.m116 = s.objetos === 0 ? 'ausente' : s.objetos === TOTAL_OBJETOS ? 'presente' : 'parcial';
  if (s.m116 === 'parcial') s.divergencias = GRUPOS.filter(k => e[k] !== OBJETOS[k].length).map(k => `${k} ${e[k]}/${OBJETOS[k].length}`);
  return s;
}

/** Guardas antes de qualquer leitura de dados: tabelas exigidas (074a e 095), aplicação parcial e privilégios de cada caso. */
function exigirCatalogo(s) {
  for (const [k, t] of [['notificacoes', 'ia_credito_notificacoes'], ['lotes', 'ia_credito_lotes'], ['carteiras', 'ia_credito_carteiras'], ['contratacoes', 'assinatura_contratacoes']])
    assert.ok(s[k], 'TABELA_AUSENTE ' + t);
  assert.notEqual(s.m116, 'parcial', 'APLICACAO_PARCIAL_116 ' + (s.divergencias ?? []).join(', '));
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_lotes && 'SELECT_LOTES', !s.ler_notificacoes && 'SELECT_NOTIFICACOES', !s.ler_contratacoes && 'SELECT_CONTRATACOES'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  if (s.m116 === 'ausente') {
    const falta = [!s.dono_notificacoes && 'DONO_NOTIFICACOES', !s.referencias_carteiras && 'REFERENCES_CARTEIRAS', !s.referencias_lotes && 'REFERENCES_LOTES',
      !s.referencias_contratacoes && 'REFERENCES_CONTRATACOES', !s.ler_carteiras && 'SELECT_CARTEIRAS', !s.pode_criar && 'CREATE', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_116 ' + falta.join(' '));
  }
  // Presente: o postcheck (bloco DO) e as contagens das tabelas novas leem as 2 tabelas da 116 (P3-1 do Astra, 04/11).
  if (s.m116 === 'presente') {
    const falta = [!s.ler_franquias_ciclo && 'SELECT_FRANQUIAS_CICLO', !s.ler_pendencias && 'SELECT_PENDENCIAS', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_116_PRESENTE ' + falta.join(' '));
  }
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m116 === 'presente' ? ['postcheck 116'] : ['precheck 116', 'migration 116', 'postcheck 116'];
}

/** Situação do COMMIT quando o PRÓPRIO COMMIT falha (mesma regra da 109/112, com 40003 indeterminado). */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
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
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
const SQL_LOTES = 'SELECT origem::text AS chave, count(*)::int AS n FROM public.ia_credito_lotes GROUP BY origem ORDER BY origem';
const SQL_NOTIFICACOES = 'SELECT tipo::text AS chave, count(*)::int AS n FROM public.ia_credito_notificacoes GROUP BY tipo ORDER BY tipo';
const SQL_NOVAS = `SELECT (SELECT count(*) FROM public.ia_credito_franquias_ciclo)::int AS franquias_ciclo,
  (SELECT count(*) FROM public.ia_credito_franquia_pendencias)::int AS pendencias,
  (SELECT count(*) FROM public.ia_credito_franquia_pendencias WHERE processada_em IS NULL)::int AS pendencias_abertas`;
const mapa = rows => Object.fromEntries(rows.map(x => [x.chave, x.n]));
/** Contagens informativas (sem ids): lotes por origem, notificações por tipo e, com a 116, linhas das tabelas novas. */
async function contagens(db, m116) {
  const c = {lotesPorOrigem: mapa((await somenteLeitura(db, SQL_LOTES)).rows), notificacoesPorTipo: mapa((await somenteLeitura(db, SQL_NOTIFICACOES)).rows)};
  if (m116 === 'presente') c.novas = (await somenteLeitura(db, SQL_NOVAS)).rows[0];
  return c;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano, contagens e, em READ ONLY, o
 * precheck (ausente) ou o postcheck (presente).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db, {guardar: false});
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const presente = r.estado.m116 === 'presente';
  r.contagens = await contagens(db, r.estado.m116);
  r.checks = {};
  const nome = presente ? 'postcheck 116' : 'precheck 116';
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
    await db.query(semCommitFinal(sqls.get('migration 116'), 'migration 116'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    const p = (await db.query(SQL_PRESERVACAO)).rows[0];
    assert.ok(p && PRESERVADAS.every(t => p[t] === 0), 'PRESERVACAO_116 ' + PRESERVADAS.map(t => `${t}=${p?.[t]}`).join(' '));
    passo.antesDoCommit.preservacao = 'PASS';
    await db.query(corpoSomenteLeitura(sqls.get('postcheck 116'), 'postcheck 116'));
    passo.antesDoCommit['postcheck 116'] = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_116'); }
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
  semCommitFinal(sqls.get('migration 116'), 'migration 116');
  for (const nome of ['precheck 116', 'postcheck 116']) corpoSomenteLeitura(sqls.get(nome), nome);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes.m116);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome === 'migration 116') {
      await migrarComVerificacao(db, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false})).m116, 'presente', 'ESTADO_DEPOIS_116');
    } else await somenteLeitura(db, corpoSomenteLeitura(sqls.get(nome), nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m116, 'presente', 'ESTADO_FINAL_116');
  r.contagensDepois = await contagens(db, 'presente');
  r.resultado = r.plano.includes('migration 116') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['116', x.commit]));
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

/** Fábrica do aplicador de um ambiente (mesmo contrato dos aplicadores 092–112: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      provaNoAlvo: 'preservação (nenhuma linha de ia_credito_notificacoes, ia_credito_lotes, ia_credito_carteiras nem assinatura_contratacoes escrita pela transação) e postcheck DENTRO da transação da 116, antes do COMMIT; depois, o postcheck em READ ONLY',
      prazos: 'lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['116: nenhum dos 5 objetos presente (precheck: 074a e 095 aplicadas, CHECK de tipo das notificações da 095)',
        '116: current_user DONO de ia_credito_notificacoes, com REFERENCES e SELECT em ia_credito_carteiras, ia_credito_lotes e assinatura_contratacoes, USAGE e CREATE em public e USAGE em plpgsql',
        'código da F1 (#319, compatível com e sem a 116) publicado no web; CREDITOS_FRANQUIA_PLANO_ATIVO desligada',
        'B-14: depois da 116, os modos diferentes de --fila ficam indisponíveis até a entrega de compatibilidade (declarado na F1)'],
      ordem: ['conferir no Render o commit do web (F1) e os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL deste ambiente comprovado (PITR disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 116 neste ambiente',
        'janela curta, fora do minuto do cron de reconciliação (a cada 5 min): sem DDL concorrente; escritas em notificações, lotes, carteiras e contratações esperam a transação (lock_timeout 5 s)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência funcional logada: Assinatura → Créditos de IA igual (caminho legado, flag desligada)'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou conferência RECUSARIA depois de CONFIRMADO: parar, preservar saída e marcador, reconciliar e só então decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-116.<horario>.json'],
      recuperacao: ['database/rollback/20261103_116_franquias_ciclo_down.sql só com autorização própria e SEM trilha financeira (o down recusa franquia reconhecida ou aviso FRANQUIA_80/100)',
        'depois do primeiro reconhecimento: só correção para frente', 'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 116', 'alteração de env', 'deploy', 'restart', 'ligar CREDITOS_FRANQUIA_PLANO_ATIVO',
        'escrita em ia_credito_notificacoes, ia_credito_lotes, ia_credito_carteiras ou assinatura_contratacoes']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-116\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
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

module.exports = {ETAPAS, OBJETOS, TOTAL_OBJETOS, PRESERVADAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_PRESERVACAO,
  SQL_LOTES, SQL_NOTIFICACOES, SQL_NOVAS, lerEstado, exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, corpoSomenteLeitura,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
