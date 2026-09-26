BEGIN;

-- Abre só as transições aprovadas da membership.
-- A função da 043 permanece para o rollback reapontar o gatilho.
-- Não há status SUSPENSA, não há coluna papel e não há reativação.
-- REVOGADA é terminal. A unicidade (empresa, usuário) continua ocupada.
-- O guard carimba revogado_em. O chamador não carimba.
-- Cada transição grava auditoria na mesma transação, só com o status.

DO $$ BEGIN
  IF to_regprocedure('public.kidmais_043_guard_memberships()') IS NULL
     OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.auditoria') IS NULL THEN
    RAISE EXCEPTION '045: guard da 043, memberships ou auditoria ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_045_guard_memberships()') IS NOT NULL THEN
    RAISE EXCEPTION '045: ciclo da membership já instalado.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'memberships'
       AND column_name = 'papel'
  ) THEN
    RAISE EXCEPTION '045: membership não recebe papel.';
  END IF;
END $$;

CREATE FUNCTION kidmais_045_guard_memberships()
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
    RAISE EXCEPTION '045: exclusão física de membership recusada.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'PENDENTE' OR NEW.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION '045: membership nova começa pendente.';
    END IF;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    NEW.vigente_desde := NEW.criado_em;
    NEW.revisao := 1;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.vigente_desde IS DISTINCT FROM OLD.vigente_desde
     OR NEW.revogado_em IS DISTINCT FROM OLD.revogado_em THEN
    RAISE EXCEPTION '045: identidade da membership é imutável. revogado_em não é carimbado pelo chamador.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'PENDENTE' AND NEW.status IN ('ATIVA', 'REVOGADA'))
      OR (OLD.status = 'ATIVA' AND NEW.status = 'REVOGADA')
    ) THEN
      RAISE EXCEPTION '045: transição de membership recusada.';
    END IF;
    IF NEW.status = 'REVOGADA' THEN
      NEW.revogado_em := clock_timestamp();
    END IF;
    NEW.revisao := OLD.revisao + 1;
    ator := nullif(current_setting('kidmais.ator_usuario_id', true), '');
    IF ator IS NULL THEN
      ator_id := NULL;
    ELSE
      BEGIN
        ator_id := ator::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION '045: ator da transição inválido.';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM usuarios_administrativos WHERE id = ator_id AND ativo
      ) THEN
        RAISE EXCEPTION '045: transição sem usuário administrativo ativo.';
      END IF;
    END IF;
    INSERT INTO auditoria (
      ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
      dados_antes, dados_depois, origem, criado_em
    ) VALUES (
      CASE WHEN ator_id IS NULL THEN 'SISTEMA' ELSE 'USUARIO' END,
      ator_id,
      'MEMBERSHIP_TRANSICAO',
      'MEMBERSHIP',
      NEW.id,
      jsonb_build_object('status', OLD.status),
      jsonb_build_object('status', NEW.status),
      'HG8_CICLO_MEMBERSHIP',
      clock_timestamp()
    );
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER kidmais_043_memberships_guard_trg ON memberships;

CREATE TRIGGER kidmais_043_memberships_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW
EXECUTE FUNCTION kidmais_045_guard_memberships();

COMMIT;
