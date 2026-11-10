/* eslint-disable @typescript-eslint/no-require-imports */
// B-5 (conferência SOMENTE LEITURA antes do E3): migrations 110, 111 e 115 da pesquisa de satisfação pelo catálogo, com
// identidade por objeto (parecer do Astra, 10/11/2026). Separado de conferencia-b5-producao.cjs para o agregador caber numa
// parte do bloco shell (scripts/bloco-shell-conferencia-b5-producao.cjs); o agregador reexporta tudo. Só node:assert.
const assert = require('node:assert/strict');

/**
 * 110, 111 e 115 (pesquisa de satisfação; sem núcleo de leitura): só catálogo, numa instrução, com IDENTIDADE POR OBJETO
 * (parecer do Astra, 10/11): cada objeto sai como ausente, conforme ou divergente, e a migration só é "ausente" com todos
 * ausentes e "presente" com todos conformes. Nada de soma: um objeto a mais não compensa outro faltando.
 * - Funções: md5 do corpo (prosrc) igual ao da migration. kidmais086_execucao_tenant() é REDEFINIDA pela 110: corpo da 086
 *   = ausente, corpo da 110 = conforme, qualquer outro (ou função sumida) = divergente.
 * - CHECKs: md5 de pg_get_constraintdef e validado. Os 4 que a 110 redefine com o nome da 086 seguem a mesma regra da
 *   função (definição da 086 = ausente). Os 7 novos: ausentes ou conformes.
 * - Gatilhos: um só com o nome, na tabela certa, chamando a função certa, com o tgtype (momento/eventos/linha), colunas
 *   de UPDATE OF, WHEN, DEFERRABLE INITIALLY DEFERRED e HABILITADO (tgenabled 'O'). Desabilitado = divergente.
 * - Colunas: tipo e NOT NULL. Tabelas: relkind 'r'.
 * - 115: índice novo válido/pronto/vivo, btree, (empresa_id, data_evento), sem predicado; o 054 removido. Ausente = 115
 *   sem índice e o 054 COM a forma da 054 ((empresa_id) WHERE empresa_id IS NOT NULL, válido); outra forma = divergente.
 * As definições esperadas são conferidas em PostgreSQL descartável nos modelos 109, 110, 111 e 115
 * (lib/satisfacao/b5-catalogo-satisfacao.postgres.test.ts) e os corpos, contra os arquivos das migrations (teste unitário).
 */
const TABELAS_110 = Object.freeze(['satisfacao_agregados_mensais', 'satisfacao_capacidades', 'satisfacao_email_simulado', 'satisfacao_entregas',
  'satisfacao_envios', 'satisfacao_expurgos', 'satisfacao_respostas', 'satisfacao_saidas', 'satisfacao_tarefas']);
const TABELAS_111 = Object.freeze(['satisfacao_auditoria', 'satisfacao_links_avaliacao']);
/** [migration, assinatura, md5 do corpo]. */
const FUNCOES_SATISFACAO = Object.freeze([
  ['110', 'kidmais110_capacidade_guarda()', '3b9aa31317c0908f780479da9f2a7860'], ['110', 'kidmais110_entrega_guarda()', '8ccf17148a4bfa0d3544a165f50497ff'],
  ['110', 'kidmais110_envio_guarda()', 'b2f1b32d1e8383c192fbe2e518e29686'], ['110', 'kidmais110_invariante_resposta()', 'af8507a0f4329c12241eba1f8e13b8ca'],
  ['110', 'kidmais110_marco_contato()', '9a4ea9b074f8076f533fbfdaeb8c1c3c'], ['110', 'kidmais110_resposta_guarda()', '752b2abcf824bfbe04f64e85fe6cfb5a'],
  ['110', 'kidmais110_tarefa_guarda()', '7976df4ff0abadadbe5cabf51a2070d1'],
  ['111', 'kidmais111_auditoria_coerencia()', 'fe0090d33c3a9b50b4856d9016f2f9e6'], ['111', 'kidmais111_auditoria_somente_insercao()', 'f2118fd51f0dfce90b4a3431efa8a210'],
  ['111', 'kidmais111_link_guarda()', '405461b6e4dc4790de5ae76428eea67c']].map(Object.freeze));
/** [migration, assinatura, md5 do corpo da 086 (= ausente), md5 do corpo da 110 (= conforme)]. */
const FUNCOES_REDEFINIDAS = Object.freeze([['110', 'kidmais086_execucao_tenant()', '6ce72e15a353b6f65214866384a12cc2', '3f6beec01861e5968ad2baf97e34ebab']].map(Object.freeze));
/** [migration, nome, tabela, função, tgtype, constraint trigger (DEFERRABLE INITIALLY DEFERRED), colunas de UPDATE OF, tem WHEN]. */
const GATILHOS_SATISFACAO = Object.freeze([
  ['110', 'satisfacao_capacidades_guarda', 'satisfacao_capacidades', 'kidmais110_capacidade_guarda()', 31, false, '', false],
  ['110', 'satisfacao_entregas_guarda', 'satisfacao_entregas', 'kidmais110_entrega_guarda()', 31, false, '', false],
  ['110', 'satisfacao_entregas_marco', 'satisfacao_entregas', 'kidmais110_marco_contato()', 17, false, 'estado', true],
  ['110', 'satisfacao_envios_guarda', 'satisfacao_envios', 'kidmais110_envio_guarda()', 31, false, '', false],
  ['110', 'satisfacao_envios_invariante', 'satisfacao_envios', 'kidmais110_invariante_resposta()', 21, true, '', false],
  ['110', 'satisfacao_respostas_guarda', 'satisfacao_respostas', 'kidmais110_resposta_guarda()', 31, false, '', false],
  ['110', 'satisfacao_respostas_invariante', 'satisfacao_respostas', 'kidmais110_invariante_resposta()', 5, true, '', false],
  ['110', 'satisfacao_tarefas_guarda', 'satisfacao_tarefas', 'kidmais110_tarefa_guarda()', 31, false, '', false],
  ['111', 'satisfacao_auditoria_coerencia', 'satisfacao_auditoria', 'kidmais111_auditoria_coerencia()', 7, false, '', false],
  ['111', 'satisfacao_auditoria_imutavel', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 27, false, '', false],
  ['111', 'satisfacao_auditoria_truncate', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 34, false, '', false],
  ['111', 'satisfacao_links_guarda', 'satisfacao_links_avaliacao', 'kidmais111_link_guarda()', 19, false, '', false]].map(Object.freeze));
/** [migration, tabela, coluna, tipo, NOT NULL]. */
const COLUNAS_SATISFACAO = Object.freeze([
  ['110', 'marketing_automacao_regras', 'canais', 'text[]', true], ['110', 'marketing_automacao_regras', 'template_lembrete_texto', 'text', false],
  ['110', 'marketing_automacao_regras', 'template_lembrete_provedor', 'text', false]].map(Object.freeze));
/** [migration, tabela, nome, md5 de pg_get_constraintdef]. */
const CHECKS_SATISFACAO = Object.freeze([
  ['110', 'marketing_automacao_regras', 'marketing_regras_pesquisa_pos_festa', 'a02288361d4757a1835f6dbd2d228362'],
  ['110', 'marketing_automacao_regras', 'marketing_regras_canais', '21284059a90f462a21fc7c78d6ed41db'],
  ['110', 'marketing_automacao_regras', 'marketing_regras_template_lembrete', '145ca71502483ab483a9cc3d494809c8'],
  ['110', 'marketing_automacao_regras', 'marketing_regras_template_lembrete_provedor', 'b0b4d6deddf8c83d561bcbe60db78c1b'],
  ['110', 'marketing_automacao_regras', 'marketing_regras_pesquisa_revisada', '7e6ce0ad9f13d76d821d4195d0595f8c'],
  ['110', 'marketing_automacao_execucoes', 'marketing_exec_pesquisa_estados', 'c6119c58bc9a234467f15e8ab1b34def'],
  ['110', 'marketing_automacao_execucoes', 'marketing_exec_pesquisa_criada', '2593c489c6da232fdc36adc3a3953ef9']].map(Object.freeze));
/** [migration, tabela, nome, md5 da definição da 086 (= ausente), md5 da definição da 110 (= conforme)]. */
const CHECKS_REDEFINIDOS = Object.freeze([
  ['110', 'marketing_automacao_regras', 'marketing_regras_acao', '95d04fef243fde1dcccc82b4f47a9b02', '9428e448ecaa9a88b7f619a299792f8a'],
  ['110', 'marketing_automacao_execucoes', 'marketing_exec_acao', 'b710d44dab1956d998824b3afa7136f1', '814b411ffbc8e56b0d48284e0fc592d5'],
  ['110', 'marketing_automacao_execucoes', 'marketing_exec_estado', '206850dfe3575dc4f1b5b9d8e2376bea', '66f984ff6a045fb1507d3c5ccfc6bae3'],
  ['110', 'marketing_automacao_execucoes', 'marketing_exec_final', 'c6738071dd8b6272af6273f87faa4288', 'e83024cd88036861ff54211960c31e1f']].map(Object.freeze));
/** Identidades na ordem: [id, migration]. */
const IDS_SATISFACAO = Object.freeze([
  ...TABELAS_110.map(t => [`110:tabela:${t}`, '110']), ...TABELAS_111.map(t => [`111:tabela:${t}`, '111']),
  ...FUNCOES_SATISFACAO.map(([m, f]) => [`${m}:funcao:${f}`, m]), ...FUNCOES_REDEFINIDAS.map(([m, f]) => [`${m}:funcao:${f}`, m]),
  ...GATILHOS_SATISFACAO.map(([m, g]) => [`${m}:gatilho:${g}`, m]), ...COLUNAS_SATISFACAO.map(([m, t, c]) => [`${m}:coluna:${t}.${c}`, m]),
  ...CHECKS_SATISFACAO.map(([m, , n]) => [`${m}:check:${n}`, m]), ...CHECKS_REDEFINIDOS.map(([m, , n]) => [`${m}:check:${n}`, m]),
  ['115:indice:fechamentos_115_empresa_data_idx', '115'], ['115:sem_indice:fechamentos_054_empresa_idx', '115']].map(Object.freeze));
const OBJETOS_SATISFACAO = Object.freeze(Object.fromEntries(['110', '111', '115'].map(m => [m, IDS_SATISFACAO.filter(([, x]) => x === m).length])));
const literal = v => typeof v === 'string' ? `'${v.split("'").join("''")}'` : typeof v === 'boolean' ? String(v) : String(Number(v));
const valores = (linhas, f) => linhas.map(l => `(${f(l).map(literal).join(', ')})`).join(',\n    ');
/** Colunas (por nome) de um índice, na ordem; e o método. */
const COLUNAS_INDICE = `(SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)`;
const BTREE = `(SELECT m.amname FROM pg_class r JOIN pg_am m ON m.oid = r.relam WHERE r.oid = i.indexrelid) = 'btree'`;
const INDICE_SAO = `i.indrelid = to_regclass('public.fechamentos') AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indexprs IS NULL`;
const SQL_ESTADO_SATISFACAO = `WITH
  tab(id, nome) AS (VALUES ${valores([...TABELAS_110.map(t => ['110', t]), ...TABELAS_111.map(t => ['111', t])], ([m, t]) => [`${m}:tabela:${t}`, t])}),
  fun(id, assin, corpo) AS (VALUES ${valores(FUNCOES_SATISFACAO, ([m, f, h]) => [`${m}:funcao:${f}`, f, h])}),
  fre(id, assin, antes, depois) AS (VALUES ${valores(FUNCOES_REDEFINIDAS, ([m, f, a, d]) => [`${m}:funcao:${f}`, f, a, d])}),
  gat(id, nome, tabela, funcao, tipo, restricao, colunas, quando) AS (VALUES ${valores(GATILHOS_SATISFACAO, ([m, g, ...r]) => [`${m}:gatilho:${g}`, g, ...r])}),
  col(id, tabela, nome, tipo, obrigatoria) AS (VALUES ${valores(COLUNAS_SATISFACAO, ([m, t, c, ...r]) => [`${m}:coluna:${t}.${c}`, t, c, ...r])}),
  chk(id, tabela, nome, def) AS (VALUES ${valores(CHECKS_SATISFACAO, ([m, t, n, h]) => [`${m}:check:${n}`, t, n, h])}),
  chr(id, tabela, nome, antes, depois) AS (VALUES ${valores(CHECKS_REDEFINIDOS, ([m, t, n, a, d]) => [`${m}:check:${n}`, t, n, a, d])})
SELECT jsonb_object_agg(id, estado) AS objetos FROM (
  SELECT t.id, CASE WHEN c.oid IS NULL THEN 'ausente' WHEN c.relkind = 'r' THEN 'conforme' ELSE 'divergente' END AS estado
    FROM tab t LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || t.nome)
  UNION ALL
  SELECT f.id, CASE WHEN p.oid IS NULL THEN 'ausente' WHEN md5(p.prosrc) = f.corpo AND p.prorettype = 'trigger'::regtype THEN 'conforme' ELSE 'divergente' END
    FROM fun f LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || f.assin)
  UNION ALL
  SELECT f.id, CASE WHEN p.oid IS NULL THEN 'divergente' WHEN md5(p.prosrc) = f.depois THEN 'conforme' WHEN md5(p.prosrc) = f.antes THEN 'ausente' ELSE 'divergente' END
    FROM fre f LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || f.assin)
  UNION ALL
  SELECT g.id, CASE WHEN count(tg.oid) = 0 THEN 'ausente'
      WHEN count(tg.oid) = 1 AND bool_and(tg.tgrelid = to_regclass('public.' || g.tabela) AND tg.tgfoid = to_regprocedure('public.' || g.funcao)
        AND tg.tgtype = g.tipo AND tg.tgenabled = 'O' AND (tg.tgconstraint <> 0) = g.restricao AND tg.tgdeferrable = g.restricao
        AND tg.tginitdeferred = g.restricao AND (tg.tgqual IS NOT NULL) = g.quando
        AND COALESCE((SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
                        WHERE a.attrelid = tg.tgrelid AND a.attnum = ANY (tg.tgattr::int2[])), '') = g.colunas)
      THEN 'conforme' ELSE 'divergente' END
    FROM gat g LEFT JOIN pg_trigger tg ON tg.tgname = g.nome AND NOT tg.tgisinternal GROUP BY g.id
  UNION ALL
  SELECT c.id, CASE WHEN a.attnum IS NULL THEN 'ausente' WHEN format_type(a.atttypid, a.atttypmod) = c.tipo AND a.attnotnull = c.obrigatoria THEN 'conforme' ELSE 'divergente' END
    FROM col c LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || c.tabela) AND a.attname = c.nome AND NOT a.attisdropped AND a.attnum > 0
  UNION ALL
  SELECT c.id, CASE WHEN k.oid IS NULL THEN 'ausente' WHEN k.contype = 'c' AND k.convalidated AND md5(pg_get_constraintdef(k.oid)) = c.def THEN 'conforme' ELSE 'divergente' END
    FROM chk c LEFT JOIN pg_constraint k ON k.conrelid = to_regclass('public.' || c.tabela) AND k.conname = c.nome
  UNION ALL
  SELECT c.id, CASE WHEN k.oid IS NULL OR k.contype <> 'c' OR NOT k.convalidated THEN 'divergente' WHEN md5(pg_get_constraintdef(k.oid)) = c.depois THEN 'conforme'
      WHEN md5(pg_get_constraintdef(k.oid)) = c.antes THEN 'ausente' ELSE 'divergente' END
    FROM chr c LEFT JOIN pg_constraint k ON k.conrelid = to_regclass('public.' || c.tabela) AND k.conname = c.nome
  UNION ALL
  SELECT '115:indice:fechamentos_115_empresa_data_idx', CASE WHEN i.indexrelid IS NULL THEN 'ausente'
      WHEN ${INDICE_SAO} AND i.indpred IS NULL AND ${BTREE}
        AND ${COLUNAS_INDICE} = 'empresa_id,data_evento' THEN 'conforme' ELSE 'divergente' END
    FROM (SELECT 1) u LEFT JOIN pg_index i ON i.indexrelid = to_regclass('public.fechamentos_115_empresa_data_idx')
  UNION ALL
  SELECT '115:sem_indice:fechamentos_054_empresa_idx', CASE WHEN i.indexrelid IS NULL THEN 'conforme'
      WHEN ${INDICE_SAO} AND pg_get_expr(i.indpred, i.indrelid) = '(empresa_id IS NOT NULL)' AND ${BTREE}
        AND ${COLUNAS_INDICE} = 'empresa_id' THEN 'ausente' ELSE 'divergente' END
    FROM (SELECT 1) u LEFT JOIN pg_index i ON i.indexrelid = to_regclass('public.fechamentos_054_empresa_idx')
) o`;
const ESTADOS_OBJETO = Object.freeze(['ausente', 'conforme', 'divergente']);
/** Estado por objeto, conferido contra a lista completa de identidades (faltando, sobrando ou fora do vocabulário = ilegível). */
function objetosSatisfacao(l) {
  const o = l?.objetos;
  assert.ok(o !== null && typeof o === 'object' && !Array.isArray(o), 'ESTADO_SATISFACAO_ILEGIVEL');
  const ids = IDS_SATISFACAO.map(([id]) => id);
  assert.ok(Object.keys(o).length === ids.length && ids.every(id => ESTADOS_OBJETO.includes(o[id])), 'ESTADO_SATISFACAO_ILEGIVEL');
  return o;
}
function lerEstadoSatisfacao(l) {
  const o = objetosSatisfacao(l);
  const de = m => IDS_SATISFACAO.filter(([, x]) => x === m).map(([id]) => o[id]);
  const por = v => v.every(x => x === 'ausente') ? 'ausente' : v.every(x => x === 'conforme') ? 'presente' : 'parcial';
  return {'110': por(de('110')), '111': por(de('111')), '115': por(de('115'))};
}
/** Diagnóstico: objetos que não estão ausentes (o que impede "ausente" antes do E3). */
function divergenciasSatisfacao(l) {
  const o = objetosSatisfacao(l);
  return IDS_SATISFACAO.map(([id]) => id).filter(id => o[id] !== 'ausente').map(id => `${id}=${o[id]}`);
}

module.exports = {SQL_ESTADO_SATISFACAO, lerEstadoSatisfacao, OBJETOS_SATISFACAO, IDS_SATISFACAO, FUNCOES_SATISFACAO, FUNCOES_REDEFINIDAS, GATILHOS_SATISFACAO, CHECKS_SATISFACAO, CHECKS_REDEFINIDOS, divergenciasSatisfacao, objetosSatisfacao};
