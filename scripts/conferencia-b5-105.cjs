// B-5 ampliado: estrutura da 105 (mcp_oauth_concessoes) conferida pelo agregador scripts/conferencia-b5-producao.cjs, na MESMA
// fotografia (REPEATABLE READ READ ONLY) da integridade herdada do aplicador. Módulo separado desde a rodada 8 para o
// agregador caber na carga por parte do bloco do Web Shell; só constantes e SQL de catálogo, sem efeito ao carregar.

// Revisão Astra r3 (A): as garantias positivas da 105 pela definição: índice único parcial com as chaves e o predicado EXATOS
// (pg_get_indexdef, search_path fixo) e válido, pronto, vivo e imediato; um único gatilho com esse nome, na relação certa, com a
// definição exata (sem WHEN, sem UPDATE OF, função de public sem qualificação) e ligado ao OID da função de public cujo corpo
// foi conferido (plpgsql, RETURNS trigger).
const INDICE_105_DEF = 'CREATE UNIQUE INDEX mcp_oauth_concessoes_ativa_uk ON public.mcp_oauth_concessoes USING btree (usuario_id, empresa_id, client_id) WHERE (revogada_em IS NULL)';
const GATILHO_105_DEF = 'CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes FOR EACH ROW EXECUTE FUNCTION mcp_oauth_concessao_revogacao_imutavel()';
const CORPO_105 = '71cd349698aff45d2d36d5a1355466dbaa1db3d32115b4c9d2779c34ac87a862';
// Revisão Astra r4 (A): o gatilho compara a identidade com <> (NULL escapa). O conjunto EXATO de colunas NOT NULL de
// mcp_oauth_concessoes (o da migration) é exigido na mesma fotografia; no PG 18+, só conta NOT NULL validado (contype 'n').
// Rodada 8: as listas por nome usam COLLATE "C" (a ordem não depende da collation padrão do banco).
const NAO_NULAS_105 = 'client_id,cliente_nome,criada_em,empresa_id,escopos,id,recurso,redirect_uri,usuario_id';
// Revisão Astra r6 (A): impressão digital das colunas de mcp_oauth_concessoes na ordem de attnum — nome, tipo, NOT NULL,
// GERADA (o valor de coluna gerada armazenada é calculado DEPOIS dos gatilhos BEFORE), IDENTITY, collation fora do padrão e
// DEFAULT —, igual à da migration aplicada (conferida no catálogo do PG 18 descartável).
const COLUNAS_105 = 'id uuid NOT NULL DEFAULT gen_random_uuid(); usuario_id uuid NOT NULL; empresa_id uuid NOT NULL; client_id text NOT NULL; '
  + 'cliente_nome text NOT NULL; redirect_uri text NOT NULL; escopos text[] NOT NULL; recurso text NOT NULL; '
  + 'criada_em timestamp with time zone NOT NULL DEFAULT clock_timestamp(); ultimo_uso_em timestamp with time zone; '
  + 'ultima_ferramenta_em timestamp with time zone; revogada_em timestamp with time zone; revogada_por uuid; motivo_revogacao text';
// Revisão Astra r5 (A): o conjunto DECLARADO (attnotnull ou qualquer restrição 'n', validada ou não) também tem de ser
// exatamente esse — um NOT NULL extra NOT VALID já recusa gravações novas. E a relação tem um único gatilho de usuário (a
// guarda) e nenhuma regra: outro gatilho BEFORE UPDATE posterior (ordem alfabética) poderia reescrever NEW depois dela.
const SQL_ESTRUTURA_105 = `SELECT
  (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indexrelid = to_regclass('public.mcp_oauth_concessoes_ativa_uk')) AS indice_def,
  coalesce((SELECT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND i.indrelid = to_regclass('public.mcp_oauth_concessoes') FROM pg_index i WHERE i.indexrelid = to_regclass('public.mcp_oauth_concessoes_ativa_uk')), false) AS indice_flags,
  (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'mcp_oauth_concessoes_revogacao_imutavel' AND NOT t.tgisinternal)::int AS gatilhos,
  (SELECT pg_get_triggerdef(t.oid, false) FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('public.mcp_oauth_concessoes') AND t.tgname = 'mcp_oauth_concessoes_revogacao_imutavel') AS gatilho_def,
  coalesce((SELECT t.tgfoid = p.oid AND t.tgqual IS NULL AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.tgnargs = 0 AND NOT t.tgisinternal
      AND p.prorettype = 'trigger'::regtype AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql') AND NOT p.prosecdef
      AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = '${CORPO_105}'
    FROM pg_trigger t, pg_proc p
    WHERE t.tgrelid = to_regclass('public.mcp_oauth_concessoes') AND t.tgname = 'mcp_oauth_concessoes_revogacao_imutavel'
      AND p.oid = to_regprocedure('public.mcp_oauth_concessao_revogacao_imutavel()')), false) AS gatilho_funcao,
  (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.mcp_oauth_concessoes') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      AND (current_setting('server_version_num')::int < 180000 OR EXISTS (SELECT 1 FROM pg_constraint n
        WHERE n.conrelid = a.attrelid AND n.contype = 'n' AND n.conkey = ARRAY[a.attnum] AND n.convalidated))) AS nao_nulas,
  (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.mcp_oauth_concessoes') AND a.attnum > 0 AND NOT a.attisdropped
      AND (a.attnotnull OR EXISTS (SELECT 1 FROM pg_constraint n WHERE n.conrelid = a.attrelid AND n.contype = 'n' AND a.attnum = ANY (n.conkey)))) AS nao_nulas_declaradas,
  (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.mcp_oauth_concessoes') AND NOT t.tgisinternal)::int AS gatilhos_relacao,
  (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = to_regclass('public.mcp_oauth_concessoes'))::int AS regras,
  (SELECT string_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod)
      || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
      || CASE WHEN a.attgenerated::text <> '' THEN ' GENERATED ' || a.attgenerated::text ELSE '' END
      || CASE WHEN a.attidentity::text <> '' THEN ' IDENTITY ' || a.attidentity::text ELSE '' END
      || CASE WHEN a.attcollation NOT IN (0, 100) THEN ' COLLATE ' || a.attcollation::regcollation::text ELSE '' END
      || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), ''), '; ' ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.mcp_oauth_concessoes') AND a.attnum > 0 AND NOT a.attisdropped) AS colunas`;

// Revisão Astra r7 (P1 herança; P2 RLS forçada, CHECK trocado com a mesma contagem, configuração da função): em vez de
// fechar uma propriedade por rodada, o catálogo da relação (o conjunto listado abaixo, não mais) é comparado, linha a linha, com a referência da migration,
// na mesma fotografia e com search_path = pg_catalog (todo objeto fora de pg_catalog sai qualificado nas definições, então
// uma função, um tipo ou um operador homônimo em outro esquema muda o texto). Cobre:
//   - classe: tipo da relação, persistência, método de acesso, RLS ligada e forçada, identidade de réplica, partição, opções;
//   - herança nos DOIS sentidos (pg_inherits) e políticas de RLS, mesmo inativas;
//   - TODAS as restrições (PK, FKs com destino e ações, UNIQUE, CHECK, NOT NULL, exclusão), com validada, adiável,
//     local, sem herança e aplicada (PG 18), pela definição integral e com a relação de origem — inclusive as FKs de
//     ENTRADA (outras tabelas com confrelid = concessões; revisão Astra r8, P2: colunas e adiamento delas mudam o que
//     pode ser excluído aqui);
//   - TODOS os índices, com as flags e a definição;
//   - TODOS os gatilhos desta relação: os de usuário pela definição, os internos (FKs desta e das tabelas que a
//     referenciam) pela relação e nome da restrição, função, tipo, outra relação e adiamento; ligado/desligado em todos;
//   - colunas com tipo qualificado (domínio em outro esquema muda o texto) e DEFAULT qualificado;
//   - função da guarda: configuração (proconfig, inclusive search_path), SECURITY DEFINER, STRICT, volatilidade, paralelismo,
//     tipo e LEAKPROOF.
// Ordem por COLLATE "C". Ficam fora, por não alterarem o valor gravado: dono, ACL, estatísticas e armazenamento.
const SQL_RELACAO_105 = `SELECT (SELECT string_agg(x, chr(10) ORDER BY x COLLATE "C") FROM (
  SELECT concat_ws(' ', 'classe', c.relkind, c.relpersistence, coalesce(m.amname::text, '-'), 'rls', c.relrowsecurity, c.relforcerowsecurity,
      'replica', c.relreplident, 'particao', c.relispartition, 'opcoes', coalesce(c.reloptions::text, '-'))
    FROM pg_class c LEFT JOIN pg_am m ON m.oid = c.relam WHERE c.oid = to_regclass('public.mcp_oauth_concessoes')
  UNION ALL SELECT concat_ws(' ', 'heranca', count(*)) FROM pg_inherits h WHERE to_regclass('public.mcp_oauth_concessoes') IN (h.inhparent, h.inhrelid)
  UNION ALL SELECT concat_ws(' ', 'politicas', count(*)) FROM pg_policy p WHERE p.polrelid = to_regclass('public.mcp_oauth_concessoes')
  UNION ALL SELECT concat_ws(' ', 'restricao', k.conrelid::regclass, k.conname, k.contype, k.convalidated, k.condeferrable, k.condeferred, k.conislocal, k.connoinherit,
      coalesce(to_jsonb(k) ->> 'conenforced', '-'), pg_get_constraintdef(k.oid, false))
    FROM pg_constraint k WHERE to_regclass('public.mcp_oauth_concessoes') IN (k.conrelid, k.confrelid)
  UNION ALL SELECT concat_ws(' ', 'indice', i.indexrelid::regclass, i.indisunique, i.indisprimary, i.indisexclusion, i.indimmediate, i.indisvalid,
      i.indisready, i.indislive, i.indisreplident, pg_get_indexdef(i.indexrelid))
    FROM pg_index i WHERE i.indrelid = to_regclass('public.mcp_oauth_concessoes')
  UNION ALL SELECT concat_ws(' ', 'gatilho', CASE WHEN t.tgisinternal THEN concat_ws(' ', 'interno', coalesce(k.conrelid::regclass::text, '-'), coalesce(k.conname::text, '-'), t.tgfoid::regproc, t.tgtype,
        t.tgconstrrelid::regclass, t.tgdeferrable, t.tginitdeferred)
      ELSE pg_get_triggerdef(t.oid, false) END, t.tgenabled)
    FROM pg_trigger t LEFT JOIN pg_constraint k ON k.oid = t.tgconstraint WHERE t.tgrelid = to_regclass('public.mcp_oauth_concessoes')
  UNION ALL SELECT concat_ws(' ', 'coluna', lpad(a.attnum::text, 3, '0'), a.attname, format_type(a.atttypid, a.atttypmod),
      coalesce('DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '-'))
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.mcp_oauth_concessoes') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT concat_ws(' ', 'funcao', coalesce(p.proconfig::text, '-'), p.prosecdef, p.proisstrict, p.provolatile, p.proparallel, p.prokind, p.proleakproof)
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_oauth_concessao_revogacao_imutavel()')
) r(x)) AS relacao`;
// Referência: catálogo da base 088 + 099 + 105 (texto em LF) no PostgreSQL 18 descartável, uma linha por item.
const RELACAO_105 = [
  'classe r p heap rls f f replica d particao f opcoes -',
  'coluna 001 id uuid DEFAULT public.gen_random_uuid()',
  'coluna 002 usuario_id uuid -',
  'coluna 003 empresa_id uuid -',
  'coluna 004 client_id text -',
  'coluna 005 cliente_nome text -',
  'coluna 006 redirect_uri text -',
  'coluna 007 escopos text[] -',
  'coluna 008 recurso text -',
  'coluna 009 criada_em timestamp with time zone DEFAULT clock_timestamp()',
  'coluna 010 ultimo_uso_em timestamp with time zone -',
  'coluna 011 ultima_ferramenta_em timestamp with time zone -',
  'coluna 012 revogada_em timestamp with time zone -',
  'coluna 013 revogada_por uuid -',
  'coluna 014 motivo_revogacao text -',
  'funcao - f f v u f f',
  'gatilho CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel() O',
  'gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_codigos f f O',
  'gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_codigos f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey "RI_FKey_check_ins" 5 public.mcp_oauth_clientes f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey "RI_FKey_check_upd" 17 public.mcp_oauth_clientes f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey "RI_FKey_check_ins" 5 public.empresas f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey "RI_FKey_check_upd" 17 public.empresas f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_revogada_por_fkey "RI_FKey_check_ins" 5 public.usuarios_administrativos f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_revogada_por_fkey "RI_FKey_check_upd" 17 public.usuarios_administrativos f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_usuario_id_fkey "RI_FKey_check_ins" 5 public.usuarios_administrativos f f O',
  'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_usuario_id_fkey "RI_FKey_check_upd" 17 public.usuarios_administrativos f f O',
  'gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_tokens f f O',
  'gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_tokens f f O',
  'heranca 0',
  'indice public.mcp_oauth_concessoes_ativa_uk t f f t t t t f CREATE UNIQUE INDEX mcp_oauth_concessoes_ativa_uk ON public.mcp_oauth_concessoes USING btree (usuario_id, empresa_id, client_id) WHERE (revogada_em IS NULL)',
  'indice public.mcp_oauth_concessoes_empresa_idx f f f t t t t f CREATE INDEX mcp_oauth_concessoes_empresa_idx ON public.mcp_oauth_concessoes USING btree (empresa_id) WHERE (revogada_em IS NULL)',
  'indice public.mcp_oauth_concessoes_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_oauth_concessoes_pkey ON public.mcp_oauth_concessoes USING btree (id)',
  'indice public.mcp_oauth_concessoes_usuario_idx f f f t t t t f CREATE INDEX mcp_oauth_concessoes_usuario_idx ON public.mcp_oauth_concessoes USING btree (usuario_id, criada_em DESC)',
  'politicas 0',
  'restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_check c t f f t f true CHECK (((revogada_em IS NULL) = (motivo_revogacao IS NULL)))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey f t f f t t true FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clientes(client_id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_not_null n t f f t f true NOT NULL client_id',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_cliente_nome_check c t f f t f true CHECK ((length(cliente_nome) <= 120))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_cliente_nome_not_null n t f f t f true NOT NULL cliente_nome',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_criada_em_not_null n t f f t f true NOT NULL criada_em',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_fkey f t f f t t true FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_empresa_id_not_null n t f f t f true NOT NULL empresa_id',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_escopos_check c t f f t f true CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY[\'agenda:read\'::text, \'financeiro:read\'::text, \'conhecimento:read\'::text])))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_escopos_not_null n t f f t f true NOT NULL escopos',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_id_not_null n t f f t f true NOT NULL id',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_motivo_revogacao_check c t f f t f true CHECK ((motivo_revogacao = ANY (ARRAY[\'USUARIO\'::text, \'REUSO\'::text, \'SUBSTITUIDA\'::text])))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_pkey p t f f t t true PRIMARY KEY (id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_recurso_check c t f f t f true CHECK ((length(recurso) <= 500))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_recurso_not_null n t f f t f true NOT NULL recurso',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_redirect_uri_check c t f f t f true CHECK (((redirect_uri ~ \'^https://\'::text) AND (length(redirect_uri) <= 500)))',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_redirect_uri_not_null n t f f t f true NOT NULL redirect_uri',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_revogada_por_fkey f t f f t t true FOREIGN KEY (revogada_por) REFERENCES public.usuarios_administrativos(id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_usuario_id_fkey f t f f t t true FOREIGN KEY (usuario_id) REFERENCES public.usuarios_administrativos(id)',
  'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_usuario_id_not_null n t f f t f true NOT NULL usuario_id',
  'restricao public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
].join(String.fromCharCode(10));

module.exports = {INDICE_105_DEF, GATILHO_105_DEF, CORPO_105, NAO_NULAS_105, COLUNAS_105, SQL_ESTRUTURA_105, SQL_RELACAO_105, RELACAO_105};
