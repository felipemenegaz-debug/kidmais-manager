-- Remove só o marcador da 038 e devolve o texto da função da 036.
-- Não apaga vínculo, não limpa empresa_id e não reescreve FESTA_LOCAL.
-- Os gatilhos do pai permanecem: sem eles, a empresa do pai volta a mudar.
BEGIN;

CREATE OR REPLACE FUNCTION kidmais_036_empresa_pai_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION '036: a empresa de % não muda.', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS kidmais_038_falhar_se_incompativel();

COMMIT;
