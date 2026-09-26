BEGIN;

-- A revisão aponta só para pacote do mesmo tenant.
-- A 032 criou a chave estrangeira pacotes.revisao_anterior_id → pacotes.id
-- sem empresa. SQL direto podia ligar a empresa A à empresa B.
--
-- Política:
--   os dois lados NULL é válido (legado);
--   a mesma empresa é válida;
--   empresas diferentes são inválidas;
--   empresa/NULL é inválido;
--   NULL/empresa é inválido.
--
-- FK composta (revisao_anterior_id, empresa_id) não serve: MATCH SIMPLE
-- ignoraria o filho com empresa nula e aceitaria NULL → empresa. O gatilho
-- trava a linha anterior e compara as duas empresas.
--
-- A trava da tabela vem ANTES da validação. Dado já incompatível aborta a
-- migration inteira. Nada é reescrito. Os sete pacotes legados não recebem
-- empresa. HG-6 continua exigindo migration própria, controlada e auditável,
-- não um bypass deste gatilho. NULL para empresa no pai continua recusado
-- pela 036. Não há exceção genérica nem parâmetro de sessão.

LOCK TABLE public.pacotes IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL THEN
    RAISE EXCEPTION '041: pacote ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'revisao_anterior_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id'
  ) THEN
    RAISE EXCEPTION '041: revisão ou empresa do pacote ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL THEN
    RAISE EXCEPTION '041: imutabilidade de empresa do pai ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_041_revisao_mesmo_tenant()') IS NOT NULL THEN
    RAISE EXCEPTION '041: guarda de revisão já existe.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pacotes filho
      JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
     WHERE filho.empresa_id IS DISTINCT FROM pai.empresa_id
  ) THEN
    RAISE EXCEPTION '041: revisão cruza empresas. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION kidmais_041_falhar_se_revisao_cruzada()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pacotes filho
      JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
     WHERE filho.empresa_id IS DISTINCT FROM pai.empresa_id
  ) THEN
    RAISE EXCEPTION '041: revisão cruza empresas. A migration não corrige dado.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

SELECT kidmais_041_falhar_se_revisao_cruzada();

CREATE FUNCTION kidmais_041_revisao_mesmo_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  empresa_anterior uuid;
BEGIN
  IF NEW.revisao_anterior_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT empresa_id INTO empresa_anterior
    FROM pacotes
   WHERE id = NEW.revisao_anterior_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '041: revisão anterior ausente.'
      USING ERRCODE = '23503';
  END IF;
  IF empresa_anterior IS DISTINCT FROM NEW.empresa_id THEN
    RAISE EXCEPTION '041: revisão cruza empresas.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pacotes_revisao_tenant_trg ON pacotes;
CREATE TRIGGER pacotes_revisao_tenant_trg
BEFORE INSERT OR UPDATE OF revisao_anterior_id, empresa_id ON pacotes
FOR EACH ROW
EXECUTE FUNCTION kidmais_041_revisao_mesmo_tenant();

SELECT kidmais_041_falhar_se_revisao_cruzada();

COMMIT;
