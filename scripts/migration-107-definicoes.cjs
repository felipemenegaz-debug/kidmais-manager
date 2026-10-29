// E4-A (plano "E4 aplicadores 107 108 staging", rev. 2.1, E4-1 F0 e E4-2): definições esperadas da 107 como CONSTANTES do
// PostgreSQL 18, e os construtores de SQL SOMENTE LEITURA que as usam.
//   - A migration 107 gera a definição esperada numa tabela temporária (LIKE) e compara pelo texto do próprio servidor.
//     Numa transação READ ONLY isso é impossível (sem tabela temporária), então o CONFERIR e a integridade comparam com o
//     deparse do PG 18 fixado aqui. Outra versão maior do servidor RECUSA (as constantes valem só para PG_MAIOR).
//   - Proveniência de cada constante em `origem` (objeto) e em A_CONFIRMAR_NO_CLUSTER (lista do que não foi medido no
//     staging): o cluster PG 18 autorizado confirma, rodando a 107 na base canônica e na deriva simulada, que
//     sqlIntegridade107() passa e que cada constante é igual ao `modelo` que a própria migration gravou no registro.
//   - Nenhum construtor escreve: só SELECT (CTE + catálogo); dados só são lidos por query_to_xml de um SELECT, e só quando
//     a tabela existe (sem ::regclass de objeto que pode faltar; to_regclass/to_regprocedure em tudo).
//   - Independente de search_path: o texto da função do gatilho é fixado pelo OID de public.kidmais_set_atualizado_em(),
//     e os deparses usados não qualificam nomes (btrim/mod/text são de pg_catalog). O aplicador usa search_path pg_catalog.

const PG_MAIOR = 18;

/** O mesmo corte da migration (e do down) para o texto de pg_get_indexdef, sem "CREATE INDEX nome ON tabela ". */
const RE_INDICE = '^CREATE INDEX \\S+ ON \\S+ ';

/** Forma estrutural do gatilho, igual ao `modelo` da migration: BEFORE UPDATE FOR EACH ROW (tgtype 19), função da 005,
 *  sem argumentos, sem WHEN, sem lista de colunas, ligado (O). */
const GATILHO_ESTRUTURA = '19|kidmais_set_atualizado_em()|0|true|0|O';
const FUNCAO_GATILHO = 'public.kidmais_set_atualizado_em()';

const ORIGEM_STAGING = 'medido no staging (PG 18.6, diagnóstico somente leitura de 25/10/2026, saida-staging-20261025.json)';
const ORIGEM_LOCAL_097 = 'medido no modelo local 097 (ambientes-locais/retrato-comp-097.txt, versão maior do PG não registrada no arquivo); '
  + 'a confirmar no cluster PG 18';
const ORIGEM_MIGRATION = 'constante estrutural da própria migration 107 (modelo do gatilho), independente do deparse';

/**
 * Os 14 objetos da 107, na MESMA ordem e com os mesmos nomes/tabelas/tipos/expressões do VALUES da migration
 * (o teste confere contra o arquivo). tipo: I = índice, K = CHECK renomeado pela deriva, N = CHECK nao_vazio que pode
 * faltar, T = gatilho atualizado_em que pode faltar. `expr` = expressão-fonte da migration (usada também para conferir
 * se alguma linha viola um CHECK a criar). `esperado` = deparse do servidor no PG 18.
 */
const DEFINICOES = Object.freeze([
  {n: 1, tipo: 'I', tabela: 'bloqueios_agenda', canonico: 'bloqueios_agenda_data_ativos_idx', deriva: 'ix_bloqueios_agenda_data_ativos',
    expr: '(data) WHERE ativo = true',
    esperado: 'USING btree (data) WHERE (ativo = true)', origem: ORIGEM_STAGING},
  {n: 2, tipo: 'I', tabela: 'bloqueios_agenda', canonico: 'bloqueios_agenda_intervalo_ativos_idx', deriva: 'ix_bloqueios_agenda_intervalo_ativos',
    expr: '(data, horario_inicio, horario_fim) WHERE ativo = true AND dia_inteiro = false',
    esperado: 'USING btree (data, horario_inicio, horario_fim) WHERE ((ativo = true) AND (dia_inteiro = false))', origem: ORIGEM_STAGING},
  {n: 3, tipo: 'I', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_ativos_idx', deriva: 'ix_configuracao_agenda_ativos',
    expr: '(ordem_exibicao) WHERE ativo = true',
    esperado: 'USING btree (ordem_exibicao) WHERE (ativo = true)', origem: ORIGEM_STAGING},
  {n: 4, tipo: 'K', tabela: 'bloqueios_agenda', canonico: 'bloqueios_agenda_periodo_check', deriva: 'ck_bloqueios_agenda_periodo',
    expr: '(dia_inteiro = true AND horario_inicio IS NULL AND horario_fim IS NULL) OR (dia_inteiro = false AND horario_inicio IS NOT NULL AND horario_fim IS NOT NULL AND horario_fim > horario_inicio)',
    esperado: 'CHECK ((((dia_inteiro = true) AND (horario_inicio IS NULL) AND (horario_fim IS NULL)) OR ((dia_inteiro = false) AND (horario_inicio IS NOT NULL) AND (horario_fim IS NOT NULL) AND (horario_fim > horario_inicio))))',
    origem: ORIGEM_STAGING},
  {n: 5, tipo: 'K', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_intervalo_check', deriva: 'ck_configuracao_agenda_intervalo',
    expr: 'horario_fim_padrao > horario_inicio_padrao',
    esperado: 'CHECK ((horario_fim_padrao > horario_inicio_padrao))', origem: ORIGEM_STAGING},
  {n: 6, tipo: 'K', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_tolerancia_check', deriva: 'ck_configuracao_agenda_tolerancia',
    expr: 'tolerancia_inicio_minutos BETWEEN 0 AND 180',
    esperado: 'CHECK (((tolerancia_inicio_minutos >= 0) AND (tolerancia_inicio_minutos <= 180)))', origem: ORIGEM_STAGING},
  {n: 7, tipo: 'K', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_passo_check', deriva: 'ck_configuracao_agenda_passo',
    expr: 'passo_inicio_minutos BETWEEN 1 AND 180',
    esperado: 'CHECK (((passo_inicio_minutos >= 1) AND (passo_inicio_minutos <= 180)))', origem: ORIGEM_STAGING},
  {n: 8, tipo: 'K', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_passo_compativel_check', deriva: 'ck_configuracao_agenda_passo_compativel',
    expr: 'tolerancia_inicio_minutos = 0 OR mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0',
    esperado: 'CHECK (((tolerancia_inicio_minutos = 0) OR (mod(tolerancia_inicio_minutos, passo_inicio_minutos) = 0)))', origem: ORIGEM_STAGING},
  {n: 9, tipo: 'K', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_ordem_check', deriva: 'ck_configuracao_agenda_ordem',
    expr: 'ordem_exibicao > 0',
    esperado: 'CHECK ((ordem_exibicao > 0))', origem: ORIGEM_STAGING},
  // nao_vazio: AUSENTES no staging (nada medido lá). motivo é text; codigo varchar(40) e nome varchar(80) (005) ganham o
  // cast explícito para text no deparse. A confirmar no cluster PG 18.
  {n: 10, tipo: 'N', tabela: 'bloqueios_agenda', canonico: 'bloqueios_agenda_motivo_nao_vazio', deriva: null,
    expr: "btrim(motivo) <> ''",
    esperado: "CHECK ((btrim(motivo) <> ''::text))", origem: ORIGEM_LOCAL_097},
  {n: 11, tipo: 'N', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_codigo_nao_vazio', deriva: null,
    expr: "btrim(codigo) <> ''",
    esperado: "CHECK ((btrim((codigo)::text) <> ''::text))", origem: ORIGEM_LOCAL_097},
  {n: 12, tipo: 'N', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_nome_nao_vazio', deriva: null,
    expr: "btrim(nome) <> ''",
    esperado: "CHECK ((btrim((nome)::text) <> ''::text))", origem: ORIGEM_LOCAL_097},
  {n: 13, tipo: 'T', tabela: 'bloqueios_agenda', canonico: 'bloqueios_agenda_atualizado_em_trg', deriva: null,
    expr: null, esperado: GATILHO_ESTRUTURA, origem: ORIGEM_MIGRATION},
  {n: 14, tipo: 'T', tabela: 'configuracao_agenda', canonico: 'configuracao_agenda_atualizado_em_trg', deriva: null,
    expr: null, esperado: GATILHO_ESTRUTURA, origem: ORIGEM_MIGRATION},
].map(Object.freeze));

/** Ação que a migration registra para cada tipo. */
const ACAO_POR_TIPO = Object.freeze({I: 'RENOMEAR_INDICE', K: 'RENOMEAR_CHECK', N: 'CRIAR_CHECK', T: 'CRIAR_GATILHO'});

/** Estrutura exata do registro public.kidmais107_reparos (CREATE TABLE da migration). Colunas em ordem de attnum. */
const REGISTRO_COLUNAS = 'ordem smallint NOT NULL, acao text NOT NULL, tabela text NOT NULL, nome_anterior text, nome_novo text NOT NULL, '
  + 'definicao text NOT NULL, registrado_em timestamp with time zone NOT NULL DEFAULT clock_timestamp()';
/** Restrições do registro (sem as NOT NULL, que o PG 18 também cataloga em pg_constraint: conferidas pelas colunas).
 *  NO INHERIT só é forma para CHECK: no PG 18 a PK tem connoinherit = true (medido no cluster E4, 29/10/2026),
 *  `tipo:deparse`, ordenadas como o SQL ordena (contype, depois texto, COLLATE "C"). Derivadas, NÃO medidas. */
const REGISTRO_RESTRICOES = Object.freeze([
  "c:CHECK ((acao = ANY (ARRAY['RENOMEAR_INDICE'::text, 'RENOMEAR_CHECK'::text, 'CRIAR_GATILHO'::text, 'CRIAR_CHECK'::text])))",
  "c:CHECK ((tabela = ANY (ARRAY['bloqueios_agenda'::text, 'configuracao_agenda'::text])))",
  "c:CHECK (((acao ~~ 'RENOMEAR_%'::text) = (nome_anterior IS NOT NULL)))",
  'p:PRIMARY KEY (ordem)',
].slice().sort(compararC));

/** Constantes que NÃO vieram de medição no staging PG 18 (relatório e teste). */
const A_CONFIRMAR_NO_CLUSTER = Object.freeze([
  ...DEFINICOES.filter((d) => d.origem === ORIGEM_LOCAL_097).map((d) => `${d.canonico}: ${d.esperado}`),
  `REGISTRO_COLUNAS: ${REGISTRO_COLUNAS}`,
  ...REGISTRO_RESTRICOES.map((r) => `REGISTRO_RESTRICOES: ${r}`),
]);

function compararC(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Literal SQL (standard_conforming_strings), NULL para null. */
function lit(v) { return v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }

function cteDefinicoes() {
  const linhas = DEFINICOES.map((d) => `    (${d.n}, ${lit(d.tipo)}, ${lit(d.tabela)}, ${lit(d.canonico)}, ${d.deriva === null ? 'NULL::text' : lit(d.deriva)}, `
    + `${lit(d.esperado)}, ${d.expr === null ? 'NULL::text' : lit(d.expr)})`);
  return `  def(n, tipo, tabela, canonico, deriva, esperado, expr) AS (VALUES\n${linhas.join(',\n')}\n  )`;
}

const FN = `to_regprocedure(${lit(FUNCAO_GATILHO)})`;
const rel = (col) => `to_regclass('public.' || ${col})`;
/** Estrutura do gatilho (alias t), com o texto da função fixado pelo OID (sem depender do search_path). */
const estruturaGatilho = (t) => `${t}.tgtype || '|' || CASE WHEN ${t}.tgfoid = ${FN} THEN 'kidmais_set_atualizado_em()' ELSE ${t}.tgfoid::regprocedure::text END`
  + ` || '|' || ${t}.tgnargs || '|' || (${t}.tgqual IS NULL) || '|' || cardinality(${t}.tgattr::int2[]) || '|' || ${t}.tgenabled::text`;

const CTE_BASE = `  base AS (
    SELECT to_regclass('public.bloqueios_agenda') IS NOT NULL AND to_regclass('public.configuracao_agenda') IS NOT NULL
             AND ${FN} IS NOT NULL AS ok,
           current_setting('server_version_num')::int / 10000 AS pg_maior,
           to_regclass('public.kidmais107_reparos') IS NOT NULL AS ja_aplicada
  )`;

/**
 * F0 / avaliação objeto a objeto, com as MESMAS regras da migration 107, sem escrever (READ ONLY, sem tabela temporária).
 * Uma linha por objeto: n, tipo, tabela, canonico, deriva, estado, linhas_violam, ja_aplicada, pg_maior.
 * estado: CANONICO | DERIVA (renomear) | AUSENTE_CRIAVEL (só N/T) | RECUSA:<motivo>, onde motivo ∈
 *   PG_MAIOR (servidor ≠ PG_MAIOR: constantes não valem), BASE_AUSENTE (precheck da migration),
 *   GATILHO_OUTRO_NOME (outro gatilho na tabela chama a mesma função), DOIS_NOMES (canônico e deriva juntos),
 *   DEFINICAO_DIFERENTE (canônico com outro texto, índice inválido/não pronto [INVALIDO], CHECK não validado/NO INHERIT/
 *   não-CHECK [FORMA], gatilho desligado), DEFINICAO_DIFERENTE_DERIVA (idem no nome da deriva), NOME_OCUPADO (o nome
 *   canônico do índice já é outra relação: o RENAME falharia), LINHA_VIOLA (CHECK nao_vazio a criar violado por
 *   alguma linha), AUSENTE (índice/CHECK sem nenhum dos dois nomes).
 * linhas_violam: só para N ausente (lido por query_to_xml de um SELECT EXISTS); null nos demais.
 */
function sqlAvaliacao107() {
  return `WITH
${cteDefinicoes()},
${CTE_BASE},
  med AS (
    SELECT d.n, d.tipo, d.tabela, d.canonico, d.deriva, d.esperado, d.expr,
           CASE d.tipo
             WHEN 'I' THEN (SELECT regexp_replace(pg_get_indexdef(i.indexrelid), ${lit(RE_INDICE)}, '')
                                   || CASE WHEN i.indisvalid AND i.indisready THEN '' ELSE ' [INVALIDO]' END
                              FROM pg_index i WHERE i.indexrelid = ${rel('d.canonico')} AND i.indrelid = ${rel('d.tabela')})
             WHEN 'T' THEN (SELECT ${estruturaGatilho('t')}
                              FROM pg_trigger t WHERE t.tgrelid = ${rel('d.tabela')} AND t.tgname = d.canonico AND NOT t.tgisinternal)
             ELSE (SELECT pg_get_constraintdef(c.oid) || CASE WHEN c.contype = 'c' AND c.convalidated AND NOT c.connoinherit THEN '' ELSE ' [FORMA]' END
                     FROM pg_constraint c WHERE c.conrelid = ${rel('d.tabela')} AND c.conname = d.canonico)
           END AS atual_canonico,
           CASE
             WHEN d.deriva IS NULL THEN NULL
             WHEN d.tipo = 'I' THEN (SELECT regexp_replace(pg_get_indexdef(i.indexrelid), ${lit(RE_INDICE)}, '')
                                            || CASE WHEN i.indisvalid AND i.indisready THEN '' ELSE ' [INVALIDO]' END
                                       FROM pg_index i WHERE i.indexrelid = ${rel('d.deriva')} AND i.indrelid = ${rel('d.tabela')})
             ELSE (SELECT pg_get_constraintdef(c.oid) || CASE WHEN c.contype = 'c' AND c.convalidated AND NOT c.connoinherit THEN '' ELSE ' [FORMA]' END
                     FROM pg_constraint c WHERE c.conrelid = ${rel('d.tabela')} AND c.conname = d.deriva)
           END AS atual_deriva,
           d.tipo = 'T' AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ${rel('d.tabela')} AND NOT t.tgisinternal
                                      AND t.tgfoid = ${FN} AND t.tgname <> d.canonico) AS outro_gatilho,
           d.tipo = 'I' AND ${rel('d.canonico')} IS NOT NULL AS nome_canonico_existe
      FROM def d
  ),
  viol AS (
    SELECT m.*,
           CASE WHEN b.ok AND m.tipo = 'N' AND m.atual_canonico IS NULL AND m.atual_deriva IS NULL
                THEN (xpath('/row/v/text()', query_to_xml(format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE NOT (%s)) AS v', m.tabela, m.expr),
                                                            false, true, '')))[1]::text = 'true'
           END AS linhas_violam
      FROM med m CROSS JOIN base b
  )
SELECT v.n, v.tipo, v.tabela, v.canonico, v.deriva,
       CASE
         WHEN b.pg_maior <> ${PG_MAIOR} THEN 'RECUSA:PG_MAIOR'
         WHEN NOT b.ok THEN 'RECUSA:BASE_AUSENTE'
         WHEN v.outro_gatilho THEN 'RECUSA:GATILHO_OUTRO_NOME'
         WHEN v.atual_canonico IS NOT NULL AND v.atual_deriva IS NOT NULL THEN 'RECUSA:DOIS_NOMES'
         WHEN v.atual_canonico IS NOT NULL THEN CASE WHEN v.atual_canonico = v.esperado THEN 'CANONICO' ELSE 'RECUSA:DEFINICAO_DIFERENTE' END
         WHEN v.atual_deriva IS NOT NULL THEN
           CASE WHEN v.atual_deriva IS DISTINCT FROM v.esperado THEN 'RECUSA:DEFINICAO_DIFERENTE_DERIVA'
                WHEN v.nome_canonico_existe THEN 'RECUSA:NOME_OCUPADO'
                ELSE 'DERIVA' END
         WHEN v.tipo = 'N' THEN CASE WHEN v.linhas_violam THEN 'RECUSA:LINHA_VIOLA' ELSE 'AUSENTE_CRIAVEL' END
         WHEN v.tipo = 'T' THEN 'AUSENTE_CRIAVEL'
         ELSE 'RECUSA:AUSENTE'
       END AS estado,
       v.linhas_violam, b.ja_aplicada, b.pg_maior
  FROM viol v CROSS JOIN base b
 ORDER BY v.n`;
}

const SQL_REGISTRO_LEITURA = 'SELECT ordem, acao, tabela, nome_anterior, nome_novo, definicao FROM public.kidmais107_reparos ORDER BY ordem';

/**
 * E4-2 / integridade da 107 aplicada: linhas (ok boolean, motivo text), na ordem; a 107 está íntegra se TODAS têm ok.
 * Confere: PG maior; base da 005; os 14 objetos canônicos com a definição esperada, na tabela certa (índice válido,
 * pronto e vivo, não único; CHECK validado, não NO INHERIT; gatilho ligado com a estrutura exata, sem constraint trigger
 * nem tabelas de transição); nenhum outro gatilho com a mesma função; nenhum nome de deriva (os 9 conhecidos e os padrões
 * ck_* do postcheck da migration); registro kidmais107_reparos presente com a estrutura exata (tabela comum permanente,
 * colunas/tipos/nulidade/default, PK e CHECKs); cada ação registrada coerente (alvo conhecido e único, ação/tabela/nome
 * anterior/definição iguais ao que a migration grava, nome anterior ausente, ordem 1..k crescente com os objetos).
 * Registro vazio = base canônica, legítimo. Linhas do registro só são lidas se a estrutura estiver exata.
 */
function sqlIntegridade107() {
  return `WITH
${cteDefinicoes()},
${CTE_BASE},
  obj AS (
    SELECT d.n, d.tipo, d.tabela, d.canonico, d.deriva, d.esperado,
           CASE d.tipo
             WHEN 'I' THEN (SELECT regexp_replace(pg_get_indexdef(i.indexrelid), ${lit(RE_INDICE)}, '')
                              FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                             WHERE i.indexrelid = ${rel('d.canonico')} AND i.indrelid = ${rel('d.tabela')}
                               AND c.relkind = 'i' AND c.relnamespace = 'public'::regnamespace
                               AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique)
             WHEN 'T' THEN (SELECT ${estruturaGatilho('t')}
                              FROM pg_trigger t
                             WHERE t.tgrelid = ${rel('d.tabela')} AND t.tgname = d.canonico AND NOT t.tgisinternal
                               AND t.tgfoid = ${FN} AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
             ELSE (SELECT pg_get_constraintdef(c.oid)
                     FROM pg_constraint c
                    WHERE c.conrelid = ${rel('d.tabela')} AND c.conname = d.canonico
                      AND c.contype = 'c' AND c.convalidated AND NOT c.connoinherit)
           END AS atual,
           CASE WHEN d.tipo = 'T' THEN (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = ${rel('d.tabela')} AND NOT t.tgisinternal
                                                                       AND t.tgfoid = ${FN} AND t.tgname <> d.canonico) = 0
                ELSE true END AS sem_outro_gatilho,
           CASE WHEN d.deriva IS NULL THEN false
                WHEN d.tipo = 'I' THEN ${rel('d.deriva')} IS NOT NULL
                ELSE EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = d.deriva) END AS deriva_presente
      FROM def d
  ),
  reg_estr AS (
    SELECT r.oid IS NOT NULL AS existe,
           COALESCE((SELECT c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition AND c.relnamespace = 'public'::regnamespace
                       FROM pg_class c WHERE c.oid = r.oid), false) AS forma,
           (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                              || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                              || COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
                              || CASE WHEN a.attidentity <> '' OR a.attgenerated <> '' THEN ' [GERADA]' ELSE '' END,
                              ', ' ORDER BY a.attnum)
              FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
             WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped) AS colunas,
           (SELECT string_agg(c.contype::text || ':' || pg_get_constraintdef(c.oid)
                              || CASE WHEN c.convalidated AND (c.contype <> 'c' OR NOT c.connoinherit) THEN '' ELSE ' [FORMA]' END,
                              ' | ' ORDER BY c.contype::text COLLATE "C", pg_get_constraintdef(c.oid) COLLATE "C")
              FROM pg_constraint c WHERE c.conrelid = r.oid AND c.contype <> 'n') AS restricoes
      FROM (SELECT to_regclass('public.kidmais107_reparos')::oid AS oid) r
  ),
  reg_ok AS (
    SELECT e.existe AND e.forma AND e.colunas IS NOT DISTINCT FROM ${lit(REGISTRO_COLUNAS)}
           AND e.restricoes IS NOT DISTINCT FROM ${lit(REGISTRO_RESTRICOES.join(' | '))} AS ok
      FROM reg_estr e
  ),
  reg AS (
    SELECT x.ordem, x.acao, x.tabela, x.nome_anterior, x.nome_novo, x.definicao
      FROM reg_ok o,
           XMLTABLE('/table/row' PASSING (CASE WHEN o.ok THEN query_to_xml(${lit(SQL_REGISTRO_LEITURA)}, false, false, '') END)
                    COLUMNS ordem int PATH 'ordem', acao text PATH 'acao', tabela text PATH 'tabela',
                            nome_anterior text PATH 'nome_anterior', nome_novo text PATH 'nome_novo', definicao text PATH 'definicao') x
  ),
  regd AS (
    SELECT r.*, d.n, d.tipo, d.tabela AS d_tabela, d.deriva AS d_deriva, d.esperado AS d_esperado,
           row_number() OVER (ORDER BY r.ordem) AS pos,
           count(*) OVER (PARTITION BY r.nome_novo) AS repeticoes,
           lag(d.n) OVER (ORDER BY r.ordem) AS n_anterior
      FROM reg r LEFT JOIN def d ON d.canonico = r.nome_novo
  ),
  verif(grupo, sub, ok, motivo) AS (
    SELECT 1, 0, b.pg_maior = ${PG_MAIOR}, 'PostgreSQL maior diferente de ${PG_MAIOR} (constantes de deparse não valem)' FROM base b
    UNION ALL
    SELECT 2, 0, b.ok, 'agenda da 005 ausente (configuracao_agenda, bloqueios_agenda ou kidmais_set_atualizado_em())' FROM base b
    UNION ALL
    SELECT 3, o.n, COALESCE(o.atual = o.esperado, false),
           format('%s (%s) ausente, em outra tabela, inválido, não validado, desligado ou com definição diferente', o.canonico, o.tabela)
      FROM obj o
    UNION ALL
    SELECT 4, o.n, o.sem_outro_gatilho, format('%s: outro gatilho chama a mesma função', o.tabela) FROM obj o WHERE o.tipo = 'T'
    UNION ALL
    SELECT 5, o.n, NOT o.deriva_presente, format('nome de deriva %s ainda existe', o.deriva) FROM obj o WHERE o.deriva IS NOT NULL
    UNION ALL
    SELECT 6, 0, NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname LIKE 'ck\\_bloqueios\\_agenda\\_%' OR c.conname LIKE 'ck\\_configuracao\\_agenda\\_%'),
           'constraint ck_bloqueios_agenda_*/ck_configuracao_agenda_* ainda existe'
    UNION ALL
    SELECT 7, 0, e.existe, 'registro kidmais107_reparos ausente (107 não aplicada)' FROM reg_estr e
    UNION ALL
    SELECT 8, 0, NOT e.existe OR (e.forma AND e.colunas IS NOT DISTINCT FROM ${lit(REGISTRO_COLUNAS)}), 'registro kidmais107_reparos: tabela ou colunas diferentes da 107'
      FROM reg_estr e
    UNION ALL
    SELECT 9, 0, NOT e.existe OR e.restricoes IS NOT DISTINCT FROM ${lit(REGISTRO_RESTRICOES.join(' | '))}, 'registro kidmais107_reparos: PK ou CHECKs diferentes da 107'
      FROM reg_estr e
    UNION ALL
    SELECT 10, r.ordem, r.n IS NOT NULL AND r.repeticoes = 1,
           format('registro ordem %s: alvo %s desconhecido ou repetido', r.ordem, r.nome_novo) FROM regd r
    UNION ALL
    SELECT 11, r.ordem, COALESCE(r.ordem = r.pos AND (r.n_anterior IS NULL OR r.n_anterior < r.n), false),
           format('registro ordem %s: fora da sequência 1..k na ordem dos objetos', r.ordem) FROM regd r
    UNION ALL
    SELECT 12, r.ordem,
           COALESCE(r.acao = CASE r.tipo WHEN 'I' THEN ${lit(ACAO_POR_TIPO.I)} WHEN 'K' THEN ${lit(ACAO_POR_TIPO.K)}
                                         WHEN 'N' THEN ${lit(ACAO_POR_TIPO.N)} WHEN 'T' THEN ${lit(ACAO_POR_TIPO.T)} END
                    AND r.tabela = r.d_tabela
                    AND r.nome_anterior IS NOT DISTINCT FROM CASE WHEN r.tipo IN ('I', 'K') THEN r.d_deriva END
                    AND r.definicao = r.d_esperado, false),
           format('registro ordem %s (%s): ação, tabela, nome anterior ou definição diferentes do que a 107 grava', r.ordem, r.nome_novo) FROM regd r
    UNION ALL
    SELECT 13, r.ordem,
           r.nome_anterior IS NULL OR CASE WHEN r.acao = ${lit(ACAO_POR_TIPO.I)} THEN ${rel('r.nome_anterior')} IS NULL
                                           ELSE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = r.nome_anterior) END,
           format('registro ordem %s: nome anterior %s ainda existe', r.ordem, r.nome_anterior) FROM regd r
  )
SELECT ok, motivo FROM verif ORDER BY grupo, sub`;
}

module.exports = {
  PG_MAIOR, RE_INDICE, GATILHO_ESTRUTURA, FUNCAO_GATILHO, DEFINICOES, ACAO_POR_TIPO, REGISTRO_COLUNAS, REGISTRO_RESTRICOES,
  A_CONFIRMAR_NO_CLUSTER, ORIGEM_STAGING, ORIGEM_LOCAL_097, ORIGEM_MIGRATION, SQL_REGISTRO_LEITURA,
  sqlAvaliacao107, sqlIntegridade107, lit,
};
