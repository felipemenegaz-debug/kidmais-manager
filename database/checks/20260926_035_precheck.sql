-- Somente leitura. Não aplica a 035.
-- Recusa se a guarda já existe ou se a vigência publicada já se cruza.
DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL THEN
    RAISE EXCEPTION '035 precheck: tabelas de preço ausentes.';
  END IF;
  IF to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NOT NULL
     OR to_regprocedure('public.kidmais_035_preservar_preco_publicado()') IS NOT NULL THEN
    RAISE EXCEPTION '035 precheck: guarda de publicação já aplicada.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tabelas_preco' AND column_name = 'publicada_em'
  ) THEN
    RAISE EXCEPTION '035 precheck: publicada_em ausente.';
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
    RAISE EXCEPTION '035 precheck: vigência publicada já se sobrepõe. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_035' AS marco, (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
