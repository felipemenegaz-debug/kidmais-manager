-- Remove só a guarda da 053: gatilhos, funções e a chave estrangeira composta da fotografia anterior.
-- Não apaga fechamento, revisão, adicional, fotografia ou regra de desconto e não reescreve
-- pacote, tabela ou preço. Sem a 053, a coerência de tenant do fechamento volta a depender só do serviço.
BEGIN;

DO $$ BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kidmais-053'));
END $$;

DROP TRIGGER IF EXISTS regras_desconto_pacote_053_utilizada_trg ON public.regras_desconto_pacote;
DROP TRIGGER IF EXISTS fechamento_pacote_composicao_053_empresa_trg ON public.fechamento_pacote_composicao;
DROP TRIGGER IF EXISTS fechamento_pacote_snapshots_053_empresa_trg ON public.fechamento_pacote_snapshots;
DROP TRIGGER IF EXISTS fechamento_revisao_adicionais_053_empresa_trg ON public.fechamento_revisao_adicionais;
DROP TRIGGER IF EXISTS fechamento_revisoes_053_filhos_trg ON public.fechamento_revisoes;
DROP TRIGGER IF EXISTS fechamento_revisoes_053_empresa_trg ON public.fechamento_revisoes;
DROP TRIGGER IF EXISTS fechamento_adicionais_053_empresa_trg ON public.fechamento_adicionais;
DROP TRIGGER IF EXISTS fechamentos_053_filhos_trg ON public.fechamentos;
DROP TRIGGER IF EXISTS fechamentos_053_empresa_trg ON public.fechamentos;

ALTER TABLE public.fechamento_pacote_snapshots
  DROP CONSTRAINT IF EXISTS fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk;

DROP FUNCTION IF EXISTS public.kidmais_053_falhar_se_incompativel();
DROP FUNCTION IF EXISTS public.kidmais_053_desconto_utilizado();
DROP FUNCTION IF EXISTS public.kidmais_053_composicao();
DROP FUNCTION IF EXISTS public.kidmais_053_fotografia();
DROP FUNCTION IF EXISTS public.kidmais_053_revisao_filhos();
DROP FUNCTION IF EXISTS public.kidmais_053_revisao_adicional();
DROP FUNCTION IF EXISTS public.kidmais_053_revisao();
DROP FUNCTION IF EXISTS public.kidmais_053_fechamento_filhos();
DROP FUNCTION IF EXISTS public.kidmais_053_fechamento_adicional();
DROP FUNCTION IF EXISTS public.kidmais_053_fechamento();
DROP FUNCTION IF EXISTS public.kidmais_053_validar_adicional(uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.kidmais_053_empresa_do_fechamento(uuid);
DROP FUNCTION IF EXISTS public.kidmais_053_empresa_comercial(uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.kidmais_053_inexistente(text);
DROP FUNCTION IF EXISTS public.kidmais_053_recusar(text);

COMMIT;
