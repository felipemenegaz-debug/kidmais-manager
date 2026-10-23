-- Somente leitura. Confirma a 092: PONTO aceito nas duas CHECKs, ponto com mínimo = máximo, lacunas novas na 047.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_tipo_calculo_check'
                  AND pg_get_constraintdef(oid) LIKE '%PONTO%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fechamento_pacote_snapshots_tipo_check'
                  AND pg_get_constraintdef(oid) LIKE '%PONTO%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_092_ponto_check') THEN
    RAISE EXCEPTION '092 postcheck: CHECKs de PONTO ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kidmais_047_lacunas_escopo'
                  AND pg_get_functiondef(oid) LIKE '%PONTO_DECRESCENTE%'
                  AND pg_get_functiondef(oid) LIKE '%PONTO_SEM_EXTREMOS%'
                  AND pg_get_functiondef(oid) LIKE '%PONTO_MISTURADO%') THEN
    RAISE EXCEPTION '092 postcheck: lacunas de PONTO ausentes em kidmais_047_lacunas_escopo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kidmais_035_preservar_tabela_publicada'
              AND pg_get_functiondef(oid) NOT LIKE '%kidmais_047_lacunas_escopo%') THEN
    RAISE EXCEPTION '092 postcheck: a guarda de publicação deixou de chamar as lacunas';
  END IF;
  RAISE NOTICE '092 postcheck OK';
END $$;
SELECT pp.tipo_calculo, count(*) AS linhas FROM precos_pacote pp GROUP BY pp.tipo_calculo ORDER BY pp.tipo_calculo;
