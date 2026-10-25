-- Somente leitura. Recusa schema ausente, parcial ou já alterado; não corrige dados.
DO $$
BEGIN
  IF to_regclass('public.convites') IS NULL OR to_regclass('public.convite_ia_autorizacoes') IS NULL
    OR to_regprocedure('public.convite_validar_vinculo()') IS NULL
    OR to_regprocedure('public.convite_ia_autorizacao_validar()') IS NULL THEN
    RAISE EXCEPTION '099: dependências 073/088 ausentes';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND is_nullable='NO'
    AND ((table_name='convites' AND column_name IN ('festa_id','cliente_id','versao_contrato_id'))
      OR (table_name='convite_ia_autorizacoes' AND column_name='festa_id'))) <> 4
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convites'::regclass AND conname='convite_avulso_vinculo_completo')
    OR to_regclass('public.convites_empresa_atualizado') IS NOT NULL THEN
    RAISE EXCEPTION '099: aplicação anterior ou parcial';
  END IF;
  IF EXISTS (SELECT 1 FROM convites WHERE festa_id IS NULL OR cliente_id IS NULL OR versao_contrato_id IS NULL) THEN
    RAISE EXCEPTION '099: vínculo existente incompleto';
  END IF;
END $$;

-- Corpos revisados; impede sobrescrever função divergente silenciosamente.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM (VALUES ('convite_validar_vinculo()','44e558acf648b665b88ac1d3846583c1f0c4e134f47ec4fe97e31241194e73e1'),('convite_ia_autorizacao_validar()','b8e50a37f1736d7def652d7929b6660cd310c67bd6e8ca5257d09841eb23a0a1') ) AS esperado(f,h)
 WHERE (SELECT encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.'||esperado.f)) IS DISTINCT FROM esperado.h)
 THEN RAISE EXCEPTION '099: corpo de função divergente'; END IF;
END $$;
