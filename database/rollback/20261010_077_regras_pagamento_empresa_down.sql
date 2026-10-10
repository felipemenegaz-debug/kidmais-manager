-- 077 rollback PREPARADO, NÃO EXECUTADO. Remove a tabela de regras; condições já gravadas com descontoPercentual
-- continuam válidas (o cálculo usa o percentual gravado). Novas condições voltam ao legado para todas as empresas.
-- ABORTA se houver regra além da linha legada da Kidmais (configuração feita depois precisa ser revisada antes).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresa_regras_pagamento') IS NULL THEN
    RAISE EXCEPTION '077 rollback: tabela ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM empresa_regras_pagamento r JOIN empresas e ON e.id = r.empresa_id
             WHERE NOT (e.codigo = 'kidmais' AND r.pix_avista_percentual = 10 AND r.pix_parcelado_percentual = 3
                        AND r.cartao_rotulo = 'Cielo' AND r.desconto_dia_util)) THEN
    RAISE EXCEPTION '077 rollback: há regras configuradas além da legada da Kidmais; revisar antes.';
  END IF;
END $$;
DROP TABLE empresa_regras_pagamento;
COMMIT;
