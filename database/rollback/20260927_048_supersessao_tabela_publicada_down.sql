-- Devolve a guarda de publicação ao texto da 047.
-- Não apaga preço, não limpa publicada_em e não reescreve vigência.
-- Se já existe supersessão, parar: remover a coluna reabriria sobreposição publicada.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL THEN
    RAISE EXCEPTION '048 down: tabela de preço ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tabelas_preco'
       AND column_name = 'substituida_em'
  ) AND EXISTS (SELECT 1 FROM tabelas_preco WHERE substituida_em IS NOT NULL) THEN
    RAISE EXCEPTION '048 down: já existe supersessão. Não reescrever vigência daqui.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS tabelas_preco_supersessao_fim_trg ON tabelas_preco;
DROP TRIGGER IF EXISTS tabelas_preco_supersessao_imediata_trg ON tabelas_preco;
DROP FUNCTION IF EXISTS kidmais_048_validar_supersessao_fim();
DROP FUNCTION IF EXISTS kidmais_048_preparar_supersessao();
DROP FUNCTION IF EXISTS kidmais_048_recusar_ciclo(uuid, uuid);

ALTER TABLE tabelas_preco DROP CONSTRAINT IF EXISTS tabelas_preco_substituida_por_fk;
ALTER TABLE tabelas_preco DROP CONSTRAINT IF EXISTS tabelas_preco_substituida_por_self_check;
ALTER TABLE tabelas_preco DROP CONSTRAINT IF EXISTS tabelas_preco_substituida_par_check;
DROP INDEX IF EXISTS tabelas_preco_corrente_publicada_idx;
ALTER TABLE tabelas_preco DROP COLUMN IF EXISTS substituida_por_id;
ALTER TABLE tabelas_preco DROP COLUMN IF EXISTS substituida_em;

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

COMMIT;
