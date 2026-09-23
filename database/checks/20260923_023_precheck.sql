-- Somente leitura; executar apenas em clone isolado autorizado.
DO $$ BEGIN
  IF to_regclass('public.pacote_adicionais') IS NULL THEN
    RAISE EXCEPTION 'Estrutura 021 ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM pacote_adicionais) THEN
    RAISE EXCEPTION 'Já existem vínculos: revisar antes da carga inicial 023.';
  END IF;
END $$;
SELECT 'pre_023' AS marco,(SELECT count(*) FROM fechamentos) AS fechamentos;
