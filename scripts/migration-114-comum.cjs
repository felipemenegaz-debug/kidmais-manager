/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 114 (D-LIB-6, plano "liberar agenda com mais de um salão": os gatilhos da 019 passam a
// VERIFICAR a trava da configuração da agenda; sem ela, KD114) em staging (scripts/migration-114-staging.cjs fixa o alvo, a
// identidade da conexão e o disco). Mesmo desenho do aplicador da 117 (alvo travado, TLS, hash fixado do SQL com CRLF
// normalizado, marcador exclusivo no disco persistente, códigos 0/1/2/3), para UMA migration que só troca funções:
//   - a 114 cria kidmais114_exigir_configuracao(uuid) e recria kidmais019_lock_ocupacao() e kidmais_validar_agenda_revisao(),
//     sem tabela, índice ou dado. Não há DROP nem trava de tabela; lock_timeout 5 s e statement_timeout 60 s do próprio SQL;
//   - compatibilidade: a ordem é código ANTES da migration (a 114 reprova qualquer escritor sem a trava). O código que trava as
//     entradas (#331) está LIVE no web; o bloco confere o sha de lib/agenda/trava-configuracao.ts implantado;
//   - estado só pelo catálogo: a função nova, o hash do prosrc das 3 funções e os atributos que mudam o que elas fazem
//     (linguagem, SECURITY DEFINER, volatilidade, STRICT, retorno, configuração). Sem a função e corpos da cadeia 108/109 =
//     ausente; com a função, os 3 corpos e os 3 atributos da 114 = presente; qualquer outra combinação = divergente (recusa e
//     informa os 8 primeiros caracteres de cada hash). Só nome, tabela e função não bastam para os 6 gatilhos da 019: a
//     definição efetiva precisa bater (dispara em sessão normal, BEFORE/AFTER, ROW, INSERT e UPDATE, sem colunas, sem WHEN,
//     adiamento). Um gatilho em ENABLE REPLICA, só de INSERT ou com WHEN restritivo deixaria escrita sem verificação;
//   - EXECUTE para PUBLIC na função nova: exigência conservadora. Os gatilhos rodam como quem escreve e a aplicação não é
//     necessariamente quem aplica; concessões aos papéis escritores também bastariam, mas o aplicador não as enumera: recusa;
//   - aplicação: estado (READ ONLY) → migration SEM o COMMIT final (com o precheck e o postcheck do próprio SQL) → na MESMA
//     transação: estado de novo, prova de preservação e prova funcional → COMMIT só com tudo PASS → estado e prova funcional
//     de novo (READ ONLY);
//   - o que a prova de preservação detecta, nas 4 tabelas: INSERT, UPDATE e DELETE desta transação, inclusive em subtransação e
//     mesmo desfeitos (contadores pg_stat_get_xact_*), e TRUNCATE ou reescrita (relfilenode comparado com o de antes). Exige
//     track_counts ligado. Não detecta escrita de outra sessão, que não é efeito desta transação;
//   - o que a prova funcional detecta: sem a trava, com a trava de outra empresa ou de outra chave = KD114; com a trava da
//     empresa e com empresa nula = passa. Quem autentica o corpo é o hash; a prova confere que o catálogo real o executa.
//     O UUID é aleatório: colisão de hash com a trava de uma empresa real é remotíssima e, no pior caso, só espera (prazos);
//   - situação do COMMIT: falha no corpo ou nas verificações = NAO_COMMITADA (o COMMIT nunca foi enviado); falha NO COMMIT =
//     DESFEITA_PELO_SERVIDOR com SQLSTATE fora de 08/57/58/XX e diferente de 40003, senão INDETERMINADO (reconciliar pela
//     conferência); erro de transporte do Node = INDETERMINADO; COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, lock_timeout 5s e search_path = public, pg_catalog; a conferência não grava
//     no banco nem no disco. A prova funcional usa um UUID aleatório e a trava advisory morre com a transação.
// Nunca executa o down. Rollback (manual, autorização própria): database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql.
// Saída só com nomes de etapas, booleanos, a versão do servidor, o commit do Render, prefixos de hash e nomes de divergências.
// Nunca lê dado de festa.
// Privilégios, avaliados como current_user (no Render a credencial entra com `SET role`):
//   sempre: USAGE em public e SELECT nas 4 tabelas (prova de preservação);
//   114 ausente: DONO das 2 funções (CREATE OR REPLACE), CREATE em public (função nova) e USAGE em plpgsql;
//   114 presente: EXECUTE para PUBLIC na função nova.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const FLAG_CONFERIR = '--conferir-114';
const FLAG_APLICAR = '--aplicar-114-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-114.json';
const ARQUIVO = 'database/migrations/20261031_114_trava_configuracao_gatilhos.sql';
const HASH_ARQUIVO = 'caa25084c1c1f81c3fef49202eeddf049f69b86801e58a52b150cb2fe60f534f';
const ETAPAS = Object.freeze([['migration 114', ARQUIVO, HASH_ARQUIVO]]);
/** Hash do prosrc (CR removido) das 2 funções: os mesmos do precheck e do postcheck do SQL e do down. */
const CORPOS = Object.freeze({
  antes: Object.freeze({lock: 'eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880', revisao: '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24'}),
  depois: Object.freeze({lock: '2518c5bf7646946705955cd2875c09d432935d02f42a1d6f276e14f4b9c9dfd0', revisao: 'dcbfd2b296635249273d36a2593baf15eefb27fa9628523357df4b56476638a1'}),
});
/** Hash do prosrc da função nova: a 114 não o fixa no próprio postcheck; o aplicador fixa. */
const HASH_EXIGIR = '0f0f6a4a61700d49a31aa411f7ae2a28111fb91d82637e5f88a13edf464a6149';
const CONFIG = 'search_path=public, pg_catalog';
/** Depois da 114: linguagem:SECURITY DEFINER:volatilidade:STRICT:retorno:configuração. */
const ATRIBUTOS = Object.freeze({
  exigir: `plpgsql:false:s:false:void:${CONFIG}`,
  lock: `plpgsql:false:v:false:trigger:${CONFIG}`,
  revisao: 'plpgsql:false:v:false:trigger:',
});
const F_LOCK = 'kidmais019_lock_ocupacao()';
const F_REVISAO = 'kidmais_validar_agenda_revisao()';
const F_114 = 'kidmais114_exigir_configuracao(uuid)';
/** As 4 tabelas que os gatilhos protegem; a 114 nunca escreve nelas. */
const PRESERVADAS = Object.freeze(['fechamentos', 'contratos', 'contrato_fluxos', 'fechamento_revisoes']);
/** Os 6 gatilhos que chamam as 2 funções: [gatilho, tabela, função, tgtype, constraint trigger adiado]. tgtype: ROW 1, BEFORE 2, INSERT 4, UPDATE 16. */
const GATILHOS = Object.freeze([
  ['festa019_lock_fechamento', 'fechamentos', F_LOCK, 23, false],
  ['festa019_lock_contrato', 'contratos', F_LOCK, 23, false],
  ['festa019_lock_fluxo', 'contrato_fluxos', F_LOCK, 23, false],
  ['festa019_lock_revisao', 'fechamento_revisoes', F_LOCK, 23, false],
  ['fr_agenda_validar_trg', 'fechamento_revisoes', F_REVISAO, 21, true],
  ['fr_confirmacao_agenda_trg', 'fechamentos', F_REVISAO, 21, true],
]);
/** nome:dispara em sessão normal:tgtype:colunas:sem WHEN:DEFERRABLE:INITIALLY DEFERRED:constraint:argumentos. */
const GATILHOS_ESPERADOS = Object.freeze(GATILHOS.map(([g, , , tipo, adiado]) => `${g}:true:${tipo}::true:${adiado}:${adiado}:${adiado}:0`));
const fn = f => `to_regprocedure('public.${f}')`;
const hash = f => `(SELECT encode(sha256(convert_to(replace(prosrc,E'\\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid = ${fn(f)})`;
const dono = f => `coalesce((SELECT pg_has_role(current_user, proowner, 'USAGE') FROM pg_proc WHERE oid = ${fn(f)}), false)`;
const ler = t => `coalesce((SELECT has_table_privilege(current_user, oid, 'SELECT') FROM pg_class WHERE oid = to_regclass('public.${t}')), false)`;
const atributos = f => `(SELECT l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || p.proisstrict::text || ':' || format_type(p.prorettype, NULL) || ':' || coalesce(array_to_string(p.proconfig, ';'), '')
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = ${fn(f)})`;
const SQL_GATILHOS = `(SELECT coalesce(array_agg(concat_ws(':', x.tgname, (x.tgenabled IN ('O','A'))::text, x.tgtype::text, x.tgattr::text, (x.tgqual IS NULL)::text,
      x.tgdeferrable::text, x.tginitdeferred::text, (x.tgconstraint <> 0)::text, x.tgnargs::text) ORDER BY x.tgname), '{}'::text[])
    FROM (VALUES ${GATILHOS.map(([g, t, f]) => `('${g}','${t}','${f}')`).join(',')}) AS g(nome, tabela, funcao)
    JOIN pg_trigger x ON x.tgname = g.nome AND x.tgrelid = to_regclass('public.' || g.tabela)
      AND x.tgfoid = to_regprocedure('public.' || g.funcao) AND NOT x.tgisinternal)`;
/** Antes do estado: USAGE em public (sem ele, to_regclass('public.…') falha antes da recusa nominal). */
const SQL_USAGE_PUBLIC = "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public";
/** Estado (somente catálogo e privilégios, sem ler nenhuma tabela de dados). */
const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (SELECT count(*) FROM unnest(ARRAY[${PRESERVADAS.map(t => `'${t}'`).join(',')}]) t WHERE to_regclass('public.' || t) IS NOT NULL)::int AS tabelas,
  (${fn(F_114)} IS NOT NULL) AS f114,
  ${hash(F_LOCK)} AS hash_lock,
  ${hash(F_REVISAO)} AS hash_revisao,
  ${hash(F_114)} AS hash_exigir,
  ${atributos(F_LOCK)} AS atributos_lock,
  ${atributos(F_REVISAO)} AS atributos_revisao,
  ${atributos(F_114)} AS atributos_exigir,
  ${SQL_GATILHOS} AS gatilhos,
  ${dono(F_LOCK)} AS dono_lock,
  ${dono(F_REVISAO)} AS dono_revisao,
  coalesce(has_function_privilege('public', ${fn(F_114)}::oid, 'EXECUTE'), false) AS execute_publico,
  (${PRESERVADAS.map(ler).join(' AND ')}) AS ler_tabelas,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS plpgsql,
  (session_user <> current_user) AS papel_trocado,
  (current_setting('track_counts') = 'on') AS contagem_ligada`;
const BOOLEANOS = Object.freeze(['f114', 'dono_lock', 'dono_revisao', 'execute_publico', 'ler_tabelas', 'usar_public', 'pode_criar', 'plpgsql', 'papel_trocado', 'contagem_ligada']);
/**
 * Prova de preservação, das 4 tabelas: contadores da sessão (somam subtransações, mesmo desfeitas) e relfilenode. Lida antes do corpo
 * (READ ONLY) e DENTRO da transação da migration. O contador também guarda o que transações anteriores desta sessão ainda não
 * enviaram às estatísticas, e esse acumulado pode ser enviado (zerado) ao fim de qualquer transação: comparar diferenças entre
 * transações não é seguro em geral. Por isso a leitura de antes precisa dar ZERO nas 4 tabelas: a prova só vale em sessão sem escrita
 * anterior nelas, como a conexão nova deste aplicador. Contador só vale com track_counts.
 */
const SQL_PRESERVACAO = `/* preservacao-114 */ SELECT c.relname::text AS tabela, c.relfilenode::text AS arquivo,
  (pg_stat_get_xact_tuples_inserted(c.oid) + pg_stat_get_xact_tuples_updated(c.oid) + pg_stat_get_xact_tuples_deleted(c.oid))::int AS escritas
  FROM pg_class c WHERE c.oid IN (${PRESERVADAS.map(t => `to_regclass('public.${t}')`).join(', ')}) ORDER BY c.relname`;
const SQL_EXIGIR = 'SELECT public.kidmais114_exigir_configuracao($1::uuid)';
const SQL_TRAVAR = "SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))";
const SQL_TRAVAR_OUTRA_CHAVE = "SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:prova-114:' || $1::text, 0))";
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);
const prefixo = h => (typeof h === 'string' ? h.slice(0, 8) : 'ausente');
/** Commit que o Render diz estar implantado (informativo): só SHA; a comparação com o esperado é de quem lê a saída. */
const commitImplantado = env => (/^[0-9a-f]{7,40}$/.test(env?.RENDER_GIT_COMMIT ?? '') ? env.RENDER_GIT_COMMIT : null);

/** Estado lido: ausente | presente | divergente (qualquer outra combinação da função nova e dos 2 corpos). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  assert.ok(Number.isInteger(e?.versao_pg) && e.versao_pg >= 0, 'ESTADO_ILEGIVEL versao_pg');
  assert.ok(Number.isInteger(e?.tabelas) && e.tabelas >= 0 && e.tabelas <= PRESERVADAS.length, 'ESTADO_ILEGIVEL tabelas');
  for (const k of ['hash_lock', 'hash_revisao', 'hash_exigir']) assert.ok(e[k] === null || (typeof e[k] === 'string' && /^[0-9a-f]{64}$/.test(e[k])), 'ESTADO_ILEGIVEL ' + k);
  for (const k of ['atributos_lock', 'atributos_revisao', 'atributos_exigir']) assert.ok(e[k] === null || typeof e[k] === 'string', 'ESTADO_ILEGIVEL ' + k);
  assert.ok(Array.isArray(e?.gatilhos) && e.gatilhos.every(x => typeof x === 'string'), 'ESTADO_ILEGIVEL gatilhos');
  const s = Object.fromEntries(BOOLEANOS.map(k => [k, e[k]]));
  s.versao_pg = e.versao_pg; s.tabelas = e.tabelas;
  s.corpos = {lock: prefixo(e.hash_lock), revisao: prefixo(e.hash_revisao), exigir: prefixo(e.hash_exigir)};
  s.gatilhosDivergentes = GATILHOS_ESPERADOS.filter(g => !e.gatilhos.includes(g)).map(g => g.split(':')[0]);
  const iguais = c => e.hash_lock === c.lock && e.hash_revisao === c.revisao;
  s.atributosDivergentes = !e.f114 ? [] : ['lock', 'revisao', 'exigir'].filter(k => e['atributos_' + k] !== ATRIBUTOS[k]);
  s.m114 = !e.f114 && iguais(CORPOS.antes) ? 'ausente'
    : e.f114 && iguais(CORPOS.depois) && e.hash_exigir === HASH_EXIGIR && s.atributosDivergentes.length === 0 ? 'presente' : 'divergente';
  return s;
}

/** Guardas antes de qualquer escrita: tabelas, leitura, corpos conhecidos, gatilhos e privilégios de cada caso. */
function exigirCatalogo(s) {
  assert.equal(s.tabelas, PRESERVADAS.length, 'TABELA_AUSENTE ' + s.tabelas + '/' + PRESERVADAS.length);
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.ler_tabelas && 'SELECT_TABELAS'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  assert.notEqual(s.m114, 'divergente', `CORPOS_DIVERGENTES_114 f114=${s.f114} lock=${s.corpos.lock} revisao=${s.corpos.revisao} exigir=${s.corpos.exigir} atributos=${s.atributosDivergentes.join(',')}`);
  assert.ok(s.gatilhosDivergentes.length === 0, 'GATILHO_DIVERGENTE_114 ' + s.gatilhosDivergentes.join(' '));
  if (s.m114 === 'ausente') {
    const falta = [!s.dono_lock && 'DONO_LOCK', !s.dono_revisao && 'DONO_REVISAO', !s.pode_criar && 'CREATE', !s.plpgsql && 'LINGUAGEM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_114 ' + falta.join(' '));
    assert.ok(s.contagem_ligada, 'CONTAGEM_DESLIGADA_114 track_counts');
  } else assert.ok(s.execute_publico, 'EXECUTE_RESTRITO_114');
}

/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  exigirCatalogo(s);
  return s.m114 === 'presente' ? [] : ['migration 114'];
}

/**
 * Situação do COMMIT quando o PRÓPRIO COMMIT falha (regra da 117). SQLSTATE só de RESPOSTA do servidor (erro do pg: severity
 * presente, sem syscall/errno): erro de transporte do Node com código de 5 letras (EPIPE) não é SQLSTATE e fica INDETERMINADO.
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

/** Roda `f` numa transação READ ONLY com os prazos do aplicador; sempre termina em ROLLBACK. */
async function emLeitura(db, f) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await f();
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
const somenteLeitura = (db, sql) => emLeitura(db, () => db.query(sql));

/**
 * Prova funcional, dentro da transação aberta por quem chama (as travas advisory morrem com ela; ROLLBACK TO solta as tomadas depois
 * do savepoint): UUID aleatório sem a trava, com a trava de outra empresa ou de outra chave = KD114; com a trava compartilhada
 * da empresa = passa; empresa nula (fechamento legado) = passa.
 */
async function provaFuncional(db, uuid = randomUUID()) {
  await db.query('SAVEPOINT prova_114');
  const recusa = async (caso, preparar) => {
    let codigo = 'SEM_ERRO';
    if (preparar) await preparar();
    try { await db.query(SQL_EXIGIR, [uuid]); } catch (e) { codigo = e?.code ?? 'ERRO_SEM_CODIGO'; }
    await db.query('ROLLBACK TO SAVEPOINT prova_114');
    assert.equal(codigo, 'KD114', `PROVA_FUNCIONAL_114 ${caso}: ${codigo}`);
  };
  await recusa('sem a trava');
  await recusa('trava de outra empresa', () => db.query(SQL_TRAVAR, [randomUUID()]));
  await recusa('trava de outra chave', () => db.query(SQL_TRAVAR_OUTRA_CHAVE, [uuid]));
  await db.query(SQL_TRAVAR, [uuid]);
  await db.query(SQL_EXIGIR, [uuid]);
  await db.query(SQL_EXIGIR, [null]);
  await db.query('RELEASE SAVEPOINT prova_114');
}

/** Preservação: leitura de antes com contador zero; na transação, as 4 tabelas com contador zero e o mesmo relfilenode de antes do corpo. */
function exigirPreservacao(linhas, antes) {
  const porTabela = new Map((linhas ?? []).map(l => [l.tabela, l]));
  const anterior = new Map((antes ?? []).map(l => [l.tabela, l]));
  const ruins = PRESERVADAS.flatMap(t => {
    const l = porTabela.get(t);
    if (!l) return [t + '=AUSENTE'];
    const a = anterior.get(t);
    return [a?.escritas !== 0 && t + '=ACUMULADO_ANTERIOR', l.escritas !== 0 && `${t}=${l.escritas}`, (!l.arquivo || l.arquivo !== a?.arquivo) && t + '=ARQUIVO_TROCADO'].filter(Boolean);
  });
  assert.ok(ruins.length === 0, 'PRESERVACAO_114 ' + ruins.join(' '));
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

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, guardas, plano e, com a 114, a prova funcional. */
async function conferirNoCliente(db, {sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  try {
    r.estado = await estadoAtual(db, {guardar: false});
    r.plano = planoEtapas(r.estado);
  } catch (e) {
    if (!/^(SEM_PRIVILEGIO|TABELA_AUSENTE|CORPOS_DIVERGENTES|GATILHO_DIVERGENTE|EXECUTE_RESTRITO|CONTAGEM_DESLIGADA)/.test(e?.message ?? '')) throw e;
    r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r;
  }
  if (r.estado.m114 === 'ausente') { r.resultado = 'PRONTA_PARA_APLICAR'; return r; }
  try { await emLeitura(db, () => provaFuncional(db)); r.provaFuncional = 'PASS'; }
  catch (e) { r.provaFuncional = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = 'JA_APLICADA_POSTCHECK_PASS';
  return r;
}

/**
 * Migration sem o COMMIT final; estado, preservação e prova funcional dentro da transação; COMMIT só com tudo PASS. Registra a
 * situação do COMMIT (NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO) antes de qualquer outra leitura.
 */
async function migrarComVerificacao(db, sql, passo, registrar) {
  let fase = 'corpo';
  try {
    const antes = (await somenteLeitura(db, SQL_PRESERVACAO)).rows;
    exigirPreservacao(antes, antes); // sessão com acumulado anterior recusa antes de enviar o corpo
    await db.query(semCommitFinal(sql, 'migration 114'));
    fase = 'verificacao';
    passo.antesDoCommit = {};
    const s = lerEstado((await db.query(SQL_ESTADO)).rows[0]);
    assert.equal(s.m114, 'presente', 'ESTADO_NA_TRANSACAO_114 ' + s.m114);
    exigirCatalogo(s);
    passo.antesDoCommit.estado = 'PASS';
    exigirPreservacao((await db.query(SQL_PRESERVACAO)).rows, antes);
    passo.antesDoCommit.preservacao = 'PASS';
    await provaFuncional(db);
    passo.antesDoCommit.provaFuncional = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_114'); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/** Aplicação: estado relido aqui, imediatamente antes → migration com as provas → COMMIT → estado e prova (READ ONLY). */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sql = lerRevisado(raiz, ARQUIVO, HASH_ARQUIVO);
  semCommitFinal(sql, 'migration 114');
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.plano = planoEtapas(r.estadoAntes);
  registrar(r);
  for (const nome of r.plano) {
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    await migrarComVerificacao(db, sql, passo, () => registrar(r));
    assert.equal((await estadoAtual(db, {guardar: false})).m114, 'presente', 'ESTADO_DEPOIS_114');
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.equal(r.estadoDepois.m114, 'presente', 'ESTADO_FINAL_114');
  exigirCatalogo(r.estadoDepois);
  await emLeitura(db, () => provaFuncional(db));
  r.provaFuncionalDepois = 'PASS';
  r.resultado = r.plano.length ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => ['114', x.commit]));
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
      arquivos: ETAPAS.map(([nome, arquivo, h]) => { lerRevisado(raiz, arquivo, h); return {nome, arquivo, sha256: h}; }),
      provaNoAlvo: 'estado, preservação (INSERT, UPDATE e DELETE desta transação, inclusive em subtransação, e TRUNCATE ou reescrita nas 4 tabelas) e prova funcional (sem a trava, com a de outra empresa ou de outra chave = KD114; com a trava e com empresa nula = passa) DENTRO da transação da 114, antes do COMMIT; depois, estado e prova funcional em READ ONLY',
      prazos: 'lock_timeout 5 s e statement_timeout 60 s do próprio SQL (SET LOCAL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['114: função nova ausente e corpos das 2 funções iguais aos da cadeia 108/109 (outra forma recusa e informa os prefixos de hash)',
        'os 6 gatilhos da 019 com a definição efetiva esperada: disparam em sessão normal, eventos, BEFORE/AFTER, ROW, sem colunas, sem WHEN e adiamento',
        'track_counts ligado',
        'current_user DONO das 2 funções, com CREATE e USAGE em public, USAGE em plpgsql e SELECT nas 4 tabelas',
        'código que trava as entradas (#331) LIVE no web: conferir no Render e pelo commitImplantado da saída; o sha de lib/agenda/trava-configuracao.ts sozinho não prova os chamadores',
        'crons e worker de staging: serviço, commit implantado e caminhos de escrita levantados ANTES da 114 (evidência anexa ao plano)'],
      ordem: ['conferir no Render o commit do web (com este aplicador) e os hashes implantados', FLAG_CONFERIR,
        'ponto de recuperação do PostgreSQL deste ambiente comprovado (PITR disponível, cobrindo o horário da aplicação) e registrado (referência e horário, anterior à aplicação)',
        'autorização de Felipe para a 114 neste ambiente',
        `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'conferência funcional logada: salvar e editar uma festa de teste em staging; logs do web e do worker sem KD114',
        'só depois, com autorização própria: AGENDA_MAIS_DE_UM_SALAO'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'marcador incompleto ou ilegível, processo interrompido (sem saída final) ou conferência RECUSARIA depois de CONFIRMADO: parar, preservar saída e marcador, reconciliar e só então decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-114.<horario>.json'],
      recuperacao: ['KD114 nos logs depois de aplicar: database/rollback/20261031_114_trava_configuracao_gatilhos_down.sql com autorização própria (devolve os corpos da cadeia 108/109; recusa se os corpos não forem os da 114)',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 114', 'alteração de env', 'deploy', 'restart', 'ligar AGENDA_MAIS_DE_UM_SALAO', 'escrita nas 4 tabelas']};
  }
  async function conferir({env, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return {...await conferirNoCliente(db, {sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}), commitImplantado: commitImplantado(env)}; }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e), commitImplantado: commitImplantado(env)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    lerRevisado(raiz, ARQUIVO, HASH_ARQUIVO);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-114\..+\.json$/.test(n)).sort();
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
      return {resultado: r.resultado, marcador, commitImplantado: commitImplantado(env), conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        provaFuncionalDepois: r.provaFuncionalDepois, etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
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

module.exports = {ETAPAS, ARQUIVO, CORPOS, HASH_EXIGIR, ATRIBUTOS, PRESERVADAS, GATILHOS, GATILHOS_ESPERADOS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_PRESERVACAO, SQL_USAGE_PUBLIC,
  SQL_EXIGIR, SQL_TRAVAR, SQL_TRAVAR_OUTRA_CHAVE, exigirPreservacao, lerEstado, exigirCatalogo, planoEtapas, commitNaFalha, semCommitFinal, provaFuncional, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
