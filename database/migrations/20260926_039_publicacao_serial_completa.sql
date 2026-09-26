BEGIN;

-- Toda mutação que muda o significado de uma tabela publicada usa a mesma
-- trava por empresa da publicação (kidmais_037_trava_publicacao). Empresas
-- diferentes não compartilham essa chave. HG-4 continua aberto: não se exige
-- cobrir todos os pacotes nem as duas categorias.
--
-- A trava das tabelas vem antes da validação e da troca do gatilho. Não há
-- janela em que uma escrita concorrente passe pela guarda antiga.
--
-- O preço recusa no BEFORE o que já está publicado, antes dos outros gatilhos
-- da faixa. A trava por empresa fica no AFTER, depois da chave estrangeira de
-- tabelas_preco. Tomá-la no BEFORE, antes dessa chave, fecha ciclo com a
-- publicação: ela já segurou a linha da tabela e em seguida espera a trava
-- consultiva. A publicação continua no BEFORE, trava a empresa e só então
-- valida o estado que a transação vai confirmar. Quem chega depois espera,
-- relê e recusa o que a publicação já não aceita.
-- observacoes e atualizado_em não mudam esse significado e não entram na trava.
-- Não se despublica tabela vazia já existente e não se apaga preço daqui.

LOCK TABLE
  public.precos_pacote,
  public.tabelas_preco
IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '039: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL THEN
    RAISE EXCEPTION '039: guarda de publicação ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco a
      JOIN tabelas_preco b
        ON b.id > a.id
       AND b.empresa_id IS NOT DISTINCT FROM a.empresa_id
       AND a.publicada_em IS NOT NULL
       AND b.publicada_em IS NOT NULL
       AND daterange(a.vigencia_inicio, COALESCE(a.vigencia_fim, 'infinity'::date), '[]')
           && daterange(b.vigencia_inicio, COALESCE(b.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '039: vigência publicada já se sobrepõe. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
  IF to_regprocedure('public.kidmais_039_travar_par(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '039: serialização da publicação já existe.';
  END IF;
END $$;

CREATE FUNCTION kidmais_039_travar_par(primeira uuid, segunda uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  chave_a text := COALESCE(primeira::text, '');
  chave_b text := COALESCE(segunda::text, '');
BEGIN
  IF chave_a = chave_b THEN
    PERFORM kidmais_037_trava_publicacao(primeira);
    RETURN;
  END IF;
  IF chave_a < chave_b THEN
    PERFORM kidmais_037_trava_publicacao(primeira);
    PERFORM kidmais_037_trava_publicacao(segunda);
  ELSE
    PERFORM kidmais_037_trava_publicacao(segunda);
    PERFORM kidmais_037_trava_publicacao(primeira);
  END IF;
END;
$$;

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

DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_trg ON precos_pacote;
CREATE TRIGGER precos_pacote_tabela_publicada_trg
BEFORE INSERT OR UPDATE OR DELETE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_preco_publicado();

DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_depois_trg ON precos_pacote;
CREATE TRIGGER precos_pacote_tabela_publicada_depois_trg
AFTER INSERT OR UPDATE OR DELETE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_preco_publicado();

COMMIT;
