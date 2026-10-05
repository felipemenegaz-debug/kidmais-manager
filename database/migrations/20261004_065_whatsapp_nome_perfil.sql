-- 065 — Atendimento WhatsApp: nome de PERFIL do contato (não verificado), por conversa.
--
-- O Gupshup entrega em cada mensagem recebida `payload.sender.name`: o nome que a própria pessoa pôs no perfil do
-- WhatsApp. Não é verificado e não identifica cliente; a tela o mostra rotulado como tal, separado do nome cadastrado
-- (que vem do cadastro de clientes da empresa, consultado na hora, sem coluna nova).
--
-- Aditiva e sem reescrita de tabela: duas colunas anuláveis em whatsapp_atendimento_conversas (isolada por empresa e
-- ambiente desde a 060). Exige a 060; independe da 064. Falha fechada se já aplicada.
-- Aplicação real somente com autorização explícita (docs/OPERACAO_AGENTES.md). Postcheck: database/checks/20261004_065_postcheck.sql.
-- Numeração coordenada em 04/10/2026: a 063 fica com feat/painel-desenvolvedor-20261004 (já publicada); as do
-- atendimento são a 064 (mensagens prontas) e esta 065. Entram em qualquer ordem (docs/IDENTIFICACAO_CONTATO_ATENDIMENTO.md).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_conversas') IS NULL THEN
    RAISE EXCEPTION '065 exige a 060 (atendimento WhatsApp).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.whatsapp_atendimento_conversas'::regclass
              AND attname IN ('nome_perfil', 'nome_perfil_em') AND NOT attisdropped) THEN
    RAISE EXCEPTION '065 já aplicada (total ou parcialmente).';
  END IF;
END $$;

ALTER TABLE whatsapp_atendimento_conversas
  ADD COLUMN nome_perfil text
    CONSTRAINT whatsapp_atendimento_conversas_nome_perfil_formato
    CHECK (nome_perfil IS NULL OR (nome_perfil = btrim(nome_perfil) AND char_length(nome_perfil) BETWEEN 1 AND 80)),
  ADD COLUMN nome_perfil_em timestamptz,
  ADD CONSTRAINT whatsapp_atendimento_conversas_nome_perfil_par
    CHECK ((nome_perfil IS NULL) = (nome_perfil_em IS NULL));

COMMENT ON COLUMN whatsapp_atendimento_conversas.nome_perfil IS
  'Nome do perfil do WhatsApp informado pela própria pessoa (Gupshup payload.sender.name). NÃO verificado; não identifica cliente; não vai ao modelo.';
COMMENT ON COLUMN whatsapp_atendimento_conversas.nome_perfil_em IS
  'Horário do evento (Gupshup) que trouxe o nome_perfil atual; evento mais antigo não sobrescreve.';

COMMIT;
