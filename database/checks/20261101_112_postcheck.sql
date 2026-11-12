-- 112 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura: colunas, CHECKs, índice e funções exatamente como a 112 cria,
-- e nenhuma linha fora do contrato (todas PF sem dado de PJ logo depois da aplicação; PJ só depois, pelo código).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE colunas jsonb; checks jsonb;
BEGIN
  SELECT jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
           || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), ''))
    INTO colunas
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.clientes'::regclass AND NOT a.attisdropped
     AND a.attname IN ('tipo_pessoa','cnpj','razao_social','nome_fantasia','representante_nome','representante_cpf');
  IF colunas IS DISTINCT FROM '{"tipo_pessoa":"text NOT NULL DEFAULT ''PF''::text","cnpj":"text","razao_social":"text",
      "nome_fantasia":"text","representante_nome":"text","representante_cpf":"character(11)"}'::jsonb
    THEN RAISE EXCEPTION '112 postcheck: colunas divergentes: %', colunas; END IF;

  SELECT jsonb_object_agg(conname, pg_get_constraintdef(oid)) INTO checks
    FROM pg_constraint WHERE conrelid = 'public.clientes'::regclass AND conname LIKE 'clientes\_112\_%' AND convalidated AND contype = 'c';
  IF checks IS DISTINCT FROM jsonb_build_object(
      'clientes_112_tipo_pessoa_check', 'CHECK ((tipo_pessoa = ANY (ARRAY[''PF''::text, ''PJ''::text])))',
      'clientes_112_cnpj_formato', 'CHECK (((cnpj IS NULL) OR kidmais_112_cnpj_valido(cnpj)))',
      'clientes_112_representante_cpf_formato', 'CHECK (((representante_cpf IS NULL) OR kidmais_112_cpf_valido((representante_cpf)::text)))',
      'clientes_112_textos_nao_vazios', 'CHECK ((((razao_social IS NULL) OR (btrim(razao_social) <> ''''::text)) AND ((nome_fantasia IS NULL) OR (btrim(nome_fantasia) <> ''''::text)) AND ((representante_nome IS NULL) OR (btrim(representante_nome) <> ''''::text))))',
      'clientes_112_pf_sem_campos_pj', 'CHECK (((tipo_pessoa <> ''PF''::text) OR ((cnpj IS NULL) AND (razao_social IS NULL) AND (nome_fantasia IS NULL) AND (representante_nome IS NULL) AND (representante_cpf IS NULL))))',
      'clientes_112_pj_identidade', 'CHECK (((tipo_pessoa <> ''PJ''::text) OR ((cnpj IS NOT NULL) AND (cpf IS NULL) AND (razao_social IS NOT NULL) AND (razao_social = nome_completo))))',
      'clientes_112_representante_nome', 'CHECK (((representante_cpf IS NULL) OR (representante_nome IS NOT NULL)))')
    THEN RAISE EXCEPTION '112 postcheck: CHECKs divergentes: %', checks; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.clientes_cnpj_empresa_canonico_uk')
       AND i.indisunique AND i.indisvalid AND i.indisready AND i.indrelid = 'public.clientes'::regclass
       AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX clientes_cnpj_empresa_canonico_uk ON public.clientes USING btree (COALESCE(empresa_id, ''00000000-0000-0000-0000-000000000000''::uuid), cnpj) WHERE ((cnpj IS NOT NULL) AND ((status)::text <> ''MESCLADO''::text))')
    THEN RAISE EXCEPTION '112 postcheck: índice de CNPJ por empresa ausente ou divergente'; END IF;
  -- O índice de CPF por empresa (076) continua intacto.
  IF to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NULL THEN RAISE EXCEPTION '112 postcheck: índice da 076 sumiu'; END IF;

  -- As 3 funções exatamente como a 112 cria: corpo (sha256 do prosrc sem CR, igual ao texto entre os delimitadores de cifrão da migration),
  -- linguagem, assinatura, retorno e atributos. Corpo trocado com a mesma assinatura e atributos também é divergência.
  SELECT jsonb_object_agg(p.proname, jsonb_build_object(
           'corpo', encode(sha256(convert_to(replace(p.prosrc, E'\r', ''), 'UTF8')), 'hex'), 'linguagem', l.lanname,
           'argumentos', pg_get_function_identity_arguments(p.oid), 'retorno', p.prorettype::regtype::text,
           'volatilidade', p.provolatile, 'strict', p.proisstrict, 'paralelo', p.proparallel, 'definer', p.prosecdef,
           'config', to_jsonb(p.proconfig)))
    INTO checks
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname IN ('kidmais_112_cpf_valido','kidmais_112_cnpj_valido','kidmais_112_mesclagem_mesmo_tipo');
  IF checks IS DISTINCT FROM jsonb_build_object(
      'kidmais_112_cpf_valido', jsonb_build_object('corpo', 'd754978a81e262b30c003a1c26a5aec6a13728ac61605458922e33ca1b80ee6d', 'linguagem', 'plpgsql',
        'argumentos', 'doc text', 'retorno', 'boolean', 'volatilidade', 'i', 'strict', true, 'paralelo', 's', 'definer', false, 'config', '["search_path=pg_catalog, pg_temp"]'::jsonb),
      'kidmais_112_cnpj_valido', jsonb_build_object('corpo', '68df108853c2a3075d76e4d20676c38c7a69ba0bced1669cfee3a3eaca29ee02', 'linguagem', 'plpgsql',
        'argumentos', 'doc text', 'retorno', 'boolean', 'volatilidade', 'i', 'strict', true, 'paralelo', 's', 'definer', false, 'config', '["search_path=pg_catalog, pg_temp"]'::jsonb),
      'kidmais_112_mesclagem_mesmo_tipo', jsonb_build_object('corpo', '2cda2e63b84658488320fbe2e75d8d1f9a5044a3c665ddecb25bf856f9540cba', 'linguagem', 'plpgsql',
        'argumentos', '', 'retorno', 'trigger', 'volatilidade', 'v', 'strict', false, 'paralelo', 'u', 'definer', false, 'config', '["search_path=pg_catalog, pg_temp"]'::jsonb))
    THEN RAISE EXCEPTION '112 postcheck: funções divergentes (corpo ou atributos): %', checks; END IF;
  -- Vetores conhecidos (mesmos dos testes de lib/cadastro/cnpj.ts e de cpfValidoServico).
  IF NOT (public.kidmais_112_cnpj_valido('11222333000181') AND public.kidmais_112_cnpj_valido('12ABC34501DE35')
          AND NOT public.kidmais_112_cnpj_valido('11222333000182') AND NOT public.kidmais_112_cnpj_valido('1122233300018')
          AND public.kidmais_112_cpf_valido('52998224725') AND NOT public.kidmais_112_cpf_valido('52998224726')
          AND NOT public.kidmais_112_cpf_valido('11111111111'))
    THEN RAISE EXCEPTION '112 postcheck: DV divergente nos vetores conhecidos'; END IF;
  -- Mesclagem só entre clientes do mesmo tipo: a função (corpo conferido acima) e os dois gatilhos ativos, nas colunas certas.
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
       AND t.tgfoid = to_regprocedure('public.kidmais_112_mesclagem_mesmo_tipo()')
       AND ((t.tgname = 'clientes_112_mesclagem_mesmo_tipo' AND t.tgrelid = 'public.clientes'::regclass
             AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER clientes_112_mesclagem_mesmo_tipo BEFORE INSERT OR UPDATE OF cliente_principal_id, tipo_pessoa ON public.clientes FOR EACH ROW EXECUTE FUNCTION kidmais_112_mesclagem_mesmo_tipo()')
         OR (t.tgname = 'mesclagens_clientes_112_mesmo_tipo' AND t.tgrelid = 'public.mesclagens_clientes'::regclass
             AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER mesclagens_clientes_112_mesmo_tipo BEFORE INSERT OR UPDATE OF cliente_principal_id, cliente_secundario_id ON public.mesclagens_clientes FOR EACH ROW EXECUTE FUNCTION kidmais_112_mesclagem_mesmo_tipo()'))) <> 2
    THEN RAISE EXCEPTION '112 postcheck: gatilhos de mesclagem ausentes ou divergentes'; END IF;
END $$;
SELECT current_database() AS banco,
       count(*) FILTER (WHERE tipo_pessoa = 'PJ') AS clientes_pj,
       count(*) FILTER (WHERE tipo_pessoa = 'PF') AS clientes_pf,
       true AS aprovado
  FROM clientes;
ROLLBACK;
