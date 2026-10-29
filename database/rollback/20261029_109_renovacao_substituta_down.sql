-- PREPARADO, NÃO EXECUTADO. Volta à 075 SÓ sem histórico de substituição: com qualquer linha SUBSTITUIDA ou com vínculo, recusa
-- (depois da primeira substituição, só correção para frente). Exige o código compatível ainda publicado (a 075 volta inteira).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.assinatura_renovacoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.assinatura_renovacoes WHERE estado = 'SUBSTITUIDA' OR substitui_id IS NOT NULL)
    THEN RAISE EXCEPTION '109: rollback recusado com histórico de substituição.'; END IF;
END $$;
DROP TRIGGER assinatura_renovacoes_109_sucessor ON public.assinatura_renovacoes;
DROP TRIGGER assinatura_renovacoes_075_guarda ON public.assinatura_renovacoes;
DROP TRIGGER assinatura_renovacoes_075_truncate ON public.assinatura_renovacoes;
CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR UPDATE OR DELETE ON public.assinatura_renovacoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_075_renovacao_guarda();
CREATE TRIGGER assinatura_renovacoes_075_truncate BEFORE TRUNCATE ON public.assinatura_renovacoes FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais_075_renovacao_guarda();
DROP INDEX public.assinatura_renovacoes_109_vigente_uq;
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_contratacao_id_key UNIQUE (contratacao_id);
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_109_substituida_sem_evidencia;
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_109_estado_check;
ALTER TABLE public.assinatura_renovacoes ADD CONSTRAINT assinatura_renovacoes_estado_check
  CHECK (estado IN ('PENDENTE','AVISANDO','AVISADA','APLICANDO','REGULAR','REVISAO','CANCELADA'));
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_109_cadeia_fk;
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_109_cadeia_alvo_uq;
ALTER TABLE public.assinatura_renovacoes DROP CONSTRAINT assinatura_renovacoes_109_substitui_uq;
ALTER TABLE public.assinatura_renovacoes DROP COLUMN substitui_id;
DROP FUNCTION public.kidmais_109_renovacao_sucessor();
DROP FUNCTION public.kidmais_109_renovacao_guarda();
COMMIT;
