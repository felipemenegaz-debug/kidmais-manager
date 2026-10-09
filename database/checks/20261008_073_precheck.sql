-- 073 precheck somente leitura. Confere dependências e recusa aplicação parcial/repetida.
DO $$
DECLARE nome text;
BEGIN
  FOREACH nome IN ARRAY ARRAY['empresas','clientes','estabelecimentos','fechamentos','contratos','contrato_versoes','contrato_fluxos','festas'] LOOP
    IF to_regclass('public.' || nome) IS NULL THEN RAISE EXCEPTION '073 precheck: dependência ausente: %', nome; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='empresa_id' AND udt_name='uuid')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='estabelecimento_id' AND udt_name='uuid') THEN
    RAISE EXCEPTION '073 precheck: escopo de empresa/unidade ausente em fechamentos.';
  END IF;
  FOREACH nome IN ARRAY ARRAY['convite_carteiras','convite_consumos','convite_orcamento_global','convites','convite_artes','convite_geracoes','convite_respostas','convite_limites_http','convite_eventos'] LOOP
    IF to_regclass('public.' || nome) IS NOT NULL THEN RAISE EXCEPTION '073 precheck: já aplicada (total ou parcial): %', nome; END IF;
  END LOOP;
  IF to_regprocedure('public.convite_validar_vinculo()') IS NOT NULL THEN RAISE EXCEPTION '073 precheck: função já existe.'; END IF;
  RAISE NOTICE '073 precheck OK.';
END $$;
