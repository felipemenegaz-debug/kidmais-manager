/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 107 (reparo da deriva da agenda) e da 108 (salões combinados) — staging
// (scripts/migration-107-108-staging.cjs fixa o alvo, a identidade da conexão e o disco). Plano "E4 aplicadores 107 108
// staging 20261029", rev. 2 + critérios da rev. 2.1, decisões D-E1..D-E4 de Felipe (29/10/2026). Mesmo mecanismo do
// 104/106 (scripts/migration-104-106-comum.cjs): alvo travado, TLS, hash fixado de cada arquivo (LF, com linha final),
// marcador exclusivo no disco persistente, códigos 0/1/2/3. O que muda (D-E1: UM aplicador, DUAS transações):
//   - estados: 107 = ausente | aplicada (registro kidmais107_reparos + integridade da 107 por DEFINIÇÃO) | divergente
//     (registro presente e integridade falha); 108 = AUSENTE | NOVA | ANTIGA | PARCIAL, a mesma classificação de
//     lib/agenda/estado-combinados.ts (espelhada em SQL_ESTADO; o teste confere as constantes);
//   - fases (P2-E4-1), com expectativas DISTINTAS e nunca o retrato encontrado no alvo como referência (D-E2):
//       F0 (pré-107): sqlAvaliacao107() objeto a objeto (CANONICO/DERIVA/AUSENTE_CRIAVEL; qualquer RECUSA:* recusa) +
//          precheck da 107 + o precheck da 108 na forma "fase pré-107" (sem a exigência de kidmais107_reparos, só ela;
//          database/checks/20261029_108_precheck_pre107.sql, gerado por precheckPre107()) + retrato F0;
//       F1 (pós-107/pré-108): sqlIntegridade107() + precheck da 108 + retrato F1;
//       F2 (pós-108): sqlIntegridade107() + sqlProva108Integra() (detector NOVA + marcador + metadados + retrato F2);
//     esperados de database/checks/20261029_108_retratos_esperados.json; A_MEDIR_NO_CLUSTER = RETRATO_NAO_MEDIDO (o
//     CONFERIR recusa com código 3 depois de medir e mostrar o hash; o APLICAR recusa ANTES de conectar, código 1);
//   - transação 1 (só com a 107 ausente) e transação 2 (só com a 108 AUSENTE), cada uma: BEGIN → orçamento (SET LOCAL) →
//     LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE na ORDEM FIXA abaixo → REVALIDAÇÃO da fase na própria transação (F0 na 1,
//     F1 na 2) → migration sem BEGIN/COMMIT → verificações (1: integridade da 107; 2: postcheck da 108 + prova "108
//     íntegra" + EXECUTE das 14 funções) → COMMIT. A 108 só começa com a 107 CONFIRMADA e íntegra (F1 relida em READ ONLY);
//   - ORDEM DOS LOCKS (fixa, alfabética dentro de cada transação; nenhuma das duas trava as tabelas da outra):
//       transação 1: public.bloqueios_agenda → public.configuracao_agenda;
//       transação 2: public.agenda_saloes → public.contratos;
//     SHARE ROW EXCLUSIVE conflita com qualquer escrita e com outro SHARE ROW EXCLUSIVE; a migration sobe para ACCESS
//     EXCLUSIVE (ALTER TABLE/CREATE TRIGGER) e segura até o COMMIT, inclusive durante as verificações;
//   - ORÇAMENTO (SET LOCAL em cada transação e em cada leitura): lock_timeout 5s (cada espera de lock; recusa 55P03 em vez
//     de fila), statement_timeout 120s (cada instrução; a migration põe 60s para as dela e o aplicador volta a 120s nas
//     verificações), idle_in_transaction_session_timeout 60s (cliente parado com lock = o servidor encerra a sessão e
//     desfaz). Pior caso teórico por transação ≈ 8 instruções × 120s; o esperado na janela drenada é de segundos;
//   - COMMIT classificado como no 104/106: NAO_COMMITADA (COMMIT nunca enviado) | CONFIRMADO | DESFEITA_PELO_SERVIDOR
//     (respondido como ROLLBACK, ou SQLSTATE fora de 08/57/58/XX e diferente de 40003) | INDETERMINADO (40003, 08/57/58/XX
//     ou sem SQLSTATE). INDETERMINADO exige reconciliação pelo CONFERIR; nunca há reaplicação automática;
//   - marcadores: um da execução (migration-107-108.json, exclusivo) e um POR ETAPA (migration-107-108.etapa-107.json /
//     .etapa-108.json, exclusivos, criados antes do BEGIN da transação): etapa já tentada recusa até ser revisada e o
//     marcador renomeado (nunca apagado). Retomada = com a 107 aplicada e íntegra, só a 108;
//   - drenagem (D-E4): o APLICAR exige `--drenagem "<registro>"` (web em manutenção ou escala zero, cron suspenso, sem
//     outros escritores nem DDL durante as DUAS transações); a contagem de sessões do banco é evidência pontual, não prova;
//   - toda leitura: BEGIN TRANSACTION READ ONLY, com search_path conforme a consulta (public, pg_catalog para os checks
//     .sql; pg_catalog para os construtores de catálogo e o retrato).
// Privilégios (E4-4; P3-E4-R2-2: condicionados ao estado), sempre de current_user (no Render a credencial entra com
// `SET role`), cada um por has_*_privilege (ser dono não basta depois de um REVOKE):
//   leitura (sempre): USAGE em public e plpgsql; SELECT em agenda_saloes, contratos, contrato_fluxos, fechamentos,
//     fechamento_revisoes, agenda_escopo_config, configuracao_agenda, bloqueios_agenda; SELECT em kidmais107_reparos só se
//     existir; EXECUTE em kidmais094_ocupacoes(date,date) só com a 108 pendente (o precheck a chama);
//   escrita 107 (só com a 107 ausente): dono de bloqueios_agenda e configuracao_agenda, CREATE em public, TEMP, TRIGGER e
//     LOCK (UPDATE/DELETE/TRUNCATE/MAINTAIN) nas duas, EXECUTE em kidmais_set_atualizado_em();
//   escrita 108 (só com a 108 AUSENTE): dono de agenda_saloes, contratos e das 3 funções substituídas, CREATE em public,
//     TRIGGER e LOCK nas duas tabelas, USAGE em sql; antes do COMMIT, EXECUTE nas 14 funções da 108;
//   alguma pendente: superusuário ou pg_read_all_stats (atividade de outras sessões visível).
// Nunca executa os down, env, deploy, restart nem liga SALOES_PUBLICOS. Saída só com rótulos, booleanos, contagens,
// versão do servidor e hashes (sem ids, dados ou URL do banco).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const def107 = require('./migration-107-definicoes.cjs');
const ret108 = require('./migration-108-retrato.cjs');

const FLAG_CONFERIR = '--conferir-107-108';
const FLAG_APLICAR = '--aplicar-107-108-autorizado';
const FLAG_BACKUP = '--backup';
const FLAG_DRENAGEM = '--drenagem';
/** Esperados do retrato SÓ para a suíte PostgreSQL (mede no cluster e injeta). O aplicador de staging recusa. */
const ENV_RETRATOS_TESTE = 'KIDMAIS_RETRATOS_108_TESTE';
const MARCADOR = 'migration-107-108.json';
const marcadorEtapa = id => `migration-107-108.etapa-${id}.json`;
const IDS = Object.freeze(['107', '108']);
const REGISTRO_SEGURO = /^[A-Za-z0-9:._/ -]{6,120}$/;

/** Arquivos usados, fixados por sha256 do texto LF (o arquivo precisa terminar em linha nova). */
const ARQUIVOS = Object.freeze([
  ['precheck 107', 'database/checks/20261028_107_precheck.sql', '3de285f810b20e89f8ebe10912ee6fda3a08f42ee01d0a244500ecb0dfc6459d'],
  ['migration 107', 'database/migrations/20261028_107_reparo_deriva_agenda.sql', '01431b70317be6762d14bc0bfad8ca6780024dee5ab220e74acb9100410a251e'],
  ['integridade 107', 'database/checks/20261029_107_integridade.sql', '6a9f8580505112aca2c6148cdd9aa2a936d19fd356e408f980c43629c3393ed4'],
  ['precheck 108 pre-107', 'database/checks/20261029_108_precheck_pre107.sql', '8029cd9734451ab71a7b51b44b6bc8bfe62d752cb60ed208dff73fbba221faa9'],
  ['precheck 108', 'database/checks/20261028_108_precheck.sql', 'ff3e0ee413f07cc0b5ca2b6fed7fcd340e1770b831670a4ea6340dbc7b728574'],
  ['migration 108', 'database/migrations/20261028_108_saloes_combinados.sql', 'eaeca1d9ff31086e049b40e6f0f754141450e9c5f825b140dc57c78b0f89fd92'],
  ['postcheck 108', 'database/checks/20261028_108_postcheck.sql', '13c14280812a5c29d15b4aa84cac7ed332d0814bbc100a29f51677e2cba3eae3'],
  ['retrato 108', 'database/checks/20261029_108_retrato.sql', '1f667111edc8e2d061df974b834e9f12bbdb8fab1c10cbebce7e272195610ef3'],
  ['retratos esperados 108', 'database/checks/20261029_108_retratos_esperados.json', ret108.HASH_ESPERADOS],
]);
/** Downs: NUNCA executados pelo aplicador; fixados para o plano e para o bloco (recuperação documentada, 108 antes da 107). */
const RECUPERACAO = Object.freeze([
  ['down 108', 'database/rollback/20261028_108_saloes_combinados_down.sql', '70c337994193b6f24f6e4b014330f84c54bb29be6b856ad7f366c631ce3164e9'],
  ['down 107', 'database/rollback/20261028_107_reparo_deriva_agenda_down.sql', 'f0d72565436c65144bc5dadfcc6df61e6b8a8d24ac682b2944d1ec6577d1691a'],
]);
const arquivo = nome => ARQUIVOS.find(e => e[0] === nome);

/** Leitura revisada: LF, linha final obrigatória e o sha256 fixado. */
function lerRevisado(raiz, relativo, hash, fsx = fs) {
  const texto = fsx.readFileSync(path.join(raiz, relativo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(texto.endsWith('\n'), 'SEM_LINHA_FINAL ' + relativo);
  assert.equal(createHash('sha256').update(texto, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + relativo);
  return texto;
}

// ---- Precheck da 108 na fase pré-107 (E4-1 F0): o original MENOS a exigência de kidmais107_reparos. ----
const CLAUSULA_107 = "\n    OR to_regclass('public.kidmais107_reparos') IS NULL THEN";
const CABECALHO_PRE107 = `-- Fase pré-107 (plano E4, E4-1 F0): o precheck da 108 SEM a exigência de kidmais107_reparos (só ela sai), para conferir
-- as demais dependências da 108 antes de a 107 existir. GERADO por precheckPre107() (scripts/migration-107-108-comum.cjs)
-- a partir de database/checks/20261028_108_precheck.sql; o teste confere que é o original menos essa cláusula.
`;
/** Gera o texto do precheck pré-107 a partir do precheck da 108 (a cláusula precisa aparecer exatamente uma vez). */
function precheckPre107(original) {
  assert.equal(original.split(CLAUSULA_107).length, 2, 'PRECHECK_108_SEM_CLAUSULA_107');
  return CABECALHO_PRE107 + original.replace(CLAUSULA_107, ' THEN');
}

/** Migration sem a moldura: exatamente um `BEGIN;` e um `COMMIT;` final; o aplicador abre e fecha a transação. */
function semMoldura(sql, nome) {
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.ok(sql.endsWith('\nCOMMIT;\n'), 'TRANSACAO_INESPERADA ' + nome);
  return sql.slice(0, -'COMMIT;\n'.length).replace(/^BEGIN;\n/m, '');
}

// ---- Orçamento e locks (ver cabeçalho). ----
const ORCAMENTO = Object.freeze({lock_timeout: '5s', statement_timeout: '120s', idle_in_transaction_session_timeout: '60s'});
const TABELAS_LOCK = Object.freeze({'107': Object.freeze(['bloqueios_agenda', 'configuracao_agenda']), '108': Object.freeze(['agenda_saloes', 'contratos'])});
const SQL_LOCK = Object.freeze(Object.fromEntries(IDS.map(id => [id,
  `LOCK TABLE ${TABELAS_LOCK[id].map(t => 'public.' + t).join(', ')} IN SHARE ROW EXCLUSIVE MODE`])));
const CAMINHO_CHECKS = 'public, pg_catalog';
const CAMINHO_CATALOGO = 'pg_catalog';

// ---- Catálogo e privilégios: um SELECT, sem ::regclass de objeto que pode faltar. ----
const reg = t => `to_regclass('public.${t}')`;
const proc = f => `to_regprocedure('public.${f}')`;
const tabela = (t, privilegio) => `coalesce((SELECT has_table_privilege(current_user, oid, '${privilegio}') FROM pg_class WHERE oid = ${reg(t)}), false)`;
const dono = t => `coalesce((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = ${reg(t)}), false)`;
const donoFuncao = f => `coalesce((SELECT pg_has_role(current_user, proowner, 'USAGE') FROM pg_proc WHERE oid = ${proc(f)}), false)`;
const executa = f => `coalesce(has_function_privilege(current_user, ${proc(f)}, 'EXECUTE'), false)`;
const linguagem = l => `coalesce(has_language_privilege(current_user, '${l}', 'USAGE'), false)`;
const existeColuna = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ${reg(t)} AND attname = '${c}' AND NOT attisdropped)`;
const travar = t => `(${['UPDATE', 'DELETE', 'TRUNCATE'].map(p => tabela(t, p)).join(' OR ')}
    OR CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ${tabela(t, 'MAINTAIN')} ELSE false END)`;
const corpoHash = f => `(SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = ${proc(f)})`;
const SET_ATUALIZADO = 'kidmais_set_atualizado_em()';
const OCUPACOES = 'kidmais094_ocupacoes(date,date)';
const CONFLITO = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';
const SUBSTITUIDAS_108 = Object.freeze([CONFLITO, 'kidmais019_validar_contrato()', 'kidmais_validar_agenda_revisao()']);
/** Corpo da regra de conflito da 098 HISTÓRICA (lib/agenda/estado-combinados.ts, HASHES_COMBINADOS.conflito098). */
const CONFLITO_098 = 'a3b9bcb198adbe4cd0595c56a5def99aff8463f96f0c192554f42099029ca05a';
const TABELAS_LEITURA = Object.freeze(['agenda_saloes', 'contratos', 'contrato_fluxos', 'fechamentos', 'fechamento_revisoes', 'agenda_escopo_config',
  'configuracao_agenda', 'bloqueios_agenda']);
const colunaLer = t => 'ler_' + t;

const SQL_ESTADO = `SELECT
  current_setting('server_version_num')::int AS versao_pg,
  (${reg('bloqueios_agenda')} IS NOT NULL AND ${reg('configuracao_agenda')} IS NOT NULL AND ${proc(SET_ATUALIZADO)} IS NOT NULL) AS base107,
  (${reg('kidmais107_reparos')} IS NOT NULL) AS registro107,
  (${['agenda_saloes', 'contratos', 'contrato_fluxos', 'fechamentos', 'fechamento_revisoes', 'agenda_escopo_config', 'agenda_salao_fotos'].map(t => `${reg(t)} IS NOT NULL`).join(' AND ')}
    AND ${proc(OCUPACOES)} IS NOT NULL AND ${proc(CONFLITO)} IS NOT NULL AND ${proc('kidmais102_salao_conteudo()')} IS NOT NULL
    AND ${existeColuna('fechamento_revisoes', 'hash_versao')} AND ${existeColuna('fechamentos', 'salao_preferido_id')}) AS d108,
  (SELECT count(*)::int FROM (VALUES ${Object.entries(ret108.NOVA.funcoes).map(([n, h]) => `('${n}', '${h}')`).join(', ')}) AS e(nome, h)
    JOIN pg_proc p ON p.proname = e.nome AND p.pronamespace = 'public'::regnamespace
    WHERE encode(sha256(convert_to(replace(p.prosrc, E'\\r', ''), 'UTF8')), 'hex') = e.h) AS c_funcoes,
  (SELECT count(DISTINCT p.proname)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'kidmais098\\_%') AS c_funcoes_qualquer,
  ${existeColuna('agenda_saloes', 'combinado')} AS c_combinado,
  ${existeColuna('agenda_saloes', 'membros')} AS c_membros,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${reg('agenda_saloes')} AND conname = 'agenda_saloes_098_membros_check'
    AND contype = 'c' AND convalidated AND NOT connoinherit
    AND regexp_replace(replace(pg_get_constraintdef(oid), 'public.', ''), '[\\s()]', '', 'g') = '${ret108.NOVA.checkMembros}') AS c_check,
  (SELECT count(*)::int FROM (VALUES ${ret108.NOVA.gatilhos.map(([n, t, f, tipo, dif, col]) => `('${n}', '${t}', '${f}', ${tipo}, ${dif}, ${col ? `'${col}'` : 'NULL::text'})`).join(', ')})
      AS g(nome, tabela, funcao, tipo, diferido, coluna)
    WHERE EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                   WHERE t.tgname = g.nome AND t.tgrelid = to_regclass('public.' || g.tabela) AND NOT t.tgisinternal
                     AND t.tgenabled = 'O' AND p.proname = g.funcao AND p.pronamespace = 'public'::regnamespace
                     AND t.tgtype = g.tipo AND t.tgdeferrable = g.diferido AND t.tginitdeferred = g.diferido
                     AND t.tgnargs = 0 AND t.tgqual IS NULL
                     AND array_to_string(t.tgattr::int2[], ',') = coalesce((SELECT a.attnum::text FROM pg_attribute a
                           WHERE a.attrelid = t.tgrelid AND a.attname = g.coluna AND NOT a.attisdropped), ''))) AS c_gatilhos,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_098\\_%') AS c_gatilhos_qualquer,
  ${corpoHash(CONFLITO)} AS c_conflito,
  ${corpoHash('kidmais019_validar_contrato()')} AS c_contrato,
  ${corpoHash('kidmais_validar_agenda_revisao()')} AS c_revisao,
  (${proc('kidmais108_instalada()')} IS NOT NULL) AS c_marcador,
  has_schema_privilege(current_user, 'public', 'USAGE') AS usar_public,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  has_database_privilege(current_user, current_database(), 'TEMP') AS temp,
  ${linguagem('plpgsql')} AS plpgsql,
  ${linguagem('sql')} AS linguagem_sql,
  ${TABELAS_LEITURA.map(t => `${tabela(t, 'SELECT')} AS ${colunaLer(t)}`).join(',\n  ')},
  ${tabela('kidmais107_reparos', 'SELECT')} AS ler_reparos,
  ${executa(OCUPACOES)} AS executar_ocupacoes,
  ${dono('bloqueios_agenda')} AS dono_bloqueios,
  ${dono('configuracao_agenda')} AS dono_config_agenda,
  ${tabela('bloqueios_agenda', 'TRIGGER')} AS gatilho_bloqueios,
  ${tabela('configuracao_agenda', 'TRIGGER')} AS gatilho_config_agenda,
  ${travar('bloqueios_agenda')} AS travar_bloqueios,
  ${travar('configuracao_agenda')} AS travar_config_agenda,
  ${executa(SET_ATUALIZADO)} AS executar_set_atualizado,
  ${dono('agenda_saloes')} AS dono_saloes,
  ${dono('contratos')} AS dono_contratos,
  (${SUBSTITUIDAS_108.map(donoFuncao).join(' AND ')}) AS dono_funcoes_108,
  ${tabela('agenda_saloes', 'TRIGGER')} AS gatilho_saloes,
  ${tabela('contratos', 'TRIGGER')} AS gatilho_contratos,
  ${travar('agenda_saloes')} AS travar_saloes,
  ${travar('contratos')} AS travar_contratos,
  (coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')) AS ver_atividade,
  (session_user <> current_user) AS papel_trocado`;

/** Tabelas da verificação de atividade (P2-C1 do 104/106: lock com pid NULL = transação preparada conta como sem contexto). */
const TABELAS_ATIVIDADE = Object.freeze(['agenda_saloes', 'contratos', 'fechamentos', 'fechamento_revisoes', 'bloqueios_agenda', 'configuracao_agenda']);
const SQL_ATIVIDADE = `SELECT count(*)::int AS locks, count(DISTINCT l.pid)::int AS sessoes,
  count(DISTINCT l.pid) FILTER (WHERE a.xact_start IS NOT NULL)::int AS sessoes_em_transacao,
  count(*) FILTER (WHERE l.pid IS NULL)::int AS locks_sem_pid,
  (count(DISTINCT l.pid) FILTER (WHERE l.pid IS NOT NULL AND (a.pid IS NULL OR a.state IS NULL)) + count(*) FILTER (WHERE l.pid IS NULL))::int AS sem_contexto
  FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.relation IN (${TABELAS_ATIVIDADE.map(reg).join(', ')}) AND l.pid IS DISTINCT FROM pg_backend_pid()`;
/** Sessões de cliente no banco (D-E4): EVIDÊNCIA pontual da drenagem, registrada; não é prova de drenagem contínua. */
const SQL_SESSOES = `SELECT count(*)::int AS outras, count(*) FILTER (WHERE state IS DISTINCT FROM 'idle')::int AS nao_ociosas,
  count(*) FILTER (WHERE xact_start IS NOT NULL)::int AS em_transacao
  FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`;
/** EXECUTE das 14 funções da 108 por current_user, DENTRO da transação 2, antes do COMMIT. */
const SQL_EXECUCAO_108 = `SELECT ${ret108.METADADOS_108.map(([f]) => executa(f)).join('\n  AND ')} AS executa_108`;

const BOOLEANOS = Object.freeze(['base107', 'registro107', 'd108', 'c_combinado', 'c_membros', 'c_check', 'c_marcador', 'usar_public', 'pode_criar', 'temp',
  'plpgsql', 'linguagem_sql', ...TABELAS_LEITURA.map(colunaLer), 'ler_reparos', 'executar_ocupacoes', 'dono_bloqueios', 'dono_config_agenda', 'gatilho_bloqueios',
  'gatilho_config_agenda', 'travar_bloqueios', 'travar_config_agenda', 'executar_set_atualizado', 'dono_saloes', 'dono_contratos', 'dono_funcoes_108',
  'gatilho_saloes', 'gatilho_contratos', 'travar_saloes', 'travar_contratos', 'ver_atividade', 'papel_trocado']);
const CONTADORES = Object.freeze(['c_funcoes', 'c_funcoes_qualquer', 'c_gatilhos', 'c_gatilhos_qualquer']);
const HASHES = Object.freeze(['c_conflito', 'c_contrato', 'c_revisao']);
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Classificação da 108 IGUAL a classificarCombinados (lib/agenda/estado-combinados.ts). */
function classificar108(e) {
  const total = Object.keys(ret108.NOVA.funcoes).length, gatilhos = ret108.NOVA.gatilhos.length;
  const algum = e.c_funcoes_qualquer > 0 || e.c_combinado || e.c_membros || e.c_gatilhos_qualquer > 0 || e.c_marcador;
  if (!algum) return 'AUSENTE';
  const nucleo = e.c_funcoes === total && e.c_funcoes_qualquer === total && e.c_combinado && e.c_membros && e.c_check
    && e.c_gatilhos === gatilhos && e.c_gatilhos_qualquer === gatilhos && e.c_contrato === ret108.NOVA.hashes.contrato && e.c_revisao === ret108.NOVA.hashes.revisao;
  if (nucleo && e.c_marcador && e.c_conflito === ret108.NOVA.hashes.conflito108) return 'NOVA';
  if (nucleo && !e.c_marcador && e.c_conflito === CONFLITO_098) return 'ANTIGA';
  return 'PARCIAL';
}

/** Estado lido do catálogo (presença; a integridade da 107 só os checks provam). */
function lerEstado(e) {
  for (const k of BOOLEANOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  for (const k of CONTADORES) assert.ok(Number.isInteger(e?.[k]) && e[k] >= 0, 'ESTADO_ILEGIVEL ' + k);
  for (const k of HASHES) assert.ok(e?.[k] === null || /^[0-9a-f]{64}$/.test(e?.[k]), 'ESTADO_ILEGIVEL ' + k);
  assert.ok(Number.isInteger(e?.versao_pg) && e.versao_pg > 0, 'ESTADO_ILEGIVEL versao_pg');
  const s = Object.fromEntries([...BOOLEANOS, ...CONTADORES, ...HASHES, 'versao_pg'].map(k => [k, e[k]]));
  s.m107 = e.registro107 ? 'presente' : 'ausente';
  s.m108 = classificar108(e);
  return s;
}
const pendente107 = s => s.m107 === 'ausente';
const pendente108 = s => s.m108 === 'AUSENTE';
const algumaPendente = s => pendente107(s) || pendente108(s);

/** Guardas do catálogo, ANTES de qualquer leitura de dados (inclusive o registro da 107). */
function exigirCatalogo(s) {
  assert.equal(Math.floor(s.versao_pg / 10000), ret108.VERSAO_MAIOR, `PG_MAIOR_DIFERENTE ${s.versao_pg} (constantes de deparse e retratos valem só para o PostgreSQL ${ret108.VERSAO_MAIOR})`);
  assert.ok(s.base107, 'SEM_BASE_107 configuracao_agenda/bloqueios_agenda/kidmais_set_atualizado_em() (005)');
  assert.ok(s.d108, 'SEM_DEPENDENCIA_108 (093/094/100/102/104/106: agenda_saloes, contratos, contrato_fluxos, fechamentos, revisões, agenda_salao_fotos, funções)');
  assert.notEqual(s.m108, 'ANTIGA', 'COM_098_HISTORICA (a 098 histórica não é suportada; nada aplicado)');
  assert.notEqual(s.m108, 'PARCIAL', 'APLICACAO_PARCIAL_108');
  assert.ok(!(s.m108 === 'NOVA' && s.m107 === 'ausente'), 'NOVA_SEM_107 (108 completa sem o registro da 107)');
  const leitura = [!s.usar_public && 'USAGE_PUBLIC', !s.plpgsql && 'PLPGSQL', ...TABELAS_LEITURA.filter(t => !s[colunaLer(t)]).map(t => 'SELECT_' + t.toUpperCase()),
    s.m107 === 'presente' && !s.ler_reparos && 'SELECT_KIDMAIS107_REPAROS', pendente108(s) && !s.executar_ocupacoes && 'EXECUTE_KIDMAIS094_OCUPACOES'].filter(Boolean);
  assert.ok(leitura.length === 0, 'SEM_PRIVILEGIO_LEITURA ' + leitura.join(' '));
  if (pendente107(s)) {
    const falta = [!s.pode_criar && 'CREATE', !s.temp && 'TEMP', !s.dono_bloqueios && 'DONO_BLOQUEIOS_AGENDA', !s.dono_config_agenda && 'DONO_CONFIGURACAO_AGENDA',
      !s.gatilho_bloqueios && 'TRIGGER_BLOQUEIOS_AGENDA', !s.gatilho_config_agenda && 'TRIGGER_CONFIGURACAO_AGENDA', !s.travar_bloqueios && 'LOCK_BLOQUEIOS_AGENDA',
      !s.travar_config_agenda && 'LOCK_CONFIGURACAO_AGENDA', !s.executar_set_atualizado && 'EXECUTE_KIDMAIS_SET_ATUALIZADO_EM'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_107 ' + falta.join(' '));
  }
  if (pendente108(s)) {
    const falta = [!s.pode_criar && 'CREATE', !s.linguagem_sql && 'LINGUAGEM_SQL', !s.dono_saloes && 'DONO_AGENDA_SALOES', !s.dono_contratos && 'DONO_CONTRATOS',
      !s.dono_funcoes_108 && 'DONO_FUNCOES_SUBSTITUIDAS', !s.gatilho_saloes && 'TRIGGER_AGENDA_SALOES', !s.gatilho_contratos && 'TRIGGER_CONTRATOS',
      !s.travar_saloes && 'LOCK_AGENDA_SALOES', !s.travar_contratos && 'LOCK_CONTRATOS'].filter(Boolean);
    assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_108 ' + falta.join(' '));
  }
  assert.ok(!algumaPendente(s) || s.ver_atividade, 'ATIVIDADE_NAO_VERIFICAVEL (sem superusuário nem pg_read_all_stats: atividade de outras sessões oculta)');
}

/** Atividade lida: nenhuma outra sessão com lock nas tabelas e nenhuma sem contexto (transação preparada recusa). */
function exigirSemAtividade(a) {
  for (const k of ['locks', 'sessoes', 'sessoes_em_transacao', 'locks_sem_pid', 'sem_contexto']) assert.ok(Number.isInteger(a?.[k]) && a[k] >= 0, 'ESTADO_ILEGIVEL atividade ' + k);
  assert.equal(a.sem_contexto, 0, `ATIVIDADE_NAO_VERIFICAVEL ${a.sem_contexto} sem contexto visível (${a.locks_sem_pid} lock(s) sem pid: transação preparada)`);
  assert.equal(a.sessoes, 0, `ATIVIDADE_NAS_TABELAS ${a.sessoes} sessão(ões), ${a.sessoes_em_transacao} em transação, ${a.locks} lock(s)`);
}

/** Situação do COMMIT quando o PRÓPRIO COMMIT falha (idêntica ao 104/106). */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) && sqlstate !== '40003' ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}

// ---- Esperados do retrato. ----
/**
 * Os esperados do arquivo (fixado por hash) ou, SÓ num ambiente que aceite, os injetados pela suíte PostgreSQL em
 * KIDMAIS_RETRATOS_108_TESTE (JSON no mesmo formato do arquivo, medido no cluster).
 */
function esperadosDe(env, raiz, aceitaTeste, fsx = fs) {
  const injetado = env?.[ENV_RETRATOS_TESTE];
  if (injetado !== undefined) {
    assert.ok(aceitaTeste, 'RETRATOS_DE_TESTE_RECUSADOS (' + ENV_RETRATOS_TESTE + ' só vale na suíte PostgreSQL)');
    let x; try { x = JSON.parse(injetado); } catch { assert.fail('RETRATOS_DE_TESTE_ILEGIVEIS'); }
    assert.ok(x && typeof x === 'object', 'RETRATOS_DE_TESTE_ILEGIVEIS');
    return x;
  }
  const [, relativo, hash] = arquivo('retratos esperados 108');
  return JSON.parse(lerRevisado(raiz, relativo, hash, fsx));
}
/** Recusa nomeada para esperado não medido: RETRATO_NAO_MEDIDO; outras recusas do comparador passam como estão. */
function rotularRetrato(e) {
  const m = curta(e);
  if (/RETRATO_108_NAO_MEDIDO/.test(m)) { const x = new Error('RETRATO_NAO_MEDIDO ' + m.replace(/^RETRATO_108_NAO_MEDIDO /, '')); x.code = e?.code; return x; }
  return e;
}
/** Situação de cada fase (para o plano e para recusar o APLICAR antes de conectar). */
function situacaoRetratos(esperados) {
  return Object.fromEntries(ret108.FASES.map(f => {
    try { return [f, ret108.hashesAceitos(f, esperados).map(a => a.variante)]; } catch (e) { return [f, curta(rotularRetrato(e))]; }
  }));
}
function exigirRetratosMedidos(esperados) {
  for (const f of ret108.FASES) {
    try { ret108.hashesAceitos(f, esperados); } catch (e) { throw rotularRetrato(e); }
  }
}
/** Resumo sanitizado do retrato para o diff: por seção, quantidade e sha256 (sem corpos nem literais). */
function resumoRetrato(retrato) {
  if (!retrato || typeof retrato !== 'object') return null;
  return Object.fromEntries(Object.keys(retrato).sort().map(k => {
    const v = retrato[k];
    return [k, {n: Array.isArray(v) ? v.length : v === null ? 0 : 1, sha256: createHash('sha256').update(JSON.stringify(v) ?? 'null').digest('hex')}];
  }));
}

// ---- Execução das consultas. ----
async function somenteLeitura(db, sql, caminho = CAMINHO_CHECKS) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query(`SET LOCAL lock_timeout = '${ORCAMENTO.lock_timeout}'`);
    await db.query(`SET LOCAL statement_timeout = '${ORCAMENTO.statement_timeout}'`);
    await db.query(`SET LOCAL search_path = ${caminho}`);
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Dentro da transação de escrita: muda só o search_path desta consulta (SET LOCAL vale até o fim da transação). */
async function naTransacao(db, sql, caminho = CAMINHO_CHECKS) {
  await db.query(`SET LOCAL search_path = ${caminho}`);
  return db.query(sql);
}
const rotulada = (rotulo, e) => { const x = new Error(rotulo + ' ' + curta(e)); x.code = e?.code; return x; };
async function checkDo(executar, rotulo, sql) {
  try { await executar(sql, CAMINHO_CHECKS); return 'PASS'; } catch (e) { throw rotulada(rotulo, e); }
}

/**
 * Contexto de SQL de uma execução: arquivos revisados e os construtores (os que dependem de esperados medidos são
 * gerados sob demanda, para o CONFERIR poder medir e recusar com RETRATO_NAO_MEDIDO).
 */
function contexto(raiz, esperados, fsx = fs) {
  const sqls = new Map(ARQUIVOS.map(([nome, relativo, hash]) => [nome, lerRevisado(raiz, relativo, hash, fsx)]));
  for (const id of IDS) semMoldura(sqls.get('migration ' + id), 'migration ' + id);
  assert.equal(sqls.get('precheck 108 pre-107'), precheckPre107(sqls.get('precheck 108')), 'PRECHECK_PRE107_DIVERGE_DO_GERADO');
  return {sqls, esperados, raiz, avaliacao107: def107.sqlAvaliacao107(), integridade107: def107.sqlIntegridade107(), retrato: ret108.sqlRetrato108({raiz}),
    prova: () => { try { return ret108.sqlProva108Integra({esperados, raiz}); } catch (e) { throw rotularRetrato(e); } }};
}

/** Avaliação F0 da 107 (READ ONLY, objeto a objeto). Recusa qualquer RECUSA:*; devolve o resumo por estado. */
async function avaliar107(executar, ctx) {
  const linhas = (await executar(ctx.avaliacao107, CAMINHO_CATALOGO)).rows ?? [];
  assert.equal(linhas.length, def107.DEFINICOES.length, 'AVALIACAO_107_ILEGIVEL ' + linhas.length + ' linha(s)');
  const recusas = linhas.filter(l => typeof l.estado !== 'string' || !['CANONICO', 'DERIVA', 'AUSENTE_CRIAVEL'].includes(l.estado));
  assert.ok(recusas.length === 0, 'AVALIACAO_107_RECUSA ' + recusas.slice(0, 4).map(l => `${l.canonico}:${l.estado}`).join(' '));
  const resumo = {CANONICO: 0, DERIVA: 0, AUSENTE_CRIAVEL: 0};
  for (const l of linhas) resumo[l.estado]++;
  return resumo;
}
/** Integridade da 107 pelo construtor (READ ONLY): todas as linhas ok, senão INTEGRIDADE_107 com os motivos. */
async function integridade107(executar, ctx) {
  const linhas = (await executar(ctx.integridade107, CAMINHO_CATALOGO)).rows ?? [];
  assert.ok(linhas.length > 0, 'INTEGRIDADE_107 ilegível');
  const falhas = linhas.filter(l => l.ok !== true);
  assert.ok(falhas.length === 0, 'INTEGRIDADE_107 ' + falhas.slice(0, 3).map(l => String(l.motivo)).join('; '));
  return 'PASS';
}
/** Retrato de uma fase: mede (hash + resumo sanitizado em `saida`), depois compara com o esperado da fase. */
async function retrato(executar, ctx, fase, saida) {
  const linha = (await executar(ctx.retrato, CAMINHO_CATALOGO)).rows?.[0];
  saida.retrato = {fase, hash: linha?.hash_108 ?? null, secoes: resumoRetrato(linha?.retrato_108)};
  let c;
  try { c = ret108.compararRetrato108(fase, linha, ctx.esperados); } catch (e) { throw rotularRetrato(e); }
  assert.ok(c.ok, `RETRATO_${fase}_DIVERGENTE ${String(linha?.hash_108).slice(0, 64)} (nenhum esperado da fase; diff por seção em retrato.secoes)`);
  saida.retrato.variante = c.variante;
  return c.variante;
}
/** Prova "108 íntegra" (detector NOVA + marcador + metadados + retrato F2). */
async function prova108(executar, ctx) {
  const sql = ctx.prova();
  const linha = (await executar(sql, CAMINHO_CATALOGO)).rows?.[0];
  assert.ok(linha && typeof linha.integra === 'boolean', 'INTEGRIDADE_108 ilegível');
  assert.ok(linha.integra, 'INTEGRIDADE_108 ' + (Array.isArray(linha.motivos) ? linha.motivos.slice(0, 6).join(' ') : String(linha.motivos)));
  return 'PASS';
}

/** F0 (pré-107): avaliação da 107, precheck da 107, precheck da 108 pré-107 e retrato F0 coerente com a avaliação. */
async function verificarF0(executar, ctx, saida) {
  const v = {};
  v['avaliacao 107'] = await avaliar107(executar, ctx);
  v['precheck 107'] = await checkDo(executar, 'PRECHECK_107', ctx.sqls.get('precheck 107'));
  v['precheck 108 pre-107'] = await checkDo(executar, 'PRECHECK_108_PRE107', ctx.sqls.get('precheck 108 pre-107'));
  const variante = await retrato(executar, ctx, 'F0', saida);
  // Coerência: o retrato canônico só com tudo CANONICO; a deriva conhecida só com algum objeto a reparar.
  const tudoCanonico = v['avaliacao 107'].CANONICO === def107.DEFINICOES.length;
  assert.ok((variante === 'canonico') === tudoCanonico, `RETRATO_F0_INCOERENTE variante ${variante} × avaliação ${JSON.stringify(v['avaliacao 107'])}`);
  v['retrato F0'] = variante;
  return v;
}
/** F1 (pós-107/pré-108): integridade da 107, precheck da 108 e retrato F1. */
async function verificarF1(executar, ctx, saida) {
  const v = {};
  v['integridade 107'] = await integridade107(executar, ctx);
  v['precheck 108'] = await checkDo(executar, 'PRECHECK_108', ctx.sqls.get('precheck 108'));
  v['retrato F1'] = await retrato(executar, ctx, 'F1', saida);
  return v;
}
/** F2 (pós-108): integridade da 107 e prova "108 íntegra". */
async function verificarF2(executar, ctx) {
  return {'integridade 107': await integridade107(executar, ctx), 'prova 108': await prova108(executar, ctx)};
}
const leitor = db => (sql, caminho) => somenteLeitura(db, sql, caminho);

async function estadoAtual(db, {guardar = true} = {}) {
  const s = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (guardar) exigirCatalogo(s);
  return s;
}
async function atividade(db, s) {
  if (!algumaPendente(s)) return null;
  const a = (await somenteLeitura(db, SQL_ATIVIDADE)).rows[0];
  exigirSemAtividade(a);
  return a;
}
async function sessoes(db) {
  const x = (await somenteLeitura(db, SQL_SESSOES)).rows[0];
  for (const k of ['outras', 'nao_ociosas', 'em_transacao']) assert.ok(Number.isInteger(x?.[k]) && x[k] >= 0, 'ESTADO_ILEGIVEL sessoes ' + k);
  return x;
}
/** Fase a verificar a partir do estado: F0 (107 ausente), F1 (107 presente, 108 AUSENTE) ou F2 (NOVA). */
const faseDe = s => (pendente107(s) ? 'F0' : pendente108(s) ? 'F1' : 'F2');
const VERIFICAR = Object.freeze({F0: verificarF0, F1: verificarF1, F2: verificarF2});

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade → catálogo/privilégios → guardas → 107 (integridade
 * se presente) → atividade e sessões (com algo pendente) → verificações da fase, tudo em READ ONLY.
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade, esperados}) {
  const r = {modo: 'conferencia'};
  const ctx = contexto(raiz, esperados);
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  const recusar = e => { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; };
  try { exigirCatalogo(r.estado); } catch (e) { return recusar(e); }
  r.fase = faseDe(r.estado);
  r.estado107 = r.estado.m107 === 'ausente' ? 'ausente' : 'aplicada';
  if (r.estado.m107 === 'presente') {
    try { await integridade107(leitor(db), ctx); } catch (e) { r.estado107 = 'divergente'; return recusar(e); }
  }
  try { r.atividade = await atividade(db, r.estado); } catch (e) { return recusar(e); }
  r.sessoes = await sessoes(db);
  try { r.verificacoes = await VERIFICAR[r.fase](leitor(db), ctx, r); } catch (e) { return recusar(e); }
  r.resultado = r.fase === 'F2' ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Uma transação de escrita (id 107 ou 108): BEGIN → orçamento → LOCK na ordem fixa → revalidação da fase → corpo sem
 * moldura → verificações → COMMIT. Situação do COMMIT registrada antes de qualquer outra leitura.
 */
async function transacao(db, id, ctx, passo, registrar) {
  let fase = 'abertura';
  const executar = (sql, caminho) => naTransacao(db, sql, caminho);
  try {
    await db.query('BEGIN');
    for (const [k, v] of Object.entries(ORCAMENTO)) await db.query(`SET LOCAL ${k} = '${v}'`);
    fase = 'lock';
    await db.query(SQL_LOCK[id]);
    fase = 'revalidacao';
    const saida = {};
    passo.revalidacao = id === '107' ? await verificarF0(executar, ctx, saida) : await verificarF1(executar, ctx, saida);
    passo.retrato = saida.retrato;
    fase = 'corpo';
    await db.query(semMoldura(ctx.sqls.get('migration ' + id), 'migration ' + id));
    await db.query(`SET LOCAL statement_timeout = '${ORCAMENTO.statement_timeout}'`);
    fase = 'verificacao';
    passo.antesDoCommit = {};
    if (id === '107') passo.antesDoCommit['integridade 107'] = await checkDo(executar, 'INTEGRIDADE_107', ctx.sqls.get('integridade 107'));
    else {
      passo.antesDoCommit['postcheck 108'] = await checkDo(executar, 'POSTCHECK_108', ctx.sqls.get('postcheck 108'));
      passo.antesDoCommit['prova 108'] = await prova108(executar, ctx);
      const x = (await executar(SQL_EXECUCAO_108, CAMINHO_CHECKS)).rows?.[0]?.executa_108;
      assert.equal(x, true, 'EXECUCAO_FUNCOES_108 ' + String(x));
      passo.antesDoCommit['execucao 108'] = 'PASS';
    }
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; assert.fail('COMMIT_RESPONDIDO_COMO_ROLLBACK_' + id); }
  } catch (e) {
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    passo.faseDaFalha = fase;
    await db.query('ROLLBACK').catch(() => {});
    try { registrar(); } catch { /* a falha original vale; o executor registra o que puder */ }
    throw e;
  }
  passo.commit = 'CONFIRMADO';
  registrar();
}

/**
 * Aplicação: estado e guardas → 107 (integridade se presente) → verificações da fase em READ ONLY → atividade e
 * sessões → [transação 107 → estado → F1 em READ ONLY → atividade de novo] → [transação 108 → estado] → F2 em READ ONLY.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, esperados, registrar = () => {}, abrirEtapa = () => {}}) {
  const ctx = contexto(raiz, esperados);
  ctx.prova(); // F2 precisa estar medido antes da 1ª escrita
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.estado107 = r.estadoAntes.m107 === 'ausente' ? 'ausente' : 'aplicada';
  if (r.estadoAntes.m107 === 'presente') {
    try { await integridade107(leitor(db), ctx); } catch (e) { r.estado107 = 'divergente'; registrar(r); throw e; }
  }
  r.fase = faseDe(r.estadoAntes);
  r.plano = [...(pendente107(r.estadoAntes) ? ['transacao 107'] : []), ...(pendente108(r.estadoAntes) ? ['transacao 108'] : [])];
  registrar(r);
  if (r.plano.length === 0) {
    r.verificacoes = await verificarF2(leitor(db), ctx);
    r.estadoDepois = r.estadoAntes; r.resultado = 'JA_APLICADA_INTEGRIDADE_PASS'; registrar(r);
    return r;
  }
  r.verificacoes = await VERIFICAR[r.fase](leitor(db), ctx, r);
  r.atividade = await atividade(db, r.estadoAntes);
  r.sessoes = await sessoes(db);
  registrar(r);
  for (const nome of r.plano) {
    const id = nome.slice(-3);
    if (id === '108' && r.plano.includes('transacao 107')) {
      // Entre as etapas: a 107 confirmada e íntegra, F1 em READ ONLY e a atividade de novo (P3-E4-R2-2).
      const s = await estadoAtual(db);
      assert.equal(s.m107, 'presente', 'ESTADO_DEPOIS_107');
      r.entreEtapas = {verificacoes: await verificarF1(leitor(db), ctx, {}), atividade: await atividade(db, s)};
      registrar(r);
    }
    abrirEtapa(id);
    const passo = {nome, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    await transacao(db, id, ctx, passo, () => registrar(r));
    const depois = await estadoAtual(db, {guardar: false});
    assert.ok(id === '107' ? depois.m107 === 'presente' : depois.m108 === 'NOVA', 'ESTADO_DEPOIS_' + id);
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db, {guardar: false});
  assert.ok(r.estadoDepois.m107 === 'presente' && r.estadoDepois.m108 === 'NOVA', 'ESTADO_FINAL');
  r.depois = await verificarF2(leitor(db), ctx);
  r.resultado = 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r?.etapas ?? []).filter(x => x.commit).map(x => [x.nome.slice(-3), x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv[0] === FLAG_APLICAR) {
    assert.ok(argv[1] === FLAG_BACKUP && argv.length >= 3, 'BACKUP_OBRIGATORIO');
    assert.match(argv[2], REGISTRO_SEGURO, 'BACKUP_INVALIDO');
    assert.ok(argv[3] === FLAG_DRENAGEM && argv.length === 5, 'DRENAGEM_OBRIGATORIA (D-E4: web em manutenção ou escala zero e cron suspenso)');
    assert.match(argv[4], REGISTRO_SEGURO, 'DRENAGEM_INVALIDA');
    return {modo: 'aplicar', backup: argv[2], drenagem: argv[4]};
  }
  assert.fail('ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente (contrato do 104/106: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco)
 * + `aceitaRetratosTeste` (só a suíte PostgreSQL; staging nunca).
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  const aceita = amb.aceitaRetratosTeste === true;
  function plano({env = {}, raiz = raizPadrao} = {}) {
    const esperados = esperadosDe(env, raiz, aceita);
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ARQUIVOS.map(([nome, relativo, hash]) => { lerRevisado(raiz, relativo, hash); return {nome, arquivo: relativo, sha256: hash}; }),
      recuperacaoArquivos: RECUPERACAO.map(([nome, relativo, hash]) => { lerRevisado(raiz, relativo, hash); return {nome, arquivo: relativo, sha256: hash}; }),
      retratos: situacaoRetratos(esperados),
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup> ${FLAG_DRENAGEM} <registro-da-drenagem>`}, registro: amb.DIR,
      fases: {F0: 'pré-107: avaliação da 107 objeto a objeto + precheck da 107 + precheck da 108 pré-107 + retrato F0 (canônico ou deriva conhecida)',
        F1: 'pós-107/pré-108: integridade da 107 + precheck da 108 + retrato F1',
        F2: 'pós-108: integridade da 107 + prova "108 íntegra" (detector NOVA, marcador, metadados das 14 funções, retrato F2)'},
      transacoes: IDS.map(id => ({id, locks: TABELAS_LOCK[id].map(t => 'public.' + t), modo: 'SHARE ROW EXCLUSIVE', revalida: id === '107' ? 'F0' : 'F1',
        antesDoCommit: id === '107' ? ['integridade 107'] : ['postcheck 108', 'prova 108', 'execucao 108']})),
      orcamento: {...ORCAMENTO, ordemDosLocks: 'transação 1: bloqueios_agenda → configuracao_agenda; transação 2: agenda_saloes → contratos (fixa)'},
      preRequisitos: ['PostgreSQL versão maior 18 (deparse e retratos medidos nela)',
        'leitura (sempre, current_user): USAGE em public e plpgsql; SELECT em ' + TABELAS_LEITURA.join(', ') + '; SELECT em kidmais107_reparos se existir; EXECUTE em kidmais094_ocupacoes(date,date) com a 108 pendente',
        '107 pendente: dono de bloqueios_agenda e configuracao_agenda, CREATE em public, TEMP, TRIGGER e LOCK (UPDATE/DELETE/TRUNCATE/MAINTAIN) nas duas, EXECUTE em kidmais_set_atualizado_em()',
        '108 pendente: dono de agenda_saloes, contratos e das 3 funções substituídas, CREATE em public, TRIGGER e LOCK nas duas tabelas, USAGE em sql; EXECUTE nas 14 funções antes do COMMIT',
        'alguma pendente: superusuário ou pg_read_all_stats; nenhuma sessão com lock em ' + TABELAS_ATIVIDADE.join(', '),
        'retratos F0/F1/F2 medidos no PostgreSQL 18 (A_MEDIR_NO_CLUSTER = RETRATO_NAO_MEDIDO: o APLICAR recusa antes de conectar)'],
      ordem: ['árvore implantada com #267 + E4 (aplicador, comuns, checks, retratos, migrations e downs conferidos pelo bloco)', FLAG_CONFERIR + ' (mede F0; só leitura)',
        'decisão de Felipe', 'ponto de recuperação PITR do PostgreSQL de staging comprovado e registrado (export lógico NÃO substitui)',
        'janela drenada (D-E4): web em manutenção ou escala zero, cron suspenso, sem outros escritores, jobs nem DDL durante as DUAS transações; o aplicador roda num job/shell do Render com a MESMA árvore',
        `${FLAG_CONFERIR} de novo, imediatamente antes (atividade e sessões registradas)`, `${FLAG_APLICAR} ${FLAG_BACKUP} … ${FLAG_DRENAGEM} …`,
        FLAG_CONFERIR + ' (F2, JA_APLICADA)', 'CONFERIR da 092–094/100/098/102-103/104-106', 'fim da drenagem', 'conferência logada (admin com combinados; cliente sem combinado)'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e os marcadores; não repetir',
        'FALHA: commit por etapa = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com o CONFERIR antes de decidir',
        'falha na 108 com a 107 confirmada: a 107 fica (código funciona sem combinados); retomada só da 108, por decisão de Felipe',
        'marcador incompleto, ilegível ou não gravado, ou processo interrompido: parar, preservar saída e marcadores, reconciliar pelo CONFERIR e só então decidir',
        'retomada: renomear (nunca apagar) migration-107-108.json e o marcador da etapa que falhou para migration-107-108.<horario>.json / .etapa-<id>.<horario>.json'],
      recuperacao: ['down da 108 ANTES do down da 107, cada um com autorização própria (o down da 108 recusa com qualquer salão combinado, mesmo inativo)',
        'PROIBIDO voltar o código público para versão sem o filtro E2a enquanto existir combinado',
        'em último caso, restauração PITR ao ponto registrado'],
      nuncaExecuta: ['down 107', 'down 108', 'alteração de env', 'deploy', 'restart', 'ligar SALOES_PUBLICOS', 'escrita de salões, festas ou contratos']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const esperados = esperadosDe(env, raiz, aceita);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), esperados}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, drenagem, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(), fsx = fs}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), REGISTRO_SEGURO, 'BACKUP_OBRIGATORIO');
    assert.match(String(drenagem ?? ''), REGISTRO_SEGURO, 'DRENAGEM_OBRIGATORIA');
    const esperados = esperadosDe(env, raiz, aceita, fsx);
    exigirRetratosMedidos(esperados);
    for (const [, relativo, hash] of ARQUIVOS) lerRevisado(raiz, relativo, hash, fsx);
    try { fsx.mkdirSync(dir, {recursive: true, mode: 0o700}); } catch (e) { assert.fail('MARCADOR_SEM_PERMISSAO ' + (e?.code ?? '')); }
    const marcador = path.join(dir, MARCADOR);
    let anteriores;
    try { anteriores = fsx.readdirSync(dir).filter(n => /^migration-107-108\..+\.json$/.test(n)).sort(); } catch (e) { assert.fail('MARCADOR_ILEGIVEL ' + (e?.code ?? '')); }
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, drenagem, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fsx.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) {
      if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador);
      assert.fail('MARCADOR_SEM_PERMISSAO ' + (e?.code ?? ''));
    }
    const salvar = r => fsx.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    const etapas = {};
    const abrirEtapa = id => {
      const p = path.join(dir, marcadorEtapa(id));
      try { fsx.writeFileSync(p, JSON.stringify({etapa: id, inicio: new Date().toISOString(), situacao: 'INICIADA'}, null, 2), {flag: 'wx', mode: 0o600}); }
      catch (e) { if (e?.code === 'EEXIST') assert.fail('ETAPA_JA_TENTADA_REVISAR ' + id + ' ' + p); assert.fail('MARCADOR_SEM_PERMISSAO etapa ' + id + ' ' + (e?.code ?? '')); }
      etapas[id] = p;
    };
    let ultimo = {};
    const registrar = x => {
      ultimo = JSON.parse(JSON.stringify(x));
      salvar({...ultimo, situacao: 'EM_ANDAMENTO'});
      for (const passo of ultimo.etapas ?? []) {
        const id = passo.nome.slice(-3);
        if (etapas[id]) fsx.writeFileSync(etapas[id], JSON.stringify({etapa: id, ...passo, situacao: passo.commit ?? 'EM_ANDAMENTO'}, null, 2), {mode: 0o600});
      }
    };
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), esperados, registrar, abrirEtapa});
      salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, fase: r.fase, estado107: r.estado107, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        atividade: r.atividade, sessoes: r.sessoes, etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? (ultimo.conexao ? 'VERIFICACAO' : 'CONEXAO'), mensagem: curta(e)};
      const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      let marcadorGravado = true;
      try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); } catch { marcadorGravado = false; }
      return {resultado: 'FALHA', marcador, marcadorGravado, falha, estado107: ultimo.estado107, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano({env, raiz: deps.raiz})};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, drenagem: m.drenagem, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {IDS, ARQUIVOS, RECUPERACAO, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, FLAG_DRENAGEM, ENV_RETRATOS_TESTE, MARCADOR, marcadorEtapa, ORCAMENTO,
  TABELAS_LOCK, SQL_LOCK, TABELAS_LEITURA, TABELAS_ATIVIDADE, CONFLITO_098, SUBSTITUIDAS_108, CLAUSULA_107, CABECALHO_PRE107, CAMINHO_CHECKS, CAMINHO_CATALOGO,
  SQL_ESTADO, SQL_ATIVIDADE, SQL_SESSOES, SQL_EXECUCAO_108, lerRevisado, precheckPre107, semMoldura, classificar108, lerEstado, exigirCatalogo, exigirSemAtividade,
  commitNaFalha, esperadosDe, exigirRetratosMedidos, situacaoRetratos, resumoRetrato, faseDe, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
