-- 125 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere a 123 instalada e que nada da 125 existe.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.festa_pessoas') IS NULL OR to_regclass('public.festa_links_area') IS NULL
     OR to_regclass('public.area_familia_eventos') IS NULL OR to_regprocedure('public.kidmais_123_empresa_da_festa(uuid)') IS NULL THEN
    RAISE EXCEPTION '125 precheck: exige a 123';
  END IF;
  IF to_regclass('public.festa_pendencias') IS NULL OR to_regclass('public.pagamento_parcelas') IS NULL
     OR to_regclass('public.pagamento_planos') IS NULL OR to_regclass('public.pagamentos') IS NULL
     OR to_regclass('public.contrato_versoes') IS NULL OR to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN
    RAISE EXCEPTION '125 precheck: pré-requisito ausente';
  END IF;
  IF to_regclass('public.area_familia_avisos_pagamento') IS NOT NULL OR to_regclass('public.festa_pendencias_familia') IS NOT NULL
     OR to_regclass('public.area_familia_aviso_empresa') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'kidmais_125_%') THEN
    RAISE EXCEPTION '125 precheck: 125 já (parcialmente) presente';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.area_familia_eventos'::regclass AND conname = 'area_familia_eventos_tipo_check') IS DISTINCT FROM
     'CHECK ((tipo = ANY (ARRAY[''LINK_GERADO''::text, ''LINK_REVOGADO''::text, ''ENTRADA''::text, ''SAIR''::text, ''SAIR_DE_TODOS''::text, ''BUFFET_DESCONECTOU''::text, ''PESSOA_CADASTRADA''::text, ''PESSOA_REMOVIDA''::text, ''CONTATO_ALTERADO''::text, ''SESSOES_DERRUBADAS''::text])))' THEN
    RAISE EXCEPTION '125 precheck: CHECK de area_familia_eventos.tipo fora do formato da 123';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
