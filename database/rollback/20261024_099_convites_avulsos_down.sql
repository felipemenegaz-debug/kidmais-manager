-- Reversão 099: recusa se houver avulso ou evidência histórica de autorização avulsa.
-- Não apaga dados. Preparada; não executada. Autorização operacional obrigatória.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,pg_catalog;
LOCK TABLE convites,convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM convites WHERE festa_id IS NULL)
   OR EXISTS(SELECT 1 FROM convite_ia_autorizacoes WHERE festa_id IS NULL) THEN
   RAISE EXCEPTION '099: reversão recusada; preservar convites avulsos e evidências';
 END IF;
END $$;
DROP INDEX convites_empresa_atualizado;
ALTER TABLE convites DROP CONSTRAINT convite_avulso_vinculo_completo,
 ALTER COLUMN festa_id SET NOT NULL, ALTER COLUMN cliente_id SET NOT NULL,
 ALTER COLUMN versao_contrato_id SET NOT NULL;
ALTER TABLE convite_ia_autorizacoes ALTER COLUMN festa_id SET NOT NULL;
CREATE OR REPLACE FUNCTION convite_validar_vinculo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM festas f JOIN contratos c ON c.id=f.contrato_id
    JOIN fechamentos fe ON fe.id=c.fechamento_id WHERE f.id=NEW.festa_id
      AND fe.empresa_id=NEW.empresa_id AND fe.cliente_id=NEW.cliente_id
      AND fe.estabelecimento_id IS NOT DISTINCT FROM NEW.estabelecimento_id) THEN
    RAISE EXCEPTION 'Vínculo do convite inválido';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.empresa_id, NEW.festa_id, NEW.cliente_id, NEW.estabelecimento_id)
      IS DISTINCT FROM (OLD.empresa_id, OLD.festa_id, OLD.cliente_id, OLD.estabelecimento_id) THEN
    RAISE EXCEPTION 'Vínculo do convite imutável';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION convite_ia_autorizacao_validar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revogada_em IS NOT NULL THEN RAISE EXCEPTION 'Autorização de IA: registro novo não pode nascer revogado'; END IF;
    IF NOT EXISTS (SELECT 1 FROM convites c WHERE c.id = NEW.convite_id AND c.empresa_id = NEW.empresa_id AND c.festa_id = NEW.festa_id) THEN
      RAISE EXCEPTION 'Autorização de IA: convite, festa e empresa não correspondem';
    END IF;
    IF NEW.operador_cliente_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM convites c WHERE c.id = NEW.convite_id AND c.cliente_id = NEW.operador_cliente_id) THEN
      RAISE EXCEPTION 'Autorização de IA: cliente não é o do convite';
    END IF;
    IF NEW.operador_usuario_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.empresa_id = NEW.empresa_id
        AND m.usuario_id = NEW.operador_usuario_id AND m.status = 'ATIVA') THEN
      RAISE EXCEPTION 'Autorização de IA: usuário sem vínculo ativo com a empresa';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: somente a revogação, uma vez; todo o resto é evidência imutável.
  IF OLD.revogada_em IS NOT NULL OR NEW.revogada_em IS NULL
    OR (NEW.id, NEW.empresa_id, NEW.convite_id, NEW.festa_id, NEW.finalidade, NEW.provedor, NEW.texto_versao, NEW.texto_hash, NEW.operador_tipo,
        NEW.operador_usuario_id, NEW.operador_cliente_id, NEW.responsavel_nome, NEW.responsavel_vinculo, NEW.meio, NEW.declaracao_responsavel,
        NEW.criado_em)
      IS DISTINCT FROM
       (OLD.id, OLD.empresa_id, OLD.convite_id, OLD.festa_id, OLD.finalidade, OLD.provedor, OLD.texto_versao, OLD.texto_hash, OLD.operador_tipo,
        OLD.operador_usuario_id, OLD.operador_cliente_id, OLD.responsavel_nome, OLD.responsavel_vinculo, OLD.meio, OLD.declaracao_responsavel,
        OLD.criado_em) THEN
    RAISE EXCEPTION 'Autorização de IA: registro imutável; só a revogação pode ser gravada, uma vez';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
