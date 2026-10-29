-- Somente leitura. Integridade REPETÍVEL da 094 (conferência e retomada do aplicador): só estrutura, aceita qualquer
-- dado operacional (festas e revisões com salão). O postcheck da 094 continua sendo a prova de preservação na
-- instalação (nenhuma festa com salão logo após o COMMIT).
-- Corpos das funções conferidos por sha256 do prosrc (LF); vale para o schema até a 094.
DO $$
BEGIN
  -- Coluna do salão (uuid) e FK validada para agenda_saloes nas duas tabelas.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['fechamentos', 'fechamento_revisoes']) t
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || t) AND attname = 'salao_id'
                                  AND NOT attisdropped AND format_type(atttypid, atttypmod) = 'uuid')
                 OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND convalidated AND conrelid = to_regclass('public.' || t)
                                  AND confrelid = to_regclass('public.agenda_saloes'))) THEN
    RAISE EXCEPTION '094 integridade: salao_id ausente, com outro tipo ou sem FK validada';
  END IF;
  -- Corpos das quatro funções novas e das três substituídas (regra de conflito da 094).
  IF EXISTS (SELECT 1 FROM (VALUES
        ('kidmais094_salao_fechamento()', 'ea270481051aea570015af300abc4d3b208627c90473a25977e22a1b11be0305'),
        ('kidmais094_salao_revisao()', 'b55b3e839da369ce0e28a52bad7003b391d6af2091075a4bf419c4e7770d4d59'),
        ('kidmais094_ocupacoes(date,date)', '3fa027c88aa5b82c5cbece4ac8a4f51d2b85c7ee18108def1c5974cca1237bbc'),
        ('kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)', '06a387fe9c40ceca6a4021b1f9676b76ee92592a2cc241705f1201a40cc97537'),
        ('kidmais019_validar_destino(uuid)', '02bd9366cf05913702b23c72166760dc68aea2e0e61779b5ca60a7b5be7eb6cb'),
        ('kidmais019_validar_contrato()', '13095fc87c52c3970f9cfad1c5bcef77d3e860904f71b39948de0335b4e76c21'),
        ('kidmais_validar_agenda_revisao()', '8476ec76d2ae8af4f7fbbdba595b0fd82b8060c76be4d2d915a47451f11f9e24')) AS e(f, h)
      WHERE (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.' || e.f))
            IS DISTINCT FROM e.h) THEN
    RAISE EXCEPTION '094 integridade: corpo de função ausente ou diferente do da 094';
  END IF;
  -- Gatilhos habilitados e ligados à função certa: os dois novos do salão e os da 014/019 que executam a regra nova.
  IF EXISTS (SELECT 1 FROM (VALUES ('fechamentos', 'fechamentos_094_salao_trg', 'kidmais094_salao_fechamento()'),
                                   ('fechamento_revisoes', 'fechamento_revisoes_094_salao_trg', 'kidmais094_salao_revisao()'),
                                   ('fechamento_revisoes', 'fr_agenda_validar_trg', 'kidmais_validar_agenda_revisao()'),
                                   ('fechamentos', 'fr_confirmacao_agenda_trg', 'kidmais_validar_agenda_revisao()'),
                                   ('contratos', 'festa019_contrato', 'kidmais019_validar_contrato()'),
                                   ('contrato_fluxos', 'festa019_fluxo', 'kidmais019_validar_contrato()'),
                                   ('fechamentos', 'festa019_fechamento', 'kidmais019_validar_contrato()'),
                                   ('festas', 'festa019_festa', 'kidmais019_validar_contrato()')) AS e(t, g, f)
              WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || e.t) AND tgname = e.g AND NOT tgisinternal
                                  AND tgenabled IN ('O', 'A') AND tgfoid = to_regprocedure('public.' || e.f))) THEN
    RAISE EXCEPTION '094 integridade: gatilho ausente, desligado ou ligado a outra função';
  END IF;
  RAISE NOTICE '094 integridade OK';
END $$;
