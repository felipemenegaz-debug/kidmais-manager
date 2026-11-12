-- Precheck da 106 (somente leitura): 094 e 102 presentes, agenda_saloes_empresa_id_uk presente e 106 ausente.
-- Gerado a partir de database/migrations/20261027_106_salao_preferido.sql (corpos: 1e6d43d0…, a3684094…).
DO $$
BEGIN
  IF NOT (to_regclass('public.agenda_salao_fotos') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_id' AND NOT attisdropped)
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agenda_saloes'::regclass AND conname = 'agenda_saloes_empresa_id_uk' AND contype = 'u')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamentos'::regclass AND attname = 'salao_preferido_id' AND NOT attisdropped)
     AND to_regprocedure('public.kidmais106_salao_preferido_escopo()') IS NULL
     AND to_regprocedure('public.kidmais106_salao_escopo_referenciado()') IS NULL
     AND to_regclass('public.fechamentos_106_salao_preferido_idx') IS NULL) THEN
    RAISE EXCEPTION '106 precheck: pré-requisitos ausentes ou 106 já aplicada/parcial';
  END IF;
END $$;
