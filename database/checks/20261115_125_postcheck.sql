-- 125 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere tabelas, constraints-chave, índices e gatilhos da 125.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  tabela text;
  gatilho text;
  definicao text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['area_familia_avisos_pagamento', 'festa_pendencias_familia', 'area_familia_aviso_empresa'] LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN RAISE EXCEPTION '125 postcheck: tabela % ausente', tabela; END IF;
  END LOOP;
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
   WHERE conrelid = 'public.area_familia_eventos'::regclass AND conname = 'area_familia_eventos_tipo_check' AND contype = 'c' AND convalidated;
  IF definicao IS NULL OR strpos(definicao, 'AVISO_PAGAMENTO_TRATADO') = 0 OR strpos(definicao, 'PENDENCIA_FEITA') = 0
     OR strpos(definicao, 'AVISO_FIXO') = 0 OR strpos(definicao, 'SESSOES_DERRUBADAS') = 0 THEN
    RAISE EXCEPTION '125 postcheck: CHECK de area_familia_eventos.tipo ausente ou fora do formato da 125';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_familia_avisos_pagamento_pessoa_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_familia_avisos_pagamento_tratamento_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'festa_pendencias_familia_pendencia_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'festa_pendencias_familia_pessoa_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'festa_pendencias_familia_feito_devolvido_check') THEN
    RAISE EXCEPTION '125 postcheck: constraint-chave ausente';
  END IF;
  IF to_regclass('public.area_familia_avisos_pagamento_pendente_uk') IS NULL THEN
    RAISE EXCEPTION '125 postcheck: índice único ausente';
  END IF;
  FOREACH gatilho IN ARRAY ARRAY['area_familia_avisos_pagamento_validar_trg', 'festa_pendencias_familia_validar_trg',
      'festa_pendencias_familia_atualizado_em_trg', 'area_familia_aviso_empresa_atualizado_em_trg', 'area_familia_eventos_125_pessoas_trg',
      'festa_pessoas_125_remocao_trg', 'festa_links_area_125_autoria_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = gatilho AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION '125 postcheck: gatilho % ausente ou desligado', gatilho;
    END IF;
  END LOOP;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
