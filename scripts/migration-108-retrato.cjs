/* eslint-disable @typescript-eslint/no-require-imports */
// Retrato restrito da 107/108 por fase e a prova única de "108 íntegra" (plano E4, E4-3 e critérios P2-E4-R2-1/R2-2 da
// rev. 2.1). Sem banco: este módulo só GERA SQL somente leitura e compara hashes; quem executa é o aplicador.
//   * escopo: o inventário congelado de scripts/migration-108-inventario.cjs (ponto fixo das fontes);
//   * retrato (FONTE ÚNICA: database/checks/20261029_108_retrato.sql, entre RETRATO_108_INICIO/FIM; este gerador produz
//     o mesmo texto e o teste confere byte a byte): funções do escopo (assinatura, sha256 do corpo sem CR, linguagem,
//     volatilidade, SECURITY DEFINER, STRICT, LEAKPROOF, PARALLEL, proconfig/search_path, retorno, dono e ACL
//     normalizados), presença de cada função e relação, colunas de todas as tabelas do escopo e das lidas (nome, tipo,
//     nulidade, default), e, só nas tabelas do escopo, constraints c/f/p/u/x, índices e gatilhos não internos, mais o
//     corpo do marcador kidmais108_instalada;
//   * determinismo: o chamador fixa `SET LOCAL search_path = pg_catalog` (pg_get_*def qualifica tudo de public, e o
//     texto fica como o catálogo o dá: nenhuma normalização, que apagaria também o conteúdo de literais — P2-1 da
//     revisão da E4), ordenação COLLATE "C", PostgreSQL versão maior 18. A consulta devolve o search_path
//     e a versão para o comparador recusar outra sessão;
//   * fases: F0 (pré-107: a base canônica ou a deriva conhecida do staging, como estiverem), F1 (pós-107/pré-108) e F2
//     (pós-108). A MESMA consulta serve às três; a fase só escolhe os hashes esperados de
//     database/checks/20261029_108_retratos_esperados.json. Enquanto um esperado for A_MEDIR_NO_CLUSTER, nenhuma
//     comparação é feita (recusa) — nunca se aceita como referência o retrato encontrado no alvo;
//   * dono e ACL: o dono igual ao de agenda_saloes vira DONO_AGENDA_SALOES; na ACL, o grantee/grantor 0 vira PUBLIC e o
//     dono da função vira DONO; outros papéis ficam pelo nome (dependem do ambiente: ver o relatório da E4).
// sqlProva108Integra(): a definição ÚNICA de "108 íntegra" para TODOS os aplicadores (094, 100, 107/108; P2-E4-R2-2) =
// as condições do detector NOVA (lib/agenda/estado-combinados.ts) em SQL + corpo do marcador + metadados das 14 funções
// da 108 (dono, linguagem, volatilidade, SECURITY, search_path, sem sobrecarga) + o retrato de F2 igual ao esperado +
// a integridade da 107 (migration-107-definicoes.cjs, sqlIntegridade107: estrutura e linhas do registro).
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const inv = require('./migration-108-inventario.cjs');
const def107 = require('./migration-107-definicoes.cjs');

const ARQUIVO_RETRATO = 'database/checks/20261029_108_retrato.sql';
const ARQUIVO_ESPERADOS = 'database/checks/20261029_108_retratos_esperados.json';
/** sha256 revisado de ARQUIVO_ESPERADOS (bytes sem CR). Fonte única: o carregador comum (094, 100, 107/108) recusa
 *  outro conteúdo, e o aplicador 107/108 fixa este mesmo valor em ARQUIVOS (P2-3 da revisão da E4). */
const HASH_ESPERADOS = '79b13a7e61bb4a02f256053462600e00ab150e6ebb583f31801431f05bc248ea';
const INICIO = '-- RETRATO_108_INICIO';
const FIM = '-- RETRATO_108_FIM';
const PENDENTE = 'A_MEDIR_NO_CLUSTER';
const FASES = Object.freeze(['F0', 'F1', 'F2']);
const VERSAO_MAIOR = 18;
const SEARCH_PATH_RETRATO = 'pg_catalog';
const PREPARO_SESSAO = Object.freeze(["SET LOCAL search_path = pg_catalog"]);
const sha256 = t => createHash('sha256').update(t, 'utf8').digest('hex');
const C = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Constantes do detector NOVA (espelho de lib/agenda/estado-combinados.ts; o teste confere igualdade). */
const NOVA = Object.freeze({
  hashes: Object.freeze({
    conflito108: '06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537',
    contrato: '13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21',
    revisao: '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24',
  }),
  funcoes: Object.freeze({
    kidmais098_hoje: '3a4b2df59eb38d2a5e6f4894fb6dd891f8ef6f793d302b6699184adba825c121',
    kidmais098_membros_canonicos: 'a28f25f25ca6fde6a8687f86ae7a76f557d19e2404a708906c916bd1dbc34fa4',
    kidmais098_conjunto: 'a9c7277cc298fb6307f5cfce64a7fe1eea8a0dc2d8a610f5d44bfa9d470d38dc',
    kidmais098_saloes_cruzam: '5fa4a47206e773b5a91028b5c7649e2c6317bc67e3ed548a899448fa6d3a19fe',
    kidmais098_salao_elegivel: '9f6e7b59f5ecd89c1a6bf0b67098da041600691979d2e98ae56e8ab3badce4e2',
    kidmais098_validar_elegibilidade: 'f54b73da9bf4685524f88971878bb9792d5f6442432f23cf7f3001dc64b99c05',
    kidmais098_salao_guarda: '9a587402acfe1a1c537b0a7c1a8c3d77e5a1782f2c9e721b32108fde611124c7',
    kidmais098_combinado_validar: '0d5a2713f41f68b53a6a0bd22b5189cc7e31fcc9b6a7649b59cd9671ee1045ba',
    kidmais098_proibir_truncate: 'b6fc1e418cc21bdf78952e9ae8ac8aeff89f257c9a9ab92bccba9850d28099df',
    kidmais098_contrato_guarda: '0ae5abc6372e3edf997bab5b4ab7f213a4d8bb0ff2708c4c4c5db72a5fc74e04',
  }),
  gatilhos: Object.freeze([
    ['agenda_saloes_098_guarda_trg', 'agenda_saloes', 'kidmais098_salao_guarda', 27, false, null],
    ['agenda_saloes_098_combinado_trg', 'agenda_saloes', 'kidmais098_combinado_validar', 7, false, null],
    ['agenda_saloes_098_combinado_diferido', 'agenda_saloes', 'kidmais098_combinado_validar', 5, true, null],
    ['agenda_saloes_098_truncate_trg', 'agenda_saloes', 'kidmais098_proibir_truncate', 34, false, null],
    ['contratos_098_guarda_trg', 'contratos', 'kidmais098_contrato_guarda', 27, false, 'fechamento_id'],
    ['contratos_098_truncate_trg', 'contratos', 'kidmais098_proibir_truncate', 34, false, null],
  ]),
  checkMembros: 'CHECKCASEWHENcombinadoTHENkidmais098_membros_canonicosmembrosELSEmembrosISNULLEND',
});
/** sha256 do corpo do marcador (` SELECT true `, migration 108). */
const HASH_MARCADOR_108 = '2fb8df147716589d768e113780faac103ca05619fad609a3924404bad7894f1c';
const SEARCH_PATH_108 = 'search_path=public, pg_catalog';
/**
 * Metadados das 14 funções da 108, lidos da migration (o teste reextrai do arquivo): assinatura por tipos (to_regprocedure),
 * linguagem, volatilidade (i/s/v) e proconfig esperado (null = sem SET). Nenhuma é SECURITY DEFINER.
 */
const METADADOS_108 = Object.freeze([
  ['kidmais098_hoje()', 'sql', 'v', SEARCH_PATH_108],
  ['kidmais098_membros_canonicos(uuid[])', 'sql', 'i', SEARCH_PATH_108],
  ['kidmais098_conjunto(uuid)', 'sql', 's', SEARCH_PATH_108],
  ['kidmais098_saloes_cruzam(uuid,uuid)', 'sql', 's', SEARCH_PATH_108],
  ['kidmais098_salao_elegivel(uuid)', 'sql', 's', SEARCH_PATH_108],
  ['kidmais098_validar_elegibilidade(uuid)', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais098_salao_guarda()', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais098_combinado_validar()', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais098_proibir_truncate()', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais098_contrato_guarda()', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', 'plpgsql', 's', SEARCH_PATH_108],
  ['kidmais019_validar_contrato()', 'plpgsql', 'v', SEARCH_PATH_108],
  ['kidmais_validar_agenda_revisao()', 'plpgsql', 'v', null],
  ['kidmais108_instalada()', 'sql', 'i', SEARCH_PATH_108],
]);

const lit = s => `'${String(s).replace(/'/g, "''")}'`;
/** Lista SQL quebrada em linhas de até ~120 colunas, com o recuo dado. */
function lista(nomes, recuo) {
  const linhas = [];
  let linha = '';
  for (const n of nomes) {
    const t = lit(n);
    if (linha && linha.length + t.length + 2 > 120) { linhas.push(linha + ','); linha = ''; }
    linha += (linha ? ', ' : '') + t;
  }
  linhas.push(linha);
  return linhas.join('\n' + recuo);
}
const DONO_TABELAS = `(SELECT o.relowner FROM pg_catalog.pg_class o WHERE o.oid = pg_catalog.to_regclass('public.agenda_saloes'))`;
const dono = x => `CASE WHEN ${x} = ${DONO_TABELAS} THEN 'DONO_AGENDA_SALOES' ELSE pg_catalog.pg_get_userbyid(${x})::text END`;
const papelAcl = (x, donoFn) => `CASE WHEN ${x} = 0 THEN 'PUBLIC' WHEN ${x} = ${donoFn} THEN 'DONO' ELSE pg_catalog.pg_get_userbyid(${x})::text END`;

/**
 * O trecho do retrato (expressão jsonb), gerado do inventário. O arquivo SQL guarda este mesmo texto entre os marcadores.
 */
function trechoRetrato108(inventario = inv.INVENTARIO_108) {
  const funcoes = inventario.funcoes.map(f => f.nome).sort(C);
  const escopo = [...inventario.tabelas].sort(C);
  const todas = [...new Set([...inventario.tabelas, ...inventario.tabelasLidas])].sort(C);
  const R = '                '; // recuo das listas
  const ga = papelAcl('a.grantee', 'p.proowner'), gr = papelAcl('a.grantor', 'p.proowner');
  return `(SELECT jsonb_build_object(
  'funcoes', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
                encode(sha256(convert_to(replace(p.prosrc, E'\\r', ''), 'UTF8')), 'hex'), l.lanname, p.provolatile, p.prosecdef, p.proisstrict,
                p.proleakproof, p.proparallel, coalesce(array_to_string(p.proconfig, ';'), ''),
                pg_catalog.pg_get_function_result(p.oid), ${dono('p.proowner')},
                CASE WHEN p.proacl IS NULL THEN to_jsonb('PADRAO'::text) ELSE (SELECT coalesce(jsonb_agg(jsonb_build_array(${ga}, ${gr},
                  a.privilege_type, a.is_grantable) ORDER BY ${ga} COLLATE "C", a.privilege_type COLLATE "C", ${gr} COLLATE "C"), '[]'::jsonb)
                  FROM pg_catalog.aclexplode(p.proacl) a) END)
                ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND p.proname IN (${lista(funcoes, R)})),
  'presenca_funcoes', (SELECT jsonb_agg(jsonb_build_array(e.nome, (SELECT count(*) FROM pg_catalog.pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.proname = e.nome)) ORDER BY e.nome COLLATE "C")
     FROM unnest(ARRAY[${lista(funcoes, R)}]::text[]) AS e(nome)),
  'relacoes', (SELECT jsonb_agg(jsonb_build_array(e.nome, c.relkind, CASE WHEN c.oid IS NULL THEN NULL ELSE ${dono('c.relowner')} END,
                c.relrowsecurity, c.relforcerowsecurity) ORDER BY e.nome COLLATE "C")
     FROM unnest(ARRAY[${lista(todas, R)}]::text[]) AS e(nome)
     LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || e.nome)),
  'colunas', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity, a.attgenerated)
                ORDER BY c.relname COLLATE "C", a.attname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname IN (${lista(todas, R)})),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid),
                k.convalidated, k.condeferrable, k.condeferred, k.connoinherit) ORDER BY c.relname COLLATE "C", k.conname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype IN ('c', 'f', 'p', 'u', 'x')
       AND c.relname IN (${lista(escopo, R)})),
  'indices', (SELECT coalesce(jsonb_agg(jsonb_build_array(tc.relname, ic.relname, pg_catalog.pg_get_indexdef(i.indexrelid),
                i.indisunique, i.indisprimary, i.indisvalid, i.indisready, i.indimmediate) ORDER BY tc.relname COLLATE "C", ic.relname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'public' AND tc.relname IN (${lista(escopo, R)})),
  'gatilhos', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname, g.tgname, g.tgtype, g.tgfoid::regprocedure::text, g.tgenabled,
                g.tgdeferrable, g.tginitdeferred, g.tgnargs, (SELECT coalesce(jsonb_agg(x.attname ORDER BY x.attname COLLATE "C"), '[]'::jsonb)
                  FROM pg_catalog.pg_attribute x WHERE x.attrelid = g.tgrelid AND x.attnum = ANY (g.tgattr::int2[])),
                pg_catalog.pg_get_triggerdef(g.oid)) ORDER BY c.relname COLLATE "C", g.tgname COLLATE "C"), '[]'::jsonb)
     FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT g.tgisinternal AND n.nspname = 'public'
       AND c.relname IN (${lista(escopo, R)})),
  'marcador_108', (SELECT encode(sha256(convert_to(replace(p.prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_catalog.pg_proc p
     WHERE p.oid = pg_catalog.to_regprocedure('public.kidmais108_instalada()'))
))`;
}

/** Texto completo do arquivo SQL (cabeçalho + trecho entre marcadores). */
function arquivoRetrato108(inventario = inv.INVENTARIO_108) {
  return `-- Retrato restrito da 107/108 (somente leitura; plano E4, E4-3; P2-E4-R2-1). GERADO por scripts/migration-108-retrato.cjs
-- a partir do inventário congelado (scripts/migration-108-inventario.cjs); o teste confere este arquivo byte a byte.
-- Sessão: o chamador fixa \`SET LOCAL search_path = pg_catalog\` (pg_get_*def qualifica public; texto sem normalização), numa
-- transação READ ONLY; ordenação COLLATE "C"; PostgreSQL versão maior ${VERSAO_MAIOR}. A mesma consulta serve às três fases
-- (F0 pré-107, F1 pós-107/pré-108, F2 pós-108); a fase só escolhe o hash esperado em
-- database/checks/20261029_108_retratos_esperados.json (A_MEDIR_NO_CLUSTER = sem comparação, recusa).
-- Escopo: ${inventario.funcoes.length} funções, ${inventario.tabelas.length} tabelas com estrutura completa (colunas, constraints c/f/p/u/x,
-- índices, gatilhos) e ${inventario.tabelasLidas.length} tabelas lidas (só colunas). NOT NULL vai por attnotnull (as constraints 'n' do
-- PostgreSQL 18 têm nome gerado e ficam fora). Corpos só por sha256 (sem CR); nenhuma função do escopo é executada.
SELECT
${INICIO}
${trechoRetrato108(inventario)}
${FIM}
  AS retrato_108;
`;
}

/** O trecho entre os marcadores de um texto SQL (um único par). */
function extrairTrecho(texto) {
  const t = texto.replace(/\r\n/g, '\n');
  const i = t.indexOf(INICIO), j = t.indexOf(FIM);
  if (i < 0 || j < i || t.indexOf(INICIO, i + 1) >= 0 || t.indexOf(FIM, j + 1) >= 0) throw new Error('RETRATO_108_MARCADORES');
  return t.slice(i + INICIO.length + 1, j - 1);
}
/** O trecho do arquivo, exigindo que seja o gerado do inventário congelado. */
function lerTrechoArquivo(raiz = path.resolve(__dirname, '..')) {
  const trecho = extrairTrecho(fs.readFileSync(path.join(raiz, ARQUIVO_RETRATO), 'utf8'));
  if (trecho !== trechoRetrato108()) throw new Error('RETRATO_108_ARQUIVO_DIVERGE_DO_INVENTARIO');
  return trecho;
}
const hashTrecho = trecho => sha256(trecho);

/** Consulta do retrato: hash, o próprio retrato (para o diff sanitizado), o search_path da sessão e a versão. */
function sqlRetrato108({raiz} = {}) {
  const trecho = lerTrechoArquivo(raiz);
  return `SELECT encode(sha256(convert_to(r.retrato::text, 'UTF8')), 'hex') AS hash_108, r.retrato AS retrato_108,
  current_setting('search_path') AS search_path, current_setting('server_version_num')::int AS versao_pg
FROM (SELECT
${trecho}
  AS retrato) r`;
}

function carregarEsperados(raiz = path.resolve(__dirname, '..')) {
  const texto = fs.readFileSync(path.join(raiz, ARQUIVO_ESPERADOS), 'utf8').replace(/\r/g, '');
  if (sha256(texto) !== HASH_ESPERADOS) throw new Error('RETRATO_108_ESPERADOS_NAO_REVISADOS ' + ARQUIVO_ESPERADOS);
  return JSON.parse(texto);
}
/**
 * Hashes aceitos numa fase. Recusa: fase desconhecida, esperados medidos com outro SQL (trecho_sha256), versão maior
 * diferente, qualquer variante da fase ainda A_MEDIR_NO_CLUSTER ou fora do formato de 64 hex.
 */
function hashesAceitos(fase, esperados = carregarEsperados(), {trecho = trechoRetrato108()} = {}) {
  if (!FASES.includes(fase)) throw new Error('RETRATO_108_FASE_DESCONHECIDA ' + fase);
  if (esperados?.versao_pg_maior !== VERSAO_MAIOR) throw new Error('RETRATO_108_VERSAO_ESPERADA ' + esperados?.versao_pg_maior);
  if (esperados?.trecho_sha256 !== hashTrecho(trecho)) throw new Error('RETRATO_108_ESPERADO_DE_OUTRO_SQL');
  const variantes = Object.entries(esperados?.[fase] ?? {});
  if (variantes.length === 0) throw new Error('RETRATO_108_SEM_ESPERADO ' + fase);
  for (const [nome, h] of variantes) {
    if (h === PENDENTE) throw new Error(`RETRATO_108_NAO_MEDIDO ${fase}.${nome} (${PENDENTE}): medir no PostgreSQL ${VERSAO_MAIOR} antes de comparar`);
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`RETRATO_108_ESPERADO_INVALIDO ${fase}.${nome}`);
  }
  return variantes.map(([variante, hash]) => ({variante, hash}));
}
/** Compara uma linha de sqlRetrato108() com a fase: exige search_path = pg_catalog e a versão maior medida. */
function compararRetrato108(fase, linha, esperados = carregarEsperados(), opcoes = {}) {
  const aceitos = hashesAceitos(fase, esperados, opcoes);
  if (linha?.search_path !== SEARCH_PATH_RETRATO) throw new Error('RETRATO_108_SEARCH_PATH ' + String(linha?.search_path));
  if (Math.floor(Number(linha?.versao_pg) / 10000) !== VERSAO_MAIOR) throw new Error('RETRATO_108_VERSAO_PG ' + String(linha?.versao_pg));
  if (!/^[0-9a-f]{64}$/.test(String(linha?.hash_108))) throw new Error('RETRATO_108_ILEGIVEL');
  const achado = aceitos.find(a => a.hash === linha.hash_108);
  return {fase, ok: Boolean(achado), variante: achado?.variante ?? null};
}

/**
 * Prova única de "108 íntegra" (todos os aplicadores). Devolve uma linha (integra boolean, motivos text[]). Requer a
 * mesma sessão do retrato (search_path = pg_catalog, READ ONLY). Recusa gerar enquanto o esperado de F2 não for medido.
 */
function sqlProva108Integra({esperados = carregarEsperados(), raiz} = {}) {
  const f2 = hashesAceitos('F2', esperados);
  const trecho = lerTrechoArquivo(raiz);
  const hashProc = x => `encode(sha256(convert_to(replace(${x}, E'\\r', ''), 'UTF8')), 'hex')`;
  const corpo = assinatura => `(SELECT ${hashProc('p.prosrc')} FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${lit('public.' + assinatura)}))`;
  const funcoes = Object.entries(NOVA.funcoes).map(([n, h]) => `(${lit(n)}, ${lit(h)})`).join(',\n        ');
  const gatilhos = NOVA.gatilhos.map(([n, t, f, tipo, dif, col]) => `(${lit(n)}, ${lit(t)}, ${lit(f)}, ${tipo}, ${dif}, ${col ? lit(col) : 'NULL::text'})`)
    .join(',\n        ');
  const metadados = METADADOS_108.map(([s, l, v, cfg]) => `(${lit(s)}, ${lit(l)}, ${lit(v)}, ${cfg === null ? 'NULL::text' : lit(cfg)})`).join(',\n        ');
  const conflito = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';
  return `SELECT cardinality(m.motivos) = 0 AS integra, m.motivos FROM (SELECT array_remove(ARRAY[
  -- Detector NOVA (lib/agenda/estado-combinados.ts), condição a condição.
  CASE WHEN (SELECT count(*) FROM (VALUES
        ${funcoes}) AS e(nome, h)
      JOIN pg_catalog.pg_proc p ON p.proname = e.nome AND p.pronamespace = 'public'::regnamespace WHERE ${hashProc('p.prosrc')} = e.h) = ${Object.keys(NOVA.funcoes).length}
    THEN NULL ELSE 'FUNCOES_098_CORPO' END,
  CASE WHEN (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'kidmais098\\_%') = ${Object.keys(NOVA.funcoes).length}
    THEN NULL ELSE 'FUNCOES_098_QUANTIDADE' END,
  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.agenda_saloes') AND a.attname = 'combinado'
      AND NOT a.attisdropped AND a.atttypid = 'boolean'::regtype AND a.attnotnull) THEN NULL ELSE 'COLUNA_COMBINADO' END,
  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.agenda_saloes') AND a.attname = 'membros'
      AND NOT a.attisdropped AND a.atttypid = 'uuid[]'::regtype) THEN NULL ELSE 'COLUNA_MEMBROS' END,
  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = pg_catalog.to_regclass('public.agenda_saloes')
      AND k.conname = 'agenda_saloes_098_membros_check' AND k.contype = 'c' AND k.convalidated AND NOT k.connoinherit
      AND regexp_replace(replace(pg_catalog.pg_get_constraintdef(k.oid), 'public.', ''), '[\\s()]', '', 'g') = ${lit(NOVA.checkMembros)})
    THEN NULL ELSE 'CHECK_MEMBROS' END,
  CASE WHEN (SELECT count(*) FROM (VALUES
        ${gatilhos}) AS g(nome, tabela, funcao, tipo, diferido, coluna)
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
                     WHERE t.tgname = g.nome AND t.tgrelid = pg_catalog.to_regclass('public.' || g.tabela) AND NOT t.tgisinternal
                       AND t.tgenabled = 'O' AND p.proname = g.funcao AND p.pronamespace = 'public'::regnamespace
                       AND t.tgtype = g.tipo AND t.tgdeferrable = g.diferido AND t.tginitdeferred = g.diferido
                       AND t.tgnargs = 0 AND t.tgqual IS NULL
                       AND array_to_string(t.tgattr::int2[], ',') = coalesce((SELECT a.attnum::text FROM pg_catalog.pg_attribute a
                             WHERE a.attrelid = t.tgrelid AND a.attname = g.coluna AND NOT a.attisdropped), ''))) = ${NOVA.gatilhos.length}
    THEN NULL ELSE 'GATILHOS_098' END,
  CASE WHEN (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_098\\_%') = ${NOVA.gatilhos.length}
    THEN NULL ELSE 'GATILHOS_098_QUANTIDADE' END,
  CASE WHEN ${corpo(conflito)} IS NOT DISTINCT FROM ${lit(NOVA.hashes.conflito108)} THEN NULL ELSE 'CORPO_CONFLITO_108' END,
  CASE WHEN ${corpo('kidmais019_validar_contrato()')} IS NOT DISTINCT FROM ${lit(NOVA.hashes.contrato)} THEN NULL ELSE 'CORPO_VALIDAR_CONTRATO' END,
  CASE WHEN ${corpo('kidmais_validar_agenda_revisao()')} IS NOT DISTINCT FROM ${lit(NOVA.hashes.revisao)} THEN NULL ELSE 'CORPO_VALIDAR_REVISAO' END,
  -- Marcador presente E com o corpo da 108 (o detector só confere a presença).
  CASE WHEN ${corpo('kidmais108_instalada()')} IS NOT DISTINCT FROM ${lit(HASH_MARCADOR_108)} THEN NULL ELSE 'MARCADOR_108' END
  ] || coalesce((SELECT array_agg('METADADOS ' || e.assinatura ORDER BY e.assinatura COLLATE "C") FROM (VALUES
        ${metadados}) AS e(assinatura, linguagem, volatilidade, configuracao)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
                         WHERE p.oid = pg_catalog.to_regprocedure('public.' || e.assinatura)
                           AND l.lanname = e.linguagem AND p.provolatile = e.volatilidade AND NOT p.prosecdef
                           AND array_to_string(p.proconfig, ';') IS NOT DISTINCT FROM e.configuracao
                           AND p.proowner = ${DONO_TABELAS}
                           AND (SELECT count(*) FROM pg_catalog.pg_proc o WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) = 1)),
    ARRAY[]::text[])
  -- Retrato de F2 (estrutura, metadados, ACL e dono das funções do escopo) igual ao medido.
  || CASE WHEN (SELECT encode(sha256(convert_to(r.retrato::text, 'UTF8')), 'hex') FROM (SELECT
${trecho}
  AS retrato) r) IN (${f2.map(x => lit(x.hash)).join(', ')}) THEN ARRAY[]::text[] ELSE ARRAY['RETRATO_F2'] END,
  NULL)
  -- Integridade da 107 (estrutura e LINHAS do registro kidmais107_reparos; P2-2 da revisão da E4): a mesma consulta do
  -- aplicador 107/108, para 094/100 não aprovarem um F2 com o registro adulterado.
  || coalesce((SELECT array_agg('INTEGRIDADE_107 ' || i.motivo ORDER BY i.n) FROM (SELECT row_number() OVER () AS n, v.ok, v.motivo FROM (
${def107.sqlIntegridade107()}
  ) v) i WHERE i.ok IS NOT TRUE), ARRAY[]::text[])
  AS motivos) m`;
}

if (require.main === module) {
  // `node scripts/migration-108-retrato.cjs --escrever` regrava o arquivo SQL a partir do inventário congelado.
  if (process.argv[2] === '--escrever') {
    fs.writeFileSync(path.resolve(__dirname, '..', ARQUIVO_RETRATO), arquivoRetrato108());
    console.log(JSON.stringify({arquivo: ARQUIVO_RETRATO, trecho_sha256: hashTrecho(trechoRetrato108())}));
  } else console.log(JSON.stringify({trecho_sha256: hashTrecho(trechoRetrato108())}));
}

module.exports = {ARQUIVO_RETRATO, ARQUIVO_ESPERADOS, HASH_ESPERADOS, INICIO, FIM, PENDENTE, FASES, VERSAO_MAIOR, SEARCH_PATH_RETRATO, PREPARO_SESSAO, NOVA,
  HASH_MARCADOR_108, SEARCH_PATH_108, METADADOS_108, trechoRetrato108, arquivoRetrato108, extrairTrecho, lerTrechoArquivo, hashTrecho, sqlRetrato108,
  carregarEsperados, hashesAceitos, compararRetrato108, sqlProva108Integra};
