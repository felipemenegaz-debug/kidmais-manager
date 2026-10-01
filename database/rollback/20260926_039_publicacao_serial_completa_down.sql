-- Devolve o gatilho de preço ao BEFORE da 037 e remove a trava do par.
-- Não apaga preço, não limpa publicada_em e não altera vigência.
BEGIN;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_preco_publicado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  publicada_nova timestamptz;
  publicada_antiga timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT publicada_em INTO publicada_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
    IF publicada_antiga IS NOT NULL THEN
      RAISE EXCEPTION '037: preço de tabela publicada não é apagado.'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT publicada_em INTO publicada_nova FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT publicada_em INTO publicada_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
  END IF;

  IF publicada_nova IS NULL AND publicada_antiga IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION '035: tabela publicada não recebe preço novo.';
  END IF;

  IF NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id
     OR NEW.pacote_id IS DISTINCT FROM OLD.pacote_id
     OR NEW.convidados_min IS DISTINCT FROM OLD.convidados_min
     OR NEW.convidados_max IS DISTINCT FROM OLD.convidados_max
     OR NEW.tipo_calculo IS DISTINCT FROM OLD.tipo_calculo
     OR NEW.valor IS DISTINCT FROM OLD.valor
     OR NEW.categoria_horario IS DISTINCT FROM OLD.categoria_horario THEN
    RAISE EXCEPTION '037: preço publicado não muda de tabela nem de cálculo.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ativo IS DISTINCT FROM OLD.ativo AND NEW.ativo = false THEN
    IF NOT EXISTS (
      SELECT 1
        FROM precos_pacote
       WHERE tabela_preco_id = OLD.tabela_preco_id
         AND id <> OLD.id
         AND ativo
    ) THEN
      RAISE EXCEPTION '037: desativar o último preço esvazia a publicação.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_trg ON precos_pacote;
DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_depois_trg ON precos_pacote;
CREATE TRIGGER precos_pacote_tabela_publicada_trg
BEFORE INSERT OR UPDATE OR DELETE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_preco_publicado();

DROP FUNCTION IF EXISTS kidmais_039_travar_par(uuid, uuid);

COMMIT;
