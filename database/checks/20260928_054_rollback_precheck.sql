-- Somente leitura. Diz se remover a 054 perderia empresa que não se reconstrói sem ela.
-- O _down.sql repete este critério depois de travar as tabelas e aborta sozinho.
--
-- Reconstruível sem a 054:
--   fechamentos.empresa_id = pacotes.empresa_id (o pacote continua existindo);
--   clientes.empresa_id = empresa única do grupo canônico pelos fechamentos -> pacotes.
-- Não reconstruível: cliente com empresa gravada que essa derivação não reproduz — por exemplo,
-- cliente criado no CRM depois da 054 e ainda sem fechamento. Remover a coluna apagaria esse
-- tenant. Nesse caso o rollback de schema não é automático: exige decisão humana e plano próprio.
DO $$
DECLARE
  clientes_n bigint;
  fechamentos_n bigint;
BEGIN
  IF to_regprocedure('public.kidmais_054_falhar_se_incompativel()') IS NULL THEN
    RAISE EXCEPTION '054 rollback precheck: a 054 não está instalada.';
  END IF;

  SELECT count(*) INTO fechamentos_n
    FROM public.fechamentos f
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE f.empresa_id IS DISTINCT FROM p.empresa_id;

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

  IF clientes_n + fechamentos_n > 0 THEN
    RAISE EXCEPTION '054 rollback precheck: remover a 054 perderia empresa não reconstruível (clientes=%, fechamentos=%). Não remover daqui.',
      clientes_n, fechamentos_n;
  END IF;
END $$;

SELECT 'pre_rollback_054' AS marco,
  (SELECT count(*) FROM public.clientes) AS clientes_total,
  (SELECT count(*) FROM public.fechamentos) AS fechamentos_total,
  (SELECT count(*) FROM public.clientes WHERE empresa_id IS NOT NULL) AS clientes_com_empresa;
