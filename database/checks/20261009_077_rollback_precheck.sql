-- Rollback precheck da 077: SOMENTE LEITURA. Diz se o down pode rodar e registra os números da janela.
-- O _down.sql repete as condições (dependentes antes de travar; dados e fila depois de travar) e aborta sozinho.
-- Ordem: 078 → 077 → 076 → 065 → 060. Com qualquer objeto da 078 ainda aplicado, recusa.
DO $$
DECLARE
  respostas_midia bigint;
  na_fila bigint;
  prontas_midia bigint;
BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname = 'midia_url' AND NOT attisdropped) THEN
    RAISE EXCEPTION '077 rollback precheck: a 077 não está instalada.';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND attname IN ('estado', 'arquivo_id', 'finalidade', 'envio_automatico') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.whatsapp_atendimento_mensagens') AND attname IN ('origem_grupo_id', 'midia_arquivo_id', 'fonte') AND NOT attisdropped) THEN
    RAISE EXCEPTION '077 rollback precheck: a 078 ainda está aplicada. Ordem: 078 → 077 → 076 → 065 → 060.';
  END IF;
  respostas_midia := (SELECT count(*) FROM whatsapp_atendimento_mensagens WHERE midia_tipo IS NOT NULL);
  na_fila := (SELECT count(*) FROM whatsapp_atendimento_mensagens WHERE midia_tipo IS NOT NULL AND estado IN ('PENDENTE', 'PROCESSANDO', 'ENVIANDO'));
  prontas_midia := (SELECT count(*) FROM whatsapp_atendimento_mensagens_prontas WHERE tipo IN ('IMAGEM', 'VIDEO') OR atalho IN ('SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO'));
  RAISE NOTICE '077 rollback precheck: respostas com mídia = %, na fila = %, prontas de foto/vídeo ou atalhos novos = % (fila > 0: o down recusa; com dados: exporte e confirme os descartes no down, válidos para todas as empresas e ambientes do banco)', respostas_midia, na_fila, prontas_midia;
END $$;
SELECT '077 rollback precheck OK' AS resultado;
