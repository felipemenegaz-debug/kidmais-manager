/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 102 (apresentação do salão) e da 103 (categoria Serviços nos adicionais) — staging
// (scripts/migration-102-103-staging.cjs fixa o alvo, a identidade da conexão e o disco). Mesmo desenho dos aplicadores da
// 092–094, da 098 e da 100 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador exclusivo no disco
// persistente, códigos 0/1/2/3), para duas migrations independentes:
//   - estado de cada uma em DUAS leituras (parecer do Astra de 27/10, P2-1):
//       1. catálogo e privilégios, sem ler dados: 102 ausente | completa | parcial pelos objetos (13 colunas em
//          agenda_saloes, 3 tabelas, 9 funções kidmais102_*), a 098, a versão do servidor, dependências e privilégios.
//          Recusas nomeadas daqui (102 parcial, 098, versão, dependência, privilégio) vêm antes de qualquer leitura de dados;
//       2. só depois dessas guardas, a linha global SERVICOS de public.adicional_categorias (103 ausente | completa |
//          divergente). Detectar a divergência exige ler essa linha — é a única leitura de dados antes do plano;
//   - versão do PostgreSQL: o retrato semântico da 102 foi medido no PostgreSQL 18.6; com a 102 pendente, fora da versão
//     maior 18 recusa antes de qualquer escrita. A PROVA no próprio alvo vem na aplicação (P2-4): a migration roda SEM o
//     COMMIT final do arquivo, o postcheck e a integridade (com o retrato) rodam DENTRO da mesma transação, e só com
//     integra_102 = true o aplicador manda o COMMIT. Retrato divergente = ROLLBACK, nada confirmado (o down, protegido
//     pelo mesmo retrato, nunca fica necessário por causa disso);
//   - situação do COMMIT de cada migration (P2-3): falha no corpo ou nas verificações antes do COMMIT = NAO_COMMITADA (o
//     COMMIT nunca foi enviado; o servidor desfaz a transação aberta, inclusive se a conexão cair); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão INDETERMINADO (reconciliar
//     pela conferência); COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - aplicação, para cada migration ausente e na ordem 102 → 103: precheck (READ ONLY) → migration sem COMMIT →
//     postcheck/integridade na transação → COMMIT → estado completo → postcheck/integridade (READ ONLY). Completas: só a
//     integridade (102: integridade com retrato, integra_102 = true; 103: o postcheck, repetível). Cada migration commita
//     sozinha: uma falha na 103 deixa a 102 aplicada (o código publicado funciona com qualquer combinação);
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog (contexto do deparse
//     igual ao da migration); a conferência não grava no banco nem no disco.
// Recuperação desta janela: PITR (restauração física). Uma restauração LÓGICA (pg_dump/pg_restore) recria os CHECKs a
// partir de pg_get_constraintdef, que não faz ida e volta exata (BETWEEN → AND reagrupados): o retrato da 102 muda, a
// integridade e o postcheck dão false e o down recusa, sem deriva real. Depois de uma restauração lógica, nada de
// conferência/down até comparar as definições, revisar e aprovar uma nova referência do retrato (parecer do Astra, 27/10).
// Ordem: o CÓDIGO com este aplicador e os SQL é publicado ANTES (a #241 já publicou os SQL e as telas). Depois:
// --conferir-102-103 → ponto PITR comprovado e registrado → autorização → janela sem escrita de agenda/adicionais nem DDL →
// --conferir-102-103 de novo → --aplicar-102-103-autorizado --backup <registro> → --conferir-102-103.
// Nunca executa os down (rollback manual, autorização própria, sem presumir que estará disponível). Saída só com nomes de
// etapas, booleanos, a versão do servidor e contagens (sem ids, nomes ou URL do banco).
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`; lição de 14/10/2026). Ser dono
// não garante os privilégios ordinários (podem ter sido revogados), por isso são conferidos um a um (P2-2):
//   sempre: USAGE em public, SELECT em agenda_saloes (contagens), SELECT em adicional_categorias e USAGE em plpgsql
//           (precheck/postcheck da 103 são blocos DO); com a 102 completa, SELECT no catálogo da 102 (integridade);
//   102 pendente: dono de agenda_saloes (ALTER TABLE), CREATE em public, TRIGGER e REFERENCES em agenda_saloes,
//           REFERENCES em usuarios_administrativos, USAGE em plpgsql e sql;
//   103 pendente: INSERT em adicional_categorias e, para o LOCK … SHARE ROW EXCLUSIVE, UPDATE ou DELETE ou TRUNCATE
//           (ou MAINTAIN, a partir do PostgreSQL 17).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-102-103';
const FLAG_APLICAR = '--aplicar-102-103-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-102-103.json';
const IDS = Object.freeze(['102', '103']);
const ETAPAS = Object.freeze([
  ['precheck 102', 'database/checks/20261025_102_precheck.sql', '74b68fa0e9b1226ba8eaeb850208ff907bfd3a542c7f7b89507b1c51aa0a64bc'],
  ['migration 102', 'database/migrations/20261025_102_saloes_apresentacao.sql', '27de259d274f2d814b3f219ecd7fdb1db62a25c3b09d09b02a376216c8230c69'],
  ['postcheck 102', 'database/checks/20261025_102_postcheck.sql', 'ae72af44f9181e9aca49016928b86ac90195aaffdf6abf549c05ab4b5b1a5473'],
  ['integridade 102', 'database/checks/20261025_102_integridade.sql', 'd40f7d2a45cb7645d21ea1bc0a9371f7c9647181e6fa6a62d258617b9e259d5c'],
  ['precheck 103', 'database/checks/20261025_103_precheck.sql', '4b8dfae3a9cf5cd4991a803faf468d2fd5339aaf7c675e71681fddfe9c08e3b7'],
  ['migration 103', 'database/migrations/20261025_103_adicionais_servicos.sql', '990e48a02de32a68d0cb84b74e5e086db229131eea296a2bc7f29128f7b8634c'],
  ['postcheck 103', 'database/checks/20261025_103_postcheck.sql', '42775a0994e8fe1bf3ebf2e24975890da7ff3891b4bbce40ae09b2fc987323e3'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/** Hash do retrato semântico da 102 (o mesmo dos três SQL) e a versão maior em que foi medido. */
const RETRATO_102 = 'bfb4359c9e47709eddbc346ac5523c2274145154be2d141acd46a79704e2799d';
const VERSAO_MAIOR_MEDIDA = 18;
/** Verificações de cada migration: as que rodam dentro da transação antes do COMMIT e de novo, em READ ONLY, depois. */
const VERIFICACOES = Object.freeze({'102': ['postcheck 102', 'integridade 102'], '103': ['postcheck 103']});

const reg = t => `to_regclass('public.${t}')`;
const COLUNAS_102 = Object.freeze(['convidados_minimo', 'convidados_sentados', 'area_m2', 'idade_min', 'idade_max', 'frase',
  'outra_festa_simultanea', 'exclusivos', 'fotos_referencia', 'declaracao_em', 'declaracao_por', 'declaracao_versao', 'conteudo_versao']);
const TABELAS_102 = Object.freeze(['agenda_salao_itens_catalogo', 'agenda_salao_itens', 'agenda_salao_fotos']);
const tabela = (t, privilegio) => `coalesce((SELECT has_table_privilege(current_user, oid, '${privilegio}') FROM pg_class WHERE oid = ${reg(t)}), false)`;
const linguagem = l => `coalesce(has_language_privilege(current_user, '${l}', 'USAGE'), false)`;

/**
 * Estado 1 (somente catálogo e privilégios, sem ler nenhuma tabela de dados): presença dos objetos da 102, a 098, a
 * versão do servidor, as dependências, os privilégios de cada migration e o SET role, sem nomes.
 */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${reg('agenda_saloes')} IS NOT NULL AND ${reg('usuarios_administrativos')} IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${reg('agenda_saloes')} AND conname = 'agenda_saloes_empresa_id_uk')) AS d102,
  (${reg('adicional_categorias')} IS NOT NULL AND ${reg('adicionais')} IS NOT NULL) AS d103,
  (SELECT count(*) FROM pg_attribute WHERE attrelid = ${reg('agenda_saloes')} AND NOT attisdropped
    AND attname IN (${COLUNAS_102.map(c => `'${c}'`).join(', ')}))::int AS m102_colunas,
  (${TABELAS_102.map(t => `(${reg(t)} IS NOT NULL)::int`).join(' + ')})::int AS m102_tabelas,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais102\\_%')::int AS m102_funcoes,
  (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ${reg('agenda_saloes')} AND NOT attisdropped AND attname IN ('combinado', 'membros'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais098\\_%')) AS com_098,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  ${tabela('agenda_saloes', 'SELECT')} AS ler_saloes,
  ${TABELAS_102.map(t => tabela(t, 'SELECT')).join(' AND ')} AS ler_102,
  coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${reg('agenda_saloes')}), false) AS dono_102,
  ${tabela('agenda_saloes', 'TRIGGER')} AS gatilho_102,
  (${tabela('agenda_saloes', 'REFERENCES')} AND ${tabela('usuarios_administrativos', 'REFERENCES')}) AS referencias_102,
  (${linguagem('plpgsql')} AND ${linguagem('sql')}) AS linguagens_102,
  ${linguagem('plpgsql')} AS plpgsql,
  ${tabela('adicional_categorias', 'SELECT')} AS ler_103,
  ${tabela('adicional_categorias', 'INSERT')} AS inserir_103,
  (${['UPDATE', 'DELETE', 'TRUNCATE'].map(p => tabela('adicional_categorias', p)).join(' OR ')}
    OR CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ${tabela('adicional_categorias', 'MAINTAIN')} ELSE false END) AS travar_103,
  (session_user <> current_user) AS papel_trocado`;
/** Estado 2 (depois das guardas): a linha global SERVICOS. */
const SQL_CATEGORIA_103 = `SELECT CASE WHEN count(*) = 0 THEN 'AUSENTE'
    WHEN count(*) = 1 AND bool_and(nome = 'Serviços' AND ativo AND arquivado_em IS NULL) THEN 'IGUAL' ELSE 'DIVERGENTE' END AS m103_linha
  FROM public.adicional_categorias WHERE codigo = 'SERVICOS'`;

const BOOLEANOS = Object.freeze(['d102', 'd103', 'com_098', 'usar_public', 'pode_criar', 'ler_saloes', 'ler_102', 'dono_102', 'gatilho_102', 'referencias_102',
  'linguagens_102', 'plpgsql', 'ler_103', 'inserir_103', 'travar_103', 'papel_trocado']);
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** Estado 1 lido: m102 ausente/completa/parcial pelos objetos; m103 ainda não lida. */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['versao_pg', 'm102_colunas', 'm102_tabelas', 'm102_funcoes']) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg;
  const presentes = e.m102_colunas + e.m102_tabelas + e.m102_funcoes;
  s.m102 = presentes === 0 ? 'ausente' : e.m102_colunas === COLUNAS_102.length && e.m102_tabelas === TABELAS_102.length && e.m102_funcoes === 9 ? 'completa' : 'parcial';
  s.m103 = 'nao_lida';
  return s;
}
function lerCategoria(l) {
  const m = {AUSENTE: 'ausente', IGUAL: 'completa', DIVERGENTE: 'divergente'}[l?.m103_linha];
  assert.ok(m, 'ESTADO_ILEGIVEL m103_linha');
  return m;
}

/**
 * Guardas do estado 1, ANTES de ler a linha SERVICOS: 102 parcial, 098 com a 102 pendente, versão não medida, dependências
 * e privilégios da 102; dependência da 103 e os privilégios para ler/verificar a 103 (SELECT, plpgsql) e para as contagens.
 */
function exigirCatalogo(s) {
  assert.notEqual(s.m102, 'parcial', 'APLICACAO_PARCIAL_102');
  assert.ok(s.d103, 'DEPENDENCIA_AUSENTE_103 021');
  const sempre = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_saloes && 'SELECT_AGENDA_SALOES'].filter(Boolean);
  assert.ok(sempre.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + sempre.join(' '));
  if (s.m102 === 'ausente') {
    assert.ok(s.d102, 'DEPENDENCIA_AUSENTE_102 093');
    assert.ok(!s.com_098, 'COM_098_102 (098+102 exige revisão conjunta)');
    assert.equal(Math.floor(s.versao_pg / 10000), VERSAO_MAIOR_MEDIDA, 'VERSAO_PG_NAO_MEDIDA_102 ' + s.versao_pg);
    const falta = [!s.pode_criar && 'CREATE', !s.dono_102 && 'DONO', !s.gatilho_102 && 'TRIGGER', !s.referencias_102 && 'REFERENCES',
      !s.linguagens_102 && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_102 ' + falta.join(' '));
  } else assert.ok(s.ler_102, 'SEM_PRIVILEGIO_102 SELECT_CATALOGO');
  const falta103 = [!s.ler_103 && 'SELECT', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
  assert.ok(falta103.length === 0, 'SEM_PRIVILEGIO_103 ' + falta103.join(' '));
}

/** Plano a partir do estado completo (1 + linha SERVICOS); recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  assert.notEqual(s.m103, 'nao_lida', 'ESTADO_ILEGIVEL m103');
  assert.notEqual(s.m103, 'divergente', 'CATEGORIA_DIVERGENTE_103 (SERVICOS com outro nome, inativa, arquivada ou repetida)');
  if (s.m103 === 'ausente') {
    const falta = [!s.inserir_103 && 'INSERT', !s.travar_103 && 'LOCK'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_103 ' + falta.join(' '));
  }
  return [
    ...(s.m102 === 'completa' ? ['integridade 102'] : ['precheck 102', 'migration 102', 'postcheck 102', 'integridade 102']),
    ...(s.m103 === 'completa' ? ['postcheck 103'] : ['precheck 103', 'migration 103', 'postcheck 103']),
  ];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (o corpo já rodou): com SQLSTATE fora das classes 08/57/58/XX e
 * diferente de 40003, o servidor recusou e desfez; sem SQLSTATE, nessas classes ou 40003 (statement_completion_unknown:
 * o servidor não sabe se terminou), INDETERMINADO — reconciliar pela conferência, nunca tratar como desfeito.
 */
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

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Leitura também espera lock (ACCESS SHARE contra DDL concorrente): espera curta, falha explícita. O search_path
    // fixo é o mesmo da migration: o deparse do retrato (pg_get_*def) depende dele (P2-4).
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Estado 1 → guardas → estado 2. Sem guardas (`guardar` false) só para a releitura depois de um COMMIT. */
async function estadoAtual(db, {guardar = true} = {}) {
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  if (s.d103 && s.ler_103) s.m103 = lerCategoria((await somenteLeitura(db, SQL_CATEGORIA_103)).rows[0]);
  return s;
}
/** Uma verificação: integridade da 102 exige integra_102 = true; as demais são blocos que recusam com exceção. */
async function verificar(executar, nome, sql) {
  const r = await executar(sql);
  if (nome === 'integridade 102') assert.equal(r.rows?.[0]?.integra_102, true, 'INTEGRIDADE_102 ' + String(r.rows?.[0]?.integra_102));
  return 'PASS';
}
/** Contagens informativas (sem ids): salões, salões ativos e categorias de adicionais. */
async function contagens(db) {
  return (await somenteLeitura(db, `SELECT (SELECT count(*) FROM public.agenda_saloes)::int AS saloes,
    (SELECT count(*) FROM public.agenda_saloes WHERE ativo)::int AS saloes_ativos, (SELECT count(*) FROM public.adicional_categorias)::int AS categorias_adicionais`)).rows[0];
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado 1, guardas, linha SERVICOS, plano e, em READ
 * ONLY, o precheck de cada ausente e a integridade de cada completa (102: integridade com retrato; 103: postcheck).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { exigirCatalogo(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.estado.m103 = lerCategoria((await somenteLeitura(db, SQL_CATEGORIA_103)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db);
  r.checks = {};
  for (const id of IDS) {
    const completa = r.estado['m' + id] === 'completa';
    const nome = completa ? (id === '102' ? 'integridade 102' : 'postcheck 103') : 'precheck ' + id;
    const [, arquivo, hash] = etapa(nome);
    try { r.checks[nome] = await verificar(sql => somenteLeitura(db, sql), nome, lerRevisado(raiz, arquivo, hash)); }
    catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  }
  r.resultado = IDS.every(id => r.estado['m' + id] === 'completa') ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Migration de `id` sem o COMMIT final; postcheck/integridade dentro da transação; COMMIT só com tudo PASS. Registra a
 * situação do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, id, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration ' + id), 'migration ' + id));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    for (const nome of VERIFICACOES[id]) passo.antesDoCommit[nome] = await verificar(sql => db.query(sql), nome, sqls.get(nome));
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_' + id); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/**
 * Aplicação, na ordem do plano: precheck (READ ONLY) → migration sem COMMIT → verificações na transação → COMMIT →
 * estado completo → postcheck/integridade (READ ONLY). O estado é relido aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  for (const id of IDS) semCommitFinal(sqls.get('migration ' + id), 'migration ' + id);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes); r.contagensAntes = await contagens(db); registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    if (nome.startsWith('migration ')) {
      const id = nome.slice(-3);
      await migrarComVerificacao(db, id, sqls, passo, () => registrar(r));
      assert.equal((await estadoAtual(db, {guardar: false}))['m' + id], 'completa', 'ESTADO_DEPOIS_' + id);
    } else await verificar(sql => somenteLeitura(db, sql), nome, sqls.get(nome));
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  for (const id of IDS) assert.equal(r.estadoDepois['m' + id], 'completa', 'ESTADO_FINAL_' + id);
  r.contagensDepois = await contagens(db);
  r.resultado = r.plano.some(n => n.startsWith('migration ')) ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_INTEGRIDADE_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => [x.nome.slice(-3), x.commit]));
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

/** Fábrica do aplicador de um ambiente (mesmo contrato da 092–094 e da 100: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      retrato102: {sha256: RETRATO_102, versaoMaiorMedida: VERSAO_MAIOR_MEDIDA, provaNoAlvo: 'integridade com o retrato DENTRO da transação da 102, antes do COMMIT'},
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['102: 093 aplicada (agenda_saloes, usuarios_administrativos, agenda_saloes_empresa_id_uk), SEM a 098 e nenhum objeto da 102 (parcial recusa)',
        `102: PostgreSQL versão maior ${VERSAO_MAIOR_MEDIDA} (retrato medido no 18.6); outra versão recusa até medir e revisar um hash novo`,
        '102: current_user dono de agenda_saloes, com USAGE e CREATE em public, SELECT, TRIGGER e REFERENCES em agenda_saloes, REFERENCES em usuarios_administrativos e USAGE em plpgsql e sql',
        '103: 021 aplicada; SERVICOS ausente ou idêntica (Serviços, ativa, não arquivada); SELECT e INSERT em adicional_categorias, UPDATE ou DELETE ou TRUNCATE ou MAINTAIN para o LOCK, USAGE em plpgsql',
        'aplicar a 102 bloqueia a 098 (salões combinados, pausada): o aplicador da 098 passa a recusar (098+102 exige revisão conjunta) — decisão D1 explícita antes'],
      ordem: ['deploy do código com este aplicador e os SQL; conferir commit e hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação PITR do PostgreSQL de staging comprovado (disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação); export lógico NÃO serve de recuperação desta janela', 'autorização de Felipe para a 102/103 neste ambiente',
        'janela combinada: sem salvar agenda nem catálogo de adicionais e sem DDL concorrente (a 102 pega ACCESS EXCLUSIVE em agenda_saloes)',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR, 'conferência logada: Salões, Catálogo (serviços comuns) e Agenda'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit por migration = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'falha na 103 com a 102 confirmada: a 102 fica aplicada (código funciona); a retomada é decisão de Felipe',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou 102 confirmada com verificação falha: parar, preservar saída e marcador, reconciliar pela conferência autorizada e só então decidir retomada ou restauração',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-102-103.<horario>.json'],
      recuperacao: ['database/rollback/20261025_103_adicionais_servicos_down.sql só com autorização própria (recusa se algum adicional usar SERVICOS)',
        'database/rollback/20261025_102_saloes_apresentacao_down.sql só com autorização própria (recusa com qualquer conteúdo novo ou deriva do retrato): nunca presumir que estará disponível',
        'em último caso, restauração PITR ao ponto registrado (física: preserva as definições e o retrato)',
        'restauração LÓGICA (pg_dump/pg_restore) muda o retrato da 102 sem deriva real: antes de qualquer conferência ou down, comparar as definições, revisar e aprovar uma nova referência — nunca aceitar o hash encontrado'],
      nuncaExecuta: ['down 102', 'down 103', 'alteração de env', 'deploy', 'restart', 'escrita de salões, fotos, itens ou adicionais']};
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
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-102-103\..+\.json$/.test(n)).sort();
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
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
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

module.exports = {IDS, ETAPAS, RETRATO_102, VERSAO_MAIOR_MEDIDA, VERIFICACOES, COLUNAS_102, TABELAS_102, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR,
  SQL_ESTADO, SQL_CATEGORIA_103, lerEstado, lerCategoria, exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
