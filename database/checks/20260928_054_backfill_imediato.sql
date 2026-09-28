-- Somente leitura. Prova do BACKFILL IMEDIATO da 054: rodar logo depois da aplicação, antes de a
-- aplicação gravar qualquer cliente novo. Depois disso deixa de valer (um cliente criado no CRM
-- tem empresa sem fechamento) — para o estado operacional, usar o postcheck.
--
-- Recalcula o esperado pelos pacotes (caminho independente do backfill, que usou
-- fechamentos.empresa_id) e compara linha a linha, inclusive o NULL:
--   grupo canônico com 0 empresas comprovadas -> empresa_id NULL;
--   com 1 empresa -> essa empresa;
--   com 2+ -> não pode existir (a migration aborta).
-- A migration faz a mesma prova dentro da transação (kidmais_054_esperado).
DO $$
DECLARE
  ambiguos bigint;
  nulo_esperado_divergente bigint;
  empresa_esperada_divergente bigint;
  fechamentos_divergentes bigint;
BEGIN
  WITH grupo AS (
    SELECT c.id AS cliente_id,
           CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id ELSE c.id END AS canonico_id
      FROM public.clientes c
  ), derivada AS (
    SELECT g.canonico_id,
           count(DISTINCT p.empresa_id) AS empresas,
           (array_agg(DISTINCT p.empresa_id ORDER BY p.empresa_id))[1] AS primeira
      FROM grupo g
      JOIN public.fechamentos f ON f.cliente_id = g.cliente_id
      JOIN public.pacotes p ON p.id = f.pacote_id
     WHERE p.empresa_id IS NOT NULL
     GROUP BY g.canonico_id
  ), esperado AS (
    SELECT g.cliente_id, coalesce(d.empresas, 0) AS empresas,
           CASE WHEN d.empresas = 1 THEN d.primeira END AS empresa_esperada
      FROM grupo g
      LEFT JOIN derivada d ON d.canonico_id = g.canonico_id
  )
  SELECT count(*) FILTER (WHERE e.empresas > 1),
         count(*) FILTER (WHERE e.empresas = 0 AND c.empresa_id IS NOT NULL),
         count(*) FILTER (WHERE e.empresas = 1 AND c.empresa_id IS DISTINCT FROM e.empresa_esperada)
    INTO ambiguos, nulo_esperado_divergente, empresa_esperada_divergente
    FROM public.clientes c
    JOIN esperado e ON e.cliente_id = c.id;

  SELECT count(*) INTO fechamentos_divergentes
    FROM public.fechamentos f
    JOIN public.pacotes p ON p.id = f.pacote_id
   WHERE f.empresa_id IS DISTINCT FROM p.empresa_id;

  IF ambiguos + nulo_esperado_divergente + empresa_esperada_divergente + fechamentos_divergentes > 0 THEN
    RAISE EXCEPTION '054 backfill imediato: divergência (grupos ambíguos=%, NULL esperado com empresa=%, empresa esperada divergente=%, fechamentos=%).',
      ambiguos, nulo_esperado_divergente, empresa_esperada_divergente, fechamentos_divergentes;
  END IF;
END $$;

SELECT 'backfill_imediato_054' AS marco,
  (SELECT count(*) FROM public.clientes WHERE empresa_id IS NULL) AS clientes_nulos,
  (SELECT count(*) FROM public.clientes WHERE empresa_id IS NOT NULL) AS clientes_com_empresa;
