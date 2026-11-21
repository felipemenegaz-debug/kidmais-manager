-- 129 postcheck. Somente leitura. Validação ESTRUTURAL completa do registro (vault "Registro de migrations no banco 20261120",
-- §3.1, exigirRegistro): devolve uma linha com `divergencias` (vazio = íntegro) e `aprovado`. Não lança: o módulo
-- scripts/registro-migrations-banco.cjs usa esta mesma consulta (sha256 fixado) e traduz divergência em REGISTRO_INVALIDO.
-- Textos de catálogo gerados no PostgreSQL 18 (versão de staging, production e do PG descartável); em outra versão um texto
-- diferente recusa (falha fechada). A linha da 129 CONCLUIDA é conferida à parte pelo módulo (não no bootstrap).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
WITH t AS (
  SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relhasrules
    FROM pg_class c WHERE c.oid = to_regclass('public.operacao_migration_tentativas')
), s AS (
  SELECT c.oid, c.relowner, c.relacl FROM pg_class c WHERE c.oid = to_regclass('public.operacao_migration_tentativas_id_seq')
), f AS (
  SELECT p.oid, p.proowner, p.proacl, p.prosrc, p.prolang, p.prorettype, p.pronargs, p.prosecdef, p.proconfig
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.operacao_migration_tentativas_terminal()')
), colunas_esperadas(nome, tipo, nao_nulo, identidade, padrao) AS (VALUES
  ('id', 'bigint', true, 'a', NULL), ('tentativa', 'uuid', true, '', NULL), ('ambiente', 'text', true, '', NULL),
  ('migration', 'text', true, '', NULL), ('backup', 'text', true, '', NULL), ('situacao', 'text', true, '', NULL),
  ('versao', 'integer', true, '', '1'), ('detalhe', 'jsonb', true, '', '''{}''::jsonb'),
  ('iniciada_em', 'timestamp with time zone', true, '', 'clock_timestamp()'),
  ('atualizada_em', 'timestamp with time zone', true, '', 'clock_timestamp()'),
  ('arquivada_em', 'timestamp with time zone', false, '', NULL), ('arquivada_motivo', 'text', false, '', NULL),
  ('substituida_por', 'uuid', false, '', NULL)
), colunas_atuais AS (
  SELECT a.attname::text AS nome, format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull AS nao_nulo, a.attidentity::text AS identidade,
         a.attgenerated::text AS gerada,
         pg_get_expr(d.adbin, d.adrelid) AS padrao, a.attacl
    FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
), restricoes_esperadas(nome, tipo, definicao) AS (VALUES
  ('operacao_migration_tentativas_pk', 'p', 'PRIMARY KEY (id)'),
  ('operacao_migration_tentativas_tentativa_uk', 'u', 'UNIQUE (tentativa)'),
  ('operacao_migration_tentativas_ambiente_ck', 'c', 'CHECK ((ambiente = ANY (ARRAY[''production''::text, ''staging''::text])))'),
  ('operacao_migration_tentativas_migration_ck', 'c', 'CHECK ((migration ~ ''^[0-9]{3}[a-z]?$''::text))'),
  ('operacao_migration_tentativas_backup_ck', 'c', 'CHECK ((backup ~ ''^[A-Za-z0-9:._/ -]{6,120}$''::text))'),
  ('operacao_migration_tentativas_situacao_ck', 'c', 'CHECK ((situacao = ANY (ARRAY[''INICIADA''::text, ''EM_ANDAMENTO''::text, ''VERIFICACAO_PENDENTE''::text, ''CONCLUIDA''::text, ''FALHA''::text])))'),
  ('operacao_migration_tentativas_versao_ck', 'c', 'CHECK ((versao >= 1))'),
  ('operacao_migration_tentativas_detalhe_ck', 'c', 'CHECK ((jsonb_typeof(detalhe) = ''object''::text))'),
  ('operacao_migration_tentativas_arquivada_ck', 'c', 'CHECK ((((arquivada_em IS NULL) = (arquivada_motivo IS NULL)) AND ((arquivada_motivo IS NULL) OR ((char_length(arquivada_motivo) >= 10) AND (char_length(arquivada_motivo) <= 300)))))'),
  ('operacao_migration_tentativas_substituida_ck', 'c', 'CHECK (((substituida_por IS NULL) OR (arquivada_em IS NOT NULL)))')
), restricoes_atuais AS (
  SELECT k.conname::text AS nome, k.contype::text AS tipo, pg_get_constraintdef(k.oid) AS definicao, k.convalidated, k.condeferrable
    FROM t JOIN pg_constraint k ON k.conrelid = t.oid AND k.contype <> 'n'
), gatilhos AS (
  SELECT g.* FROM t JOIN pg_trigger g ON g.tgrelid = t.oid AND NOT g.tgisinternal
), indice AS (
  SELECT i.*, pg_get_indexdef(i.indexrelid) AS definicao FROM t JOIN pg_index i ON i.indrelid = t.oid
   WHERE i.indexrelid = to_regclass('public.operacao_migration_tentativas_ativa_uk')
), divergencias AS (
  -- "Concessão" = qualquer papel além do dono (inclusive PUBLIC, grantee 0); ACL nula vale o padrão do tipo.
  SELECT 'tabela ausente' AS d WHERE NOT EXISTS (SELECT 1 FROM t)
  UNION ALL SELECT 'tabela não é comum e permanente' FROM t WHERE relkind <> 'r' OR relpersistence <> 'p'
  UNION ALL SELECT 'tabela é partição' FROM t WHERE relispartition
  UNION ALL SELECT 'tabela com herança' FROM t WHERE EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = t.oid OR h.inhparent = t.oid)
  UNION ALL SELECT 'dono da tabela não é o papel atual' FROM t WHERE relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  UNION ALL SELECT 'RLS ligada' FROM t WHERE relrowsecurity OR relforcerowsecurity
  UNION ALL SELECT 'regra na tabela' FROM t WHERE EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class = t.oid)
  UNION ALL SELECT 'concessão na tabela' FROM t
    WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a WHERE a.grantee <> t.relowner)
  UNION ALL SELECT 'sequência ausente ou de outro dono' WHERE NOT EXISTS (SELECT 1 FROM s, t WHERE s.relowner = t.relowner)
  UNION ALL SELECT 'sequência não pertence à coluna id' FROM t
    WHERE NOT EXISTS (SELECT 1 FROM s JOIN pg_depend dp ON dp.objid = s.oid AND dp.refobjid = t.oid AND dp.deptype = 'i')
  UNION ALL SELECT 'concessão na sequência' FROM s
    WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(s.relacl, acldefault('s', s.relowner))) a WHERE a.grantee <> s.relowner)
  UNION ALL SELECT 'concessão por coluna ' || nome FROM colunas_atuais WHERE attacl IS NOT NULL
  UNION ALL SELECT 'privilégio padrão concede a outro papel (' || dfa.defaclobjtype::text || ')'
    FROM t JOIN pg_default_acl dfa ON dfa.defaclrole = t.relowner
     AND (dfa.defaclnamespace = 0 OR dfa.defaclnamespace = 'public'::regnamespace) AND dfa.defaclobjtype IN ('r', 'S', 'f')
   WHERE EXISTS (SELECT 1 FROM aclexplode(dfa.defaclacl) a WHERE a.grantee <> dfa.defaclrole)
  UNION ALL SELECT 'coluna divergente ' || coalesce(e.nome, a.nome)
    FROM colunas_esperadas e FULL JOIN colunas_atuais a ON a.nome = e.nome
   WHERE e.nome IS NULL OR a.nome IS NULL OR a.tipo <> e.tipo OR a.nao_nulo <> e.nao_nulo OR a.identidade <> e.identidade
      OR a.gerada <> '' OR a.padrao IS DISTINCT FROM e.padrao
  UNION ALL SELECT 'restrição divergente ' || coalesce(e.nome, a.nome)
    FROM restricoes_esperadas e FULL JOIN restricoes_atuais a ON a.nome = e.nome
   WHERE e.nome IS NULL OR a.nome IS NULL OR a.tipo <> e.tipo OR a.definicao <> e.definicao OR NOT a.convalidated OR a.condeferrable
  UNION ALL SELECT 'gatilhos: esperado exatamente um' WHERE (SELECT count(*) FROM gatilhos) <> 1
  UNION ALL SELECT 'gatilho divergente' FROM gatilhos g
   WHERE g.tgname <> 'operacao_migration_tentativas_terminal' OR g.tgtype <> 27 OR g.tgfoid IS DISTINCT FROM (SELECT oid FROM f)
      OR g.tgqual IS NOT NULL OR cardinality(g.tgattr::int2[]) <> 0 OR g.tgenabled <> 'O'
      OR pg_get_triggerdef(g.oid) <> 'CREATE TRIGGER operacao_migration_tentativas_terminal BEFORE DELETE OR UPDATE ON public.operacao_migration_tentativas FOR EACH ROW EXECUTE FUNCTION operacao_migration_tentativas_terminal()'
  UNION ALL SELECT 'função do gatilho ausente' WHERE NOT EXISTS (SELECT 1 FROM f)
  UNION ALL SELECT 'função do gatilho divergente' FROM f, t
   WHERE md5(f.prosrc) <> 'd5c2c57047dddd9173ee4b7f6268ba36' OR f.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      OR f.prorettype <> 'trigger'::regtype OR f.pronargs <> 0 OR f.prosecdef OR f.proowner <> t.relowner
      OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
  UNION ALL SELECT 'concessão na função' FROM f
    WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee <> f.proowner)
  UNION ALL SELECT 'índice da tentativa ativa ausente' WHERE NOT EXISTS (SELECT 1 FROM indice)
  UNION ALL SELECT 'índice da tentativa ativa divergente' FROM indice
   WHERE NOT indisunique OR NOT indisvalid OR NOT indisready OR NOT indislive
      OR definicao <> 'CREATE UNIQUE INDEX operacao_migration_tentativas_ativa_uk ON public.operacao_migration_tentativas USING btree (ambiente, migration) WHERE (arquivada_em IS NULL)'
)
SELECT coalesce((SELECT array_agg(d ORDER BY d) FROM divergencias), ARRAY[]::text[]) AS divergencias,
       NOT EXISTS (SELECT 1 FROM divergencias) AS aprovado;
ROLLBACK;
