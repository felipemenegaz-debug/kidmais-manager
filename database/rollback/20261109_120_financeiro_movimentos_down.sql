-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 120 SÓ sem movimentos: recusa se houver qualquer liquidação ou
-- reversão. Recusado = nenhum efeito (uma transação só). Depois da primeira escrita, o rollback operacional é desligar a
-- escrita da P2 (guarda no servidor) e manter o leitor; nunca apagar movimentos (plano rev. 3.2, E.2).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.financeiro_entradas_liquidacoes, public.financeiro_saidas_reversoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.financeiro_entradas_liquidacoes) OR EXISTS (SELECT 1 FROM public.financeiro_saidas_reversoes)
    THEN RAISE EXCEPTION '120: rollback recusado; já existem liquidações ou reversões.'; END IF;
END $$;
DROP TABLE public.financeiro_saidas_reversoes;
DROP TABLE public.financeiro_entradas_liquidacoes;
ALTER TABLE public.financeiro_saidas DROP CONSTRAINT financeiro_saidas_empresa_uk;
ALTER TABLE public.financeiro_entradas_manuais DROP CONSTRAINT financeiro_entradas_manuais_empresa_uk;
COMMIT;
