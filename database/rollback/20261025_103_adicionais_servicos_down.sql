-- Rollback da 103. Só com autorização própria. Recusado (nada alterado) se QUALQUER adicional usar a categoria SERVICOS,
-- de qualquer empresa e em qualquer situação (ativo, inativo ou arquivado). A categoria fica travada até o fim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.adicional_categorias, public.adicionais IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM adicional_categorias WHERE codigo = 'SERVICOS') THEN
    RAISE EXCEPTION '103 rollback: categoria SERVICOS ausente; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM adicionais WHERE categoria = 'SERVICOS') THEN
    RAISE EXCEPTION '103 rollback: há adicionais na categoria SERVICOS; nada alterado';
  END IF;
END $$;
DELETE FROM public.adicional_categorias WHERE codigo = 'SERVICOS';
COMMIT;
