-- Somente leitura. Verifica o formato após a 099 sem alterar dados/consumo.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND is_nullable='YES'
    AND ((table_name='convites' AND column_name IN ('festa_id','cliente_id','versao_contrato_id'))
      OR (table_name='convite_ia_autorizacoes' AND column_name='festa_id'))) <> 4
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass
      AND conname='convite_avulso_vinculo_completo' AND contype='c' AND convalidated)
    OR to_regclass('public.convites_empresa_atualizado') IS NULL THEN
    RAISE EXCEPTION '099: estrutura incompleta';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (festa_id)') THEN
    RAISE EXCEPTION '099: unicidade de festa ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM convites WHERE NOT (
      (festa_id IS NULL AND cliente_id IS NULL AND versao_contrato_id IS NULL AND estabelecimento_id IS NULL AND editor_hash IS NULL)
      OR (festa_id IS NOT NULL AND cliente_id IS NOT NULL AND versao_contrato_id IS NOT NULL))) THEN
    RAISE EXCEPTION '099: vínculo inválido';
  END IF;
END $$;

-- Corpos revisados; impede sobrescrever função divergente silenciosamente.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM (VALUES ('convite_validar_vinculo()','0f0553ac92d6eeb474d7830c2e3daf1084c2010d752f2f68350a9fa30daba1f3'),('convite_ia_autorizacao_validar()','d89b8062a972a3f62f0b0ccaf67fa72662a7019cd0c7a734b3134a45787efc2c') ) AS esperado(f,h)
 WHERE (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.'||esperado.f)) IS DISTINCT FROM esperado.h)
 THEN RAISE EXCEPTION '099: corpo de função divergente'; END IF;
END $$;
