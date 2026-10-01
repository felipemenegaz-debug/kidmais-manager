-- 057 precheck (somente leitura): pré-requisitos, não aplicada, função de fluxo igual à da 013 e o backfill.
DO $$
DECLARE
  candidatas integer;
BEGIN
  IF to_regclass('public.festa_membership_capacidades') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel') THEN
    RAISE EXCEPTION '057 precheck: a 056 não está aplicada.';
  END IF;
  IF to_regclass('public.empresa_membership_capacidades') IS NOT NULL
     OR to_regprocedure('public.kidmais_057_pode_assinar_pela_empresa(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '057 precheck: já aplicada.';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '3de688e21a383e2dcdaf4f28bcff31d7' THEN
    RAISE EXCEPTION '057 precheck: kidmais_validar_fluxo_contrato difere da 013.';
  END IF;
  SELECT count(*) INTO candidatas
    FROM public.memberships m JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
   WHERE m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo AND u.papel = 'REPRESENTANTE_AUTORIZADO';
  RAISE NOTICE '057 precheck: % membership(s) recebem CONTRATO_ASSINAR_EMPRESA no backfill.', candidatas;
END $$;
