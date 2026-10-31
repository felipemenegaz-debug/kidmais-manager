-- 099: convites avulsos. Preparada localmente; aplicar só após autorização do ambiente.
-- Aplicar antes do código. Sem backfill, sem novos créditos e sem alterar convites vinculados.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
ALTER TABLE convites ALTER COLUMN festa_id DROP NOT NULL,
  ALTER COLUMN cliente_id DROP NOT NULL, ALTER COLUMN versao_contrato_id DROP NOT NULL;
ALTER TABLE convites ADD CONSTRAINT convite_avulso_vinculo_completo CHECK (
  (festa_id IS NULL AND cliente_id IS NULL AND versao_contrato_id IS NULL AND estabelecimento_id IS NULL AND editor_hash IS NULL)
  OR (festa_id IS NOT NULL AND cliente_id IS NOT NULL AND versao_contrato_id IS NOT NULL));
ALTER TABLE convite_ia_autorizacoes ALTER COLUMN festa_id DROP NOT NULL;
CREATE INDEX convites_empresa_atualizado ON convites(empresa_id,atualizado_em DESC,id);
CREATE OR REPLACE FUNCTION convite_validar_vinculo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Empresa e identidade do convite imutáveis';
    END IF;
    IF OLD.festa_id IS NOT NULL AND (NEW.festa_id,NEW.cliente_id,NEW.estabelecimento_id)
        IS DISTINCT FROM (OLD.festa_id,OLD.cliente_id,OLD.estabelecimento_id) THEN
      RAISE EXCEPTION 'Vínculo do convite imutável';
    END IF;
  END IF;
  IF NEW.festa_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM festas f JOIN contratos c ON c.id=f.contrato_id JOIN fechamentos fe ON fe.id=c.fechamento_id
    WHERE f.id=NEW.festa_id AND fe.empresa_id=NEW.empresa_id AND fe.cliente_id=NEW.cliente_id
      AND fe.estabelecimento_id IS NOT DISTINCT FROM NEW.estabelecimento_id
      AND EXISTS (SELECT 1 FROM contrato_versoes v WHERE v.id=NEW.versao_contrato_id AND v.contrato_id=c.id)) THEN
    RAISE EXCEPTION 'Vínculo do convite inválido';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION convite_ia_autorizacao_validar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revogada_em IS NOT NULL THEN RAISE EXCEPTION 'Autorização de IA: registro novo não pode nascer revogado'; END IF;
    IF NOT EXISTS (SELECT 1 FROM convites c WHERE c.id = NEW.convite_id AND c.empresa_id = NEW.empresa_id AND c.festa_id IS NOT DISTINCT FROM NEW.festa_id) THEN
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
