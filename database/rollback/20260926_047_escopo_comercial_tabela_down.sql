-- Devolve a guarda de publicação ao texto da 037 e remove o escopo declarado.
-- Não apaga preço, não limpa publicada_em e não altera vigência.
-- Sem o escopo, publicar volta a aceitar qualquer tabela que tenha um preço ativo.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.tabela_preco_escopos') IS NOT NULL
     AND (SELECT count(*) FROM tabela_preco_escopos) > 0 THEN
    RAISE EXCEPTION '047 down: já existe escopo declarado. Não apagar daqui.';
  END IF;
END $$;

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

DROP TRIGGER IF EXISTS tabela_preco_escopo_faixas_publicado_trg ON tabela_preco_escopo_faixas;
DROP TRIGGER IF EXISTS tabela_preco_escopos_publicado_trg ON tabela_preco_escopos;
DROP TRIGGER IF EXISTS tabela_preco_escopos_empresa_trg ON tabela_preco_escopos;
DROP FUNCTION IF EXISTS kidmais_047_escopo_imutavel();
DROP FUNCTION IF EXISTS kidmais_047_escopo_mesma_empresa();
DROP FUNCTION IF EXISTS kidmais_047_lacunas_escopo(uuid);
DROP TABLE IF EXISTS tabela_preco_escopo_faixas;
DROP TABLE IF EXISTS tabela_preco_escopos;

COMMIT;
