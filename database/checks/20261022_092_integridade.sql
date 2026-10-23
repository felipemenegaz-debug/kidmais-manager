-- Somente leitura. Integridade REPETÍVEL da 092 (conferência e retomada do aplicador): só estrutura, aceita qualquer
-- dado operacional (preços PONTO, tabelas publicadas). O postcheck da 092 continua sendo a prova da instalação.
-- Corpo da função conferido por sha256 do prosrc (LF), como a 062 faz; vale para o schema até a 094 (uma migration
-- posterior que substitua estas funções exige atualizar este arquivo).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.precos_pacote') AND conname = 'precos_pacote_tipo_calculo_check'
                  AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%PONTO%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.fechamento_pacote_snapshots') AND conname = 'fechamento_pacote_snapshots_tipo_check'
                  AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%PONTO%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.precos_pacote') AND conname = 'precos_pacote_092_ponto_check'
                  AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%convidados_max = convidados_min%') THEN
    RAISE EXCEPTION '092 integridade: CHECKs de PONTO ausentes, alteradas ou não validadas';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc
       WHERE oid = to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)'))
     IS DISTINCT FROM 'ea231e3c21cdc30e053af33e95e80035c556b400c0b09a394901f88b22d82be7' THEN
    RAISE EXCEPTION '092 integridade: corpo de kidmais_047_lacunas_escopo diferente do da 092';
  END IF;
  -- A guarda de publicação (035/049) chama as lacunas e o gatilho dela está habilitado em tabelas_preco.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.tabelas_preco') AND tgname = 'tabelas_preco_publicacao_trg'
                  AND NOT tgisinternal AND tgenabled IN ('O', 'A') AND tgfoid = to_regprocedure('public.kidmais_035_preservar_tabela_publicada()'))
    OR coalesce((SELECT prosrc NOT LIKE '%kidmais_047_lacunas_escopo%' FROM pg_proc
                  WHERE oid = to_regprocedure('public.kidmais_035_preservar_tabela_publicada()')), true) THEN
    RAISE EXCEPTION '092 integridade: guarda de publicação sem as lacunas ou com o gatilho desligado';
  END IF;
  RAISE NOTICE '092 integridade OK';
END $$;
