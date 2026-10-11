-- 077 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresa_regras_pagamento') IS NULL THEN
    RAISE EXCEPTION '077 postcheck: tabela ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais')
     AND NOT EXISTS (SELECT 1 FROM empresa_regras_pagamento r JOIN empresas e ON e.id = r.empresa_id
                     WHERE e.codigo = 'kidmais' AND r.pix_avista_percentual = 10 AND r.pix_parcelado_percentual = 3
                       AND r.cartao_rotulo = 'Cielo' AND r.desconto_dia_util) THEN
    RAISE EXCEPTION '077 postcheck: regras legadas da Kidmais ausentes ou divergentes.';
  END IF;
  IF (SELECT count(*) FROM empresa_regras_pagamento) <> (SELECT count(*) FROM empresas WHERE codigo = 'kidmais') THEN
    RAISE EXCEPTION '077 postcheck: linhas além da Kidmais.';
  END IF;
END $$;
SELECT current_database() AS banco, (SELECT count(*) FROM empresa_regras_pagamento) AS empresas_com_regra, true AS aprovado;
ROLLBACK;
