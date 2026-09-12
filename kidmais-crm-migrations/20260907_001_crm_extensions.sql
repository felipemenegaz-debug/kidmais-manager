BEGIN;

-- Kidmais Manager — Clientes / CRM
-- Migration 001: extensões e funções técnicas compartilhadas.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION kidmais_set_atualizado_em()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.atualizado_em := now();
    RETURN NEW;
END;
$$;

COMMIT;
