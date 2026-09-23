-- Somente leitura. Executar exclusivamente em clone isolado autorizado antes da 021.
DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL OR
     to_regclass('public.adicionais') IS NULL OR
     to_regclass('public.precos_adicional') IS NULL OR
     to_regclass('public.fechamentos') IS NULL THEN
    RAISE EXCEPTION 'Núcleo V1 ausente.';
  END IF;
  IF to_regclass('public.buffet_categorias') IS NOT NULL OR
     to_regclass('public.adicional_categorias') IS NOT NULL OR
     to_regclass('public.documentos_publicos') IS NOT NULL THEN
    RAISE EXCEPTION 'Estrutura de catálogo já existe; verificar histórico antes de aplicar 021.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.adicionais WHERE btrim(categoria) = '') THEN
    RAISE EXCEPTION 'Categoria legada vazia impede o backfill.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.precos_adicional'::regclass
                   AND conname = 'precos_adicional_valor_check') THEN
    RAISE EXCEPTION 'Constraint de preço anterior não localizada.';
  END IF;
END $$;

SELECT 'pre_021' AS marco,
       (SELECT count(*) FROM public.adicionais) AS adicionais,
       (SELECT count(DISTINCT categoria) FROM public.adicionais) AS categorias,
       (SELECT count(*) FROM public.precos_adicional) AS precos,
       (SELECT count(*) FROM public.fechamentos) AS fechamentos;
