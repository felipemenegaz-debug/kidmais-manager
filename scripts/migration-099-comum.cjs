/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 099 (convites avulsos) no padrão dos aplicadores 096/097 — usado pelo adaptador de
// produção (scripts/migration-099-production.cjs, que fixa o alvo, a identidade da conexão e o disco). O aplicador de
// staging (scripts/migration-099-staging.cjs) já foi usado em 24/10/2026 e fica como está.
// Ordem: a 099 vem ANTES do código de Convites avulsos (o código novo não detecta a 099); em produção é parte do E3 do plano
// de promoção, com o código antigo ainda publicado, que continua compatível com o schema da 099.
// O que muda em relação ao staging (plano de promoção, B-2):
//   - pré-condição nova (database/checks/20261025_099_vinculo_versao.sql): a 099 passa a exigir, em todo INSERT/UPDATE de
//     convite vinculado, que a versão seja do contrato da festa; convite existente fora disso recusa a aplicação;
//   - privilégio conferido antes do DDL: current_user dono de convites, convite_ia_autorizacoes e das duas funções;
//   - estado ausente/completa/parcial pelos objetos da 099 (CHECK, índice, colunas nuláveis, corpos das funções por sha256);
//   - plano sem conexão, --backup obrigatório, códigos 0/1/2/3 e saída JSON sanitizada.
// Aplicação numa TRANSAÇÃO ÚNICA, sob trava exclusiva: BEGIN → lock_timeout 5s/statement_timeout 60s → advisory lock →
// LOCK TABLE convites, convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE → precheck → vínculo/versão → retrato agregado →
// DDL da 099 (o arquivo sem BEGIN/COMMIT) → postcheck → retrato igual → COMMIT. Qualquer falha antes do COMMIT desfaz tudo;
// falha DURANTE o COMMIT fica INDETERMINADA (reconciliar pela conferência, nunca repetir).
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens e md5 agregados (sem ids nem dados pessoais).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-099';
const FLAG_APLICAR = '--aplicar-099-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-099.json';
const ETAPAS = Object.freeze([
  ['precheck 099', 'database/checks/20261024_099_precheck.sql', '9d0932e23fcae892a80daab17040627c1a9cb10a96ded08d995fa0d5738fba51'],
  ['vinculo-versao 099', 'database/checks/20261025_099_vinculo_versao.sql', '83858393eb5652c77872dac53e7ed6e861930bebf6a4f70af2cfbcefd0ef986e'],
  ['migration 099', 'database/migrations/20261024_099_convites_avulsos.sql', '3cbff37dfd4ad5e2272f7f8989e1f5131197c6244c071402075c0e1aa8c12ee5'],
  ['postcheck 099', 'database/checks/20261024_099_postcheck.sql', '1498f16c2129c2572543d38e9704b7fc815c497123da165afb04fe04d9e728c7'],
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
/** Corpos das funções (sha256 do prosrc com CRLF normalizado): 073/088 antes da 099 e os da 099 (precheck/postcheck). */
const CORPOS = Object.freeze({
  vinculo: Object.freeze({antes: '44e558acf648b665b88ac1d3846583c1f0c4e134f47ec4fe97e31241194e73e1', depois: '0f0553ac92d6eeb474d7830c2e3daf1084c2010d752f2f68350a9fa30daba1f3'}),
  autorizacao: Object.freeze({antes: 'b8e50a37f1736d7def652d7929b6660cd310c67bd6e8ca5257d09841eb23a0a1', depois: 'd89b8062a972a3f62f0b0ccaf67fa72662a7019cd0c7a734b3134a45787efc2c'}),
});
/** Tabelas e funções que a 099 altera: ALTER TABLE, CREATE INDEX e CREATE OR REPLACE FUNCTION exigem ser dono. */
const ALTERADAS = Object.freeze(['convites', 'convite_ia_autorizacoes']);
const FUNCOES = Object.freeze(['convite_validar_vinculo()', 'convite_ia_autorizacao_validar()']);
const hashCorpo = f => `(SELECT encode(sha256(convert_to(replace(prosrc,E'\\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.${f}'))`;
const lista = xs => xs.map(x => `'${x}'`).join(',');
/**
 * CHECK da 099 provado pela SEMÂNTICA, analisado LOCALMENTE (revisão do B-2: nome não prova estrutura; tirar parênteses
 * apaga o agrupamento; avaliar no servidor texto do catálogo deixava passar chamadas como "festa_id()" ou nomes
 * concatenados). A conferência só LÊ a definição (pg_get_constraintdef, como texto) e este módulo:
 *   1) separa a expressão em tokens INTEIROS — só as 5 colunas, IS, NOT, NULL, AND, OR, "(" e ")"; qualquer outro token
 *      (função, nome concatenado, literal, operador, aspas, comentário, ponto e vírgula) recusa;
 *   2) analisa uma gramática fechada: expr := termo (OR termo)*; termo := fator (AND fator)*;
 *      fator := "(" expr ")" | coluna IS [NOT] NULL — uma coluna seguida de "(" (chamada) não é fator válido;
 *   3) avalia a árvore localmente nas 32 combinações de nulo/não nulo e compara cada resultado com a regra da migration:
 *      vínculo vazio (as 5 nulas) OU festa, cliente e versão preenchidos.
 * Nada do texto do catálogo é executado. Qualquer recusa ou diferença = definição divergente = estado PARCIAL.
 */
const CHECK_COLUNAS = Object.freeze(['festa_id', 'cliente_id', 'versao_contrato_id', 'estabelecimento_id', 'editor_hash']);
const PALAVRAS_CHECK = Object.freeze(new Set([...CHECK_COLUNAS, 'IS', 'NOT', 'NULL', 'AND', 'OR']));
/** Regra da migration: [festa, cliente, versão, estabelecimento, editor] preenchidos? → o CHECK aceita? */
function regraCheck099(preenchidos) {
  const [festa, cliente, versao] = preenchidos;
  return preenchidos.every(x => !x) || (festa && cliente && versao);
}
/** As 32 combinações, cada uma com o valor esperado da regra. */
const TABELA_VERDADE = Object.freeze(Array.from({length: 2 ** CHECK_COLUNAS.length}, (_, mascara) => {
  const preenchidos = CHECK_COLUNAS.map((_, i) => Boolean(mascara & (1 << i)));
  return Object.freeze({preenchidos: Object.freeze(preenchidos), esperado: regraCheck099(preenchidos)});
}));
/** Tokens inteiros: espaços separam; "(" e ")" são tokens próprios; tudo o mais tem de ser uma palavra permitida. */
function tokensCheck(expressao) {
  const tokens = String(expressao).replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) assert.ok(t === '(' || t === ')' || PALAVRAS_CHECK.has(t), 'CHECK_TOKEN_RECUSADO');
  return tokens;
}
/** Árvore da expressão pela gramática fechada (lança CHECK_GRAMATICA_RECUSADA em qualquer desvio). */
function arvoreCheck(expressao) {
  const tokens = tokensCheck(expressao);
  let i = 0;
  const olhar = () => tokens[i];
  const comer = t => { assert.ok(tokens[i] === t, 'CHECK_GRAMATICA_RECUSADA'); i++; };
  function fator() {
    if (olhar() === '(') { comer('('); const v = expr(); comer(')'); return v; }
    const coluna = tokens[i++];
    assert.ok(CHECK_COLUNAS.includes(coluna), 'CHECK_GRAMATICA_RECUSADA');
    comer('IS');
    let negado = false;
    if (olhar() === 'NOT') { comer('NOT'); negado = true; }
    comer('NULL');
    return {tipo: negado ? 'preenchida' : 'nula', coluna};
  }
  function termo() { const filhos = [fator()]; while (olhar() === 'AND') { comer('AND'); filhos.push(fator()); } return filhos.length === 1 ? filhos[0] : {tipo: 'e', filhos}; }
  function expr() { const filhos = [termo()]; while (olhar() === 'OR') { comer('OR'); filhos.push(termo()); } return filhos.length === 1 ? filhos[0] : {tipo: 'ou', filhos}; }
  const raiz = expr();
  assert.ok(i === tokens.length, 'CHECK_GRAMATICA_RECUSADA');
  return raiz;
}
function avaliarArvore(no, preenchidas) {
  if (no.tipo === 'nula') return !preenchidas.has(no.coluna);
  if (no.tipo === 'preenchida') return preenchidas.has(no.coluna);
  return no.tipo === 'e' ? no.filhos.every(f => avaliarArvore(f, preenchidas)) : no.filhos.some(f => avaliarArvore(f, preenchidas));
}
/** Definição reconstruída pelo servidor ("CHECK (...)") → true só se a gramática aceita e as 32 combinações batem. */
function definicaoCheck099Valida(definicao) {
  if (typeof definicao !== 'string' || !definicao.startsWith('CHECK ')) return false;
  let raiz;
  try { raiz = arvoreCheck(definicao.slice(6)); } catch { return false; }
  return TABELA_VERDADE.every(({preenchidos, esperado}) =>
    avaliarArvore(raiz, new Set(CHECK_COLUNAS.filter((_, k) => preenchidos[k]))) === esperado);
}
const DEF_INDICE = '^CREATEINDEXconvites_empresa_atualizadoON(public\\.)?convitesUSINGbtreeempresa_id,atualizado_emDESC,id$';
const COLUNAS = Object.freeze([['convites', 'festa_id'], ['convites', 'cliente_id'], ['convites', 'versao_contrato_id'], ['convite_ia_autorizacoes', 'festa_id']]);
const SEM_PARENTESES = "'[()[:space:]]'";
/** Estado estrutural (leitura): dependências, cada objeto da 099, corpos e privilégios de dono. Sem dados. */
const SQL_ESTADO = `SELECT
  to_regclass('public.convites') IS NOT NULL AND to_regclass('public.convite_ia_autorizacoes') IS NOT NULL
    AND to_regprocedure('public.convite_validar_vinculo()') IS NOT NULL AND to_regprocedure('public.convite_ia_autorizacao_validar()') IS NOT NULL AS dependencias,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.convites') AND conname='convite_avulso_vinculo_completo') AS restricao,
  -- Só a LEITURA da definição (texto); a análise é local, em definicaoCheck099Valida. Nada do catálogo é executado.
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=to_regclass('public.convites') AND conname='convite_avulso_vinculo_completo'
    AND contype='c' AND convalidated) AS restricao_def,
  to_regclass('public.convites_empresa_atualizado') IS NOT NULL AS indice,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.convites_empresa_atualizado') AND i.indrelid=to_regclass('public.convites')
    AND i.indisvalid AND i.indisready AND NOT i.indisunique
    AND regexp_replace(pg_get_indexdef(i.indexrelid),${SEM_PARENTESES},'','g') ~ '${DEF_INDICE}') AS indice_definicao,
  (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND is_nullable='YES'
    AND (table_name, column_name) IN (${COLUNAS.map(([t, c]) => `('${t}','${c}')`).join(',')})) AS colunas_nulaveis,
  coalesce(${hashCorpo('convite_validar_vinculo()')}='${CORPOS.vinculo.depois}', false) AS corpo_vinculo,
  coalesce(${hashCorpo('convite_ia_autorizacao_validar()')}='${CORPOS.autorizacao.depois}', false) AS corpo_autorizacao,
  coalesce(${hashCorpo('convite_validar_vinculo()')}='${CORPOS.vinculo.antes}', false) AS corpo_vinculo_073,
  coalesce(${hashCorpo('convite_ia_autorizacao_validar()')}='${CORPOS.autorizacao.antes}', false) AS corpo_autorizacao_088,
  coalesce((SELECT bool_and(pg_has_role(current_user, d, 'USAGE')) AND count(*)=${ALTERADAS.length + FUNCOES.length} FROM (
    SELECT relowner AS d FROM pg_class WHERE oid IN (SELECT to_regclass('public.'||t) FROM unnest(ARRAY[${lista(ALTERADAS)}]) t)
    UNION ALL SELECT proowner FROM pg_proc WHERE oid IN (SELECT to_regprocedure('public.'||f) FROM unnest(ARRAY[${lista(FUNCOES)}]) f)) x), false) AS dono,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT has_language_privilege(current_user,'plpgsql','USAGE')), false) AS plpgsql,
  session_user <> current_user AS papel_trocado`;
/** Objetos da 099 cuja PRESENÇA conta para ausente/parcial; completa exige também as definições e as 4 colunas. */
const OBJETOS = Object.freeze(['restricao', 'indice', 'corpo_vinculo', 'corpo_autorizacao']);
const CAMPOS = Object.freeze(['dependencias', ...OBJETOS, 'indice_definicao', 'corpo_vinculo_073', 'corpo_autorizacao_088',
  'dono', 'pode_criar', 'plpgsql', 'papel_trocado']);
/** Retrato agregado (sem ids): contagens e md5 das colunas de vínculo que a 099 não pode alterar. */
const SQL_RETRATO = `/* retrato-099 */ SELECT
  (SELECT count(*)::int FROM convites) AS convites,
  (SELECT count(*)::int FROM convites WHERE festa_id IS NULL) AS convites_avulsos,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, empresa_id, festa_id, cliente_id, estabelecimento_id, versao_contrato_id), ',' ORDER BY id)), 'vazio') FROM convites) AS resumo_convites,
  (SELECT count(*)::int FROM convite_ia_autorizacoes) AS autorizacoes,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, convite_id, festa_id, revogada_em), ',' ORDER BY id)), 'vazio') FROM convite_ia_autorizacoes) AS resumo_autorizacoes`;
/** Mesma condição do check vínculo/versão, só a contagem: informativa na conferência. */
const SQL_INCOMPATIVEIS = `SELECT count(*)::int AS incompativeis FROM convites cv
  WHERE cv.festa_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM festas f JOIN contratos c ON c.id=f.contrato_id JOIN fechamentos fe ON fe.id=c.fechamento_id
     WHERE f.id=cv.festa_id AND fe.empresa_id=cv.empresa_id AND fe.cliente_id=cv.cliente_id
       AND fe.estabelecimento_id IS NOT DISTINCT FROM cv.estabelecimento_id
       AND EXISTS (SELECT 1 FROM contrato_versoes v WHERE v.id=cv.versao_contrato_id AND v.contrato_id=c.id))`;
const RETRATO_CAMPOS = Object.freeze(['convites', 'convites_avulsos', 'resumo_convites', 'autorizacoes', 'resumo_autorizacoes']);

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
/** O arquivo da migration sem as linhas BEGIN;/COMMIT; — roda dentro da transação única do aplicador. */
function semTransacao(sql) {
  const linhas = sql.split('\n');
  assert.equal(linhas.filter(l => /^\s*BEGIN;\s*$/.test(l)).length, 1, 'MIGRATION_SEM_BEGIN_UNICO');
  assert.equal(linhas.filter(l => /^\s*COMMIT;\s*$/.test(l)).length, 1, 'MIGRATION_SEM_COMMIT_UNICO');
  return linhas.filter(l => !/^\s*(BEGIN|COMMIT);\s*$/.test(l)).join('\n');
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/**
 * ausente | completa | parcial (uma transação só: parcial = alteração manual ou deriva). Ausente: nenhum objeto da 099 e
 * nenhuma das 4 colunas já nulável; completa: todos os objetos, CHECK e índice com a definição revisada e as 4 colunas
 * nuláveis; qualquer outra combinação é parcial, com a lista do que diverge (revisão do B-2, P2-1 e P3).
 */
function lerEstado(e) {
  for (const k of CAMPOS) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  assert.ok(Number.isInteger(e?.colunas_nulaveis) && e.colunas_nulaveis >= 0 && e.colunas_nulaveis <= COLUNAS.length, 'ESTADO_ILEGIVEL colunas_nulaveis');
  assert.ok(e.restricao_def === null || typeof e.restricao_def === 'string', 'ESTADO_ILEGIVEL restricao_def');
  const restricaoDefinicao = definicaoCheck099Valida(e.restricao_def);
  const algum = OBJETOS.some(k => e[k]) || e.colunas_nulaveis > 0;
  const divergencias = [...OBJETOS.filter(k => !e[k]), ...(e.restricao && !restricaoDefinicao ? ['restricao_definicao'] : []),
    ...(e.indice && !e.indice_definicao ? ['indice_definicao'] : []),
    ...(e.colunas_nulaveis < COLUNAS.length ? [`colunas_nulaveis ${e.colunas_nulaveis}/${COLUNAS.length}`] : [])];
  const m099 = !algum ? 'ausente' : divergencias.length === 0 ? 'completa' : 'parcial';
  return {dependencias: e.dependencias, m099, ...(m099 === 'parcial' ? {divergencias} : {}),
    corposAnteriores: e.corpo_vinculo_073 && e.corpo_autorizacao_088, dono: e.dono, pode_criar: e.pode_criar, plpgsql: e.plpgsql, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.dependencias, 'DEPENDENCIA_AUSENTE_073_088');
  assert.notEqual(s.m099, 'parcial', 'APLICACAO_PARCIAL_099 ' + (s.divergencias ?? []).join(','));
  if (s.m099 === 'completa') return ['postcheck 099'];
  // Ausente com corpo diferente do da 073/088: o precheck também recusaria; aqui a recusa vem antes de qualquer escrita.
  assert.ok(s.corposAnteriores, 'CORPO_ANTERIOR_DIVERGENTE_099');
  // Dono (ALTER TABLE, CREATE INDEX, CREATE OR REPLACE FUNCTION), CREATE no schema e USAGE na linguagem plpgsql.
  const falta = [!s.dono && 'DONO', !s.pode_criar && 'CREATE', !s.plpgsql && 'PLPGSQL'].filter(Boolean);
  assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_099 ' + falta.join(' '));
  return ETAPAS.map(([nome]) => nome);
}

/**
 * Situação do COMMIT quando ele falha: erro do PostgreSQL com SQLSTATE fora das classes 08/57/58/XX desfaz; sem resposta,
 * conexão perdida, cancelamento (57014 inclusive), recurso ou erro interno = INDETERMINADO (nunca tratado como desfeito).
 */
function commitNaFalha(e) {
  const sqlstate = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  return sqlstate && !/^(08|57|58|XX)/.test(sqlstate) ? 'DESFEITA_PELO_SERVIDOR' : 'INDETERMINADO';
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

/**
 * Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano, retrato agregado e, em READ ONLY, o
 * precheck + vínculo/versão (ausente) ou o postcheck (completa).
 */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = {...(await somenteLeitura(db, SQL_RETRATO)).rows[0]};
  for (const k of ['resumo_convites', 'resumo_autorizacoes']) delete r.contagens[k];
  r.checks = {};
  if (r.estado.m099 === 'completa') {
    await somenteLeitura(db, lerRevisado(raiz, ...etapa('postcheck 099').slice(1)));
    r.checks['postcheck 099'] = 'PASS';
    r.resultado = 'JA_APLICADA_POSTCHECK_PASS';
    return r;
  }
  r.contagens.incompativeis = (await somenteLeitura(db, SQL_INCOMPATIVEIS)).rows[0]?.incompativeis;
  await somenteLeitura(db, lerRevisado(raiz, ...etapa('precheck 099').slice(1)));
  r.checks['precheck 099'] = 'PASS';
  try { await somenteLeitura(db, lerRevisado(raiz, ...etapa('vinculo-versao 099').slice(1))); r.checks['vinculo-versao 099'] = 'PASS'; }
  catch (e) { r.checks['vinculo-versao 099'] = 'RECUSA'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = 'PRONTA_PARA_APLICAR';
  return r;
}

/**
 * Aplicação na transação única descrita no cabeçalho. `registrar` grava cada passo no marcador; o estado do COMMIT
 * (`commit`) é ENVIADO antes da consulta, CONFIRMADO quando ela volta e DESFEITA/INDETERMINADO quando falha.
 */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const ddl = semTransacao(sqls.get('migration 099'));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.plano = planoEtapas(r.estadoAntes); registrar(r);
  if (r.estadoAntes.m099 === 'completa') {
    await somenteLeitura(db, sqls.get('postcheck 099'));
    r.etapas.push({nome: 'postcheck 099', ok: true});
    r.resultado = 'JA_APLICADA_POSTCHECK_PASS'; registrar(r);
    return r;
  }
  const passo = async (nome, sql) => { r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r); const x = await db.query(sql);
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r); return x; };
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; SET LOCAL search_path = public, pg_catalog");
    await passo('trava', "SELECT pg_advisory_xact_lock(990024); LOCK TABLE convites, convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE");
    // Sob a trava: o estado não pode ter mudado desde a leitura (nada concorrente entre o plano e o DDL).
    assert.equal(lerEstado((await db.query(SQL_ESTADO)).rows[0]).m099, 'ausente', 'ESTADO_MUDOU_ANTES_DA_TRAVA');
    await passo('precheck 099', sqls.get('precheck 099'));
    await passo('vinculo-versao 099', sqls.get('vinculo-versao 099'));
    r.retratoAntes = {...(await db.query(SQL_RETRATO)).rows[0]}; registrar(r);
    await passo('migration 099', ddl);
    await passo('postcheck 099', sqls.get('postcheck 099'));
    assert.equal(lerEstado((await db.query(SQL_ESTADO)).rows[0]).m099, 'completa', 'ESTADO_DEPOIS_099');
    r.retratoDepois = {...(await db.query(SQL_RETRATO)).rows[0]};
    // Prova de preservação dentro da transação, sob a trava: nenhum convite nem autorização mudou de vínculo ou sumiu.
    for (const k of RETRATO_CAMPOS) assert.equal(r.retratoDepois[k], r.retratoAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    r.commit = 'NAO_ENVIADO'; registrar(r);
    throw e;
  }
  r.commit = 'ENVIADO'; registrar(r);
  try { await db.query('COMMIT'); } catch (e) { r.commit = commitNaFalha(e); registrar(r); throw e; }
  r.commit = 'CONFIRMADO'; registrar(r);
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m099, 'completa', 'ESTADO_FINAL_099');
  r.resultado = 'APLICADA_POSTCHECK_PASS'; registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-099, ou --aplicar-099-autorizado --backup <registro>. */
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    // Referência do backup feito antes (ex.: horário e id do dump, PITR anotado); só texto curto e seguro.
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente. `amb` fixa: nome, alvo(env) → opções do pg, SQL de identidade, identidade(linha),
 * diretório do registro, verificação do disco persistente e a ordem operacional mostrada no plano.
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR, marcador: MARCADOR,
      preRequisitos: ['073/088: convites, convite_ia_autorizacoes e as duas funções com os corpos revisados', 'CREATE em public e USAGE em plpgsql',
        '099 ausente ou completa (nunca parcial)', 'nenhum convite vinculado com versão fora do contrato da festa',
        'current_user dono de ' + [...ALTERADAS, ...FUNCOES].join(', ')],
      ordem: amb.ordem,
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA com commit INDETERMINADO: rodar a conferência antes de qualquer decisão; com NAO_ENVIADO ou DESFEITA_PELO_SERVIDOR nada mudou',
        'vinculo-versao recusou: nada foi alterado; decidir com Felipe o tratamento dos convites contados (sem corrigir dados por este aplicador)',
        'retomada só com decisão de Felipe: renomear o marcador (nunca apagar) para migration-099.<horario>.json'],
      nuncaExecuta: ['down 099', 'alteração de env', 'atualização de convites ou autorizações', 'deploy', 'restart']};
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
    const anteriores = fs.readdirSync(dir).filter(n => n.startsWith('migration-099.') && n.endsWith('.json') && n !== MARCADOR).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA'});
      return {resultado: r.resultado, marcador, commit: r.commit ?? null, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        retratoAntes: r.retratoAntes, retratoDepois: r.retratoDepois, etapas: r.etapas.map(e => e.nome)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      const commit = ultimo.commit ?? 'NAO_ENVIADO';
      const situacao = {commit, migracaoCommitada: commit === 'CONFIRMADO' ? true : commit === 'INDETERMINADO' ? null : false,
        reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      salvar({...ultimo, situacao: 'FALHA', falha, ...situacao});
      return {resultado: 'FALHA', marcador, falha, ...situacao};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, ...deps, backup: m.backup});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {ETAPAS, CORPOS, ALTERADAS, FUNCOES, COLUNAS, CHECK_COLUNAS, TABELA_VERDADE, regraCheck099, tokensCheck, arvoreCheck, definicaoCheck099Valida, DEF_INDICE, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, OBJETOS, CAMPOS, SQL_ESTADO, SQL_RETRATO,
  SQL_INCOMPATIVEIS, RETRATO_CAMPOS, lerRevisado, semTransacao, lerEstado, planoEtapas, commitNaFalha, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
