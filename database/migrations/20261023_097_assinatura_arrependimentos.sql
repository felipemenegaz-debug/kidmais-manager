-- 097 — Manifestações do direito de arrependimento (grupo C do parecer de apoio, 23/10/2026; CDC art. 49; Decreto
-- 7.962/2013, arts. 4–5: exercício pela mesma ferramenta, confirmação imediata, restituição e comunicação imediatas ao
-- intermediador). LOCAL, NÃO aplicada em staging/produção. Exige 068/074a. Independente da 089.
-- Ordem: código compatível publicado ANTES (sem a 097 a tela indica o canal oficial) → conferência → autorização →
-- aplicação → postcheck.
-- O que muda: assinatura_arrependimentos registra, com protocolo KA-…, a manifestação feita pela Gestão na tela
-- Assinatura (ou registrada pelo atendimento) INDEPENDENTEMENTE da regra comercial (primeira ativação, 7 dias da
-- garantia) e da disponibilidade do provedor. Os dados de prazo e provedor são informativos (não decidem). O atendimento
-- registra a comunicação ao intermediador e a conclusão: RESTITUIDO (com valor e referência) ou NAO_APLICAVEL (com
-- justificativa). Núcleo imutável; transições únicas; sem DELETE.
-- O que NÃO muda: nenhuma linha existente; assinatura_encerramentos (089) continua para o fluxo automático elegível.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DO $$ BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL THEN
    RAISE EXCEPTION '097 exige 068 e 074a instaladas.';
  END IF;
  IF to_regclass('public.assinatura_arrependimentos') IS NOT NULL OR to_regprocedure('public.kidmais_097_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '097 já aplicada total ou parcialmente.';
  END IF;
END $$;

CREATE TABLE assinatura_arrependimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo text NOT NULL UNIQUE CHECK (protocolo ~ '^KA-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  empresa_id uuid NOT NULL REFERENCES empresa_assinaturas(empresa_id),
  chave_idempotencia uuid NOT NULL,
  canal text NOT NULL CHECK (canal IN ('FERRAMENTA', 'ATENDIMENTO')),
  solicitado_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  solicitado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  motivo text CHECK (motivo IS NULL OR char_length(motivo) <= 500),
  situacao_assinatura text NOT NULL CHECK (situacao_assinatura IN ('TESTE', 'ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO', 'ENCERRADA')),
  -- Informativos (não decidem): referência da contratação, dentro dos 7 dias e provedor disponível no momento.
  contratado_em timestamptz,
  dentro_de_7_dias boolean,
  provedor_disponivel boolean NOT NULL,
  -- Assinatura do provedor vigente no registro (revisão 8da88ba, P2-C1): a conclusão com restituição só encerra o acesso
  -- se a empresa ainda estiver nela, e a sincronização não deixa as cobranças dela até o limite reabrirem o período.
  provedor_assinatura_id text CHECK (provedor_assinatura_id IS NULL OR provedor_assinatura_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  -- Acompanhamento pelo atendimento (transições únicas pela guarda).
  intermediador_comunicado_em timestamptz,
  intermediador_referencia text CHECK (intermediador_referencia IS NULL OR char_length(btrim(intermediador_referencia)) BETWEEN 3 AND 300),
  situacao text NOT NULL DEFAULT 'RECEBIDO' CHECK (situacao IN ('RECEBIDO', 'RESTITUIDO', 'NAO_APLICAVEL')),
  concluido_em timestamptz,
  concluido_por uuid REFERENCES usuarios_administrativos(id),
  conclusao_referencia text CHECK (conclusao_referencia IS NULL OR char_length(btrim(conclusao_referencia)) BETWEEN 5 AND 500),
  valor_restituido_centavos integer CHECK (valor_restituido_centavos IS NULL OR valor_restituido_centavos > 0),
  -- Restituição (P2-C1): data (Brasília) da conclusão; cobranças da assinatura acima com vencimento até ela não sustentam
  -- período na sincronização. Cobrança restituída informada pelo atendimento (opcional) também não.
  restituicao_limite date,
  restituicao_cobranca_id text CHECK (restituicao_cobranca_id IS NULL OR restituicao_cobranca_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  email_confirmacao text NOT NULL DEFAULT 'PENDENTE' CHECK (email_confirmacao IN ('PENDENTE', 'ENVIADO', 'FALHOU', 'SEM_DESTINATARIO')),
  aviso_interno text NOT NULL DEFAULT 'PENDENTE' CHECK (aviso_interno IN ('PENDENTE', 'ENVIADO', 'FALHOU', 'NAO_CONFIGURADO')),
  CONSTRAINT assinatura_arrependimentos_chave_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT assinatura_arrependimentos_restituicao_check CHECK (situacao = 'RESTITUIDO' OR (restituicao_limite IS NULL AND restituicao_cobranca_id IS NULL)),
  CONSTRAINT assinatura_arrependimentos_intermediador_check CHECK ((intermediador_comunicado_em IS NULL) = (intermediador_referencia IS NULL)),
  CONSTRAINT assinatura_arrependimentos_conclusao_check CHECK (
    (situacao = 'RECEBIDO' AND concluido_em IS NULL AND concluido_por IS NULL AND conclusao_referencia IS NULL AND valor_restituido_centavos IS NULL)
    OR (situacao = 'RESTITUIDO' AND concluido_em IS NOT NULL AND concluido_por IS NOT NULL AND conclusao_referencia IS NOT NULL
        AND valor_restituido_centavos IS NOT NULL AND intermediador_comunicado_em IS NOT NULL AND restituicao_limite IS NOT NULL)
    OR (situacao = 'NAO_APLICAVEL' AND concluido_em IS NOT NULL AND concluido_por IS NOT NULL AND conclusao_referencia IS NOT NULL AND valor_restituido_centavos IS NULL))
);
CREATE INDEX assinatura_arrependimentos_pendentes_idx ON assinatura_arrependimentos (solicitado_em) WHERE situacao = 'RECEBIDO';
CREATE INDEX assinatura_arrependimentos_empresa_idx ON assinatura_arrependimentos (empresa_id, solicitado_em DESC);

-- Núcleo imutável; cada campo de acompanhamento muda uma vez só (NULL → valor, RECEBIDO → final, PENDENTE → final). Sem DELETE.
CREATE FUNCTION kidmais_097_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '097: manifestação de arrependimento não é apagada.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao IS DISTINCT FROM 'RECEBIDO' OR NEW.intermediador_comunicado_em IS NOT NULL OR NEW.email_confirmacao IS DISTINCT FROM 'PENDENTE'
       OR NEW.aviso_interno IS DISTINCT FROM 'PENDENTE' THEN
      RAISE EXCEPTION '097: manifestação nasce RECEBIDA, sem acompanhamento.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.protocolo, NEW.empresa_id, NEW.chave_idempotencia, NEW.canal, NEW.solicitado_por, NEW.solicitado_em, NEW.motivo,
      NEW.situacao_assinatura, NEW.contratado_em, NEW.dentro_de_7_dias, NEW.provedor_disponivel, NEW.provedor_assinatura_id)
     IS DISTINCT FROM (OLD.id, OLD.protocolo, OLD.empresa_id, OLD.chave_idempotencia, OLD.canal, OLD.solicitado_por, OLD.solicitado_em, OLD.motivo,
      OLD.situacao_assinatura, OLD.contratado_em, OLD.dentro_de_7_dias, OLD.provedor_disponivel, OLD.provedor_assinatura_id)
     OR (OLD.intermediador_comunicado_em IS NOT NULL AND (NEW.intermediador_comunicado_em, NEW.intermediador_referencia)
         IS DISTINCT FROM (OLD.intermediador_comunicado_em, OLD.intermediador_referencia))
     OR (OLD.situacao IS DISTINCT FROM 'RECEBIDO' AND (NEW.situacao, NEW.concluido_em, NEW.concluido_por, NEW.conclusao_referencia, NEW.valor_restituido_centavos,
         NEW.restituicao_limite, NEW.restituicao_cobranca_id)
         IS DISTINCT FROM (OLD.situacao, OLD.concluido_em, OLD.concluido_por, OLD.conclusao_referencia, OLD.valor_restituido_centavos,
         OLD.restituicao_limite, OLD.restituicao_cobranca_id))
     OR (OLD.email_confirmacao IS DISTINCT FROM 'PENDENTE' AND NEW.email_confirmacao IS DISTINCT FROM OLD.email_confirmacao)
     OR (OLD.aviso_interno IS DISTINCT FROM 'PENDENTE' AND NEW.aviso_interno IS DISTINCT FROM OLD.aviso_interno) THEN
    RAISE EXCEPTION '097: manifestação imutável; acompanhamento registrado uma vez só.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assinatura_arrependimentos_097_guarda BEFORE INSERT OR UPDATE OR DELETE ON assinatura_arrependimentos
  FOR EACH ROW EXECUTE FUNCTION kidmais_097_guarda();
COMMENT ON TABLE assinatura_arrependimentos IS '097: manifestações do direito de arrependimento, com protocolo, independentes da regra comercial e do provedor; acompanhamento pelo atendimento.';
COMMIT;
