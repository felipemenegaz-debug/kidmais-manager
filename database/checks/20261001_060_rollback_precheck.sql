-- Rollback precheck da 060: SOMENTE LEITURA. Diz se o down pode rodar e registra os números da janela.
-- O _down.sql repete as condições DEPOIS de travar as tabelas (ACCESS EXCLUSIVE) e aborta sozinho.
DO $$
DECLARE
  conversas bigint;
  mensagens bigint;
  ativas bigint;
  status_pendentes bigint;
BEGIN
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION '060 rollback precheck: a 060 não está instalada.';
  END IF;
  -- Revisão final (09/10): dependentes ainda aplicados recusam aqui também (o down repete a guarda).
  IF to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') IS NOT NULL
     OR to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass AND attname IN ('nome_perfil', 'nome_perfil_em', 'contexto', 'passagem') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.whatsapp_atendimento_mensagens') AND attname IN ('midia_tipo', 'midia_pronta_id', 'origem_grupo_id', 'midia_arquivo_id', 'fonte') AND NOT attisdropped) THEN
    RAISE EXCEPTION '060 rollback precheck: 065, 077a, 077b ou 078 ainda estão aplicadas. Ordem: 078 → 077b → 077a → 065 → 060.';
  END IF;
  conversas := (SELECT count(*) FROM whatsapp_atendimento_conversas);
  mensagens := (SELECT count(*) FROM whatsapp_atendimento_mensagens);
  ativas := (SELECT count(*) FROM whatsapp_atendimento_mensagens WHERE estado IN ('PROCESSANDO','ENVIANDO'));
  status_pendentes := (SELECT count(*) FROM whatsapp_atendimento_status);
  RAISE NOTICE '060 rollback precheck: conversas = %, mensagens = %, em processamento/envio = %, status sem correspondência = % (com dados: exporte e confirme o descarte com SET LOCAL kidmais.rollback_060_descartar_atendimento = ''sim'' no down; com processamento/envio o down recusa)', conversas, mensagens, ativas, status_pendentes;
END $$;
SELECT '060 rollback precheck OK' AS resultado;
