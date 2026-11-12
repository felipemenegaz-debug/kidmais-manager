-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 121 SÓ sem abertura: recusa se houver qualquer revisão ou
-- conferência. Depois da primeira abertura, o rollback operacional é desligar a escrita da P2 e manter o leitor.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.financeiro_abertura_conferencias, public.financeiro_aberturas IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.financeiro_aberturas) OR EXISTS (SELECT 1 FROM public.financeiro_abertura_conferencias)
    THEN RAISE EXCEPTION '121: rollback recusado; já existe abertura registrada.'; END IF;
END $$;
DROP TABLE public.financeiro_abertura_conferencias;
DROP TABLE public.financeiro_aberturas;
DROP FUNCTION public.kidmais_121_somente_acrescimo();
COMMIT;
