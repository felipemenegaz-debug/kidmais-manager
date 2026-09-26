-- Devolve o gatilho de preço ao texto da 039 e remove a releitura da 042.
-- Não apaga preço, não limpa publicada_em e não altera vigência.
-- Sem a releitura, duas reativações sobrepostas voltam a poder confirmar.
BEGIN;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_preco_publicado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_nova uuid;
  empresa_antiga uuid;
  publicada_nova timestamptz;
  publicada_antiga timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tabela_preco_id IS NOT DISTINCT FROM OLD.tabela_preco_id
     AND NEW.pacote_id IS NOT DISTINCT FROM OLD.pacote_id
     AND NEW.convidados_min IS NOT DISTINCT FROM OLD.convidados_min
     AND NEW.convidados_max IS NOT DISTINCT FROM OLD.convidados_max
     AND NEW.tipo_calculo IS NOT DISTINCT FROM OLD.tipo_calculo
     AND NEW.valor IS NOT DISTINCT FROM OLD.valor
     AND NEW.categoria_horario IS NOT DISTINCT FROM OLD.categoria_horario
     AND NEW.ativo IS NOT DISTINCT FROM OLD.ativo THEN
    RETURN NEW;
  END IF;

  IF TG_WHEN = 'AFTER' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT empresa_id INTO empresa_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
      PERFORM kidmais_039_travar_par(empresa_antiga, empresa_antiga);
    ELSE
      SELECT empresa_id INTO empresa_nova FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
      IF TG_OP = 'UPDATE' AND NEW.tabela_preco_id IS DISTINCT FROM OLD.tabela_preco_id THEN
        SELECT empresa_id INTO empresa_antiga FROM tabelas_preco WHERE id = OLD.tabela_preco_id;
      ELSE
        empresa_antiga := empresa_nova;
      END IF;
      PERFORM kidmais_039_travar_par(empresa_nova, empresa_antiga);
    END IF;
  END IF;

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

DROP FUNCTION IF EXISTS kidmais_042_revalidar_faixa_publicada(uuid, uuid, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS kidmais_042_falhar_se_faixa_publicada_sobreposta();

COMMIT;
