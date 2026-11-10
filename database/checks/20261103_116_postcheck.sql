-- 116 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere, contra literais exatos:
--   * colunas (tipo, NOT NULL e default) das duas tabelas novas — o NOT NULL fica aqui, pelo pg_attribute (o PG 18 também o
--     registra em pg_constraint como contype 'n', que por isso fica fora do mapa de constraints);
--   * constraints pela DEFINIÇÃO (pg_get_constraintdef: colunas de PK/UNIQUE/FK, alvo da FK, expressão do CHECK; a própria
--     definição termina em "NOT VALID" quando a constraint não foi validada);
--   * índices (pg_get_indexdef), gatilho (pg_get_triggerdef: BEFORE UPDATE OR DELETE, FOR EACH ROW), ligado, e a função dele;
--   * CHECK de tipo das notificações;
--   * dados: ia_credito_franquias_ciclo VAZIA (só o worker com a flag ligada grava, e a flag continua desligada); pendências
--     só as LEGÍTIMAS (revisão r1, P2-4: a sincronização pode registrar uma logo depois do COMMIT da 116) — não processadas,
--     sem tentativa nem motivo, de contratação CONFIRMADA da mesma empresa.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  c jsonb := '{}'::jsonb;
  t jsonb;
  tabela text;
  esperado jsonb := $j${
    "ia_credito_franquia_pendencias": {
      "colunas": {
        "contratacao_id": "uuid NOT NULL",
        "criada_em": "timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
        "empresa_id": "uuid NOT NULL",
        "processada_em": "timestamp with time zone",
        "tentativas": "integer NOT NULL DEFAULT 0",
        "ultimo_motivo": "text"
      },
      "constraints": {
        "ia_credito_franquia_pendencias_contratacao_fk": "FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id)",
        "ia_credito_franquia_pendencias_motivo_check": "CHECK (((ultimo_motivo IS NULL) OR (ultimo_motivo ~ '^[A-Z_]{1,60}$'::text)))",
        "ia_credito_franquia_pendencias_pk": "PRIMARY KEY (empresa_id, contratacao_id)",
        "ia_credito_franquia_pendencias_tentativas_check": "CHECK (((tentativas >= 0) AND (tentativas <= 1000)))"
      },
      "gatilhos": {},
      "indices": {
        "ia_credito_franquia_pendencias_abertas_idx": "CREATE INDEX ia_credito_franquia_pendencias_abertas_idx ON public.ia_credito_franquia_pendencias USING btree (criada_em) WHERE (processada_em IS NULL)",
        "ia_credito_franquia_pendencias_pk": "CREATE UNIQUE INDEX ia_credito_franquia_pendencias_pk ON public.ia_credito_franquia_pendencias USING btree (empresa_id, contratacao_id)"
      }
    },
    "ia_credito_franquias_ciclo": {
      "colunas": {
        "chave": "text NOT NULL",
        "ciclo": "date NOT NULL",
        "concedido": "bigint NOT NULL",
        "contratacao_id": "uuid",
        "criado_em": "timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
        "devido_calculado": "bigint",
        "empresa_id": "uuid NOT NULL",
        "historico": "jsonb NOT NULL DEFAULT '[]'::jsonb",
        "id": "uuid NOT NULL DEFAULT gen_random_uuid()",
        "lote_id": "uuid NOT NULL",
        "recurso": "text NOT NULL",
        "tipo": "text NOT NULL",
        "versao_tabela": "text"
      },
      "constraints": {
        "ia_credito_franquias_ciclo_carteira_fk": "FOREIGN KEY (empresa_id, recurso) REFERENCES ia_credito_carteiras(empresa_id, recurso)",
        "ia_credito_franquias_ciclo_chave_check": "CHECK ((chave ~ '^FRANQUIA:[0-9]{4}-[0-9]{2}(:R[0-9]{1,4})?$'::text))",
        "ia_credito_franquias_ciclo_chave_uk": "UNIQUE (empresa_id, recurso, ciclo, chave)",
        "ia_credito_franquias_ciclo_ciclo_check": "CHECK ((ciclo = (date_trunc('month'::text, (ciclo)::timestamp with time zone))::date))",
        "ia_credito_franquias_ciclo_contratacao_fk": "FOREIGN KEY (empresa_id, contratacao_id) REFERENCES assinatura_contratacoes(empresa_id, id)",
        "ia_credito_franquias_ciclo_historico_check": "CHECK ((jsonb_typeof(historico) = 'array'::text))",
        "ia_credito_franquias_ciclo_lote_fk": "FOREIGN KEY (lote_id, empresa_id, recurso) REFERENCES ia_credito_lotes(id, empresa_id, recurso)",
        "ia_credito_franquias_ciclo_lote_uk": "UNIQUE (lote_id)",
        "ia_credito_franquias_ciclo_pkey": "PRIMARY KEY (id)",
        "ia_credito_franquias_ciclo_reconhecimento_check": "CHECK (((tipo = 'ADOCAO'::text) OR ((devido_calculado IS NOT NULL) AND (contratacao_id IS NOT NULL) AND (versao_tabela IS NOT NULL) AND ((char_length(btrim(versao_tabela)) >= 1) AND (char_length(btrim(versao_tabela)) <= 40)))))",
        "ia_credito_franquias_ciclo_tipo_check": "CHECK ((tipo = ANY (ARRAY['ADOCAO'::text, 'RECONHECIMENTO'::text])))",
        "ia_credito_franquias_ciclo_valores_check": "CHECK (((concedido > 0) AND ((devido_calculado IS NULL) OR (devido_calculado >= 0))))"
      },
      "gatilhos": {
        "ia_credito_franquias_ciclo_116_somente_insercao": "CREATE TRIGGER ia_credito_franquias_ciclo_116_somente_insercao BEFORE DELETE OR UPDATE ON public.ia_credito_franquias_ciclo FOR EACH ROW EXECUTE FUNCTION kidmais_116_somente_insercao() [O]"
      },
      "indices": {
        "ia_credito_franquias_ciclo_chave_uk": "CREATE UNIQUE INDEX ia_credito_franquias_ciclo_chave_uk ON public.ia_credito_franquias_ciclo USING btree (empresa_id, recurso, ciclo, chave)",
        "ia_credito_franquias_ciclo_empresa_idx": "CREATE INDEX ia_credito_franquias_ciclo_empresa_idx ON public.ia_credito_franquias_ciclo USING btree (empresa_id, recurso, ciclo)",
        "ia_credito_franquias_ciclo_lote_uk": "CREATE UNIQUE INDEX ia_credito_franquias_ciclo_lote_uk ON public.ia_credito_franquias_ciclo USING btree (lote_id)",
        "ia_credito_franquias_ciclo_pkey": "CREATE UNIQUE INDEX ia_credito_franquias_ciclo_pkey ON public.ia_credito_franquias_ciclo USING btree (id)"
      }
    }
  }$j$::jsonb;
BEGIN
  IF to_regclass('public.ia_credito_franquias_ciclo') IS NULL OR to_regclass('public.ia_credito_franquia_pendencias') IS NULL
    THEN RAISE EXCEPTION '116 postcheck: tabelas ausentes'; END IF;
  FOREACH tabela IN ARRAY ARRAY['ia_credito_franquias_ciclo', 'ia_credito_franquia_pendencias'] LOOP
    SELECT jsonb_build_object(
      'colunas', (SELECT jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                    || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), ''))
                  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = to_regclass('public.' || tabela) AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_object_agg(conname, pg_get_constraintdef(oid))
                      FROM pg_constraint WHERE conrelid = to_regclass('public.' || tabela) AND contype <> 'n'),
      'indices', (SELECT jsonb_object_agg(indexrelid::regclass::text, pg_get_indexdef(indexrelid))
                  FROM pg_index WHERE indrelid = to_regclass('public.' || tabela)),
      'gatilhos', COALESCE((SELECT jsonb_object_agg(tgname, pg_get_triggerdef(oid) || ' [' || tgenabled::text || ']')
                  FROM pg_trigger WHERE tgrelid = to_regclass('public.' || tabela) AND NOT tgisinternal), '{}'::jsonb))
    INTO t;
    c := c || jsonb_build_object(tabela, t);
  END LOOP;
  IF c IS DISTINCT FROM esperado
    THEN RAISE EXCEPTION '116 postcheck: definição das tabelas novas divergente: %', c; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.kidmais_116_somente_insercao()')) IS DISTINCT FROM
     E'\nBEGIN\n  RAISE EXCEPTION ''ia_credito_franquias_ciclo é só inserção (116).'';\nEND;\n'
    THEN RAISE EXCEPTION '116 postcheck: função do gatilho de só inserção divergente'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.ia_credito_notificacoes'::regclass AND conname = 'ia_credito_notificacoes_tipo_check') IS DISTINCT FROM
     'CHECK ((tipo = ANY (ARRAY[''PAGAMENTO_CONFIRMADO''::text, ''DEVOLUCAO_REGISTRADA''::text, ''AVISO_INTERNO_DEVOLUCAO''::text, ''LOTE_VENCENDO_30''::text, ''LOTE_VENCENDO_7''::text, ''FRANQUIA_80''::text, ''FRANQUIA_100''::text])))'
    THEN RAISE EXCEPTION '116 postcheck: CHECK de tipo das notificações divergente'; END IF;
  IF EXISTS (SELECT 1 FROM ia_credito_franquias_ciclo)
    THEN RAISE EXCEPTION '116 postcheck: ia_credito_franquias_ciclo deveria estar vazia (flag desligada)'; END IF;
  IF EXISTS (SELECT 1 FROM ia_credito_franquia_pendencias p
             WHERE p.processada_em IS NOT NULL OR p.tentativas <> 0 OR p.ultimo_motivo IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM assinatura_contratacoes h WHERE h.empresa_id = p.empresa_id AND h.id = p.contratacao_id AND h.estado = 'CONFIRMADA'))
    THEN RAISE EXCEPTION '116 postcheck: pendência de franquia não legítima (processada, com tentativa/motivo ou de contratação não confirmada)'; END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM ia_credito_franquia_pendencias) AS pendencias_legitimas;
ROLLBACK;
