-- Somente leitura. Não aplica a 032.
DO $$ BEGIN
  IF to_regclass('public.empresas') IS NULL OR to_regclass('public.pacotes') IS NULL THEN
    RAISE EXCEPTION '032 precheck: empresa ou pacote ausente.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'revisao_anterior_id'
  ) THEN
    RAISE EXCEPTION '032 precheck: revisão já aplicada.';
  END IF;
END $$;
SELECT 'pre_032' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NOT NULL) AS pacotes_com_empresa;
