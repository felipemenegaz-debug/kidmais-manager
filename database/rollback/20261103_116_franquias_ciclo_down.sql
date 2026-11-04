-- PREPARADO, NÃO EXECUTADO. Volta à base anterior à 116 SÓ sem trilha financeira: recusa se houver qualquer linha em
-- ia_credito_franquias_ciclo (lotes reconhecidos pelo motor por plano) ou notificação FRANQUIA_80/100. Pendências não
-- processadas são só intenções e saem junto. Recusado = nenhum efeito (uma transação só). Depois do primeiro
-- reconhecimento, só correção para frente. Exige o código compatível publicado (sem a 116 ele segue o caminho legado).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.ia_credito_franquias_ciclo, public.ia_credito_franquia_pendencias, public.ia_credito_notificacoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ia_credito_franquias_ciclo)
    THEN RAISE EXCEPTION '116: rollback recusado; já existe franquia reconhecida pelo motor por plano.'; END IF;
  IF EXISTS (SELECT 1 FROM public.ia_credito_notificacoes WHERE tipo IN ('FRANQUIA_80', 'FRANQUIA_100'))
    THEN RAISE EXCEPTION '116: rollback recusado; já existe aviso de uso da franquia.'; END IF;
END $$;
ALTER TABLE public.ia_credito_notificacoes DROP CONSTRAINT ia_credito_notificacoes_tipo_check;
ALTER TABLE public.ia_credito_notificacoes ADD CONSTRAINT ia_credito_notificacoes_tipo_check CHECK (tipo IN ('PAGAMENTO_CONFIRMADO', 'DEVOLUCAO_REGISTRADA',
  'AVISO_INTERNO_DEVOLUCAO', 'LOTE_VENCENDO_30', 'LOTE_VENCENDO_7'));
DROP TABLE public.ia_credito_franquia_pendencias;
DROP TRIGGER ia_credito_franquias_ciclo_116_somente_insercao ON public.ia_credito_franquias_ciclo;
DROP TABLE public.ia_credito_franquias_ciclo;
DROP FUNCTION public.kidmais_116_somente_insercao();
COMMIT;
