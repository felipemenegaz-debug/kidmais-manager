-- Postcheck da 107 (somente leitura). Gerado de database/migrations/20261028_107_reparo_deriva_agenda.sql.
DO $$
BEGIN
  IF to_regclass('public.kidmais107_reparos') IS NULL THEN
    RAISE EXCEPTION '107 postcheck: registro de proveniência ausente';
  END IF;
END $$;
-- Postcheck: os 14 objetos canônicos presentes, nenhum nome de deriva sobrou.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (
        'bloqueios_agenda_data_ativos_idx', 'bloqueios_agenda_intervalo_ativos_idx', 'configuracao_agenda_ativos_idx')) <> 3
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.bloqueios_agenda'::regclass, 'public.configuracao_agenda'::regclass) AND conname IN (
        'bloqueios_agenda_periodo_check', 'configuracao_agenda_intervalo_check', 'configuracao_agenda_tolerancia_check',
        'configuracao_agenda_passo_check', 'configuracao_agenda_passo_compativel_check', 'configuracao_agenda_ordem_check',
        'bloqueios_agenda_motivo_nao_vazio', 'configuracao_agenda_codigo_nao_vazio', 'configuracao_agenda_nome_nao_vazio')) <> 9
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('bloqueios_agenda_atualizado_em_trg', 'configuracao_agenda_atualizado_em_trg')) <> 2
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (
        'ix_bloqueios_agenda_data_ativos', 'ix_bloqueios_agenda_intervalo_ativos', 'ix_configuracao_agenda_ativos'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE 'ck\_bloqueios\_agenda\_%' OR conname LIKE 'ck\_configuracao\_agenda\_%') THEN
    RAISE EXCEPTION '107: postcheck falhou; nada alterado';
  END IF;
END $$;
