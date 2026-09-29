-- 057 postcheck (somente leitura).
DO $$ BEGIN
  IF to_regclass('public.empresa_membership_capacidades') IS NULL THEN
    RAISE EXCEPTION '057 postcheck: tabela ausente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kidmais_057_emc_membership_fk' AND contype = 'f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kidmais_057_emc_capacidade_ck')
     OR to_regclass('public.kidmais_057_emc_ativa_uk') IS NULL THEN
    RAISE EXCEPTION '057 postcheck: FK, check ou índice único ausente.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kidmais_057_emc_imutavel_trg' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '057 postcheck: trigger de imutabilidade ausente ou desabilitado.';
  END IF;
  IF to_regprocedure('public.kidmais_057_pode_assinar_pela_empresa(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '057 postcheck: regra de assinatura ausente.';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM 'e7d4d19ac1b1d925135adbc45a2247a5' THEN
    RAISE EXCEPTION '057 postcheck: validação de contrato não é a da 057.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'contrato_assinaturas_validar_trg' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '057 postcheck: validação diferida da assinatura desabilitada.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.empresa_membership_capacidades c JOIN public.memberships m ON m.id = c.membership_id
     WHERE m.empresa_id <> c.empresa_id
  ) THEN
    RAISE EXCEPTION '057 postcheck: capacidade fora da empresa da membership.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.memberships m JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
     WHERE m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo AND u.papel = 'REPRESENTANTE_AUTORIZADO'
       AND NOT EXISTS (SELECT 1 FROM public.empresa_membership_capacidades c
                        WHERE c.membership_id = m.id AND c.capacidade = 'CONTRATO_ASSINAR_EMPRESA')
  ) THEN
    RAISE EXCEPTION '057 postcheck: backfill incompleto.';
  END IF;
END $$;
