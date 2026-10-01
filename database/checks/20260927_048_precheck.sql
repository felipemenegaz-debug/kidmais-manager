-- Somente leitura. Não cria sucessora, não publica e não altera vigência.
DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL
     OR to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL
     OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NULL THEN
    RAISE EXCEPTION '048 precheck: publicação ou escopo anterior ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tabelas_preco'
       AND column_name IN ('substituida_em', 'substituida_por_id')
  ) OR to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '048 precheck: supersessão já existe.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'kidmais_035_preservar_tabela_publicada'
       AND pg_get_functiondef(oid) NOT LIKE '%kidmais_047_lacunas_escopo%'
  ) THEN
    RAISE EXCEPTION '048 precheck: a guarda de publicação não está na revisão 047.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco a
      JOIN tabelas_preco b
        ON b.id > a.id
       AND b.empresa_id IS NOT DISTINCT FROM a.empresa_id
       AND a.publicada_em IS NOT NULL
       AND b.publicada_em IS NOT NULL
       AND daterange(a.vigencia_inicio, COALESCE(a.vigencia_fim, 'infinity'::date), '[]')
           && daterange(b.vigencia_inicio, COALESCE(b.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '048 precheck: vigência publicada já se sobrepõe. Não corrigir daqui.'
      USING ERRCODE = '23514';
  END IF;
END $$;

SELECT 'pre_048' AS marco,
       (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
