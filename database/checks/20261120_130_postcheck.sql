DO $$
DECLARE
  divergente record;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  -- Definições canônicas do PG18. Uma peça ausente, desativada ou alterada deve reprovar.
  WITH esperado(tabela,nome,definicao) AS (VALUES
      ('contratos', 'pre_reserva_contrato_pedido', 'CREATE UNIQUE INDEX pre_reserva_contrato_pedido ON public.contratos USING btree (fechamento_id, id)'),
      ('fechamentos', 'pre_reserva_fechamento_titular', 'CREATE UNIQUE INDEX pre_reserva_fechamento_titular ON public.fechamentos USING btree (empresa_id, id, cliente_id)'),
      ('pre_reserva_aceites', 'pre_reserva_aceite_historico', 'CREATE TRIGGER pre_reserva_aceite_historico BEFORE INSERT OR DELETE OR UPDATE ON public.pre_reserva_aceites FOR EACH ROW EXECUTE FUNCTION pre_reserva_validar_aceite()'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_chave_pix_check', 'CHECK ((btrim(chave_pix) <> ''''::text))'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_check', 'CHECK ((fim_evento > inicio_evento))'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_check1', 'CHECK ((((sinal_centavos >= 1000) AND (sinal_centavos <= 50000)) AND (sinal_centavos <= preco_aceito_centavos)))'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_empresa_id_estabelecimento_id_fkey', 'FOREIGN KEY (empresa_id, estabelecimento_id) REFERENCES estabelecimentos(empresa_id, id)'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_empresa_id_fechamento_id_cliente_id_fkey', 'FOREIGN KEY (empresa_id, fechamento_id, cliente_id) REFERENCES fechamentos(empresa_id, id, cliente_id)'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_empresa_id_fechamento_id_sequencia_sina_key', 'UNIQUE (empresa_id, fechamento_id, sequencia, sinal_centavos)'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_empresa_id_salao_id_fkey', 'FOREIGN KEY (empresa_id, salao_id) REFERENCES agenda_saloes(empresa_id, id)'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_pkey', 'PRIMARY KEY (empresa_id, fechamento_id, sequencia)'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_recebedor_check', 'CHECK ((btrim(recebedor) <> ''''::text))'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_termos_aceitos_check', 'CHECK ((btrim(termos_aceitos) <> ''''::text))'),
      ('pre_reserva_aceites', 'pre_reserva_aceites_termos_versao_check', 'CHECK ((btrim(termos_versao) <> ''''::text))'),
      ('pre_reserva_configuracoes', 'pre_reserva_configuracoes_empresa_id_atualizado_por_fkey', 'FOREIGN KEY (empresa_id, atualizado_por) REFERENCES memberships(empresa_id, usuario_id)'),
      ('pre_reserva_configuracoes', 'pre_reserva_configuracoes_empresa_id_fkey', 'FOREIGN KEY (empresa_id) REFERENCES empresas(id)'),
      ('pre_reserva_configuracoes', 'pre_reserva_configuracoes_pkey', 'PRIMARY KEY (empresa_id)'),
      ('pre_reserva_configuracoes', 'pre_reserva_configuracoes_sinal_centavos_check', 'CHECK (((sinal_centavos >= 1000) AND (sinal_centavos <= 50000)))'),
      ('pre_reserva_configuracoes', 'pre_reserva_configuracoes_versao_check', 'CHECK ((versao > 0))'),
      ('pre_reserva_recebimentos', 'pre_reserva_movimento_historico', 'CREATE TRIGGER pre_reserva_movimento_historico BEFORE INSERT OR DELETE OR UPDATE ON public.pre_reserva_recebimentos FOR EACH ROW EXECUTE FUNCTION pre_reserva_preservar_movimento()'),
      ('pre_reserva_recebimentos', 'pre_reserva_pendencias_por_empresa', 'CREATE INDEX pre_reserva_pendencias_por_empresa ON public.pre_reserva_recebimentos USING btree (empresa_id, confirmado_em) WHERE ((devolvido_em IS NULL) AND (contrato_id IS NULL))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check', 'CHECK (((garantia_ate IS NULL) = (sinal_garantido_centavos IS NULL)))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check1', 'CHECK ((garantia_ate > confirmado_em))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check10', 'CHECK (((devolvido_em IS NULL) OR ((devolucao_assumida_em IS NOT NULL) AND (devolvido_em >= devolucao_assumida_em))))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check2', 'CHECK (((sinal_garantido_centavos IS NULL) OR (sinal_garantido_centavos = valor_centavos)))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check3', 'CHECK (((encerramento IS NULL) = (encerrado_em IS NULL)))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check4', 'CHECK (((encerramento IS NULL) OR ((sinal_garantido_centavos IS NOT NULL) AND (encerrado_em >= confirmado_em))))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check5', 'CHECK (((contrato_id IS NOT NULL) = (NOT (encerramento IS DISTINCT FROM ''FORMALIZACAO''::text))))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check6', 'CHECK (((contrato_id IS NULL) OR ((encerrado_em < garantia_ate) AND (devolucao_assumida_em IS NULL))))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check7', 'CHECK (((devolucao_assumida_por IS NULL) = (devolucao_assumida_em IS NULL)))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check8', 'CHECK (((devolucao_assumida_em IS NULL) OR ((devolucao_assumida_em >= confirmado_em) AND (((sinal_garantido_centavos IS NULL) OR (encerrado_em <= devolucao_assumida_em) OR (devolucao_assumida_em >= garantia_ate)) IS TRUE))))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_check9', 'CHECK (((devolvido_em IS NULL) = (referencia_devolucao IS NULL)))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_empresa_id_confirmado_por_fkey', 'FOREIGN KEY (empresa_id, confirmado_por) REFERENCES memberships(empresa_id, usuario_id)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_empresa_id_devolucao_assumida_por_fkey', 'FOREIGN KEY (empresa_id, devolucao_assumida_por) REFERENCES memberships(empresa_id, usuario_id)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_empresa_id_fechamento_id_aceite__fkey1', 'FOREIGN KEY (empresa_id, fechamento_id, aceite_sequencia, sinal_garantido_centavos) REFERENCES pre_reserva_aceites(empresa_id, fechamento_id, sequencia, sinal_centavos)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_empresa_id_fechamento_id_aceite_s_fkey', 'FOREIGN KEY (empresa_id, fechamento_id, aceite_sequencia) REFERENCES pre_reserva_aceites(empresa_id, fechamento_id, sequencia)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_empresa_id_referencia_devolucao_key', 'UNIQUE (empresa_id, referencia_devolucao)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_encerramento_check', 'CHECK ((encerramento = ANY (ARRAY[''DESISTENCIA''::text, ''RECUSA''::text, ''FORMALIZACAO''::text])))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_end_to_end_id_check', 'CHECK ((end_to_end_id ~ ''^E[0-9]{20}[A-Za-z0-9]{11}$''::text))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_fechamento_id_contrato_id_fkey', 'FOREIGN KEY (fechamento_id, contrato_id) REFERENCES contratos(fechamento_id, id)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_pkey', 'PRIMARY KEY (empresa_id, end_to_end_id)'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_referencia_devolucao_check', 'CHECK ((btrim(referencia_devolucao) <> ''''::text))'),
      ('pre_reserva_recebimentos', 'pre_reserva_recebimentos_valor_centavos_check', 'CHECK ((valor_centavos > 0))'),
      ('pre_reserva_recebimentos', 'pre_reserva_um_sinal_por_pedido', 'CREATE UNIQUE INDEX pre_reserva_um_sinal_por_pedido ON public.pre_reserva_recebimentos USING btree (empresa_id, fechamento_id) WHERE (sinal_garantido_centavos IS NOT NULL)'),
      ('pre_reserva_situacoes', 'pre_reserva_situacoes', ' SELECT empresa_id,
    fechamento_id,
    end_to_end_id,
    valor_centavos,
    garantia_ate,
        CASE
            WHEN sinal_garantido_centavos IS NULL THEN ''SEM_GARANTIA''::text
            WHEN encerramento IS NOT NULL THEN encerramento
            WHEN garantia_ate <= statement_timestamp() THEN ''EXPIRADA''::text
            ELSE ''ATIVA''::text
        END AS garantia,
        CASE
            WHEN contrato_id IS NOT NULL THEN NULL::timestamp with time zone
            WHEN sinal_garantido_centavos IS NULL THEN confirmado_em
            WHEN encerrado_em IS NOT NULL OR garantia_ate <= statement_timestamp() THEN LEAST(encerrado_em, garantia_ate)
            ELSE NULL::timestamp with time zone
        END AS devolver_desde,
        CASE
            WHEN contrato_id IS NOT NULL THEN ''CREDITO_CONTRATO''::text
            WHEN devolvido_em IS NOT NULL THEN ''DEVOLVIDO''::text
            WHEN devolucao_assumida_em IS NOT NULL THEN ''EM_DEVOLUCAO''::text
            WHEN sinal_garantido_centavos IS NULL OR encerramento IS NOT NULL OR garantia_ate <= statement_timestamp() THEN ''A_DEVOLVER''::text
            ELSE ''EM_GARANTIA''::text
        END AS dinheiro
   FROM pre_reserva_recebimentos;')
  ), instalado AS (
SELECT c.relname AS tabela, k.conname AS nome, pg_get_constraintdef(k.oid) AS definicao
FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('pre_reserva_configuracoes','pre_reserva_aceites','pre_reserva_recebimentos')
  AND k.contype IN ('c','f','p','u') AND k.convalidated
UNION ALL
SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('pre_reserva_aceites','pre_reserva_recebimentos')
  AND NOT t.tgisinternal AND t.tgenabled='O'
UNION ALL
SELECT c.relname,i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid)
FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
WHERE i.indexrelid IN (to_regclass('public.pre_reserva_um_sinal_por_pedido'),to_regclass('public.pre_reserva_pendencias_por_empresa'),
  to_regclass('public.pre_reserva_fechamento_titular'),to_regclass('public.pre_reserva_contrato_pedido'))
  AND i.indisvalid AND i.indisready
UNION ALL
SELECT 'pre_reserva_situacoes','pre_reserva_situacoes',pg_get_viewdef(c.oid,true)
FROM pg_class c WHERE c.oid=to_regclass('public.pre_reserva_situacoes') AND c.relkind='v' AND 'security_invoker=true'=ANY(c.reloptions)
  )
  SELECT e.tabela,e.nome INTO divergente FROM esperado e LEFT JOIN instalado i ON i.tabela=e.tabela AND i.nome=e.nome AND i.definicao=replace(e.definicao,chr(13),'')
    WHERE i.nome IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '130: peça ausente ou divergente %.%', divergente.tabela,divergente.nome; END IF;
  IF EXISTS (SELECT FROM public.pre_reserva_configuracoes WHERE habilitada) THEN
    RAISE EXCEPTION '130: empresa habilitada na instalação';
  END IF;
END $$;
SELECT true AS aprovado;
