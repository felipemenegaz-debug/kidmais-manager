-- Fatia A. Não altera a ocupação da agenda nem habilita buffets existentes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE pre_reserva_configuracoes (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id),
  habilitada boolean NOT NULL DEFAULT false,
  sinal_centavos integer NOT NULL DEFAULT 10000 CHECK (sinal_centavos BETWEEN 1000 AND 50000),
  versao integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  atualizado_por uuid NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (empresa_id, atualizado_por) REFERENCES memberships(empresa_id, usuario_id)
);

-- A referência composta impede associar o aceite a outro pedido, titular ou empresa.
CREATE UNIQUE INDEX pre_reserva_fechamento_titular ON fechamentos(empresa_id, id, cliente_id);
CREATE TABLE pre_reserva_aceites (
  empresa_id uuid NOT NULL,
  fechamento_id uuid NOT NULL,
  sequencia integer NOT NULL,
  cliente_id uuid NOT NULL,
  estabelecimento_id uuid,
  salao_id uuid,
  inicio_evento timestamptz NOT NULL,
  fim_evento timestamptz NOT NULL CHECK (fim_evento > inicio_evento),
  preco_aceito_centavos bigint NOT NULL,
  sinal_centavos integer NOT NULL CHECK (sinal_centavos BETWEEN 1000 AND 50000 AND sinal_centavos <= preco_aceito_centavos),
  -- Fotografia da referência do recebedor e dos termos, preservada após troca da chave Pix.
  recebedor text NOT NULL CHECK (btrim(recebedor) <> ''),
  chave_pix text NOT NULL CHECK (btrim(chave_pix) <> ''),
  termos_versao text NOT NULL CHECK (btrim(termos_versao) <> ''),
  termos_aceitos text NOT NULL CHECK (btrim(termos_aceitos) <> ''),
  aceito_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa_id, fechamento_id, sequencia),
  UNIQUE (empresa_id, fechamento_id, sequencia, sinal_centavos),
  FOREIGN KEY (empresa_id, fechamento_id, cliente_id) REFERENCES fechamentos(empresa_id, id, cliente_id),
  FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos(empresa_id, id),
  FOREIGN KEY (empresa_id, salao_id) REFERENCES agenda_saloes(empresa_id, id)
);

-- A fotografia é um aceite histórico. Um salão com unidade própria só pertence àquela unidade.
CREATE FUNCTION pre_reserva_validar_aceite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'O aceite da pré-reserva é histórico' USING ERRCODE='23514';
  END IF;
  -- O aceite e o recebimento serializam na mesma linha. As consultas seguintes
  -- precisam observar o commit do escritor anterior após a espera pela trava.
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Confirmação requer READ COMMITTED' USING ERRCODE='25000';
  END IF;
  PERFORM 1 FROM fechamentos WHERE empresa_id=NEW.empresa_id AND id=NEW.fechamento_id FOR UPDATE;
  IF EXISTS (SELECT FROM pre_reserva_recebimentos WHERE empresa_id=NEW.empresa_id
    AND fechamento_id=NEW.fechamento_id AND garantia_ate IS NOT NULL) THEN
    RAISE EXCEPTION 'Pedido já tem recebimento com garantia' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(max(sequencia),0)+1 INTO NEW.sequencia FROM pre_reserva_aceites
    WHERE empresa_id=NEW.empresa_id AND fechamento_id=NEW.fechamento_id;
  IF NEW.salao_id IS NOT NULL AND EXISTS (
    SELECT FROM agenda_saloes WHERE id=NEW.salao_id AND empresa_id=NEW.empresa_id
      AND estabelecimento_id IS NOT NULL AND estabelecimento_id IS DISTINCT FROM NEW.estabelecimento_id
  ) THEN RAISE EXCEPTION 'Salão de outra unidade' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pre_reserva_aceite_historico BEFORE INSERT OR UPDATE OR DELETE ON pre_reserva_aceites
FOR EACH ROW EXECUTE FUNCTION pre_reserva_validar_aceite();

CREATE UNIQUE INDEX pre_reserva_contrato_pedido ON contratos(fechamento_id, id);
CREATE TABLE pre_reserva_recebimentos (
  empresa_id uuid NOT NULL,
  fechamento_id uuid NOT NULL,
  end_to_end_id text COLLATE "C" NOT NULL CHECK (end_to_end_id ~ '^E[0-9]{20}[A-Za-z0-9]{11}$'),
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  confirmado_por uuid NOT NULL,
  confirmado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- NULL para Pix duplicado, divergente ou sem vaga. Só a confirmação com vaga referencia o valor aceito.
  aceite_sequencia integer NOT NULL,
  garantia_ate timestamptz,
  sinal_garantido_centavos integer,
  encerramento text CHECK (encerramento IN ('DESISTENCIA','RECUSA','FORMALIZACAO','FORMALIZACAO_SEM_CREDITO')),
  encerrado_em timestamptz,
  contrato_id uuid,
  credito_revertido_em timestamptz,
  credito_reversao_motivo text CHECK (credito_reversao_motivo IN ('CANCELAMENTO_FESTA_SEM_BAIXA','ADITIVO_ABAIXO_DO_CREDITO')),
  devolucao_assumida_por uuid,
  devolucao_assumida_em timestamptz,
  devolvido_em timestamptz,
  devolvido_por uuid,
  referencia_devolucao text CHECK (btrim(referencia_devolucao) <> ''),
  PRIMARY KEY (empresa_id, end_to_end_id),
  FOREIGN KEY (empresa_id, fechamento_id, aceite_sequencia) REFERENCES pre_reserva_aceites(empresa_id, fechamento_id, sequencia),
  FOREIGN KEY (empresa_id, fechamento_id, aceite_sequencia, sinal_garantido_centavos) REFERENCES pre_reserva_aceites(empresa_id, fechamento_id, sequencia, sinal_centavos),
  FOREIGN KEY (empresa_id, confirmado_por) REFERENCES memberships(empresa_id, usuario_id),
  FOREIGN KEY (empresa_id, devolucao_assumida_por) REFERENCES memberships(empresa_id, usuario_id),
  CONSTRAINT pre_reserva_devolvido_por_fk FOREIGN KEY (empresa_id, devolvido_por) REFERENCES memberships(empresa_id, usuario_id),
  FOREIGN KEY (fechamento_id, contrato_id) REFERENCES contratos(fechamento_id, id),
  CHECK ((garantia_ate IS NULL) = (sinal_garantido_centavos IS NULL)),
  CHECK (garantia_ate > confirmado_em),
  CHECK (sinal_garantido_centavos IS NULL OR sinal_garantido_centavos = valor_centavos),
  CHECK ((encerramento IS NULL) = (encerrado_em IS NULL)),
  CHECK (encerramento IS NULL OR (sinal_garantido_centavos IS NOT NULL AND encerrado_em >= confirmado_em)),
  CHECK ((contrato_id IS NOT NULL) = (encerramento IS NOT DISTINCT FROM 'FORMALIZACAO')),
  CHECK (contrato_id IS NULL OR devolucao_assumida_em IS NULL OR
    (credito_revertido_em IS NOT NULL AND devolucao_assumida_em >= credito_revertido_em)),
  CONSTRAINT pre_reserva_reversao_formalizada CHECK (
    ((credito_revertido_em IS NULL) = (credito_reversao_motivo IS NULL)) AND
    (credito_revertido_em IS NULL OR (contrato_id IS NOT NULL AND credito_revertido_em >= encerrado_em))),
  CHECK ((devolucao_assumida_por IS NULL) = (devolucao_assumida_em IS NULL)),
  CHECK (devolucao_assumida_em IS NULL OR (devolucao_assumida_em >= confirmado_em AND
    (sinal_garantido_centavos IS NULL OR encerrado_em <= devolucao_assumida_em OR
     devolucao_assumida_em >= garantia_ate) IS TRUE)),
  CHECK (((devolvido_em IS NULL) = (referencia_devolucao IS NULL)) AND
    ((devolvido_em IS NULL) = (devolvido_por IS NULL))),
  CHECK (devolvido_em IS NULL OR (devolucao_assumida_em IS NOT NULL AND devolvido_em >= devolucao_assumida_em)),
  UNIQUE (empresa_id, referencia_devolucao)
);
CREATE UNIQUE INDEX pre_reserva_um_sinal_por_pedido ON pre_reserva_recebimentos(empresa_id, fechamento_id)
  WHERE sinal_garantido_centavos IS NOT NULL;
CREATE INDEX pre_reserva_pendencias_por_empresa ON pre_reserva_recebimentos(empresa_id, confirmado_em)
  WHERE devolvido_em IS NULL AND (contrato_id IS NULL OR credito_revertido_em IS NOT NULL);

-- Um movimento do extrato não pode ser reapontado ou apagado para reutilizar a referência.
CREATE FUNCTION pre_reserva_preservar_movimento() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  valor_final jsonb;
  total_reais numeric;
BEGIN
  IF TG_OP='INSERT' THEN
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
      RAISE EXCEPTION 'Confirmação requer READ COMMITTED' USING ERRCODE='25000';
    END IF;
    PERFORM 1 FROM fechamentos WHERE empresa_id=NEW.empresa_id AND id=NEW.fechamento_id FOR UPDATE;
    IF NEW.credito_revertido_em IS NOT NULL OR NEW.credito_reversao_motivo IS NOT NULL THEN
      RAISE EXCEPTION 'Reversão exige formalização anterior' USING ERRCODE='23514';
    END IF;
    IF NEW.devolvido_em IS NOT NULL OR NEW.devolvido_por IS NOT NULL OR NEW.referencia_devolucao IS NOT NULL THEN
      RAISE EXCEPTION 'Baixa exige recebimento anterior' USING ERRCODE='23514';
    END IF;
    SELECT max(sequencia) INTO NEW.aceite_sequencia FROM pre_reserva_aceites
      WHERE empresa_id=NEW.empresa_id AND fechamento_id=NEW.fechamento_id;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recebimento histórico' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.empresa_id,NEW.fechamento_id,NEW.end_to_end_id,NEW.valor_centavos,NEW.confirmado_por,NEW.confirmado_em,NEW.sinal_garantido_centavos,NEW.garantia_ate,NEW.aceite_sequencia)
     IS DISTINCT FROM ROW(OLD.empresa_id,OLD.fechamento_id,OLD.end_to_end_id,OLD.valor_centavos,OLD.confirmado_por,OLD.confirmado_em,OLD.sinal_garantido_centavos,OLD.garantia_ate,OLD.aceite_sequencia)
     OR (OLD.encerramento IS NOT NULL AND ROW(NEW.encerramento,NEW.encerrado_em,NEW.contrato_id) IS DISTINCT FROM ROW(OLD.encerramento,OLD.encerrado_em,OLD.contrato_id))
     OR (OLD.credito_revertido_em IS NOT NULL AND ROW(NEW.credito_revertido_em,NEW.credito_reversao_motivo) IS DISTINCT FROM ROW(OLD.credito_revertido_em,OLD.credito_reversao_motivo))
     OR (OLD.devolucao_assumida_em IS NOT NULL AND ROW(NEW.devolucao_assumida_por,NEW.devolucao_assumida_em) IS DISTINCT FROM ROW(OLD.devolucao_assumida_por,OLD.devolucao_assumida_em))
     OR (OLD.devolvido_em IS NOT NULL AND ROW(NEW.devolvido_em,NEW.referencia_devolucao,NEW.devolvido_por) IS DISTINCT FROM ROW(OLD.devolvido_em,OLD.referencia_devolucao,OLD.devolvido_por))
  THEN RAISE EXCEPTION 'O lançamento e as baixas confirmadas são históricos' USING ERRCODE='23514'; END IF;
  IF NEW.credito_revertido_em IS NOT NULL AND OLD.credito_revertido_em IS NULL THEN
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
      RAISE EXCEPTION 'Reversão requer READ COMMITTED' USING ERRCODE='25000';
    END IF;
    -- A promoção de vigência, o plano e o cancelamento também travam esta linha.
    PERFORM 1 FROM public.contratos WHERE id=OLD.contrato_id FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT FROM pagamento_recebimentos r JOIN pagamentos p ON p.id=r.pagamento_id
      JOIN contrato_versoes v ON v.id=p.contrato_versao_id
      WHERE v.contrato_id=OLD.contrato_id AND r.chave_idempotencia='PRE_RESERVA:' || OLD.contrato_id::text
    ) THEN RAISE EXCEPTION 'Crédito indisponível para reversão' USING ERRCODE='23514'; END IF;
    IF NEW.credito_reversao_motivo='CANCELAMENTO_FESTA_SEM_BAIXA' THEN
      IF NOT EXISTS (SELECT FROM public.contratos c WHERE c.id=OLD.contrato_id
        AND c.status='CANCELADO' AND c.cancelado_em=NEW.credito_revertido_em) THEN
        RAISE EXCEPTION 'Reversão exige cancelamento da Festa' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.credito_reversao_motivo='ADITIVO_ABAIXO_DO_CREDITO' THEN
      SELECT v.snapshot #> '{comercial,valorFinalContrato}' INTO valor_final
      FROM public.contratos c JOIN public.contrato_fluxos f ON f.contrato_id=c.id
      JOIN public.contrato_versoes v ON v.id=f.versao_vigente_id AND v.contrato_id=c.id
      WHERE c.id=OLD.contrato_id AND c.status='ASSINADO' AND v.status='ASSINADA'
        AND v.assinado_em IS NOT NULL AND v.numero_versao=c.versao_atual
        AND v.numero_versao>1 AND f.versao_em_preparacao_id IS DISTINCT FROM v.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reversão exige aditivo assinado e vigente' USING ERRCODE='23514';
      END IF;
      IF jsonb_typeof(valor_final) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Valor final ausente ou inválido no snapshot do aditivo vigente' USING ERRCODE='23514';
      END IF;
      total_reais := valor_final::numeric;
      IF total_reais NOT BETWEEN 0.01 AND 9999999999.99 OR trunc(total_reais,2) <> total_reais THEN
        RAISE EXCEPTION 'Valor final ausente ou inválido no snapshot do aditivo vigente' USING ERRCODE='23514';
      END IF;
      IF total_reais * 100 >= OLD.valor_centavos THEN
        RAISE EXCEPTION 'Valor do aditivo vigente não é inferior ao crédito' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Motivo da reversão inválido' USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD.devolvido_em IS NULL AND NEW.devolvido_em IS NOT NULL AND
     (OLD.devolucao_assumida_em IS NULL OR NEW.devolvido_em < OLD.devolucao_assumida_em OR NEW.devolvido_em > clock_timestamp()) THEN
    RAISE EXCEPTION 'Baixa exige assunção anterior e instante válido' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pre_reserva_movimento_historico BEFORE INSERT OR UPDATE OR DELETE ON pre_reserva_recebimentos
FOR EACH ROW EXECUTE FUNCTION pre_reserva_preservar_movimento();

-- Cada linha representa uma transferência integral. O valor aplicado ou devolvido é valor_centavos.
-- A mesma transação pode ler a visão sem materializar a expiração e sem alterar o fechamento.
CREATE VIEW pre_reserva_situacoes WITH (security_invoker = true) AS
SELECT empresa_id, fechamento_id, end_to_end_id, valor_centavos,
  garantia_ate,
  CASE WHEN sinal_garantido_centavos IS NULL THEN 'SEM_GARANTIA'
       WHEN encerramento IS NOT NULL THEN encerramento
       WHEN garantia_ate <= statement_timestamp() THEN 'EXPIRADA'
       ELSE 'ATIVA' END AS garantia,
  CASE WHEN credito_revertido_em IS NOT NULL THEN credito_revertido_em
       WHEN contrato_id IS NOT NULL THEN NULL
       WHEN sinal_garantido_centavos IS NULL THEN confirmado_em
       WHEN encerrado_em IS NOT NULL OR garantia_ate <= statement_timestamp()
         THEN least(encerrado_em, garantia_ate) END AS devolver_desde,
  CASE WHEN contrato_id IS NOT NULL AND credito_revertido_em IS NULL THEN 'CREDITO_CONTRATO'
       WHEN devolvido_em IS NOT NULL THEN 'DEVOLVIDO'
       WHEN devolucao_assumida_em IS NOT NULL THEN 'EM_DEVOLUCAO'
       WHEN sinal_garantido_centavos IS NULL OR encerramento IS NOT NULL
         OR garantia_ate <= statement_timestamp() THEN 'A_DEVOLVER'
       ELSE 'EM_GARANTIA' END AS dinheiro,
  credito_reversao_motivo, devolvido_por
FROM pre_reserva_recebimentos;
COMMIT;
