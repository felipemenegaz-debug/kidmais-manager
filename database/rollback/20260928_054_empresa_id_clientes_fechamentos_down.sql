-- Remove só o que a 054 criou: gatilhos, funções, índices, FKs e as colunas empresa_id.
-- Não apaga cliente nem fechamento e não reescreve outra coluna.
--
-- Ordem obrigatória: primeiro a aplicação volta a uma versão que não lê nem grava empresa_id
-- (base f5d1da5); depois este arquivo. Com o código do PR-B1 no ar, remover as colunas quebra
-- cadastro de cliente e criação de fechamento.
--
-- Dois cenários:
--   A) rollback imediato/teste, antes de uso real: toda empresa gravada se reconstrói pela
--      regra do backfill; o critério abaixo passa e a remoção não perde informação.
--   B) depois de uso real: um cliente criado no CRM já tem empresa que o backfill não
--      reproduz. O critério aborta. Não há parâmetro que force; remover exige decisão humana,
--      exportação do vínculo e plano próprio.
-- Mesmo critério de database/checks/20260928_054_rollback_precheck.sql.
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kidmais-054'));
END $$;

LOCK TABLE public.pacotes, public.clientes, public.fechamentos, public.fechamento_revisoes IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  clientes_n bigint := 0;
  fechamentos_n bigint := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fechamentos' AND column_name = 'empresa_id'
  ) THEN
    SELECT count(*) INTO fechamentos_n
      FROM public.fechamentos f
      JOIN public.pacotes p ON p.id = f.pacote_id
     WHERE f.empresa_id IS DISTINCT FROM p.empresa_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'empresa_id'
  ) THEN
    WITH grupo AS (
      SELECT c.id AS cliente_id,
             CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
        FROM public.clientes c
    ), derivada AS (
      SELECT g.canonico_id,
             CASE WHEN count(DISTINCT p.empresa_id) = 1
                  THEN (array_agg(DISTINCT p.empresa_id ORDER BY p.empresa_id))[1] END AS empresa_id
        FROM grupo g
        JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
        JOIN public.pacotes p ON p.id = f.pacote_id
       WHERE p.empresa_id IS NOT NULL
       GROUP BY g.canonico_id
    )
    SELECT count(*) INTO clientes_n
      FROM public.clientes c
      JOIN grupo g ON g.cliente_id = c.id
      LEFT JOIN derivada d ON d.canonico_id = g.canonico_id
     WHERE c.empresa_id IS NOT NULL
       AND c.empresa_id IS DISTINCT FROM d.empresa_id;
  END IF;

  IF clientes_n + fechamentos_n > 0 THEN
    RAISE EXCEPTION '054 rollback: remover a 054 perderia empresa não reconstruível (clientes=%, fechamentos=%). Nada foi removido.',
      clientes_n, fechamentos_n
      USING ERRCODE = '23514';
  END IF;
END $$;

DROP TRIGGER IF EXISTS fechamento_revisoes_054_cliente_coerente_trg ON public.fechamento_revisoes;
DROP TRIGGER IF EXISTS fechamentos_054_cliente_coerente_trg ON public.fechamentos;
DROP TRIGGER IF EXISTS fechamentos_054_empresa_coerente_trg ON public.fechamentos;
DROP TRIGGER IF EXISTS fechamentos_054_empresa_imutavel_trg ON public.fechamentos;
DROP TRIGGER IF EXISTS clientes_054_empresa_imutavel_trg ON public.clientes;

DROP FUNCTION IF EXISTS public.kidmais_054_falhar_se_incompativel();
DROP FUNCTION IF EXISTS public.kidmais_054_revisao_cliente_coerente();
DROP FUNCTION IF EXISTS public.kidmais_054_fechamento_cliente_coerente();
DROP FUNCTION IF EXISTS public.kidmais_054_fechamento_empresa_coerente();
DROP FUNCTION IF EXISTS public.kidmais_054_empresa_imutavel();

DROP INDEX IF EXISTS public.fechamentos_054_empresa_idx;
DROP INDEX IF EXISTS public.clientes_054_empresa_idx;

ALTER TABLE public.fechamentos DROP CONSTRAINT IF EXISTS fechamentos_054_empresa_fk;
ALTER TABLE public.clientes DROP CONSTRAINT IF EXISTS clientes_054_empresa_fk;

ALTER TABLE public.fechamentos DROP COLUMN IF EXISTS empresa_id;
ALTER TABLE public.clientes DROP COLUMN IF EXISTS empresa_id;

COMMIT;
