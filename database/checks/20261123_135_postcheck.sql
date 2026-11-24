-- Somente leitura. A 135 criou a tabela de consumo com as colunas, a chave e as travas esperadas, sem dado pessoal.
DO $$
DECLARE colunas text; travas text; literais text;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  IF to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NULL THEN
    RAISE EXCEPTION '135: tabela whatsapp_atendimento_consumo_mensal ausente';
  END IF;
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' ORDER BY a.attnum) INTO colunas
  FROM pg_attribute a WHERE a.attrelid = 'public.whatsapp_atendimento_consumo_mensal'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF colunas IS DISTINCT FROM 'empresa_id:uuid:true,ambiente:text:true,mes:text:true,usadas:integer:true,atualizado_em:timestamp with time zone:true' THEN
    RAISE EXCEPTION '135: colunas divergentes (%)', colunas;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.whatsapp_atendimento_consumo_mensal'::regclass AND c.contype = 'p'
                 AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (empresa_id, ambiente, mes)') THEN
    RAISE EXCEPTION '135: chave primária (empresa_id, ambiente, mes) ausente';
  END IF;
  -- Astra r2/r3 (P3): confere a DEFINIÇÃO das três travas CHECK, normalizada (sem espaços, parênteses e o cast ::text)
  -- para não depender da formatação do pg_get_constraintdef entre versões do PostgreSQL.
  SELECT string_agg(d, ' | ' ORDER BY d) INTO travas FROM (
    SELECT regexp_replace(replace(lower(pg_get_constraintdef(c.oid)), '::text', ''), '[[:space:]()]', '', 'g') AS d
    FROM pg_constraint c WHERE c.conrelid = 'public.whatsapp_atendimento_consumo_mensal'::regclass AND c.contype = 'c') t;
  IF travas IS DISTINCT FROM 'checkambiente=anyarray[''staging'',''production''] | checkmes~''^[0-9]{4}-0[1-9]|1[0-2]$'' | checkusadas>=0' THEN
    RAISE EXCEPTION '135: travas CHECK divergentes (%)', travas;
  END IF;
  -- Astra r4 (P3): a normalização acima apaga também os parênteses DE DENTRO da regex; os literais SQL das travas são
  -- conferidos à parte, exatos (uma regex de mês enfraquecida, sem o grupo, recusa aqui).
  SELECT string_agg(l[1], ' | ' ORDER BY l[1] COLLATE "C") INTO literais
  FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g') AS l
  WHERE c.conrelid = 'public.whatsapp_atendimento_consumo_mensal'::regclass AND c.contype = 'c';
  IF literais IS DISTINCT FROM '^[0-9]{4}-(0[1-9]|1[0-2])$ | production | staging' THEN
    RAISE EXCEPTION '135: literais das travas CHECK divergentes (%)', literais;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.whatsapp_atendimento_consumo_mensal'::regclass AND c.contype = 'f'
                 AND c.confrelid = 'public.empresas'::regclass AND c.confdeltype = 'c') THEN
    RAISE EXCEPTION '135: referência a empresas (ON DELETE CASCADE) ausente';
  END IF;
END $$;
