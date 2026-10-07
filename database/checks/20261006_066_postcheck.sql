-- 066 postcheck (somente leitura). Tabela e restrições presentes.
DO $$ BEGIN
  IF to_regclass('public.empresa_pix_recebimento') IS NULL THEN RAISE EXCEPTION '066 postcheck: tabela ausente.'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.empresa_pix_recebimento'::regclass
        AND conname IN ('empresa_pix_tipo_check', 'empresa_pix_chave_formato_check', 'empresa_pix_nome_check', 'empresa_pix_cidade_check', 'empresa_pix_versao_check')) <> 5 THEN
    RAISE EXCEPTION '066 postcheck: restrições ausentes.';
  END IF;
  RAISE NOTICE '066 postcheck OK: chaves configuradas = %', (SELECT count(*) FROM empresa_pix_recebimento);
END $$;
