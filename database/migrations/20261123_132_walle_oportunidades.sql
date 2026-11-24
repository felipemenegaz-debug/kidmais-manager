-- 132: Wall-e fatia 1a (LOCAL 23/11/2026, vault "Plano melhoria Wall-e atendimento 20261122", D-WA-2 e D-WA-3 de Felipe).
-- Vínculo entre o contato do funil (marketing_contatos, 085) e a conversa do WhatsApp que o criou: marca a origem
-- automática do Wall-e (distinta do registro manual pelo canal WhatsApp) e registra a anonimização do contato a pedido
-- do titular. A 085 NÃO muda: o contato continua sem DELETE e a anonimização é um UPDATE dos campos pessoais.
-- A pendência na conversa (oportunidade_pendente_em) é a fila de recuperação da captura: a resposta grava a marca e o
-- worker grava o cartão depois, em transação própria (falha na captura nunca impede nem atrasa a resposta).
-- Exige 082 (conversas do atendimento) e 085 (contatos). Sem texto: nenhuma coluna nova guarda dado pessoal.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.marketing_contatos') IS NULL OR to_regclass('public.whatsapp_atendimento_controles_contato') IS NULL THEN
    RAISE EXCEPTION '132 requer as estruturas 082 e 085';
  END IF;
  IF to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL THEN RAISE EXCEPTION '132 já presente'; END IF;
END $$;

CREATE TABLE whatsapp_atendimento_oportunidades (
  contato_id uuid PRIMARY KEY REFERENCES marketing_contatos (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  empresa_id uuid NOT NULL REFERENCES empresas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ambiente text NOT NULL,
  -- A exclusão da conversa (a pedido ou por retenção) solta o vínculo; o cartão fica.
  conversa_id uuid REFERENCES whatsapp_atendimento_conversas (id) ON UPDATE RESTRICT ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  anonimizado_em timestamptz,
  CONSTRAINT walle_oportunidades_ambiente CHECK (ambiente IN ('staging', 'production'))
);
CREATE INDEX walle_oportunidades_conversa_idx ON whatsapp_atendimento_oportunidades (empresa_id, ambiente, conversa_id);

-- Mesma empresa no contato e na conversa; contato, empresa, ambiente e criação imutáveis; anonimização sem volta; sem DELETE.
-- A conversa do vínculo só pode ser solta (ID -> NULL, pelo ON DELETE SET NULL): nunca trocada por outra nem religada.
CREATE FUNCTION kidmais132_oportunidade_guarda() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '132: vínculo do Wall-e não é apagado.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.contato_id IS DISTINCT FROM OLD.contato_id OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
      OR NEW.ambiente IS DISTINCT FROM OLD.ambiente OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
      OR (OLD.anonimizado_em IS NOT NULL AND NEW.anonimizado_em IS DISTINCT FROM OLD.anonimizado_em)
      OR (NEW.conversa_id IS NOT NULL AND NEW.conversa_id IS DISTINCT FROM OLD.conversa_id)) THEN
    RAISE EXCEPTION '132: vínculo do Wall-e é imutável.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM marketing_contatos k WHERE k.id = NEW.contato_id AND k.empresa_id = NEW.empresa_id AND k.canal_atendimento = 'WHATSAPP') THEN
    RAISE EXCEPTION '132: contato de outra empresa ou de outro canal.';
  END IF;
  IF NEW.conversa_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_atendimento_conversas c
      WHERE c.id = NEW.conversa_id AND c.empresa_id = NEW.empresa_id AND c.ambiente = NEW.ambiente) THEN
    RAISE EXCEPTION '132: conversa de outra empresa ou de outro ambiente.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kidmais132_oportunidade_guarda BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_atendimento_oportunidades
  FOR EACH ROW EXECUTE FUNCTION kidmais132_oportunidade_guarda();

ALTER TABLE whatsapp_atendimento_conversas ADD COLUMN oportunidade_pendente_em timestamptz;
CREATE INDEX walle_conversas_oportunidade_pendente_idx ON whatsapp_atendimento_conversas (oportunidade_pendente_em)
  WHERE oportunidade_pendente_em IS NOT NULL;

COMMIT;
