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
  conversas := (SELECT count(*) FROM whatsapp_atendimento_conversas);
  mensagens := (SELECT count(*) FROM whatsapp_atendimento_mensagens);
  ativas := (SELECT count(*) FROM whatsapp_atendimento_mensagens WHERE estado IN ('PROCESSANDO','ENVIANDO'));
  status_pendentes := (SELECT count(*) FROM whatsapp_atendimento_status);
  RAISE NOTICE '060 rollback precheck: conversas = %, mensagens = %, em processamento/envio = %, status sem correspondência = % (com dados: exporte e confirme o descarte com SET LOCAL kidmais.rollback_060_descartar_atendimento = ''sim'' no down; com processamento/envio o down recusa)', conversas, mensagens, ativas, status_pendentes;
END $$;
SELECT '060 rollback precheck OK' AS resultado;
