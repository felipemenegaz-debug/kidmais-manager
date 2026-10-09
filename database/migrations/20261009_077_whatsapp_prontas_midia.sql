-- 077 — Atendimento WhatsApp: fotos e vídeos nas mensagens prontas e na resposta do atendente; atalhos de salgados,
--       bolos, endereço e localização.
--
-- NÃO APLICADA. Exige autorização explícita (docs/OPERACAO_AGENTES.md) para qualquer banco, inclusive staging, clones e
-- o cluster descartável. Exige a 060 (mensagens) e a 076 (mensagens prontas); independe da 065.
--
-- Mídia por URL https pública (requisito do Gupshup: a URL é baixada pelo provedor; IP não vale). A mídia é sempre a de
-- uma mensagem pronta da EMPRESA: o atendente escolhe, revisa a legenda e envia; a URL nunca vem da tela.
--   Foto: JPEG/PNG até 5 MB.  Vídeo: MP4/3GPP (H.264 + AAC) até 16 MB.  Tamanho e codec são conferidos pelo provedor.
--   Legenda: até 1024 caracteres (limite conservador; o texto continua com o teto de 4000 nos demais tipos).
-- Localização: atalho de mensagem de texto/link (endereço, link de mapa); não há tipo "localização" nativo nesta entrega.
--
-- Origem revisada: a saída com mídia guarda a mensagem pronta e a VERSÃO dela que o atendente viu na prévia (o envio é
-- recusado se a pronta mudou). FK composta (id, empresa, ambiente): a origem é sempre da mesma empresa e ambiente da
-- mensagem. A FK também torna a 076 dependente da 077: o down da 076 (DROP TABLE sem CASCADE) falha fechado enquanto a
-- 077 existir — antes ele apagava as prontas e deixava as colunas de mídia órfãs (prova em .local-ux da fase B).
--
-- Aditiva: troca as duas restrições CHECK da 076 (tipo e atalho) por versões ampliadas com nome próprio, e acrescenta
-- colunas anuláveis. Nenhuma linha existente muda. Falha fechada se já aplicada ou se as restrições da 076 divergirem.
-- Postcheck: database/checks/20261009_077_postcheck.sql. Rollback: database/rollback/20261009_077_whatsapp_prontas_midia_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens') IS NULL OR to_regclass('public.whatsapp_atendimento_mensagens_prontas') IS NULL THEN
    RAISE EXCEPTION '077 exige a 060 (atendimento WhatsApp) e a 076 (mensagens prontas).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('public.whatsapp_atendimento_mensagens_prontas'::regclass, 'public.whatsapp_atendimento_mensagens'::regclass)
              AND attname IN ('midia_url', 'midia_tipo', 'midia_pronta_id', 'midia_pronta_versao') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass AND conname IN ('whatsapp_prontas_tipo', 'whatsapp_prontas_atalho')) THEN
    RAISE EXCEPTION '077 já aplicada (total ou parcialmente).';
  END IF;
  -- As duas restrições substituídas precisam estar exatamente como a 076 as criou.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass
       AND conname = 'whatsapp_atendimento_mensagens_prontas_tipo_check')
     IS DISTINCT FROM 'CHECK ((tipo = ANY (ARRAY[''TEXTO''::text, ''LINK''::text, ''LINK_FECHAMENTO_INDIVIDUAL''::text])))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.whatsapp_atendimento_mensagens_prontas'::regclass
       AND conname = 'whatsapp_atendimento_mensagens_prontas_atalho_check')
     IS DISTINCT FROM 'CHECK ((atalho = ANY (ARRAY[''TABELA_PRECOS''::text, ''DISPONIBILIDADE_FECHAMENTO''::text])))' THEN
    RAISE EXCEPTION '077 recusada: as restrições de tipo/atalho da 076 divergem do esperado.';
  END IF;
END $$;

ALTER TABLE whatsapp_atendimento_mensagens_prontas
  DROP CONSTRAINT whatsapp_atendimento_mensagens_prontas_tipo_check,
  DROP CONSTRAINT whatsapp_atendimento_mensagens_prontas_atalho_check,
  ADD CONSTRAINT whatsapp_prontas_tipo CHECK (tipo IN ('TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL', 'IMAGEM', 'VIDEO')),
  ADD CONSTRAINT whatsapp_prontas_atalho CHECK (atalho IN ('TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO', 'SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO')),
  ADD COLUMN midia_url text
    CONSTRAINT whatsapp_prontas_midia_url_formato CHECK (midia_url ~ '^https://[^[:space:]]+$' AND length(midia_url) <= 2048),
  -- URL de mídia só (e sempre) nos tipos de mídia; legenda com teto próprio.
  ADD CONSTRAINT whatsapp_prontas_midia_por_tipo CHECK ((tipo IN ('IMAGEM', 'VIDEO')) = (midia_url IS NOT NULL)),
  ADD CONSTRAINT whatsapp_prontas_legenda_limite CHECK (tipo NOT IN ('IMAGEM', 'VIDEO') OR length(texto) <= 1024);

ALTER TABLE whatsapp_atendimento_mensagens
  ADD COLUMN midia_tipo text CONSTRAINT whatsapp_mensagens_midia_tipo CHECK (midia_tipo IN ('IMAGEM', 'VIDEO')),
  ADD COLUMN midia_url text
    CONSTRAINT whatsapp_mensagens_midia_url_formato CHECK (midia_url ~ '^https://[^[:space:]]+$' AND length(midia_url) <= 2048),
  ADD CONSTRAINT whatsapp_mensagens_midia_par CHECK ((midia_tipo IS NULL) = (midia_url IS NULL)),
  -- Mídia é só de SAÍDA (a entrada de mídia continua sem conteúdo gravado, como na 060).
  ADD CONSTRAINT whatsapp_mensagens_midia_so_saida CHECK (midia_tipo IS NULL OR direcao = 'SAIDA'),
  ADD CONSTRAINT whatsapp_mensagens_legenda_limite CHECK (midia_tipo IS NULL OR texto IS NULL OR length(texto) <= 1024),
  -- Origem: a mensagem pronta e a versão revisada; presentes juntas, e só quando há mídia.
  ADD COLUMN midia_pronta_id uuid,
  ADD COLUMN midia_pronta_versao bigint CONSTRAINT whatsapp_mensagens_midia_pronta_versao CHECK (midia_pronta_versao >= 0),
  ADD CONSTRAINT whatsapp_mensagens_midia_origem CHECK ((midia_tipo IS NULL) = (midia_pronta_id IS NULL) AND (midia_pronta_id IS NULL) = (midia_pronta_versao IS NULL)),
  ADD CONSTRAINT whatsapp_mensagens_midia_pronta FOREIGN KEY (midia_pronta_id, empresa_id, ambiente)
    REFERENCES whatsapp_atendimento_mensagens_prontas (id, empresa_id, ambiente);

COMMENT ON COLUMN whatsapp_atendimento_mensagens.midia_pronta_versao IS
  'Versão da mensagem pronta que o atendente viu na prévia; o envio é recusado se a pronta mudou depois dela.';
COMMENT ON COLUMN whatsapp_atendimento_mensagens_prontas.midia_url IS
  'URL https pública da foto (JPEG/PNG até 5 MB) ou do vídeo (MP4/3GPP, H.264+AAC, até 16 MB) desta mensagem pronta. O texto é a legenda.';
COMMENT ON COLUMN whatsapp_atendimento_mensagens.midia_url IS
  'Mídia de SAÍDA copiada da mensagem pronta escolhida pelo atendente (a URL nunca vem da tela). O texto é a legenda.';

COMMIT;
