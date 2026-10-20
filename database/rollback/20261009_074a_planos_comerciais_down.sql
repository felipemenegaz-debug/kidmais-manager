-- 074 rollback PREPARADO, NÃO EXECUTADO. Só permitido antes de qualquer uso comercial.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE empresa_assinaturas, assinatura_isencoes, assinatura_fundadores, assinatura_contratacoes IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM assinatura_isencoes)
     OR EXISTS (SELECT 1 FROM assinatura_fundadores)
     OR EXISTS (SELECT 1 FROM assinatura_contratacoes)
     OR EXISTS (SELECT 1 FROM empresa_assinaturas WHERE plano <> 'UNICO' OR contratacao_atual_id IS NOT NULL) THEN
    RAISE EXCEPTION '074 rollback recusado: há histórico comercial ou isenção. Fazer correção progressiva.';
  END IF;
END $$;

-- Restauração literal da função 068; nenhuma redução nas guardas do legado.
CREATE OR REPLACE FUNCTION kidmais_068_assinatura_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Assinatura não é apagada; encerre.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao <> 'TESTE' THEN RAISE EXCEPTION 'Assinatura nasce em TESTE.' USING ERRCODE = 'P0001'; END IF;
    NEW.versao := 1;
    NEW.criado_em := clock_timestamp();
    NEW.atualizado_em := NEW.criado_em;
    RETURN NEW;
  END IF;
  IF NEW.empresa_id <> OLD.empresa_id OR NEW.teste_inicio <> OLD.teste_inicio OR NEW.criado_em <> OLD.criado_em
     OR NEW.plano <> OLD.plano OR NEW.documento_teste IS DISTINCT FROM OLD.documento_teste THEN
    RAISE EXCEPTION 'Identidade da assinatura é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.teste_fim < OLD.teste_fim THEN RAISE EXCEPTION 'O fim do teste só avança.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.teste_fim <> OLD.teste_fim AND OLD.situacao <> 'TESTE' THEN
    RAISE EXCEPTION 'O teste só é estendido enquanto a assinatura está em TESTE.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.provedor_cliente_id IS NOT NULL AND NEW.provedor_cliente_id IS DISTINCT FROM OLD.provedor_cliente_id THEN
    RAISE EXCEPTION 'Cliente no provedor é imutável depois de vinculado.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.provedor_assinatura_id IS NOT NULL AND NEW.provedor_assinatura_id IS DISTINCT FROM OLD.provedor_assinatura_id
     AND OLD.situacao NOT IN ('TESTE', 'CANCELADA_FIM_PERIODO', 'ENCERRADA') THEN
    RAISE EXCEPTION 'Assinatura no provedor só é trocada depois de cancelada ou encerrada.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.situacao <> OLD.situacao AND NOT ((OLD.situacao, NEW.situacao) IN (
       ('TESTE', 'ATIVA'), ('TESTE', 'ENCERRADA'),
       ('ATIVA', 'EM_ATRASO'), ('ATIVA', 'CANCELADA_FIM_PERIODO'), ('ATIVA', 'ENCERRADA'),
       ('EM_ATRASO', 'ATIVA'), ('EM_ATRASO', 'CANCELADA_FIM_PERIODO'), ('EM_ATRASO', 'ENCERRADA'),
       ('CANCELADA_FIM_PERIODO', 'ATIVA'), ('CANCELADA_FIM_PERIODO', 'ENCERRADA'),
       ('ENCERRADA', 'ATIVA'))) THEN
    RAISE EXCEPTION 'Transição de assinatura inválida: % → %.', OLD.situacao, NEW.situacao USING ERRCODE = 'P0001';
  END IF;
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;

ALTER TABLE empresa_assinaturas
  DROP CONSTRAINT empresa_assinaturas_contratacao_fk,
  DROP CONSTRAINT empresa_assinaturas_contratacao_check,
  DROP COLUMN contratacao_atual_id,
  DROP CONSTRAINT empresa_assinaturas_plano_check,
  ADD CONSTRAINT empresa_assinaturas_plano_check CHECK (plano IN ('UNICO'));
ALTER TABLE assinatura_fundadores DROP CONSTRAINT assinatura_fundadores_confirmacao_fk;
DROP TABLE assinatura_contratacoes;
DROP TABLE assinatura_fundadores;
DROP TABLE assinatura_isencoes;
DROP FUNCTION kidmais_074_registro_guarda();
COMMIT;
