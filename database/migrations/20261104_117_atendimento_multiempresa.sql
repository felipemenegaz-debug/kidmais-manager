-- 117 — Atendimento WhatsApp multiempresa, E-ME1 (plano "Plano Atendimento WhatsApp multiempresa 20261104" r6.1,
-- APROVADO pelo Astra; D-ME-1..5 decididas por Felipe em 04/11/2026). LOCAL, preparada em 04/11/2026. NÃO aplicada em
-- staging/produção.
-- Exige a 060 (atendimento). Só acréscimos; nenhuma tabela existente é alterada.
-- Ordem: código compatível publicado ANTES (sem a 117 o modo efetivo é PILOTO e o status segue a correlação legada com
-- contagem de unicidade) → conferência → autorização → aplicação → postcheck. WHATSAPP_ATENDIMENTO_MULTIEMPRESA só é
-- ligada depois.
--   whatsapp_atendimento_rodizio: vez de cada empresa na reserva do worker (§4). `ordem` é um contador gravado SÓ pela
--     transação de reserva, sob a trava consultiva do rodízio; nenhum outro caminho escreve aqui.
--   whatsapp_atendimento_status_colisoes: marca persistente de identificador do provedor visto em mais de uma saída do
--     mesmo ambiente (§5). Guarda só o identificador e a data; retenção de 30 dias pela rotina do buffer de status.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.whatsapp_atendimento_mensagens') IS NULL OR to_regclass('public.whatsapp_atendimento_status') IS NULL THEN
    RAISE EXCEPTION '117 exige a 060 (atendimento WhatsApp).';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_rodizio') IS NOT NULL OR to_regclass('public.whatsapp_atendimento_status_colisoes') IS NOT NULL THEN
    RAISE EXCEPTION '117 já (parcialmente) presente.';
  END IF;
END $$;

CREATE TABLE whatsapp_atendimento_rodizio (
  empresa_id uuid NOT NULL REFERENCES empresas (id),
  ambiente text NOT NULL,
  ordem bigint NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, ambiente),
  CONSTRAINT whatsapp_atendimento_rodizio_ambiente_check CHECK (ambiente IN ('staging', 'production')),
  CONSTRAINT whatsapp_atendimento_rodizio_ordem_check CHECK (ordem > 0)
);
-- Ordem única por ambiente: o contador é serializado; um empate indicaria escrita fora da reserva.
CREATE UNIQUE INDEX whatsapp_atendimento_rodizio_ordem_uq ON whatsapp_atendimento_rodizio (ambiente, ordem);

CREATE TABLE whatsapp_atendimento_status_colisoes (
  ambiente text NOT NULL,
  provedor_id text NOT NULL,
  detectada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (ambiente, provedor_id),
  CONSTRAINT whatsapp_atendimento_status_colisoes_ambiente_check CHECK (ambiente IN ('staging', 'production')),
  CONSTRAINT whatsapp_atendimento_status_colisoes_provedor_check CHECK (length(provedor_id) BETWEEN 1 AND 512)
);
CREATE INDEX whatsapp_atendimento_status_colisoes_retencao_idx ON whatsapp_atendimento_status_colisoes (detectada_em);

-- Busca global de status por identificador (§5): somente leitura, por ambiente.
CREATE INDEX IF NOT EXISTS whatsapp_atendimento_mensagens_ambiente_provedor_idx
  ON whatsapp_atendimento_mensagens (ambiente, provedor_id) WHERE provedor_id IS NOT NULL;

COMMIT;
