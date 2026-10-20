-- 074 precheck PREPARADO, NÃO EXECUTADO. Somente leitura; não mostra dados de clientes.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL
     OR to_regclass('public.cobranca_eventos') IS NULL
     OR to_regclass('public.plataforma_empresas_cadastro') IS NULL THEN
    RAISE EXCEPTION '074 precheck: modelo comercial/cobrança/cadastro ausentes.';
  END IF;
  IF to_regclass('public.assinatura_isencoes') IS NOT NULL
     OR to_regclass('public.assinatura_fundadores') IS NOT NULL
     OR to_regclass('public.assinatura_contratacoes') IS NOT NULL
     OR to_regprocedure('public.kidmais_074_registro_guarda()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'empresa_assinaturas' AND column_name = 'contratacao_atual_id') THEN
    RAISE EXCEPTION '074 precheck: instalação total ou parcial já existe.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.empresa_assinaturas'::regclass
       AND tgname = 'empresa_assinaturas_068_guarda_trg' AND NOT tgisinternal AND tgenabled = 'O')
     OR to_regprocedure('public.kidmais_068_assinatura_guarda()') IS NULL THEN
    RAISE EXCEPTION '074 precheck: guarda 068 ausente/desativada.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.empresa_assinaturas'::regclass
       AND conname = 'empresa_assinaturas_plano_check' AND convalidated)
     OR EXISTS (SELECT 1 FROM empresa_assinaturas WHERE plano <> 'UNICO') THEN
    RAISE EXCEPTION '074 precheck: plano legado divergiu; revisar antes de aplicar.';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '[[:space:]]', '', 'g')) FROM pg_proc
      WHERE oid = 'public.kidmais_068_assinatura_guarda()'::regprocedure)
      IS DISTINCT FROM '6587469604572b17146a1346a8c01c47' THEN
    RAISE EXCEPTION '074 precheck: definição da guarda divergiu da base; revisar o diff da função.';
  END IF;
  RAISE NOTICE '074 precheck OK. Não autoriza aplicação nem comprova prontidão do checkout.';
END $$;
ROLLBACK;
