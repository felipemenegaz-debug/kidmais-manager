-- Devolve a guarda de publicação ao texto da 048, só no UPDATE.
-- Não apaga preço, não remove supersessão e não reescreve vigência.
BEGIN;

DROP TRIGGER IF EXISTS tabelas_preco_publicacao_trg ON tabelas_preco;

CREATE OR REPLACE FUNCTION kidmais_048_preparar_supersessao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.substituida_em IS NULL AND NEW.substituida_por_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND (OLD.substituida_em IS NOT NULL OR OLD.substituida_por_id IS NOT NULL) THEN
      RAISE EXCEPTION '048: supersessão não pode ser desfeita.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.substituida_em IS NULL OR NEW.substituida_por_id IS NULL THEN
    RAISE EXCEPTION '048: supersessão exige data e sucessora juntas.'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.substituida_em IS NOT NULL THEN
    RAISE EXCEPTION '048: supersessão não pode ser refeita.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.publicada_em IS NULL THEN
    RAISE EXCEPTION '048: só uma tabela publicada pode ser substituída.'
      USING ERRCODE = '23514';
  END IF;
  PERFORM kidmais_037_trava_publicacao(NEW.empresa_id);
  PERFORM kidmais_048_recusar_ciclo(NEW.id, NEW.substituida_por_id);
  IF NOT EXISTS (
    SELECT 1
      FROM tabelas_preco sucessora
     WHERE sucessora.id = NEW.substituida_por_id
       AND sucessora.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
  ) THEN
    RAISE EXCEPTION '048: sucessora precisa existir na mesma empresa.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kidmais_035_preservar_tabela_publicada()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  lacuna text;
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
  SELECT codigo INTO lacuna FROM kidmais_047_lacunas_escopo(NEW.id) LIMIT 1;
  IF lacuna IS NOT NULL THEN
    RAISE EXCEPTION '047: escopo declarado incompleto (%).', lacuna
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM precos_pacote pp JOIN pacotes p ON p.id = pp.pacote_id
     WHERE pp.tabela_preco_id = NEW.id AND NEW.empresa_id IS DISTINCT FROM p.empresa_id
  ) THEN
    RAISE EXCEPTION '035: preço de pacote cruza empresas.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM precos_pacote
     WHERE tabela_preco_id = NEW.id
       AND (convidados_min < 1 OR (convidados_max IS NOT NULL AND convidados_max < convidados_min) OR valor <= 0)
  ) THEN
    RAISE EXCEPTION '035: faixa inválida.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM precos_pacote a
      JOIN precos_pacote b
        ON b.tabela_preco_id = a.tabela_preco_id AND b.pacote_id = a.pacote_id
       AND b.categoria_horario = a.categoria_horario AND b.id > a.id AND a.ativo AND b.ativo
       AND int4range(a.convidados_min::integer, a.convidados_max::integer, '[]')
           && int4range(b.convidados_min::integer, b.convidados_max::integer, '[]')
     WHERE a.tabela_preco_id = NEW.id
  ) THEN
    RAISE EXCEPTION '035: faixa sobreposta.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tabelas_preco outra
     WHERE outra.id <> NEW.id
       AND outra.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
       AND outra.publicada_em IS NOT NULL
       AND outra.substituida_em IS NULL
       AND daterange(outra.vigencia_inicio, COALESCE(outra.vigencia_fim, 'infinity'::date), '[]')
           && daterange(NEW.vigencia_inicio, COALESCE(NEW.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '035: vigência publicada sobreposta.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tabelas_preco_publicacao_trg
BEFORE UPDATE ON tabelas_preco
FOR EACH ROW
EXECUTE FUNCTION kidmais_035_preservar_tabela_publicada();

COMMIT;
