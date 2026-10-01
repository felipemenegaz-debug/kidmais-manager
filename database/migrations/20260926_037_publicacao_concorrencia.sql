BEGIN;

-- Fecha os buracos da publicação que a 035 deixou.
-- Duas transações publicavam tabelas diferentes da mesma empresa porque cada
-- uma travava só a própria linha. O segundo carimbo espera a trava da empresa
-- e então enxerga a vigência já publicada.
--
-- Preço de tabela publicada não é apagado, não muda de tabela e não esvazia
-- a publicação ao desligar o último ativo. observacoes continua editável.
-- HG-4 permanece aberto: não se exige cobrir todos os pacotes nem as duas categorias.
--
-- Não reescreve publicada_em, não apaga preço e não despublica tabela já vazia.
-- O precheck aborta a própria migration se duas publicações da mesma empresa
-- já se sobrepõem. Isso não é um script opcional.

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '037: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_preco_publicado()') IS NULL THEN
    RAISE EXCEPTION '037: guarda da 035 ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '037: trava de publicação já existe.';
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
    RAISE EXCEPTION '037: vigência publicada já se sobrepõe. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION kidmais_037_trava_publicacao(empresa uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('kidmais-037-publicacao'),
    hashtext(COALESCE(empresa::text, 'sem-empresa'))
  );
END;
$$;

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
  PERFORM kidmais_037_trava_publicacao(NEW.empresa_id);
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
CREATE TRIGGER precos_pacote_tabela_publicada_trg
BEFORE INSERT OR UPDATE OR DELETE ON precos_pacote
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_preco_publicado();

COMMIT;
