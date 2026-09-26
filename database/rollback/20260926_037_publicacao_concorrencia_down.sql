-- Rollback possível: devolve a guarda ao texto da 035.
-- Não apaga preço, não limpa publicada_em e não altera vigência.
-- Sem a trava, duas publicações da mesma empresa voltam a poder confirmar juntas.
-- Sem o DELETE no gatilho, o preço da publicação volta a poder ser apagado.
BEGIN;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_tabela_publicada()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.publicada_em IS NOT NULL THEN
    IF NEW.publicada_em IS DISTINCT FROM OLD.publicada_em
       OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
       OR NEW.codigo IS DISTINCT FROM OLD.codigo
       OR NEW.ativa IS DISTINCT FROM OLD.ativa
       OR NEW.vigencia_inicio IS DISTINCT FROM OLD.vigencia_inicio
       OR NEW.vigencia_fim IS DISTINCT FROM OLD.vigencia_fim THEN
      RAISE EXCEPTION '035: tabela publicada conserva empresa, vigência e publicação.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.publicada_em IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.ativa THEN
    RAISE EXCEPTION '035: publicação exige tabela inativa.';
  END IF;
  IF NEW.vigencia_fim IS NOT NULL AND NEW.vigencia_fim < NEW.vigencia_inicio THEN
    RAISE EXCEPTION '035: vigência inválida.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM precos_pacote WHERE tabela_preco_id = NEW.id AND ativo
  ) THEN
    RAISE EXCEPTION '035: tabela vazia não é publicada.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE pp.tabela_preco_id = NEW.id
       AND NEW.empresa_id IS DISTINCT FROM p.empresa_id
  ) THEN
    RAISE EXCEPTION '035: preço de pacote cruza empresas.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote
     WHERE tabela_preco_id = NEW.id
       AND (
         convidados_min < 1
         OR (convidados_max IS NOT NULL AND convidados_max < convidados_min)
         OR valor <= 0
       )
  ) THEN
    RAISE EXCEPTION '035: faixa inválida.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote a
      JOIN precos_pacote b
        ON b.tabela_preco_id = a.tabela_preco_id
       AND b.pacote_id = a.pacote_id
       AND b.categoria_horario = a.categoria_horario
       AND b.id > a.id
       AND a.ativo
       AND b.ativo
       AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
           && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
     WHERE a.tabela_preco_id = NEW.id
  ) THEN
    RAISE EXCEPTION '035: faixa sobreposta.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM tabelas_preco outra
     WHERE outra.id <> NEW.id
       AND outra.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
       AND outra.publicada_em IS NOT NULL
       AND daterange(outra.vigencia_inicio, COALESCE(outra.vigencia_fim, 'infinity'::date), '[]')
           && daterange(NEW.vigencia_inicio, COALESCE(NEW.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '035: vigência publicada sobreposta.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_preco_publicado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  publicada timestamptz;
BEGIN
  SELECT publicada_em INTO publicada FROM tabelas_preco WHERE id = NEW.tabela_preco_id;
  IF publicada IS NULL THEN
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
    RAISE EXCEPTION '035: preço de tabela publicada não muda o cálculo.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS precos_pacote_tabela_publicada_trg ON precos_pacote;
CREATE TRIGGER precos_pacote_tabela_publicada_trg
BEFORE INSERT OR UPDATE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_preco_publicado();

DROP FUNCTION IF EXISTS kidmais_037_trava_publicacao(uuid);

COMMIT;
