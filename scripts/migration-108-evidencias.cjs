/* eslint-disable @typescript-eslint/no-require-imports */
// Conferências históricas × 108 (plano E4, E4-6; critérios P2-E4-R2-2 e P3-E4-R2-1 da rev. 2.1). Sem banco: este módulo
// só GERA SQL somente leitura e interpreta as linhas; quem executa é o aplicador (092–094, 100 e 098).
//   * evidências da 108 (só catálogo, nenhuma leitura de dados nem chamada de função do escopo): marcador
//     kidmais108_instalada(), registro kidmais107_reparos (a 107, pré-requisito da 108), colunas combinado/membros, corpo
//     da regra de conflito da 108, os três corpos substituídos pela 108 e funções kidmais098_* com os corpos da 108;
//   * "108 íntegra" tem UM significado em todos os aplicadores: sqlProva108Integra() de scripts/migration-108-retrato.cjs
//     (detector NOVA + corpo do marcador + metadados das 14 funções + retrato de F2 igual ao medido), rodada aqui numa
//     transação READ ONLY com `SET LOCAL search_path = pg_catalog` (a sessão que o retrato exige). Enquanto o esperado
//     de F2 não for medido, a prova não é gerada e o resultado é "não íntegra" (recusa nomeada, nunca sucesso).
// A 098 histórica também cria combinado/membros e funções kidmais098_* (com OUTROS corpos): por isso as colunas só contam
// junto com o corpo de conflito da 108, e as funções só com os corpos da 108.
const retrato108 = require('./migration-108-retrato.cjs');
/** Recusa nomeada (o CONFERIR a devolve como RECUSARIA com o motivo; no APLICAR vira FALHA antes de qualquer escrita). */
const recusa = mensagem => Object.assign(new Error(mensagem), {recusa: true});

const {NOVA} = retrato108;
const CONFLITO = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';
const CORPO_CONFLITO_108 = NOVA.hashes.conflito108;
/** Os três corpos que a 108 substitui (assinatura → sha256 do prosrc sem CR). */
const CORPOS_108 = Object.freeze([[CONFLITO, NOVA.hashes.conflito108], ['kidmais019_validar_contrato()', NOVA.hashes.contrato],
  ['kidmais_validar_agenda_revisao()', NOVA.hashes.revisao]]);
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const hashProc = x => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(${x}, E'\\r', ''), 'UTF8')), 'hex')`;

/** Evidências da 108 (READ ONLY, só pg_catalog; nomes totalmente qualificados, independente do search_path). */
const SQL_EVIDENCIA_108 = `/* evidencia-108 */ SELECT
  (pg_catalog.to_regprocedure('public.kidmais108_instalada()') IS NOT NULL) AS marcador_108,
  (pg_catalog.to_regclass('public.kidmais107_reparos') IS NOT NULL) AS reparos_107,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.agenda_saloes')
            AND a.attname IN ('combinado', 'membros') AND a.attnum > 0 AND NOT a.attisdropped) AS colunas_combinado,
  coalesce((SELECT ${hashProc('p.prosrc')} FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${lit('public.' + CONFLITO)}))
    = ${lit(CORPO_CONFLITO_108)}, false) AS corpo_conflito_108,
  (SELECT count(*)::int FROM (VALUES
      ${CORPOS_108.map(([f, h]) => `(${lit('public.' + f)}, ${lit(h)})`).join(',\n      ')}) AS e(f, h)
    JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.f) WHERE ${hashProc('p.prosrc')} = e.h) AS corpos_108,
  (SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais098\\_%'
      AND ${hashProc('p.prosrc')} IN (${Object.values(NOVA.funcoes).map(lit).join(', ')})) AS funcoes_098_108`;

const BOOLEANOS = Object.freeze(['marcador_108', 'reparos_107', 'colunas_combinado', 'corpo_conflito_108']);
const INTEIROS = Object.freeze(['corpos_108', 'funcoes_098_108']);
/** Linha de SQL_EVIDENCIA_108 validada; ilegível lança (nunca vira "sem evidência"). */
function lerEvidencias108(linha) {
  const e = {};
  for (const k of BOOLEANOS) {
    if (typeof linha?.[k] !== 'boolean') throw new Error('EVIDENCIA_108_ILEGIVEL ' + k);
    e[k] = linha[k];
  }
  for (const k of INTEIROS) {
    const n = Number(linha?.[k]);
    if (!Number.isInteger(n) || n < 0 || typeof linha?.[k] === 'boolean' || linha?.[k] === null) throw new Error('EVIDENCIA_108_ILEGIVEL ' + k);
    e[k] = n;
  }
  return e;
}
/**
 * Evidências da PRÓPRIA 108 (sem a 107): marcador, corpos substituídos com o hash da 108, funções kidmais098_* com corpos
 * da 108 e colunas combinado/membros junto com o corpo de conflito da 108. Lista vazia = nenhuma.
 */
function evidencias108(e) {
  return [e.marcador_108 && 'marcador_108', e.corpos_108 > 0 && 'corpos_108', e.funcoes_098_108 > 0 && 'funcoes_098_108',
    e.colunas_combinado && e.corpo_conflito_108 && 'colunas_combinado_com_corpo_108'].filter(Boolean);
}
/**
 * Para a 098 histórica (COM_108): só o que a 098 NUNCA produz — o marcador da 108, a regra de conflito da 108 e o registro da
 * 107. As funções kidmais098_* e os corpos de contrato/revisão são IDÊNTICOS na 098 e na 108 (medido no cluster E4,
 * 29/10/2026: com eles, a 098 recém-aplicada recusava o próprio retrato). Uma 108 parcial sem esses três é, no catálogo, a
 * mesma coisa que uma 098 parcial, e o retrato recursivo do aplicador 098 já a recusa.
 */
function evidenciasCom108(e) {
  return [e.marcador_108 && 'marcador_108', e.corpo_conflito_108 && 'corpo_conflito_108', e.reparos_107 && 'reparos_107'].filter(Boolean);
}

const VERSAO_MAIOR = retrato108.VERSAO_MAIOR;
/** O mesmo override SÓ DE TESTE do aplicador 107/108 (scripts/migration-107-108-comum.cjs, esperadosDe). */
const ENV_RETRATOS_TESTE = 'KIDMAIS_RETRATOS_108_TESTE';
/**
 * Esperados do retrato da 108: os do arquivo (database/checks/20261029_108_retratos_esperados.json) ou, SÓ num aplicador
 * criado com `aceitaRetratosTeste: true` (a suíte PostgreSQL; staging nunca), os injetados em KIDMAIS_RETRATOS_108_TESTE
 * (JSON no mesmo formato do arquivo, medido no cluster). Variável presente num aplicador que não aceita = recusa nomeada.
 */
function esperados108({env = {}, raiz, aceitaTeste = false} = {}) {
  const injetado = env?.[ENV_RETRATOS_TESTE];
  if (injetado === undefined) return retrato108.carregarEsperados(raiz);
  if (aceitaTeste !== true) throw recusa('RETRATOS_DE_TESTE_RECUSADOS (' + ENV_RETRATOS_TESTE + ' só vale na suíte PostgreSQL)');
  let x;
  try { x = JSON.parse(injetado); } catch { throw recusa('RETRATOS_DE_TESTE_ILEGIVEIS'); }
  if (!x || typeof x !== 'object') throw recusa('RETRATOS_DE_TESTE_ILEGIVEIS');
  return x;
}
/**
 * SQL da prova, envolvida para devolver também o search_path e a versão da sessão (a prova só vale com
 * search_path = pg_catalog e PostgreSQL 18, como o retrato). Lança se o esperado de F2 ainda não foi medido.
 * Chamada pelo objeto do módulo (retrato108.sqlProva108Integra): fonte única da definição de "108 íntegra".
 */
function sqlProva108({raiz, esperados} = {}) {
  return `/* prova-108 */ SELECT p.integra, p.motivos, pg_catalog.current_setting('search_path') AS search_path,
  pg_catalog.current_setting('server_version_num')::int AS versao_pg
FROM (
${retrato108.sqlProva108Integra({raiz, ...(esperados ? {esperados} : {})})}
) p`;
}
/** Interpreta a linha da prova: íntegra só com integra = true, nenhum motivo, sessão pg_catalog e versão maior 18. */
function lerProva108(linha) {
  if (typeof linha?.integra !== 'boolean' || !Array.isArray(linha?.motivos) || linha.motivos.some(m => typeof m !== 'string')) {
    return {integra: false, motivos: ['PROVA_108_ILEGIVEL']};
  }
  const motivos = [...linha.motivos];
  if (linha.search_path !== 'pg_catalog') motivos.push('SESSAO_PROVA_108 search_path');
  if (Math.floor(Number(linha.versao_pg) / 10000) !== VERSAO_MAIOR) motivos.push('SESSAO_PROVA_108 versao_pg');
  return {integra: linha.integra && motivos.length === 0, motivos};
}
/** Tempo das leituras da prova (o retrato de F2 é restrito; espera de lock curta como nas demais leituras). */
const TEMPO_PROVA_108 = '120s';
/**
 * Roda a prova em READ ONLY (search_path = pg_catalog só nesta transação). Esperado de F2 não medido ou consulta
 * recusada pelo gerador = não íntegra com o motivo, sem consultar o banco. `aceitaTeste` vem do aplicador (nunca do env).
 */
async function provar108(db, {raiz, env, aceitaTeste = false} = {}) {
  // Override de teste recusado ou ilegível: recusa nomeada (lançada), antes de qualquer consulta.
  const esperados = esperados108({env, raiz, aceitaTeste});
  let sql;
  try { sql = sqlProva108({raiz, esperados}); } catch (e) { return {integra: false, motivos: ['PROVA_108_INDISPONIVEL ' + String(e?.message ?? e).split(':')[0]]}; }
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`SET LOCAL statement_timeout = '${TEMPO_PROVA_108}'`);
    await db.query('SET LOCAL search_path = pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return lerProva108(r.rows?.[0]);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
module.exports = {CONFLITO, CORPO_CONFLITO_108, CORPOS_108, SQL_EVIDENCIA_108, TEMPO_PROVA_108, lerEvidencias108, evidencias108, evidenciasCom108,
  ENV_RETRATOS_TESTE, esperados108, sqlProva108, lerProva108, provar108, recusa};
