-- PREPARADA, NÃO APLICADA em nenhum banco (staging, produção ou descartável). Exige 068 (empresa_assinaturas).
-- Aditiva: cria só a fila de avisos por e-mail da assinatura; nenhuma tabela existente é alterada.
-- Um aviso por (empresa, tipo, marco, pessoa da Gestão): o UNIQUE torna o enfileiramento idempotente sob reentrega do
-- webhook, reconciliação repetida e job diário executado mais de uma vez. Ver docs/AVISOS_ASSINATURA_EMAIL_20261020.md.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL THEN RAISE EXCEPTION '087 exige a 068 instalada.'; END IF;
  IF to_regclass('public.assinatura_avisos') IS NOT NULL OR to_regprocedure('public.kidmais_087_aviso_guarda()') IS NOT NULL
    THEN RAISE EXCEPTION '087 já aplicada total ou parcialmente.'; END IF;
END $$;

CREATE TABLE assinatura_avisos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id),
  tipo text NOT NULL CHECK (tipo IN ('TESTE_FIM_3_DIAS','TESTE_FIM_HOJE','PAGAMENTO_PENDENTE','SOMENTE_LEITURA',
    'SUSPENSAO_EM_7_DIAS','SUSPENSO','PAGAMENTO_CONFIRMADO','CANCELAMENTO_CONFIRMADO')),
  -- Instante que identifica o evento (fim do teste, início da regularização ou da leitura, fim da leitura, novo fim do
  -- período pago, cancelamento/encerramento). Mesmo evento ⇒ mesmo marco ⇒ nenhum segundo e-mail.
  marco timestamptz NOT NULL,
  destinatario_id uuid NOT NULL REFERENCES usuarios_administrativos(id),
  mensagem jsonb NOT NULL CHECK (jsonb_typeof(mensagem) = 'object' AND mensagem ?& ARRAY['para','assunto','texto','html','idempotencia']
    AND jsonb_typeof(mensagem->'para') = 'string' AND jsonb_typeof(mensagem->'assunto') = 'string'
    AND jsonb_typeof(mensagem->'texto') = 'string' AND jsonb_typeof(mensagem->'html') = 'string'
    AND mensagem->>'idempotencia' = 'kidmais-aviso-assinatura/' || id::text),
  estado text NOT NULL DEFAULT 'PENDENTE' CHECK (estado IN ('PENDENTE','ENVIANDO','ENVIADO','INCERTO','DESCARTADO','DEVOLVIDO')),
  tentado_em timestamptz,
  enviado_em timestamptz,
  id_externo text CHECK (id_externo IS NULL OR id_externo ~ '^[A-Za-z0-9._:-]{1,120}$'),
  ultimo_erro text CHECK (ultimo_erro IS NULL OR ultimo_erro ~ '^[A-Z0-9_]{1,80}$'),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT assinatura_avisos_087_um_por_evento UNIQUE (empresa_id, tipo, marco, destinatario_id),
  CHECK (enviado_em IS NULL OR (tentado_em IS NOT NULL AND enviado_em >= tentado_em AND id_externo IS NOT NULL)),
  CHECK (estado NOT IN ('ENVIANDO','INCERTO') OR tentado_em IS NOT NULL),
  CHECK (estado NOT IN ('ENVIADO','DEVOLVIDO') OR enviado_em IS NOT NULL)
);
CREATE INDEX assinatura_avisos_087_fila_idx ON assinatura_avisos(estado, criado_em) WHERE estado IN ('PENDENTE','ENVIANDO');
CREATE INDEX assinatura_avisos_087_externo_idx ON assinatura_avisos(id_externo) WHERE id_externo IS NOT NULL;

CREATE FUNCTION kidmais_087_aviso_guarda() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Histórico de avisos da assinatura não é apagado.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'PENDENTE' OR NEW.tentado_em IS NOT NULL OR NEW.enviado_em IS NOT NULL OR NEW.id_externo IS NOT NULL
      THEN RAISE EXCEPTION 'Aviso da assinatura nasce pendente.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.empresa_assinaturas a WHERE a.empresa_id = NEW.empresa_id)
      THEN RAISE EXCEPTION 'Aviso exige assinatura da empresa.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.usuarios_administrativos u ON u.id = m.usuario_id
        WHERE m.empresa_id = NEW.empresa_id AND m.usuario_id = NEW.destinatario_id AND m.status = 'ATIVA'
          AND m.papel = 'REPRESENTANTE_AUTORIZADO' AND u.ativo)
      THEN RAISE EXCEPTION 'Aviso exige destinatário ativo da Gestão da empresa.'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.empresa_id,NEW.tipo,NEW.marco,NEW.destinatario_id,NEW.mensagem,NEW.criado_em)
       IS DISTINCT FROM ROW(OLD.id,OLD.empresa_id,OLD.tipo,OLD.marco,OLD.destinatario_id,OLD.mensagem,OLD.criado_em)
      THEN RAISE EXCEPTION 'Destino e mensagem do aviso são imutáveis.'; END IF;
    IF (OLD.tentado_em IS NOT NULL AND NEW.tentado_em IS DISTINCT FROM OLD.tentado_em)
       OR (OLD.enviado_em IS NOT NULL AND ROW(NEW.enviado_em,NEW.id_externo) IS DISTINCT FROM ROW(OLD.enviado_em,OLD.id_externo))
       OR (OLD.enviado_em IS NULL AND OLD.id_externo IS NOT NULL AND NEW.id_externo IS DISTINCT FROM OLD.id_externo)
      THEN RAISE EXCEPTION 'Evidências do aviso são imutáveis.'; END IF;
    IF NOT (NEW.estado = OLD.estado OR
       (OLD.estado = 'PENDENTE' AND NEW.estado IN ('ENVIANDO','DESCARTADO')) OR
       (OLD.estado = 'ENVIANDO' AND NEW.estado IN ('ENVIADO','INCERTO')) OR
       (OLD.estado = 'ENVIADO' AND NEW.estado = 'DEVOLVIDO')) THEN RAISE EXCEPTION 'Transição de aviso inválida.'; END IF;
    IF OLD.estado IN ('ENVIADO','INCERTO','DESCARTADO','DEVOLVIDO') AND NEW.estado = OLD.estado
       AND NEW.ultimo_erro IS DISTINCT FROM OLD.ultimo_erro THEN RAISE EXCEPTION 'Aviso concluído é imutável.'; END IF;
  END IF;
  NEW.atualizado_em := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER assinatura_avisos_087_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_avisos FOR EACH ROW EXECUTE FUNCTION kidmais_087_aviso_guarda();
CREATE TRIGGER assinatura_avisos_087_truncate BEFORE TRUNCATE ON assinatura_avisos FOR EACH STATEMENT EXECUTE FUNCTION kidmais_087_aviso_guarda();
COMMIT;
