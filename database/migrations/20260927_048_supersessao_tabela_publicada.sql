BEGIN;

-- A tabela publicada corrente é a que a contratação nova lê:
-- empresa certa, publicada_em preenchido, substituida_em vazio e vigência cobrindo a data.
-- A sucessora nasce sem publicação. A anterior só aponta para ela, e ela só é publicada,
-- dentro da mesma transação. A vigência não é encurtada: a cobertura da anterior é copiada.
-- Contrato, fechamento, festa, snapshot e preço antigo não são reescritos.

DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL
     OR to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL
     OR to_regprocedure('public.kidmais_037_trava_publicacao(uuid)') IS NULL
     OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NULL THEN
    RAISE EXCEPTION '048: publicação ou escopo anterior ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tabelas_preco'
       AND column_name IN ('substituida_em', 'substituida_por_id')
  ) OR to_regprocedure('public.kidmais_048_recusar_ciclo(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '048: supersessão já existe.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'kidmais_035_preservar_tabela_publicada'
       AND pg_get_functiondef(oid) NOT LIKE '%kidmais_047_lacunas_escopo%'
  ) THEN
    RAISE EXCEPTION '048: a guarda de publicação não está na revisão 047.';
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
    RAISE EXCEPTION '048: vigência publicada já se sobrepõe. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE tabelas_preco
  ADD COLUMN substituida_em timestamptz,
  ADD COLUMN substituida_por_id uuid;

ALTER TABLE tabelas_preco
  ADD CONSTRAINT tabelas_preco_substituida_par_check
  CHECK ((substituida_em IS NULL) = (substituida_por_id IS NULL));

ALTER TABLE tabelas_preco
  ADD CONSTRAINT tabelas_preco_substituida_por_self_check
  CHECK (substituida_por_id IS NULL OR substituida_por_id <> id);

ALTER TABLE tabelas_preco
  ADD CONSTRAINT tabelas_preco_substituida_por_fk
  FOREIGN KEY (substituida_por_id) REFERENCES tabelas_preco(id) ON DELETE RESTRICT;

CREATE INDEX tabelas_preco_corrente_publicada_idx
  ON tabelas_preco (empresa_id, vigencia_inicio)
  WHERE substituida_em IS NULL AND publicada_em IS NOT NULL;

CREATE FUNCTION kidmais_048_recusar_ciclo(origem uuid, destino uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  atual uuid;
  profundidade integer := 0;
BEGIN
  IF destino IS NULL THEN
    RETURN;
  END IF;
  IF destino = origem THEN
    RAISE EXCEPTION '048: supersessão não pode apontar para a própria tabela.'
      USING ERRCODE = '23514';
  END IF;
  atual := destino;
  WHILE atual IS NOT NULL LOOP
    profundidade := profundidade + 1;
    IF profundidade > 32 THEN
      RAISE EXCEPTION '048: cadeia de supersessão excede o limite e foi recusada.'
        USING ERRCODE = '23514';
    END IF;
    IF atual = origem THEN
      RAISE EXCEPTION '048: ciclo na cadeia de supersessão.'
        USING ERRCODE = '23514';
    END IF;
    SELECT t.substituida_por_id INTO atual
      FROM tabelas_preco t
     WHERE t.id = atual;
    IF NOT FOUND THEN
      RAISE EXCEPTION '048: sucessora inexistente.'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION kidmais_048_preparar_supersessao()
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

CREATE TRIGGER tabelas_preco_supersessao_imediata_trg
BEFORE INSERT OR UPDATE OF substituida_em, substituida_por_id
ON tabelas_preco
FOR EACH ROW
EXECUTE FUNCTION kidmais_048_preparar_supersessao();

CREATE FUNCTION kidmais_048_validar_supersessao_fim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  correntes integer;
BEGIN
  IF NEW.substituida_por_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM kidmais_048_recusar_ciclo(NEW.id, NEW.substituida_por_id);
  IF NOT EXISTS (
    SELECT 1
      FROM tabelas_preco sucessora
     WHERE sucessora.id = NEW.substituida_por_id
       AND sucessora.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
       AND sucessora.publicada_em IS NOT NULL
       AND sucessora.substituida_em IS NULL
       AND sucessora.vigencia_inicio <= NEW.vigencia_inicio
       AND COALESCE(sucessora.vigencia_fim, 'infinity'::date) >= COALESCE(NEW.vigencia_fim, 'infinity'::date)
  ) THEN
    RAISE EXCEPTION '048: sucessora não é a corrente publicada da mesma empresa.'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO correntes
    FROM tabelas_preco corrente
   WHERE corrente.empresa_id IS NOT DISTINCT FROM NEW.empresa_id
     AND corrente.publicada_em IS NOT NULL
     AND corrente.substituida_em IS NULL
     AND daterange(corrente.vigencia_inicio, COALESCE(corrente.vigencia_fim, 'infinity'::date), '[]')
         && daterange(NEW.vigencia_inicio, COALESCE(NEW.vigencia_fim, 'infinity'::date), '[]');
  IF correntes <> 1 THEN
    RAISE EXCEPTION '048: supersessão não deixou exatamente uma tabela corrente.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tabelas_preco_supersessao_fim_trg
AFTER INSERT OR UPDATE OF substituida_em, substituida_por_id, publicada_em
ON tabelas_preco
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION kidmais_048_validar_supersessao_fim();

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
       AND outra.substituida_em IS NULL
       AND daterange(outra.vigencia_inicio, COALESCE(outra.vigencia_fim, 'infinity'::date), '[]')
           && daterange(NEW.vigencia_inicio, COALESCE(NEW.vigencia_fim, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION '035: vigência publicada sobreposta.';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
