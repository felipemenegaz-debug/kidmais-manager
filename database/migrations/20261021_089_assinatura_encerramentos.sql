-- 089: pedidos de cancelamento e devolução da assinatura, com protocolo (L1 do parecer da Astra de 21/10/2026, decidida
-- por Felipe; Decreto 7.962/2013: confirmação imediata e arrependimento pela mesma ferramenta da contratação).
-- Executar somente após autorização própria do ambiente, precheck e backup operacional. Aditiva: cria uma tabela nova e
-- não altera linha, coluna nem gatilho existente (a guarda da 068/074a já aceita ATIVA/CANCELADA_FIM_PERIODO → ENCERRADA).
-- ORDEM (como a 088): o CÓDIGO é publicado primeiro, já com o aplicador e estes SQL na árvore implantada; depois a 089 é
-- aplicada por scripts/migration-089-{staging,production}.cjs (blocos de scripts/bloco-shell-089.cjs). Sem a 089, o código
-- mantém o cancelamento ao fim do período como antes (sem protocolo) e não oferece encerramento com devolução; com ela
-- aplicada e o código antigo ainda no ar, a tabela fica vazia e nada muda (as duas ordens são compatíveis).
-- Tipos:
--   CANCELAMENTO_FIM_PERIODO        cancela a renovação; acesso até o fim do período pago; sem devolução;
--   ARREPENDIMENTO_7_DIAS           garantia de 7 dias na primeira ativação paga: devolução integral, encerra o período;
--   ENCERRAMENTO_ANUAL_PROPORCIONAL anual: devolução proporcional aos dias não utilizados, encerra o período.
-- Valores e cálculo são evidência imutável (regra, dias, valor pago, valor da devolução). Só mudam o resultado do
-- cancelamento no provedor, a situação do estorno e a situação dos e-mails (confirmação à Gestão e aviso interno à
-- plataforma), por transições controladas pela guarda.
-- Rollback: database/rollback/20261021_089_assinatura_encerramentos_down.sql (recusado se houver pedidos).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.empresa_assinaturas') IS NULL OR to_regclass('public.cobranca_eventos') IS NULL
    OR to_regclass('public.assinatura_contratacoes') IS NULL OR to_regclass('public.usuarios_administrativos') IS NULL
    OR to_regclass('public.assinatura_encerramentos') IS NOT NULL
    OR to_regprocedure('public.kidmais_089_encerramento_guarda()') IS NOT NULL THEN
    RAISE EXCEPTION '089: precheck falhou (067/068/074a ausentes ou 089 anterior/parcial); nada alterado';
  END IF;
END $$;
CREATE TABLE assinatura_encerramentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo text NOT NULL UNIQUE CHECK (protocolo ~ '^KM-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  empresa_id uuid NOT NULL REFERENCES empresa_assinaturas(empresa_id),
  tipo text NOT NULL CHECK (tipo IN ('CANCELAMENTO_FIM_PERIODO', 'ARREPENDIMENTO_7_DIAS', 'ENCERRAMENTO_ANUAL_PROPORCIONAL')),
  chave_idempotencia uuid NOT NULL,
  solicitado_por uuid NOT NULL REFERENCES usuarios_administrativos(id),
  solicitado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  motivo text CHECK (motivo IS NULL OR char_length(motivo) <= 500),
  ciclo text CHECK (ciclo IS NULL OR ciclo IN ('MENSAL', 'ANUAL')),
  situacao_anterior text NOT NULL CHECK (situacao_anterior IN ('TESTE', 'ATIVA', 'EM_ATRASO', 'CANCELADA_FIM_PERIODO', 'ENCERRADA')),
  provedor_assinatura_id text NOT NULL CHECK (char_length(provedor_assinatura_id) BETWEEN 1 AND 100),
  -- Devolução (nulos no cancelamento ao fim do período).
  regra text CHECK (regra IS NULL OR regra ~ '^[A-Z0-9-]{1,40}$'),
  cobranca_provedor_id text CHECK (cobranca_provedor_id IS NULL OR char_length(cobranca_provedor_id) BETWEEN 1 AND 100),
  forma_pagamento text CHECK (forma_pagamento IS NULL OR char_length(forma_pagamento) BETWEEN 1 AND 40),
  valor_pago_centavos integer CHECK (valor_pago_centavos IS NULL OR valor_pago_centavos > 0),
  inicio_ciclo date,
  data_ativacao date,
  dias_ciclo smallint CHECK (dias_ciclo IS NULL OR dias_ciclo BETWEEN 28 AND 366),
  dias_utilizados smallint CHECK (dias_utilizados IS NULL OR dias_utilizados >= 0),
  valor_devolucao_centavos integer CHECK (valor_devolucao_centavos IS NULL OR valor_devolucao_centavos > 0),
  prazo_processamento date,
  periodo_fim_anterior timestamptz,
  acesso_pago_encerrado_em timestamptz,
  -- Efeitos no provedor (mutáveis só pela guarda).
  cancelamento_provedor text NOT NULL CHECK (cancelamento_provedor IN ('PENDENTE', 'CONFIRMADO', 'AUSENTE', 'JA_REMOVIDA', 'SEM_CONFIRMACAO', 'RECUSADO')),
  estorno_situacao text NOT NULL CHECK (estorno_situacao IN ('NAO_SE_APLICA', 'AGUARDANDO_MANUAL', 'EM_CURSO', 'SOLICITADO', 'SEM_CONFIRMACAO', 'RECUSADO', 'CONCLUIDO')),
  estorno_modo text CHECK (estorno_modo IS NULL OR estorno_modo IN ('MANUAL', 'AUTOMATICO')),
  estorno_status_provedor text CHECK (estorno_status_provedor IS NULL OR estorno_status_provedor ~ '^[A-Z_]{1,40}$'),
  estorno_referencia text CHECK (estorno_referencia IS NULL OR char_length(btrim(estorno_referencia)) BETWEEN 3 AND 200),
  estorno_atualizado_em timestamptz,
  estorno_concluido_em timestamptz,
  email_situacao text NOT NULL DEFAULT 'PENDENTE' CHECK (email_situacao IN ('PENDENTE', 'ENVIADO', 'FALHOU', 'NAO_CONFIGURADO')),
  -- Aviso interno imediato ao canal da plataforma (SITE_ATENDIMENTO_EMAIL), só com protocolo, tipo, valor e prazo.
  aviso_interno_situacao text NOT NULL DEFAULT 'PENDENTE' CHECK (aviso_interno_situacao IN ('PENDENTE', 'ENVIADO', 'FALHOU', 'NAO_CONFIGURADO')),
  CONSTRAINT assinatura_encerramentos_idempotencia_uk UNIQUE (empresa_id, chave_idempotencia),
  CONSTRAINT assinatura_encerramentos_devolucao_check CHECK (
    (tipo = 'CANCELAMENTO_FIM_PERIODO' AND estorno_situacao = 'NAO_SE_APLICA' AND regra IS NULL AND cobranca_provedor_id IS NULL
      AND valor_pago_centavos IS NULL AND valor_devolucao_centavos IS NULL AND prazo_processamento IS NULL AND acesso_pago_encerrado_em IS NULL)
    OR (tipo <> 'CANCELAMENTO_FIM_PERIODO' AND estorno_situacao <> 'NAO_SE_APLICA' AND regra IS NOT NULL AND cobranca_provedor_id IS NOT NULL
      AND valor_pago_centavos IS NOT NULL AND valor_devolucao_centavos IS NOT NULL AND valor_devolucao_centavos <= valor_pago_centavos
      AND inicio_ciclo IS NOT NULL AND data_ativacao IS NOT NULL AND prazo_processamento IS NOT NULL AND acesso_pago_encerrado_em IS NOT NULL)),
  CONSTRAINT assinatura_encerramentos_integral_check CHECK (tipo <> 'ARREPENDIMENTO_7_DIAS' OR valor_devolucao_centavos = valor_pago_centavos),
  CONSTRAINT assinatura_encerramentos_proporcional_check CHECK (tipo <> 'ENCERRAMENTO_ANUAL_PROPORCIONAL'
    OR (ciclo = 'ANUAL' AND dias_ciclo IS NOT NULL AND dias_utilizados IS NOT NULL AND dias_utilizados < dias_ciclo)),
  CONSTRAINT assinatura_encerramentos_conclusao_check CHECK ((estorno_situacao = 'CONCLUIDO') = (estorno_concluido_em IS NOT NULL)
    AND (estorno_situacao <> 'CONCLUIDO' OR estorno_referencia IS NOT NULL))
);
-- Cada cobrança é devolvida no máximo uma vez por este fluxo; a garantia de 7 dias vale uma única vez por empresa.
CREATE UNIQUE INDEX assinatura_encerramentos_cobranca_uk ON assinatura_encerramentos (cobranca_provedor_id) WHERE cobranca_provedor_id IS NOT NULL;
CREATE UNIQUE INDEX assinatura_encerramentos_garantia_uk ON assinatura_encerramentos (empresa_id) WHERE tipo = 'ARREPENDIMENTO_7_DIAS';
CREATE INDEX assinatura_encerramentos_empresa_idx ON assinatura_encerramentos (empresa_id, solicitado_em DESC);
-- Fila de trabalho manual (Felipe, painel do Asaas): devoluções ainda não concluídas.
CREATE INDEX assinatura_encerramentos_abertos_idx ON assinatura_encerramentos (prazo_processamento)
  WHERE estorno_situacao NOT IN ('NAO_SE_APLICA', 'CONCLUIDO') OR cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO');

CREATE FUNCTION kidmais_089_encerramento_guarda() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION '089: pedido de encerramento não é apagado.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estorno_situacao NOT IN ('NAO_SE_APLICA', 'AGUARDANDO_MANUAL') OR NEW.estorno_modo IS NOT NULL OR NEW.estorno_status_provedor IS NOT NULL
       OR NEW.estorno_referencia IS NOT NULL OR NEW.estorno_concluido_em IS NOT NULL OR NEW.email_situacao <> 'PENDENTE'
       OR NEW.aviso_interno_situacao <> 'PENDENTE' THEN
      RAISE EXCEPTION '089: pedido nasce sem estorno executado e sem e-mail.' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.cancelamento_provedor NOT IN ('PENDENTE', 'JA_REMOVIDA', 'CONFIRMADO', 'AUSENTE', 'SEM_CONFIRMACAO') THEN
      RAISE EXCEPTION '089: resultado inicial do cancelamento inválido.' USING ERRCODE = 'P0001';
    END IF;
    NEW.solicitado_em := clock_timestamp();
    NEW.estorno_atualizado_em := NULL;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.protocolo, NEW.empresa_id, NEW.tipo, NEW.chave_idempotencia, NEW.solicitado_por, NEW.solicitado_em, NEW.motivo, NEW.ciclo,
         NEW.situacao_anterior, NEW.provedor_assinatura_id, NEW.regra, NEW.cobranca_provedor_id, NEW.forma_pagamento, NEW.valor_pago_centavos,
         NEW.inicio_ciclo, NEW.data_ativacao, NEW.dias_ciclo, NEW.dias_utilizados, NEW.valor_devolucao_centavos, NEW.prazo_processamento,
         NEW.periodo_fim_anterior, NEW.acesso_pago_encerrado_em)
     IS DISTINCT FROM ROW(OLD.id, OLD.protocolo, OLD.empresa_id, OLD.tipo, OLD.chave_idempotencia, OLD.solicitado_por, OLD.solicitado_em, OLD.motivo, OLD.ciclo,
         OLD.situacao_anterior, OLD.provedor_assinatura_id, OLD.regra, OLD.cobranca_provedor_id, OLD.forma_pagamento, OLD.valor_pago_centavos,
         OLD.inicio_ciclo, OLD.data_ativacao, OLD.dias_ciclo, OLD.dias_utilizados, OLD.valor_devolucao_centavos, OLD.prazo_processamento,
         OLD.periodo_fim_anterior, OLD.acesso_pago_encerrado_em) THEN
    RAISE EXCEPTION '089: protocolo, valores e cálculo são imutáveis.' USING ERRCODE = 'P0001';
  END IF;
  -- Cancelamento no provedor: só sai de PENDENTE/SEM_CONFIRMACAO/RECUSADO; resultado confirmado é final.
  IF NEW.cancelamento_provedor IS DISTINCT FROM OLD.cancelamento_provedor AND (
       OLD.cancelamento_provedor IN ('CONFIRMADO', 'AUSENTE', 'JA_REMOVIDA')
       OR (OLD.cancelamento_provedor = 'PENDENTE' AND NEW.cancelamento_provedor NOT IN ('CONFIRMADO', 'AUSENTE', 'SEM_CONFIRMACAO', 'RECUSADO'))
       OR (OLD.cancelamento_provedor IN ('SEM_CONFIRMACAO', 'RECUSADO') AND NEW.cancelamento_provedor NOT IN ('CONFIRMADO', 'AUSENTE'))) THEN
    RAISE EXCEPTION '089: transição do cancelamento no provedor inválida: % → %.', OLD.cancelamento_provedor, NEW.cancelamento_provedor USING ERRCODE = 'P0001';
  END IF;
  -- Estorno: EM_CURSO é o registro prévio da chamada automática; resultado desconhecido nunca volta a EM_CURSO
  -- (nenhuma segunda chamada automática); CONCLUIDO é final e exige referência (comprovante/id no painel do Asaas).
  -- EM_CURSO → CONCLUIDO cobre o processo interrompido durante a chamada, conferido e concluído à mão.
  IF NEW.estorno_situacao IS DISTINCT FROM OLD.estorno_situacao THEN
    IF NOT ((OLD.estorno_situacao, NEW.estorno_situacao) IN (
         ('AGUARDANDO_MANUAL', 'EM_CURSO'), ('AGUARDANDO_MANUAL', 'CONCLUIDO'),
         ('EM_CURSO', 'SOLICITADO'), ('EM_CURSO', 'SEM_CONFIRMACAO'), ('EM_CURSO', 'RECUSADO'), ('EM_CURSO', 'CONCLUIDO'),
         ('SOLICITADO', 'CONCLUIDO'), ('SEM_CONFIRMACAO', 'SOLICITADO'), ('SEM_CONFIRMACAO', 'CONCLUIDO'),
         ('RECUSADO', 'CONCLUIDO'))) THEN
      RAISE EXCEPTION '089: transição do estorno inválida: % → %.', OLD.estorno_situacao, NEW.estorno_situacao USING ERRCODE = 'P0001';
    END IF;
    IF NEW.estorno_situacao = 'EM_CURSO' AND NEW.estorno_modo IS DISTINCT FROM 'AUTOMATICO' THEN
      RAISE EXCEPTION '089: chamada automática exige estorno_modo AUTOMATICO.' USING ERRCODE = 'P0001';
    END IF;
    NEW.estorno_atualizado_em := clock_timestamp();
    IF NEW.estorno_situacao = 'CONCLUIDO' THEN
      NEW.estorno_concluido_em := clock_timestamp();
      NEW.estorno_modo := COALESCE(NEW.estorno_modo, 'MANUAL');
    END IF;
  ELSIF NEW.estorno_modo IS DISTINCT FROM OLD.estorno_modo OR NEW.estorno_concluido_em IS DISTINCT FROM OLD.estorno_concluido_em THEN
    RAISE EXCEPTION '089: modo e conclusão do estorno só mudam junto com a situação.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.estorno_situacao = 'CONCLUIDO' AND (NEW.estorno_referencia IS DISTINCT FROM OLD.estorno_referencia OR NEW.estorno_status_provedor IS DISTINCT FROM OLD.estorno_status_provedor) THEN
    RAISE EXCEPTION '089: estorno concluído é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.email_situacao IS DISTINCT FROM OLD.email_situacao AND NOT ((OLD.email_situacao, NEW.email_situacao) IN (
       ('PENDENTE', 'ENVIADO'), ('PENDENTE', 'FALHOU'), ('PENDENTE', 'NAO_CONFIGURADO'), ('FALHOU', 'ENVIADO'), ('NAO_CONFIGURADO', 'ENVIADO'))) THEN
    RAISE EXCEPTION '089: transição do e-mail inválida: % → %.', OLD.email_situacao, NEW.email_situacao USING ERRCODE = 'P0001';
  END IF;
  IF NEW.aviso_interno_situacao IS DISTINCT FROM OLD.aviso_interno_situacao AND NOT ((OLD.aviso_interno_situacao, NEW.aviso_interno_situacao) IN (
       ('PENDENTE', 'ENVIADO'), ('PENDENTE', 'FALHOU'), ('PENDENTE', 'NAO_CONFIGURADO'), ('FALHOU', 'ENVIADO'), ('NAO_CONFIGURADO', 'ENVIADO'))) THEN
    RAISE EXCEPTION '089: transição do aviso interno inválida: % → %.', OLD.aviso_interno_situacao, NEW.aviso_interno_situacao USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assinatura_encerramentos_089_guarda_trg BEFORE INSERT OR UPDATE OR DELETE ON assinatura_encerramentos
  FOR EACH ROW EXECUTE FUNCTION kidmais_089_encerramento_guarda();
CREATE TRIGGER assinatura_encerramentos_089_sem_truncate_trg BEFORE TRUNCATE ON assinatura_encerramentos
  FOR EACH STATEMENT EXECUTE FUNCTION kidmais_089_encerramento_guarda();

COMMENT ON TABLE assinatura_encerramentos IS '089: pedidos de cancelamento e devolução da assinatura, com protocolo (L1, 21/10/2026).';
COMMIT;
