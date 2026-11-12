/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 104 (hash da revisão com o salão, fase S-E) e da 106 (salão de preferência, fase S-D) —
// staging (scripts/migration-104-106-staging.cjs fixa o alvo, a identidade da conexão e o disco). Plano aprovado com
// ressalvas pelo Astra em 27/10/2026 (rev. 2: "Plano aplicador 104 106 staging 20261027"). Mesmo mecanismo FINAL da
// 102/103 (scripts/migration-102-103-comum.cjs): alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente, códigos 0/1/2/3, para duas migrations independentes:
//   - ordem das consultas (§3.1): 1) identidade; 2) catálogo e privilégios num só SELECT, sem nenhum ::regclass de objeto
//     que pode faltar (to_regclass/to_regprocedure); 3) estado de cada migration; 4) privilégios exigidos PARA O ESTADO
//     encontrado — tudo isso antes de ler qualquer dado; 5) com alguma pendente, a atividade nas três tabelas atingidas
//     (pg_locks com o contexto de pg_stat_activity; ressalva do Astra à rev. 2: visibilidade insuficiente RECUSA, nunca
//     conta como ausência); 6) só então dados (contagens, checks). O conjunto das duas é validado antes da 1ª escrita (D1);
//   - estados (§3.2), presença × integridade:
//       104: dependência (094: fechamento_revisoes.salao_id; fechamento_revisao_adicionais; função de hash) → divergente
//            (função de hash ausente, corpo nem 016 nem 104, ou metadados alterados) → parcial (marcadores incompletos, ou
//            marcadores × corpo trocados) → completa (4 marcadores + corpo 104) | ausente (0 marcadores + corpo 016);
//       106: dependência (094/102/093) → parcial → completa (os 7 nomes) | ausente;
//     completa só vira JA_APLICADA com a integridade passando; completa com integridade falha = INTEGRIDADE_10x;
//   - contrato das verificações (§3.3): os SQL são blocos DO; sucesso = execução inteira sem exceção (nada de booleano).
//     104: 20261027_104_integridade.sql (SÓ catálogo, novo) e 20261027_104_postcheck.sql como AUDITORIA de dados
//     (AUDITORIA_DADOS_104); 106: postcheck + integridade (catálogo e preferência fora do escopo);
//   - aplicação (§3.5), para cada pendente na ordem 104 → 106: precheck (READ ONLY) → migration SEM o COMMIT final →
//     integridade de catálogo (104) / postcheck + integridade (106) e EXECUTE das funções novas NA MESMA transação →
//     COMMIT → situação registrada antes de qualquer outra leitura → estado → integridade e auditoria (READ ONLY).
//     Situação do COMMIT: NAO_COMMITADA (COMMIT nunca enviado) | CONFIRMADO | DESFEITA_PELO_SERVIDOR (respondido como
//     ROLLBACK, ou SQLSTATE fora de 08/57/58/XX e diferente de 40003) | INDETERMINADO (sem SQLSTATE, 08/57/58/XX ou 40003).
//     Falha depois de um CONFIRMADO não o transforma em desfeito;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog (o deparse de
//     pg_get_expr/pg_get_constraintdef depende dele); a conferência não grava no banco nem no disco.
// Privilégios (§3.4), sempre de current_user (no Render a credencial entra com `SET role`); ser dono não garante os
// ordinários depois de um REVOKE, então cada um é conferido:
//   sempre: USAGE em public e em plpgsql (blocos DO); SELECT em fechamento_revisoes, fechamento_revisao_adicionais,
//           fechamentos e agenda_saloes; EXECUTE na função de hash (a auditoria a chama);
//   104 pendente: dono de fechamento_revisoes e da função de hash, CREATE em public, TEMP no banco, TRIGGER em
//           fechamento_revisoes, UPDATE/DELETE/TRUNCATE (ou MAINTAIN, PG 17+) para o LOCK SHARE ROW EXCLUSIVE, USAGE em sql;
//   106 pendente: dono de fechamentos e (política conservadora) de agenda_saloes, CREATE em public, TRIGGER em fechamentos
//           e agenda_saloes, REFERENCES em agenda_saloes.empresa_id e agenda_saloes.id;
//   alguma pendente: ver a atividade das outras sessões (superusuário ou membro de pg_read_all_stats).
// Nunca executa os down, env, deploy, restart nem liga SALOES_PUBLICOS. Saída só com nomes de etapas, booleanos, a versão
// do servidor e contagens (sem ids, nomes ou URL do banco).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-104-106';
const FLAG_APLICAR = '--aplicar-104-106-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-104-106.json';
const IDS = Object.freeze(['104', '106']);
const ETAPAS = Object.freeze([
  ['precheck 104', 'database/checks/20261027_104_precheck.sql', 'ecfbb8cb386684ef1ac42f7e8633f12aff66d5c8f48ca52a8a04a121c69b2fd9'],
  ['migration 104', 'database/migrations/20261027_104_revisao_hash_salao.sql', '9802e07e029bfa5a8f4594c032107531df50dcd59388258369dff9c5a6d9f330'],
  ['integridade 104', 'database/checks/20261027_104_integridade.sql', '13636b03f4b88a8c6d31478130e875775ca40ccdec53999654c64af4b663fc3f'],
  ['postcheck 104', 'database/checks/20261027_104_postcheck.sql', 'b59a939e9b6850ae9b60a6fa2b8a1f306701afd8280a1933c0a66664121fff48'],
  ['precheck 106', 'database/checks/20261027_106_precheck.sql', 'a47ba886fb36910e060879f2a23f6cce38693c27d39c18e42a7826c483678005'],
  ['migration 106', 'database/migrations/20261027_106_salao_preferido.sql', '6d012b991a5e116dbd41908f4d5006e5be98c1bc617486bb8695b5fc34979e88'],
  ['postcheck 106', 'database/checks/20261027_106_postcheck.sql', '432c69a4cbce4234ac9823022d819a9f89e280d833d92c5263ea71c54f70cd8f'],
  ['integridade 106', 'database/checks/20261027_106_integridade.sql', '482496356dd048a99c473c10de1d9de142619cfefac548d9c414ed13051055a3'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/** Corpos (sha256 do prosrc sem CR) da função de hash: o da 016 (antes) e o da 104 (depois). */
const CORPO_HASH_016 = '9986a2a6bad41a28ac036c8e59b6358e6f75bda680781c97896eff180bed940f';
const CORPO_HASH_104 = 'fe0f0199883b0c9d994478a2aba4e92940bea0f52250ef2ea62462900615f6ed';
const MARCADORES_104 = 4;
const MARCADORES_106 = 7;
/** Funções novas cujo EXECUTE é conferido DENTRO da transação, antes do COMMIT. */
const FUNCOES_NOVAS = Object.freeze({'104': ['kidmais104_hash_versao_imutavel()'],
  '106': ['kidmais106_salao_preferido_escopo()', 'kidmais106_salao_escopo_referenciado()']});
const sqlExecucao = id => `SELECT ${FUNCOES_NOVAS[id].map(f => `coalesce(has_function_privilege(current_user, to_regprocedure('public.${f}'), 'EXECUTE'), false)`).join(' AND ')} AS executa_${id}`;
/** Verificações de cada migration DENTRO da transação, antes do COMMIT (as de arquivo e a de EXECUTE). */
const VERIFICACOES = Object.freeze({'104': ['integridade 104', 'execucao 104'], '106': ['postcheck 106', 'integridade 106', 'execucao 106']});

const reg = t => `to_regclass('public.${t}')`;
const proc = f => `to_regprocedure('public.${f}')`;
const tabela = (t, privilegio) => `coalesce((SELECT has_table_privilege(current_user, oid, '${privilegio}') FROM pg_class WHERE oid = ${reg(t)}), false)`;
const coluna = (t, c, privilegio) => `coalesce((SELECT has_column_privilege(current_user, attrelid, attnum, '${privilegio}') FROM pg_attribute
    WHERE attrelid = ${reg(t)} AND attname = '${c}' AND NOT attisdropped), false)`;
const dono = t => `coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${reg(t)}), false)`;
const linguagem = l => `coalesce(has_language_privilege(current_user, '${l}', 'USAGE'), false)`;
const existeColuna = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ${reg(t)} AND attname = '${c}' AND NOT attisdropped)`;
const existeRestricao = (t, nome) => `EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${reg(t)} AND conname = '${nome}')`;
const existeGatilho = (t, nome) => `EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ${reg(t)} AND tgname = '${nome}' AND NOT tgisinternal)`;
const HASH = 'kidmais_hash_revisao_operacional(uuid)';

/**
 * Catálogo e privilégios (sem ler nenhuma tabela de dados): dependências, marcadores de cada migration, corpo e metadados
 * da função de hash, privilégios de cada etapa e a visibilidade da atividade, sem nomes.
 */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${reg('fechamento_revisoes')} IS NOT NULL AND ${reg('fechamento_revisao_adicionais')} IS NOT NULL
    AND ${existeColuna('fechamento_revisoes', 'salao_id')}) AS d104,
  (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = ${proc(HASH)}) AS hash_corpo,
  coalesce((SELECT p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AND p.provolatile = 's' AND p.proconfig IS NULL
    AND NOT p.prosecdef AND p.prorettype = 'text'::regtype AND p.prokind = 'f' FROM pg_proc p WHERE p.oid = ${proc(HASH)}), false) AS hash_meta,
  ((${existeColuna('fechamento_revisoes', 'hash_versao')})::int + (${existeRestricao('fechamento_revisoes', 'fechamento_revisoes_hash_versao_ck')})::int
    + (${proc('kidmais104_hash_versao_imutavel()')} IS NOT NULL)::int + (${existeGatilho('fechamento_revisoes', 'kidmais104_hash_versao_imutavel')})::int) AS m104_marcadores,
  (${reg('fechamentos')} IS NOT NULL AND ${reg('agenda_saloes')} IS NOT NULL AND ${reg('agenda_salao_fotos')} IS NOT NULL
    AND ${existeColuna('fechamentos', 'salao_id')} AND ${existeRestricao('agenda_saloes', 'agenda_saloes_empresa_id_uk')}) AS d106,
  ((${existeColuna('fechamentos', 'salao_preferido_id')})::int + (${existeRestricao('fechamentos', 'fechamentos_106_salao_preferido_fk')})::int
    + (${reg('fechamentos_106_salao_preferido_idx')} IS NOT NULL)::int + (${proc('kidmais106_salao_preferido_escopo()')} IS NOT NULL)::int
    + (${proc('kidmais106_salao_escopo_referenciado()')} IS NOT NULL)::int + (${existeGatilho('fechamentos', 'fechamentos_106_salao_preferido_trg')})::int
    + (${existeGatilho('agenda_saloes', 'agenda_saloes_106_escopo_trg')})::int) AS m106_marcadores,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  has_database_privilege(current_user, current_database(), 'TEMP') AS temp,
  ${linguagem('plpgsql')} AS plpgsql,
  ${linguagem('sql')} AS linguagem_sql,
  ${tabela('fechamento_revisoes', 'SELECT')} AS ler_revisoes,
  ${tabela('fechamento_revisao_adicionais', 'SELECT')} AS ler_revisao_adicionais,
  ${tabela('fechamentos', 'SELECT')} AS ler_fechamentos,
  ${tabela('agenda_saloes', 'SELECT')} AS ler_saloes,
  coalesce(has_function_privilege(current_user, ${proc(HASH)}, 'EXECUTE'), false) AS executar_hash,
  ${dono('fechamento_revisoes')} AS dono_revisoes,
  coalesce((SELECT pg_has_role(current_user, proowner, 'USAGE') FROM pg_proc WHERE oid = ${proc(HASH)}), false) AS dono_hash,
  ${tabela('fechamento_revisoes', 'TRIGGER')} AS gatilho_revisoes,
  (${['UPDATE', 'DELETE', 'TRUNCATE'].map(p => tabela('fechamento_revisoes', p)).join(' OR ')}
    OR CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ${tabela('fechamento_revisoes', 'MAINTAIN')} ELSE false END) AS travar_revisoes,
  ${dono('fechamentos')} AS dono_fechamentos,
  ${dono('agenda_saloes')} AS dono_saloes,
  ${tabela('fechamentos', 'TRIGGER')} AS gatilho_fechamentos,
  ${tabela('agenda_saloes', 'TRIGGER')} AS gatilho_saloes,
  (${coluna('agenda_saloes', 'empresa_id', 'REFERENCES')} AND ${coluna('agenda_saloes', 'id', 'REFERENCES')}) AS referencias_saloes,
  (coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')) AS ver_atividade,
  (session_user <> current_user) AS papel_trocado`;
/**
 * Atividade de OUTRAS sessões nas três tabelas atingidas (ressalva do Astra à rev. 2): locks de relação com o contexto da
 * sessão. Só roda depois das guardas e com ver_atividade (sem ela, linhas de outros papéis vêm ocultas: recusa antes).
 * P2-C1 (revisão do código): lock de transação PREPARADA tem pid NULL — o filtro é IS DISTINCT FROM (não descarta NULL)
 * e esses locks contam em locks_sem_pid e em sem_contexto (count(DISTINCT pid) ignoraria NULL): recusa, nunca ausência.
 */
const SQL_ATIVIDADE = `SELECT count(*)::int AS locks, count(DISTINCT l.pid)::int AS sessoes,
  count(DISTINCT l.pid) FILTER (WHERE a.xact_start IS NOT NULL)::int AS sessoes_em_transacao,
  count(*) FILTER (WHERE l.pid IS NULL)::int AS locks_sem_pid,
  (count(DISTINCT l.pid) FILTER (WHERE l.pid IS NOT NULL AND (a.pid IS NULL OR a.state IS NULL)) + count(*) FILTER (WHERE l.pid IS NULL))::int AS sem_contexto
  FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.relation IN (${['fechamentos', 'fechamento_revisoes', 'agenda_saloes'].map(reg).join(', ')}) AND l.pid IS DISTINCT FROM pg_backend_pid()`;

const BOOLEANOS = Object.freeze(['d104', 'hash_meta', 'd106', 'usar_public', 'pode_criar', 'temp', 'plpgsql', 'linguagem_sql', 'ler_revisoes',
  'ler_revisao_adicionais', 'ler_fechamentos', 'ler_saloes', 'executar_hash', 'dono_revisoes', 'dono_hash', 'gatilho_revisoes', 'travar_revisoes',
  'dono_fechamentos', 'dono_saloes', 'gatilho_fechamentos', 'gatilho_saloes', 'referencias_saloes', 'ver_atividade', 'papel_trocado']);
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** Presença de cada migration (sem integridade, que só os checks provam). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  assert.ok(Number.isInteger(e?.versao_pg) && e.versao_pg > 0, 'ESTADO_ILEGIVEL versao_pg');
  assert.ok(Number.isInteger(e?.m104_marcadores) && e.m104_marcadores >= 0 && e.m104_marcadores <= MARCADORES_104, 'ESTADO_ILEGIVEL m104_marcadores');
  assert.ok(Number.isInteger(e?.m106_marcadores) && e.m106_marcadores >= 0 && e.m106_marcadores <= MARCADORES_106, 'ESTADO_ILEGIVEL m106_marcadores');
  assert.ok(e?.hash_corpo === null || /^[0-9a-f]{64}$/.test(e?.hash_corpo), 'ESTADO_ILEGIVEL hash_corpo');
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  Object.assign(s, {versao_pg: e.versao_pg, m104_marcadores: e.m104_marcadores, m106_marcadores: e.m106_marcadores});
  // 104: divergente (função ausente, corpo desconhecido ou metadados alterados) tem precedência sobre parcial.
  const corpo = e.hash_meta ? {[CORPO_HASH_016]: '016', [CORPO_HASH_104]: '104'}[e.hash_corpo] : undefined;
  s.funcao_hash = corpo ?? 'divergente';
  s.m104 = !corpo ? 'divergente'
    : e.m104_marcadores === 0 && corpo === '016' ? 'ausente'
      : e.m104_marcadores === MARCADORES_104 && corpo === '104' ? 'completa' : 'parcial';
  s.m106 = e.m106_marcadores === 0 ? 'ausente' : e.m106_marcadores === MARCADORES_106 ? 'completa' : 'parcial';
  return s;
}
const pendente = (s, id) => s['m' + id] === 'ausente';
const algumaPendente = s => IDS.some(id => pendente(s, id));

/** Guardas do catálogo, ANTES de qualquer leitura de dados: dependências, estados e privilégios do estado encontrado. */
function exigirCatalogo(s) {
  assert.ok(s.d104, 'SEM_DEPENDENCIA_104 fechamento_revisoes.salao_id/fechamento_revisao_adicionais (094)');
  assert.ok(s.d106, 'SEM_DEPENDENCIA_106 fechamentos.salao_id/agenda_salao_fotos/agenda_saloes_empresa_id_uk (094/102/093)');
  assert.notEqual(s.m104, 'divergente', 'FUNCAO_HASH_DIVERGENTE_104 (ausente, corpo desconhecido ou metadados alterados)');
  assert.notEqual(s.m104, 'parcial', 'APLICACAO_PARCIAL_104');
  assert.notEqual(s.m106, 'parcial', 'APLICACAO_PARCIAL_106');
  const sempre = [!s.usar_public && 'USAGE_PUBLIC', !s.plpgsql && 'PLPGSQL', !s.ler_revisoes && 'SELECT_FECHAMENTO_REVISOES',
    !s.ler_revisao_adicionais && 'SELECT_FECHAMENTO_REVISAO_ADICIONAIS', !s.ler_fechamentos && 'SELECT_FECHAMENTOS',
    !s.ler_saloes && 'SELECT_AGENDA_SALOES', !s.executar_hash && 'EXECUTE_HASH'].filter(Boolean);
  assert.ok(sempre.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + sempre.join(' '));
  if (pendente(s, '104')) {
    const falta = [!s.pode_criar && 'CREATE', !s.dono_revisoes && 'DONO_FECHAMENTO_REVISOES', !s.dono_hash && 'DONO_FUNCAO_HASH', !s.temp && 'TEMP',
      !s.gatilho_revisoes && 'TRIGGER', !s.travar_revisoes && 'LOCK', !s.linguagem_sql && 'LINGUAGEM_SQL'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_104 ' + falta.join(' '));
  }
  if (pendente(s, '106')) {
    const falta = [!s.pode_criar && 'CREATE', !s.dono_fechamentos && 'DONO_FECHAMENTOS', !s.dono_saloes && 'DONO_AGENDA_SALOES',
      !s.gatilho_fechamentos && 'TRIGGER_FECHAMENTOS', !s.gatilho_saloes && 'TRIGGER_AGENDA_SALOES', !s.referencias_saloes && 'REFERENCES'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_106 ' + falta.join(' '));
  }
  assert.ok(!algumaPendente(s) || s.ver_atividade, 'ATIVIDADE_NAO_VERIFICAVEL (sem superusuário nem pg_read_all_stats: atividade de outras sessões oculta)');
}

/** Atividade lida: com alguma pendente, nenhuma outra sessão com lock nas tabelas atingidas e nenhuma sem contexto. */
function exigirSemAtividade(a) {
  for (const k of ['locks', 'sessoes', 'sessoes_em_transacao', 'locks_sem_pid', 'sem_contexto']) assert.ok(Number.isInteger(a?.[k]) && a[k] >= 0, 'ESTADO_ILEGIVEL atividade ' + k);
  assert.equal(a.sem_contexto, 0, `ATIVIDADE_NAO_VERIFICAVEL ${a.sem_contexto} sem contexto visível (${a.locks_sem_pid} lock(s) sem pid: transação preparada)`);
  assert.equal(a.sessoes, 0, `ATIVIDADE_NAS_TABELAS ${a.sessoes} sessão(ões), ${a.sessoes_em_transacao} em transação, ${a.locks} lock(s)`);
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return [
    ...(pendente(s, '104') ? ['precheck 104', 'migration 104'] : []), 'integridade 104', 'postcheck 104',
    ...(pendente(s, '106') ? ['precheck 106', 'migration 106', 'postcheck 106'] : []), 'integridade 106',
  ];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (o corpo já rodou): com SQLSTATE fora das classes 08/57/58/XX e
 * diferente de 40003, o servidor recusou e desfez; sem SQLSTATE, nessas classes ou 40003 (statement_completion_unknown),
 * INDETERMINADO — reconciliar pela conferência, nunca tratar como desfeito.
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
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
async function estadoAtual(db, {guardar = true} = {}) {
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
/** Prefixo da recusa de cada verificação (o SQL em si é um bloco DO: sucesso = sem exceção). */
const ROTULO = Object.freeze({'integridade 104': 'INTEGRIDADE_104', 'postcheck 104': 'AUDITORIA_DADOS_104', 'integridade 106': 'INTEGRIDADE_106',
  'postcheck 106': 'INTEGRIDADE_106', 'execucao 104': 'EXECUCAO_FUNCOES_104', 'execucao 106': 'EXECUCAO_FUNCOES_106'});
/** Uma verificação: arquivos DO (exceção = falha) ou o SELECT de EXECUTE das funções novas (precisa ser true). */
async function verificar(executar, nome, sql) {
  try {
    const r = await executar(sql);
    if (nome.startsWith('execucao ')) assert.equal(r.rows?.[0]?.['executa_' + nome.slice(-3)], true, String(r.rows?.[0]?.['executa_' + nome.slice(-3)]));
    return 'PASS';
  } catch (e) {
    if (!ROTULO[nome]) throw e;
    const x = new Error(ROTULO[nome] + ' ' + curta(e)); x.code = e?.code; throw x;
  }
}
/** Contagens informativas (sem ids), conforme o estado: as colunas novas só existem com a migration completa. */
async function contagens(db, s) {
  return (await somenteLeitura(db, `SELECT (SELECT count(*) FROM public.fechamento_revisoes)::int AS revisoes,
    ${s.m104 === 'completa' ? '(SELECT count(*) FROM public.fechamento_revisoes WHERE hash_versao = 2)::int' : 'NULL::int'} AS revisoes_v2,
    ${s.m106 === 'completa' ? '(SELECT count(*) FROM public.fechamentos WHERE salao_preferido_id IS NOT NULL)::int' : 'NULL::int'} AS fechamentos_com_preferencia,
    (SELECT count(*) FROM public.agenda_saloes)::int AS saloes`)).rows[0];
}
/** Com alguma pendente: a atividade nas tabelas atingidas, lida depois das guardas (ver_atividade já exigida). */
async function atividade(db, s) {
  if (!algumaPendente(s)) return null;
  const a = (await somenteLeitura(db, SQL_ATIVIDADE)).rows[0];
  exigirSemAtividade(a);
  return a;
}
const sqlDaVerificacao = (sqls, nome) => (nome.startsWith('execucao ') ? sqlExecucao(nome.slice(-3)) : sqls.get(nome));

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, catálogo/privilégios, guardas, atividade, contagens e,
 * em READ ONLY, o precheck de cada pendente e a integridade/auditoria de cada completa.
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  try { r.atividade = await atividade(db, r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado);
  r.checks = {};
  const nomes = IDS.flatMap(id => (pendente(r.estado, id) ? ['precheck ' + id] : id === '104' ? ['integridade 104', 'postcheck 104'] : ['integridade 106']));
  for (const nome of nomes) {
    const [, arquivo, hash] = etapa(nome);
    try { r.checks[nome] = await verificar(sql => somenteLeitura(db, sql), nome, lerRevisado(raiz, arquivo, hash)); }
    catch (e) { r.checks[nome] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  }
  r.resultado = algumaPendente(r.estado) ? 'PRONTA_PARA_APLICAR' : 'JA_APLICADA_INTEGRIDADE_PASS';
  return r;
}

/**
 * Migration de `id` sem o COMMIT final; verificações dentro da transação; COMMIT só com tudo PASS. Registra a situação do
 * COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, id, sqls, passo, registrar) {
  let fase = 'corpo';
  try {
    await db.query(semCommitFinal(sqls.get('migration ' + id), 'migration ' + id));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    for (const nome of VERIFICACOES[id]) passo.antesDoCommit[nome] = await verificar(sql => db.query(sql), nome, sqlDaVerificacao(sqls, nome));
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
 * estado completo → integridade/auditoria (READ ONLY). Estado e atividade relidos aqui, imediatamente antes.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  for (const id of IDS) semCommitFinal(sqls.get('migration ' + id), 'migration ' + id);
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  r.atividade = await atividade(db, r.estadoAntes);
  r.contagensAntes = await contagens(db, r.estadoAntes); registrar(r);
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
  r.contagensDepois = await contagens(db, r.estadoDepois);
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

/** Fábrica do aplicador de um ambiente (mesmo contrato da 102/103: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco). */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      funcaoHash: {corpo016: CORPO_HASH_016, corpo104: CORPO_HASH_104},
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['104: 094 aplicada (fechamento_revisoes.salao_id) e a função de hash com corpo e metadados da 016; nenhum marcador da 104 (parcial ou divergente recusa)',
        '106: 094, 102 e 093 aplicadas (fechamentos.salao_id, agenda_salao_fotos, agenda_saloes_empresa_id_uk); nenhum objeto da 106 (parcial recusa); código da S-D (#254) LIVE',
        'sempre (current_user): USAGE em public e plpgsql; SELECT em fechamento_revisoes, fechamento_revisao_adicionais, fechamentos e agenda_saloes; EXECUTE na função de hash',
        '104 pendente: dono de fechamento_revisoes e da função de hash, CREATE em public, TEMP, TRIGGER em fechamento_revisoes, UPDATE/DELETE/TRUNCATE/MAINTAIN para o LOCK, USAGE em sql',
        '106 pendente: dono de fechamentos e de agenda_saloes, CREATE em public, TRIGGER em fechamentos e agenda_saloes, REFERENCES em agenda_saloes(empresa_id, id)',
        'alguma pendente: superusuário ou pg_read_all_stats (ver a atividade das outras sessões); nenhuma sessão com lock em fechamentos, fechamento_revisoes ou agenda_saloes',
        'a 105 (MCP) fica fora (D2): nenhum marcador fictício; a 106 não depende dela'],
      ordem: ['#254 (S-D) e este aplicador LIVE; conferir commit e hashes implantados e gerar os blocos dessa árvore', FLAG_CONFERIR,
        'ponto de recuperação PITR do PostgreSQL de staging comprovado e registrado (referência e horário); export lógico NÃO substitui',
        'autorização de Felipe para a 104/106 neste ambiente',
        'janela drenada: sem cotação pública, assistente, pagamentos/webhooks, revisões e edição de salões; crons sem execução em curso (modo registrado); sem export/DDL concorrente. A 104 segura SHARE ROW EXCLUSIVE → ACCESS EXCLUSIVE em fechamento_revisoes e a 106 ACCESS EXCLUSIVE em fechamentos (SHARE ROW EXCLUSIVE em agenda_saloes) até o fim de cada transação, inclusive durante as verificações; lock_timeout 5s só limita a espera da migration',
        `${FLAG_CONFERIR} de novo, imediatamente antes (atividade pelas pg_locks com contexto)`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência logada: revisão nova em POR_SALAO grava hash v2; com SALOES_PUBLICOS desligada, /api/publico/saloes 404 e o fechamento como antes'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit por migration = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'falha na 106 com a 104 confirmada: a 104 fica aplicada (código funciona); a retomada é decisão de Felipe',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou migration confirmada com verificação falha: parar, preservar saída e marcador, reconciliar pela conferência autorizada e só então decidir retomada ou restauração',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-104-106.<horario>.json'],
      recuperacao: ['database/rollback/20261027_106_salao_preferido_down.sql só com autorização própria (recusa com qualquer preferência gravada)',
        'database/rollback/20261027_104_revisao_hash_salao_down.sql só com autorização própria (recusa com qualquer revisão em hash v2)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 104', 'down 106', 'alteração de env', 'deploy', 'restart', 'ligar SALOES_PUBLICOS', 'escrita de revisões, festas ou salões']};
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
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-104-106\..+\.json$/.test(n)).sort();
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
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois, atividade: r.atividade,
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

module.exports = {IDS, ETAPAS, CORPO_HASH_016, CORPO_HASH_104, MARCADORES_104, MARCADORES_106, FUNCOES_NOVAS, VERIFICACOES, FLAG_CONFERIR, FLAG_APLICAR,
  FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_ATIVIDADE, sqlExecucao, lerEstado, exigirCatalogo, exigirSemAtividade, planoEtapas, commitNaFalha, semCommitFinal,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
