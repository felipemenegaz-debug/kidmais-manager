-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 118 SÓ sem histórico de cota: recusa se houver qualquer linha em
-- ia_importacao_usos ou ia_importacao_cotas. Recusado = nenhum efeito (uma transação só). Depois do primeiro uso, o rollback
-- operacional é desligar o grupo CONTRACT_IMPORT (fecha a importação única e em lote; o histórico de usos é preservado) —
-- nunca dispensar a cota (plano rev. 2, R2-2). Sem a 118, o código publicado recusa novas leituras com COTA_INDISPONIVEL,
-- salvo no web de staging com a dispensa explícita.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.ia_importacao_usos, public.ia_importacao_cotas IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ia_importacao_usos) OR EXISTS (SELECT 1 FROM public.ia_importacao_cotas)
    THEN RAISE EXCEPTION '118: rollback recusado; já existe histórico de cota de importação.'; END IF;
END $$;
DROP TABLE public.ia_importacao_usos;
DROP TABLE public.ia_importacao_cotas;
DROP FUNCTION public.kidmais_118_guarda();
DROP FUNCTION public.kidmais_118_periodo_mensal(timestamptz);
DROP FUNCTION public.kidmais_118_janela_migracao(timestamptz, timestamptz);
COMMIT;
