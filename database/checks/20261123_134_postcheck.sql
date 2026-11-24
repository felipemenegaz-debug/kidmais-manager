-- Somente leitura. A 134 criou só plataforma_empresas_uso, com as colunas e restrições revisadas.
DO $$
DECLARE forma text;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  -- Astra r2 (P3): pg_get_indexdef/pg_get_constraintdef sem aspas, qualquer que seja a configuração da sessão.
  SET LOCAL quote_all_identifiers = off;
  IF to_regclass('public.plataforma_empresas_uso') IS NULL THEN
    RAISE EXCEPTION '134: plataforma_empresas_uso ausente';
  END IF;
  SELECT (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                            || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = 'public.plataforma_empresas_uso'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
      || '|' ||
         (SELECT string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), ',' ORDER BY c.conname)
            -- contype 'n' (NOT NULL como restrição, PG 18+) fica de fora: o NOT NULL já é conferido por attnotnull acima.
            FROM pg_constraint c WHERE c.conrelid = 'public.plataforma_empresas_uso'::regclass AND c.contype <> 'n')
      || '|' ||
         -- Astra r1 (P2): toda restrição (inclusive as 'n') precisa estar validada; NOT VALID não passa.
         (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.plataforma_empresas_uso'::regclass AND NOT c.convalidated)
      || '|' ||
         -- Astra r1 (P2): só o índice da PK; um UNIQUE extra (ex.: em uso) impediria marcar a 2ª empresa.
         (SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY pg_get_indexdef(i.indexrelid))
            FROM pg_index i WHERE i.indrelid = 'public.plataforma_empresas_uso'::regclass)
      || '|' ||
         (SELECT count(*)::text FROM pg_trigger t WHERE t.tgrelid = 'public.plataforma_empresas_uso'::regclass AND NOT t.tgisinternal)
    INTO forma;
  IF forma IS DISTINCT FROM 'empresa_id:uuid:true:,uso:text:true:,atualizado_por:uuid:true:,atualizado_em:timestamp with time zone:true:clock_timestamp()|kidmais_134_uso_atualizado_por_fk:FOREIGN KEY (atualizado_por) REFERENCES usuarios_administrativos(id) ON UPDATE RESTRICT ON DELETE RESTRICT,kidmais_134_uso_ck:CHECK ((uso = ANY (ARRAY[''CLIENTE''::text, ''INTERNA''::text]))),kidmais_134_uso_empresa_fk:FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT,plataforma_empresas_uso_pkey:PRIMARY KEY (empresa_id)|0|CREATE UNIQUE INDEX plataforma_empresas_uso_pkey ON public.plataforma_empresas_uso USING btree (empresa_id)|0' THEN
    RAISE EXCEPTION '134: forma divergente de plataforma_empresas_uso: %', forma;
  END IF;
END $$;
