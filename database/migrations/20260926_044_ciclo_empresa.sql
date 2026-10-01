BEGIN;

-- Substitui o comportamento permissivo da kidmais_031_guard_empresas.
-- A função antiga permanece para o rollback reapontar o gatilho.
-- O arquivo da 031 não é editado.
--
-- Transições permitidas, e só estas:
--   PROVISIONAMENTO → ATIVA
--   PROVISIONAMENTO → DESATIVADA
--   ATIVA → SUSPENSA
--   ATIVA → DESATIVADA
--   SUSPENSA → DESATIVADA
-- Não há reativação. INSERT continua só em PROVISIONAMENTO.
-- Quem entra em DESATIVADA recebe desativado_em do próprio guard.
-- O chamador não carimba essa data. Cada transição grava auditoria
-- na mesma transação, só com o status, sem segredo.

DO $$ BEGIN
  IF to_regprocedure('public.kidmais_031_guard_empresas()') IS NULL
     OR to_regclass('public.empresas') IS NULL
     OR to_regclass('public.auditoria') IS NULL THEN
    RAISE EXCEPTION '044: guard da 031, empresas ou auditoria ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_044_guard_empresas()') IS NOT NULL THEN
    RAISE EXCEPTION '044: ciclo da empresa já instalado.';
  END IF;
END $$;

CREATE FUNCTION kidmais_044_guard_empresas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  ator text;
  ator_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '044: exclusão física de empresa recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PROVISIONAMENTO' OR NEW.desativado_em IS NOT NULL THEN
      RAISE EXCEPTION '044: empresa nova começa em PROVISIONAMENTO.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.desativado_em IS DISTINCT FROM OLD.desativado_em THEN
    RAISE EXCEPTION '044: identidade da empresa é imutável. desativado_em não é carimbado pelo chamador.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'PROVISIONAMENTO' AND NEW.status IN ('ATIVA', 'DESATIVADA'))
      OR (OLD.status = 'ATIVA' AND NEW.status IN ('SUSPENSA', 'DESATIVADA'))
      OR (OLD.status = 'SUSPENSA' AND NEW.status = 'DESATIVADA')
    ) THEN
      RAISE EXCEPTION '044: transição de empresa recusada.';
    END IF;
    IF NEW.status = 'DESATIVADA' THEN
      NEW.desativado_em := clock_timestamp();
    END IF;
    ator := nullif(current_setting('kidmais.ator_usuario_id', true), '');
    IF ator IS NULL THEN
      ator_id := NULL;
    ELSE
      BEGIN
        ator_id := ator::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION '044: ator da transição inválido.';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM usuarios_administrativos WHERE id = ator_id AND ativo
      ) THEN
        RAISE EXCEPTION '044: transição sem usuário administrativo ativo.';
      END IF;
    END IF;
    INSERT INTO auditoria (
      ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
      dados_antes, dados_depois, origem, criado_em
    ) VALUES (
      CASE WHEN ator_id IS NULL THEN 'SISTEMA' ELSE 'USUARIO' END,
      ator_id,
      'EMPRESA_TRANSICAO',
      'EMPRESA',
      NEW.id,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status),
      'HG8_CICLO_EMPRESA',
      clock_timestamp()
    );
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER empresas_guard_trg ON empresas;

CREATE TRIGGER empresas_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON empresas
FOR EACH ROW
EXECUTE FUNCTION kidmais_044_guard_empresas();

COMMIT;
