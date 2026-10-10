-- Rollback precheck da 077a: SOMENTE LEITURA. Diz se o down pode rodar e registra os números da janela.
-- O _down.sql repete as condições (dependentes antes de travar; dados depois de travar) e aborta sozinho.
-- Ordem: 078 → 077b → 077a → 065 → 060. Com a 077b ou a 078 ainda aplicadas (total ou parcialmente), recusa.
DO $$
DECLARE
  prontas bigint;
  favoritas bigint;
BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL THEN
    RAISE EXCEPTION '077a rollback precheck: a 077a não está instalada.';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname IN ('midia_url', 'estado', 'arquivo_id', 'finalidade', 'envio_automatico') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.whatsapp_atendimento_mensagens') AND attname IN ('midia_tipo', 'midia_pronta_id', 'origem_grupo_id', 'midia_arquivo_id', 'fonte') AND NOT attisdropped) THEN
    RAISE EXCEPTION '077a rollback precheck: a 077b ou a 078 ainda estão aplicadas. Ordem: 078 → 077b → 077a → 065 → 060.';
  END IF;
  prontas := (SELECT count(*) FROM whatsapp_atendimento_mensagens_prontas);
  favoritas := (SELECT count(*) FROM whatsapp_atendimento_mensagens_prontas_favoritas);
  RAISE NOTICE '077a rollback precheck: prontas = %, favoritas = % (com dados: exporte e confirme o descarte com SET LOCAL kidmais.rollback_077a_descartar_prontas = ''sim'' no down; o descarte vale para todas as empresas e ambientes do banco)', prontas, favoritas;
END $$;
SELECT '077a rollback precheck OK' AS resultado;
