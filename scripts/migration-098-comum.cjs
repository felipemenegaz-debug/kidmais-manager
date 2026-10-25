/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 098 (salão combinado, fase 1 dos salões; PR #223, 23/10/2026) — staging
// (scripts/migration-098-staging.cjs, que fixa o alvo, a identidade da conexão e o disco). Derivado dos núcleos da 097
// (corte, espera de transações anteriores, prova agregada) e da 092–094 (dono dos objetos alterados, COMMIT
// CONFIRMADO/INDETERMINADO, tentativas anteriores): alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado,
// estado ausente/completa/parcial, privilégios, marcador exclusivo no disco persistente, saída sanitizada.
// Ordem: o CÓDIGO é publicado ANTES (PR #223, com o conjunto 098 no manifesto da Festa, que aceita 094 e 094 + 098), já
// com este aplicador e os SQL na árvore implantada. Depois: --retrato-098 → --conferir-098 → backup (export + PITR do
// painel) → autorização → --aplicar-098-autorizado --backup <registro> → --conferir-098.
// Retrato e conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), nada gravado no banco nem no disco.
// Aplicação: retrato (READ ONLY, estado 094 exato) → precheck (READ ONLY) → migration (transação própria do arquivo,
// lock_timeout 5s) → COMMIT registrado → estado completo → postcheck (READ ONLY) → integridade (READ ONLY) → prova
// agregada de preservação (salões existentes até o corte iguais e nenhum virou combinado; a 098 só ACRESCENTA colunas
// com default, objetos e corpos de função).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens, hashes e resumos agregados (sem ids, nomes
// ou URL do banco). Privilégios avaliados como current_user (no Render a credencial entra com `SET role` do dono; lição
// de 14/10/2026): a 098 altera agenda_saloes (ALTER TABLE, gatilhos), cria gatilhos em contratos e substitui três
// corpos da 094 (CREATE OR REPLACE FUNCTION), por isso exige ser DONO deles (pg_has_role USAGE), além de CREATE em public.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_RETRATO = '--retrato-098';
const FLAG_CONFERIR = '--conferir-098';
const FLAG_APLICAR = '--aplicar-098-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-098.json';
/** Fonte única do retrato estrutural canônico (expressão entre @@RETRATO-INICIO e @@RETRATO-FIM). */
const RETRATO = Object.freeze(['retrato 098', 'database/checks/20261023_098_retrato.sql', '34cc5ff6b5dff1eeabd8cac13e969014c7e10413564b90f24689e1b0c48c0ef1']);
const ETAPAS = Object.freeze([
  ['precheck 098', 'database/checks/20261023_098_precheck.sql', '5a0e8f56741b570f8e63c5c05d2419ffcec9716ca31776a429712584491e137a'],
  ['migration 098', 'database/migrations/20261023_098_saloes_combinados.sql', '0e66d0239c7f75f216b8835ae78f1fe5806128d0ef3b1abf6b41ba3aff7931d1'],
  ['postcheck 098', 'database/checks/20261023_098_postcheck.sql', '46790b6e18fb427fd358d3a2aeb3669e34276755cfe2df9e1fec7b5b0b9b9708'],
  ['integridade 098', 'database/checks/20261023_098_integridade.sql', '2de27c97fcdfe2af3560cc69c467af3885e8368a26258edf259df890484808eb'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/**
 * Retratos esperados (os mesmos de scripts/migration-098-retrato.mjs, embutidos no precheck/postcheck/integridade):
 * "094" = inventário inteiro ANTES da 098 (staging 22d4ac30: até a 097); "098" = depois. Por tipo de linha, a contagem e
 * os 12 primeiros hex do md5 das linhas do tipo (ordem "C"): só diagnóstico, para dizer QUAL categoria diverge.
 */
const RETRATOS = Object.freeze({
  '094': Object.freeze({hash: 'd87890a6d261bccee5c83eaaa29fdd69e8912a8304abf59deaeeb6c243e7a146', tipos: Object.freeze({C: [995, 'b8c64106749d'], F: [115, '2b39174f285a'], G: [187, '621007a98f45'], GI: [1724, 'e0e42265702e'], I: [333, 'ca504da01d97'], K: [1683, '8694c1859163'], S: [2, '845538a5a044'], T: [72, 'c68dd14da7ab'], X: [1, '525ee5abccf2']})}),
  '098': Object.freeze({hash: '2dfe0b4fb72311b3d5b23df32fe0b8af8dd15dceb469285c0200dcbb9630e64d', tipos: Object.freeze({C: [997, '0e3051ebd5ff'], F: [125, '12646fbf9579'], G: [193, '464fda9ee1c8'], GI: [1724, 'e0e42265702e'], I: [333, 'ca504da01d97'], K: [1686, 'bc60de72a6b8'], S: [2, '845538a5a044'], T: [72, 'c68dd14da7ab'], X: [1, '525ee5abccf2']})}),
});

const reg = t => `to_regclass('public.${t}')`;
const proc = f => `to_regprocedure('public.${f}')`;
const coluna = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=${reg(t)} AND attname='${c}' AND NOT attisdropped)`;
const gatilho = (t, g) => `EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='${g}' AND tgrelid=${reg(t)})`;
const restricao = (t, r) => `EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${r}' AND conrelid=${reg(t)})`;
const corpo = (f, trecho) => `coalesce((SELECT strpos(prosrc, '${trecho}') > 0 FROM pg_proc WHERE oid=${proc(f)}), false)`;
/** current_user é dono (ou membro com USAGE do dono) de TODAS as tabelas/funções listadas, e todas existem. */
const dono = (tabelas, funcoes) => `coalesce((SELECT bool_and(pg_has_role(current_user, d, 'USAGE')) AND count(*)=${tabelas.length + funcoes.length} FROM (
    SELECT relowner AS d FROM pg_class WHERE oid IN (${tabelas.map(reg).join(',')})
    UNION ALL SELECT proowner FROM pg_proc WHERE oid IN (${funcoes.map(proc).join(',')})) x), false)`;

const CONFLITO = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';
const SUBSTITUIDAS = Object.freeze([CONFLITO, 'kidmais019_validar_contrato()', 'kidmais_validar_agenda_revisao()']);
const ALTERADAS = Object.freeze(['agenda_saloes', 'contratos']);
/** Dependências e privilégios (leitura do catálogo, sem dados). */
const BASE = Object.freeze({
  d094: `${['agenda_saloes', 'contratos', 'fechamentos', 'fechamento_revisoes'].map(t => `${reg(t)} IS NOT NULL`).join(' AND ')}
    AND ${[...SUBSTITUIDAS, 'kidmais094_ocupacoes(date,date)'].map(f => `${proc(f)} IS NOT NULL`).join(' AND ')}`,
  pode_criar: `has_schema_privilege(current_user,'public','CREATE')`,
  dono_098: dono(ALTERADAS, SUBSTITUIDAS),
  papel_trocado: 'session_user <> current_user',
});
/** Objetos da 098 (presença no catálogo); a migration é uma transação só, então meio-termo = deriva. */
const OBJETOS = Object.freeze({
  coluna_combinado: coluna('agenda_saloes', 'combinado'),
  coluna_membros: coluna('agenda_saloes', 'membros'),
  restricao_membros: restricao('agenda_saloes', 'agenda_saloes_098_membros_check'),
  ...Object.fromEntries(['hoje()', 'membros_canonicos(uuid[])', 'conjunto(uuid)', 'saloes_cruzam(uuid,uuid)', 'salao_elegivel(uuid)',
    'validar_elegibilidade(uuid)', 'salao_guarda()', 'combinado_validar()', 'proibir_truncate()', 'contrato_guarda()']
    .map(f => ['f_' + f.slice(0, f.indexOf('(')), `${proc('kidmais098_' + f)} IS NOT NULL`])),
  ...Object.fromEntries([['agenda_saloes', 'agenda_saloes_098_guarda_trg'], ['agenda_saloes', 'agenda_saloes_098_combinado_trg'],
    ['agenda_saloes', 'agenda_saloes_098_combinado_diferido'], ['agenda_saloes', 'agenda_saloes_098_truncate_trg'],
    ['contratos', 'contratos_098_guarda_trg'], ['contratos', 'contratos_098_truncate_trg']].map(([t, g]) => ['g_' + g, gatilho(t, g)])),
  corpo_conflito: corpo(CONFLITO, 'kidmais098_saloes_cruzam'),
  corpo_contrato: corpo('kidmais019_validar_contrato()', 'kidmais098_validar_elegibilidade'),
  corpo_revisao: corpo('kidmais_validar_agenda_revisao()', 'kidmais098_validar_elegibilidade'),
});
const CAMPOS = Object.freeze([...Object.keys(BASE), ...Object.keys(OBJETOS)]);
const SQL_ESTADO = 'SELECT\n  ' + [...Object.entries(BASE), ...Object.entries(OBJETOS)].map(([k, sql]) => `(${sql}) AS ${k}`).join(',\n  ');

/** Corte lido no banco ANTES da migration: a prova compara só salões criados até ele (tráfego durante a janela não conta). */
const SQL_CORTE = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS corte`;
const CORTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/**
 * Resumo das colunas de agenda_saloes que a 098 não pode tocar nos salões criados até o corte (id, empresa, unidade,
 * criação); nome, capacidade, ordem e ativo mudam com o tráfego e ficam fora. Depois da 098, nenhum desses salões pode
 * ter virado combinado (a coluna nasce false para todos). Só contagens e o md5 agregado saem.
 */
function SQL_PRESERVACAO(corte, completa) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  const ate = `criado_em <= '${corte}'::timestamptz`;
  return `/* preservacao-098 */ SELECT
  (SELECT count(*)::int FROM agenda_saloes WHERE ${ate}) AS saloes,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, empresa_id, estabelecimento_id, criado_em), ',' ORDER BY id)), 'vazio') FROM agenda_saloes WHERE ${ate}) AS resumo_saloes${completa ? `,
  (SELECT count(*)::int FROM agenda_saloes WHERE ${ate} AND (combinado OR membros IS NOT NULL)) AS combinados_ate_corte` : ''}`;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/**
 * Consulta do retrato: a MESMA expressão do arquivo revisado (entre os marcadores), calculada com search_path =
 * pg_catalog. Devolve o SHA-256 do texto inteiro (o que precheck/postcheck/integridade comparam), o total de linhas e,
 * por tipo de linha (T/C/K/I/G/GI/R/P/F/S/Y/X), contagem e md5 curto. Nenhum texto do retrato sai.
 */
// Linha lógica: quebra só antes de um prefixo de tipo (definições com quebra de linha, como o CHECK com CASE da 098,
// ficam inteiras na linha do tipo delas).
const LINHA = String.raw`E'\\n(?=(?:T|C|K|I|G|GI|R|P|F|S|Y|X)\\|)'`;
function sqlRetrato(raiz) {
  const sql = lerRevisado(raiz, RETRATO[1], RETRATO[2]);
  const ini = sql.indexOf('-- @@RETRATO-INICIO'), marca = '-- @@RETRATO-FIM', fim = sql.indexOf(marca);
  assert.ok(ini >= 0 && fim > ini, 'RETRATO_SEM_MARCADORES');
  return `/* retrato-098 */ SELECT encode(sha256(convert_to(r.t, 'UTF8')), 'hex') AS hash,
  (SELECT count(*)::int FROM regexp_split_to_table(r.t, ${LINHA})) AS linhas,
  (SELECT json_object_agg(g.k, json_build_array(g.n, g.d) ORDER BY g.k COLLATE "C") FROM (
     SELECT split_part(x, '|', 1) AS k, count(*)::int AS n, left(md5(string_agg(x, E'\\n' ORDER BY x COLLATE "C")), 12) AS d
       FROM regexp_split_to_table(r.t, ${LINHA}) AS x GROUP BY 1) g) AS tipos
FROM (SELECT (
${sql.slice(ini, fim + marca.length)}
) AS t) r`;
}
/** Estado do retrato pelo hash; divergente lista os tipos diferentes dos dois estados esperados. */
function lerRetrato(linha) {
  assert.match(String(linha?.hash), /^[0-9a-f]{64}$/, 'RETRATO_ILEGIVEL');
  const tipos = Object.fromEntries(Object.entries(linha.tipos ?? {}).map(([k, [n, d]]) => [k, {n: Number(n), md5: String(d)}]));
  const estado = Object.keys(RETRATOS).find(e => RETRATOS[e].hash === linha.hash) ?? 'DIVERGENTE';
  const r = {estado, hash: linha.hash, linhas: Number(linha.linhas), tipos};
  if (estado === 'DIVERGENTE') r.tiposDivergentes = Object.fromEntries(Object.entries(RETRATOS).map(([e, esp]) => [e,
    [...new Set([...Object.keys(esp.tipos), ...Object.keys(tipos)])].sort()
      .filter(k => esp.tipos[k]?.[0] !== tipos[k]?.n || esp.tipos[k]?.[1] !== tipos[k]?.md5)]));
  return r;
}

/** ausente | completa | parcial, pelos objetos da 098. */
function lerEstado(e) {
  for (const k of CAMPOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const chaves = Object.keys(OBJETOS), presentes = chaves.filter(k => e[k]);
  const s = Object.fromEntries(Object.keys(BASE).map(k => [k, e[k]]));
  s.m098 = presentes.length === 0 ? 'ausente' : presentes.length === chaves.length ? 'completa' : 'parcial';
  if (s.m098 === 'parcial') s.objetosAusentes = chaves.filter(k => !e[k]);
  return s;
}
/** Plano a partir do estado e do retrato; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s, retrato) {
  assert.ok(s.d094, 'DEPENDENCIA_AUSENTE_093_094');
  assert.notEqual(s.m098, 'parcial', 'APLICACAO_PARCIAL_098');
  const esperado = s.m098 === 'completa' ? '098' : '094';
  assert.equal(retrato?.estado, esperado, `RETRATO_DIVERGENTE esperado ${esperado}`);
  // Já aplicada: só a integridade REPETÍVEL (o postcheck é da instalação e recusa combinados legítimos criados depois).
  if (s.m098 === 'completa') return ['integridade 098'];
  const falta = [!s.pode_criar && 'CREATE', !s.dono_098 && 'DONO'].filter(Boolean);
  assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_098 ' + falta.join(' '));
  return ETAPAS.map(([nome]) => nome);
}

/**
 * Situação do COMMIT quando a consulta da migration falha (regra da 092–094, rodada 2 do Astra): com SQLSTATE fora das
 * classes 08/57/58/XX, o PostgreSQL desfez a transação inteira; sem SQLSTATE ou nessas classes, INDETERMINADO, a
 * reconciliar pela conferência — nunca tratado como desfeito. 40003 (statement_completion_unknown) também é
 * INDETERMINADO: o próprio servidor diz que não sabe se o comando terminou (P3 da revisão do aplicador, 24/10/2026).
 */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) && sqlstate !== '40003' ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}

/**
 * Limite das leituras que calculam o retrato estrutural: o retrato e os checks que o embutem (precheck, postcheck e
 * integridade). Em 25/10/2026 o --retrato-098 no staging terminou em statement timeout com 30 s (localmente leva ~1,2 s).
 * A espera de lock continua em 5 s; as demais leituras seguem com 30 s.
 */
const TEMPO_RETRATO = '300s';
async function somenteLeitura(db, sql, {caminho, papelDaSessao = false, tempo = '30s'} = {}) {
  assert.match(tempo, /^\d{1,3}s$/, 'TEMPO_INVALIDO');
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Leitura também espera lock (ACCESS SHARE contra DDL concorrente): espera curta, falha explícita.
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`SET LOCAL statement_timeout = '${tempo}'`);
    if (caminho) await db.query(`SET LOCAL search_path = ${caminho}`);
    // Só nesta transação de leitura: volta ao papel do login (session_user), o mesmo das conexões da aplicação.
    if (papelDaSessao) await db.query('SET LOCAL ROLE NONE');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
async function retratoNoCliente(db, raiz) {
  const inicio = Date.now();
  const linha = (await somenteLeitura(db, sqlRetrato(raiz), {caminho: 'pg_catalog', tempo: TEMPO_RETRATO})).rows[0];
  return {...lerRetrato(linha), duracaoMs: Date.now() - inicio};
}

/** Contagens e resumos agregados (sem ids): salões, combinados e festas de hoje em diante com salão. */
async function contagens(db, estado, corte) {
  const completa = estado.m098 === 'completa';
  const r = {...(await somenteLeitura(db, SQL_PRESERVACAO(corte, completa))).rows[0]};
  Object.assign(r, (await somenteLeitura(db, `SELECT
    (SELECT count(*) FROM agenda_saloes WHERE ativo)::int AS saloes_ativos,
    (SELECT count(*) FROM kidmais094_ocupacoes((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'infinity'::date) WHERE salao_id IS NOT NULL)::int AS ocupacoes_futuras_com_salao${completa ? `,
    (SELECT count(*) FROM agenda_saloes WHERE combinado)::int AS combinados` : ''}`)).rows[0]);
  return r;
}

/** Só o retrato (nenhuma escrita): identidade e retrato estrutural canônico em READ ONLY. */
async function retratarNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'retrato'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.retrato = await retratoNoCliente(db, raiz);
  r.resultado = r.retrato.estado === 'DIVERGENTE' ? 'RETRATO_DIVERGENTE' : 'RETRATO_' + r.retrato.estado;
  return r;
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, retrato, plano e, em READ ONLY, o precheck
 * (098 ausente) ou a integridade repetível (098 completa; aceita combinados e festas legítimos).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  if (r.estado.d094 && r.estado.m098 !== 'parcial') r.retrato = await retratoNoCliente(db, raiz);
  try { r.plano = planoEtapas(r.estado, r.retrato); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const corte = (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte;
  r.contagens = await contagens(db, r.estado, corte);
  // Antes da janela: a aplicação recusa com sessão não classificável (P2-2); a conferência já diz se isso acontece agora.
  if (r.plano.includes('migration 098')) {
    r.sessoes = await lerAnteriores(db, corte);
    if (r.sessoes.invisiveis > 0) { r.resultado = 'RECUSARIA'; r.motivo = 'SESSOES_NAO_CLASSIFICAVEIS ' + r.sessoes.invisiveis; return r; }
  }
  r.checks = {};
  for (const nome of r.estado.m098 === 'completa' ? ['integridade 098'] : ['precheck 098']) {
    const [, arquivo, hash] = etapa(nome);
    const inicio = Date.now();
    await somenteLeitura(db, lerRevisado(raiz, arquivo, hash), {tempo: TEMPO_RETRATO});
    (r.duracoesMs ??= {})[nome] = Date.now() - inicio;
    r.checks[nome] = 'PASS';
  }
  r.resultado = r.estado.m098 === 'completa' ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Uma escrita feita ANTES do corte, mas ainda não confirmada quando o corte é lido, entraria no "depois" e não no "antes"
 * (falso PRESERVACAO_DIVERGENTE; regra da 097). Espera, só lendo, até nenhuma outra sessão de cliente deste banco ter
 * transação aberta desde antes do corte; sem isso, recusa ANTES de qualquer escrita.
 * P2-2 da revisão do aplicador (24/10/2026): sessão cujo detalhe o papel não enxerga ('<insufficient privilege>', estado
 * nulo) não é classificável — pode ter transação anterior ao corte —, então também impede a aplicação; nunca é só
 * informada. A leitura roda com o papel do login (SET LOCAL ROLE NONE, só nessa transação READ ONLY): no Render a
 * credencial entra com `SET role` do dono, e o papel do login é o das conexões da aplicação, que ele enxerga. Nenhum
 * privilégio é concedido. A conferência informa as sessões não classificáveis antes da janela.
 */
// Para sessão invisível o PostgreSQL também esconde backend_type (NULL; conferido em PG 18 com login sem privilégio):
// filtrar por backend_type = 'client backend' as descartaria. Por isso as invisíveis são contadas pelo banco (datname
// continua visível) e por backend_type nulo; processos de fundo do banco (autovacuum) visíveis ficam fora.
const SQL_ANTERIORES = corte => `SELECT
  count(*) FILTER (WHERE backend_type = 'client backend' AND xact_start IS NOT NULL AND xact_start <= '${corte}'::timestamptz)::int AS n,
  count(*) FILTER (WHERE backend_type IS NULL AND query = '<insufficient privilege>')::int AS invisiveis
  FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()`;
const lerAnteriores = async (db, corte) => {
  const l = (await somenteLeitura(db, SQL_ANTERIORES(corte), {papelDaSessao: true})).rows[0];
  return {anteriores: Number(l?.n ?? 1), invisiveis: Number(l?.invisiveis ?? 1)};
};
async function esperarTransacoesAnteriores(db, corte, pausa, tentativas) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  let ultimo = {anteriores: 1, invisiveis: 0};
  for (let i = 0; i < tentativas; i++) {
    ultimo = await lerAnteriores(db, corte);
    if (ultimo.anteriores === 0 && ultimo.invisiveis === 0) return {esperas: i, sessoesInvisiveis: 0};
    await pausa(500);
  }
  assert.ok(ultimo.invisiveis === 0, 'SESSOES_NAO_CLASSIFICAVEIS ' + ultimo.invisiveis);
  assert.fail('TRANSACOES_ANTERIORES_AO_CORTE');
}
const dormir = ms => new Promise(fim => setTimeout(fim, ms));

/**
 * Aplicação, na ordem do plano: retrato 094 exato → precheck → migration (transação do arquivo) → COMMIT registrado →
 * estado completo → postcheck → integridade → retrato 098 → preservação. Já completa: só a integridade, sem escrita.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, pausa = dormir, tentativas = 60}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.retratoAntes = r.estadoAntes.d094 && r.estadoAntes.m098 !== 'parcial' ? await retratoNoCliente(db, raiz) : undefined;
  r.plano = planoEtapas(r.estadoAntes, r.retratoAntes); registrar(r);
  r.corte = (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte;
  if (r.plano.includes('migration 098')) r.esperasCorte = await esperarTransacoesAnteriores(db, r.corte, pausa, tentativas);
  r.contagensAntes = await contagens(db, r.estadoAntes, r.corte); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 098') {
      try { await db.query(sqls.get(nome)); } catch (e) {
        r.etapas.at(-1).commit = commitNaFalha(e); registrar(r);
        await db.query('ROLLBACK').catch(() => {}); throw e;
      }
      // A consulta voltou sem erro: o COMMIT do arquivo valeu. Registrado ANTES de qualquer outra leitura.
      r.etapas.at(-1).commit = 'CONFIRMADO'; registrar(r);
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m098, 'completa', 'ESTADO_DEPOIS_098');
    } else await somenteLeitura(db, sqls.get(nome), {tempo: TEMPO_RETRATO});
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m098, 'completa', 'ESTADO_FINAL_098');
  r.retratoDepois = await retratoNoCliente(db, raiz);
  assert.equal(r.retratoDepois.estado, '098', 'RETRATO_FINAL_098');
  r.contagensDepois = await contagens(db, r.estadoDepois, r.corte);
  const aplicou = r.plano.includes('migration 098');
  // Prova agregada (só quando esta execução aplicou): nenhum salão existente até o corte mudou de identidade nem virou combinado.
  if (aplicou) {
    for (const k of ['saloes', 'resumo_saloes'])
      assert.equal(r.contagensDepois[k], r.contagensAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
    assert.equal(r.contagensDepois.combinados_ate_corte, 0, 'PRESERVACAO_DIVERGENTE combinados_ate_corte');
  }
  r.resultado = aplicou ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_INTEGRIDADE_PASS';
  registrar(r);
  return r;
}
const commitDa = r => (r.etapas ?? []).find(x => x.nome === 'migration 098')?.commit ?? null;

/** Modo: nenhum (plano), --retrato-098, --conferir-098, ou --aplicar-098-autorizado --backup <registro>. */
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_RETRATO) return {modo: 'retrato'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    // Referência do export/PITR anotado antes (id e horário); só texto curto e seguro.
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente. `amb` fixa: nome, alvo(env) → opções do pg, SQL de identidade, identidade(linha),
 * diretório do registro e verificação do disco persistente.
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: [RETRATO, ...ETAPAS].map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      retratosEsperados: {antes: RETRATOS['094'].hash, depois: RETRATOS['098'].hash},
      modos: {retrato: FLAG_RETRATO, conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['093/094 aplicadas (agenda_saloes, contratos, fechamentos, fechamento_revisoes, kidmais094_ocupacoes e os três corpos da 094)',
        '098 ausente com retrato 094 exato, ou completa com retrato 098 (nunca parcial)', 'CREATE em public',
        'dono de ' + ALTERADAS.join('/') + ' e das três funções substituídas', 'nenhuma festa de hoje em diante em salão inativo (precheck da migration)'],
      ordem: ['deploy de uma árvore com o código da PR #223 (aceita 094 e 094 + 098) e este aplicador; conferir commit e hashes implantados',
        FLAG_RETRATO, FLAG_CONFERIR, 'backup: export do banco no painel do Render + janela PITR anotados (id e horário UTC)', 'autorização de Felipe',
        'janela combinada: sem cadastro de salões/festas nem DDL concorrente', `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir; código 1 é recusa lançada antes de criar o marcador desta execução, mas ainda assim ler o registro e rodar ' + FLAG_CONFERIR + ' antes de decidir',
        'código 2 com registroGravado=false: o marcador pode estar numa etapa anterior; estado do banco desconhecido até ' + FLAG_CONFERIR,
        'RECUSARIA/FALHA SESSOES_NAO_CLASSIFICAVEIS: há sessão que o papel do login não enxerga; não conceder privilégio automaticamente — decisão de Felipe',
        'FALHA: commit = CONFIRMADO (098 aplicada), DESFEITA_PELO_SERVIDOR (nada mudou) ou INDETERMINADO (reconciliar com a conferência antes de decidir)',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-098.<horario>.json; o novo registro lista as tentativas anteriores'],
      nuncaExecuta: ['down 098', 'alteração de env', 'deploy', 'restart', 'atualização de linhas existentes']};
  }
  async function comCliente(env, Client, modoSaida, f) {
    const db = new Client(amb.alvo(env)); db.on?.('error', () => undefined);
    try { await db.connect(); return await f(db); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: modoSaida, resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  const ctx = (env, raiz) => ({raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)});
  async function retratar({env, raiz = raizPadrao, Client = require('pg').Client}) {
    amb.alvo(env);
    return comCliente(env, Client, 'retrato', db => retratarNoCliente(db, ctx(env, raiz)));
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    amb.alvo(env);
    return comCliente(env, Client, 'conferencia', db => conferirNoCliente(db, ctx(env, raiz)));
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(), pausa, tentativas}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of [RETRATO, ...ETAPAS]) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    // Tentativas anteriores preservadas pelo operador (marcador renomeado, nunca apagado) entram no novo registro.
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-098\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    // Daqui em diante a execução começou: nenhum erro escapa (P2-1 da revisão de 24/10/2026). Uma falha de gravação do
    // registro interrompe a execução e vira FALHA (código 2) com o último estado em memória, nunca o código 1.
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {}, db = null;
    try {
      db = new Client(opts); db.on?.('error', () => undefined);
      await db.connect();
      const r = await aplicarNoCliente(db, {...ctx(env, raiz), pausa, tentativas,
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA'});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        retratoAntes: r.retratoAntes?.estado, retratoDepois: r.retratoDepois.estado, contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois,
        esperaCorte: r.esperasCorte, etapas: r.etapas.map(e => e.nome), commit: commitDa(r)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      // Já gravado no registro antes do throw: CONFIRMADO, DESFEITA_PELO_SERVIDOR ou INDETERMINADO (null = não chegou à migration).
      const situacao = {commit: commitDa(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      // Registro que não pôde ser gravado: o marcador no disco pode estar numa etapa anterior; o estado do banco é
      // desconhecido até a conferência.
      let registroGravado = true;
      try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); }
      catch (g) { registroGravado = false; falha.registro = 'NAO_GRAVADO ' + curta(g); }
      return {resultado: 'FALHA', marcador, falha, ...situacao, registroGravado, ...(registroGravado ? {} : {estadoBanco: 'DESCONHECIDO_CONFERIR'})};
    } finally { if (db) await db.end().catch(() => {}); }
  }
  /**
   * Códigos: 0 PLANO/RETRATO esperado/CONFERIDO/PASS; 1 recusa lançada ANTES de criar o marcador desta execução (trava,
   * argumentos, backup, arquivo, disco, tentativa anterior); 2 FALHA de execução iniciada (inclusive registro não gravado);
   * 3 RECUSARIA ou retrato divergente.
   */
  const CODIGO = Object.freeze({PLANO: 0, RETRATO_094: 0, RETRATO_098: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0,
    APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3, RETRATO_DIVERGENTE: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'retrato' ? await retratar({env, ...deps}) : m.modo === 'conferir' ? await conferir({env, ...deps})
      : await executar({env, backup: m.backup, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, retratar, conferir, executar, principal, cli, CODIGO};
}

module.exports = {TEMPO_RETRATO, RETRATO, ETAPAS, RETRATOS, OBJETOS, BASE, CAMPOS, ALTERADAS, SUBSTITUIDAS, FLAG_RETRATO, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR,
  SQL_ESTADO, SQL_PRESERVACAO, SQL_CORTE, SQL_ANTERIORES, commitNaFalha, lerRevisado, sqlRetrato, lerRetrato, lerEstado, planoEtapas,
  retratarNoCliente, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
