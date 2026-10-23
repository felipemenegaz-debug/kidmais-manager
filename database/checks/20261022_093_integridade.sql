-- Somente leitura. Integridade REPETÍVEL da 093 (conferência e retomada do aplicador): só estrutura, aceita qualquer
-- dado operacional (capacidade diferente de 1, dias da semana, horário livre, salões). O postcheck da 093 continua
-- sendo a prova de preservação na instalação (horários existentes com padrão neutro logo após o COMMIT).
-- Corpo da função conferido por sha256 do prosrc (LF); vale para o schema até a 094.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['agenda_escopo_config', 'agenda_saloes', 'configuracao_agenda_saloes', 'pacote_saloes']) t
              WHERE to_regclass('public.' || t) IS NULL) THEN
    RAISE EXCEPTION '093 integridade: tabela da 093 ausente';
  END IF;
  -- Índices únicos válidos (chaves primárias, escopo único, nome do salão, empresa+id usada pelas FKs compostas).
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['agenda_escopo_config_pkey', 'agenda_saloes_pkey', 'configuracao_agenda_saloes_pkey', 'pacote_saloes_pkey',
                                         'agenda_escopo_config_escopo_uk', 'agenda_saloes_nome_uk', 'agenda_saloes_empresa_id_uk']) n
              WHERE NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.' || n)
                                  AND i.indisvalid AND i.indisready AND i.indisunique)) THEN
    RAISE EXCEPTION '093 integridade: índice único ausente ou inválido';
  END IF;
  -- Chaves estrangeiras validadas, por tabela e referenciada (quantidade mínima declarada na 093).
  IF EXISTS (SELECT 1 FROM (VALUES ('agenda_escopo_config', 'empresas', 1), ('agenda_escopo_config', 'usuarios_administrativos', 2),
                                   ('agenda_escopo_config', 'estabelecimentos', 1), ('agenda_saloes', 'empresas', 1), ('agenda_saloes', 'estabelecimentos', 1),
                                   ('configuracao_agenda_saloes', 'configuracao_agenda', 1), ('configuracao_agenda_saloes', 'agenda_saloes', 1),
                                   ('pacote_saloes', 'pacotes', 1), ('pacote_saloes', 'agenda_saloes', 1)) AS e(t, r, n)
              WHERE (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.convalidated
                       AND c.conrelid = to_regclass('public.' || e.t) AND c.confrelid = to_regclass('public.' || e.r)) < e.n) THEN
    RAISE EXCEPTION '093 integridade: chave estrangeira ausente ou não validada';
  END IF;
  -- Colunas novas de configuracao_agenda: tipo, NOT NULL e padrão.
  IF EXISTS (SELECT 1 FROM (VALUES ('dias_semana', 'smallint[]', false, NULL), ('capacidade', 'smallint', true, '1'),
                                   ('desativado_a_partir_de', 'date', false, NULL), ('horario_livre', 'boolean', true, 'false')) AS e(c, tipo, obrigatoria, padrao)
              WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                                  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                 WHERE a.attrelid = to_regclass('public.configuracao_agenda') AND a.attname = e.c AND NOT a.attisdropped
                                   AND format_type(a.atttypid, a.atttypmod) = e.tipo AND a.attnotnull = e.obrigatoria
                                   AND pg_get_expr(d.adbin, d.adrelid) IS NOT DISTINCT FROM e.padrao)) THEN
    RAISE EXCEPTION '093 integridade: coluna de configuracao_agenda ausente ou com tipo/padrão diferente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.configuracao_agenda')
                  AND conname = 'configuracao_agenda_093_livre_escopo_check' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION '093 integridade: CHECK do horário livre ausente ou não validada';
  END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc
       WHERE oid = to_regprocedure('public.kidmais093_mesma_empresa()'))
     IS DISTINCT FROM '53fb3e8ad6a63e4105067a5c8d70ea878ee9b0c32f689c202f196c2b68c0a346' THEN
    RAISE EXCEPTION '093 integridade: corpo de kidmais093_mesma_empresa diferente do da 093';
  END IF;
  -- Gatilhos de isolamento habilitados e ligados à função da 093.
  IF EXISTS (SELECT 1 FROM (VALUES ('configuracao_agenda_saloes', 'configuracao_agenda_saloes_093_empresa_trg'),
                                   ('pacote_saloes', 'pacote_saloes_093_empresa_trg')) AS e(t, g)
              WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.' || e.t) AND tgname = e.g AND NOT tgisinternal
                                  AND tgenabled IN ('O', 'A') AND tgfoid = to_regprocedure('public.kidmais093_mesma_empresa()'))) THEN
    RAISE EXCEPTION '093 integridade: gatilho de isolamento ausente, desligado ou ligado a outra função';
  END IF;
  RAISE NOTICE '093 integridade OK';
END $$;
