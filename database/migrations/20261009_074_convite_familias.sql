-- 074: cadastro de famílias e RSVP por link individual. Requer autorização antes de executar.
-- Aditiva: preserva respostas anteriores, sem backfill, envio de mensagens ou créditos.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
CREATE TABLE convite_familias (
  id uuid PRIMARY KEY,
  convite_id uuid NOT NULL, empresa_id uuid NOT NULL,
  nome varchar(100) NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 100),
  adultos_previstos integer NOT NULL CHECK (adultos_previstos BETWEEN 0 AND 20),
  criancas_previstas integer NOT NULL CHECK (criancas_previstas BETWEEN 0 AND 20),
  ativa boolean NOT NULL DEFAULT true,
  token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  revisao integer NOT NULL DEFAULT 1 CHECK (revisao > 0),
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (adultos_previstos + criancas_previstas > 0),
  CHECK (ativa OR token_hash IS NULL),
  UNIQUE (id, convite_id),
  FOREIGN KEY (convite_id, empresa_id) REFERENCES convites(id, empresa_id)
);
CREATE INDEX convite_familias_convite ON convite_familias(convite_id, criado_em);
ALTER TABLE convite_respostas ADD COLUMN familia_id uuid;
ALTER TABLE convite_respostas ADD CONSTRAINT convite_respostas_familia_fk
  FOREIGN KEY (familia_id, convite_id) REFERENCES convite_familias(id, convite_id);
CREATE UNIQUE INDEX convite_respostas_uma_por_familia ON convite_respostas(convite_id, familia_id) WHERE familia_id IS NOT NULL;
COMMIT;
