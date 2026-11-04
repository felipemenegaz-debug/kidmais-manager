-- 117 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere, contra literais exatos: colunas (tipo, NOT NULL e
-- default), constraints pela definição (pg_get_constraintdef), índices (pg_get_indexdef) das duas tabelas novas e o índice
-- de busca por identificador; e que as tabelas nascem VAZIAS (só a reserva do worker e o callback, com a chave
-- WHATSAPP_ATENDIMENTO_MULTIEMPRESA, gravam nelas; a marca de colisão também pode ser gravada no PILOTO — vazia aqui porque
-- o postcheck roda logo depois da aplicação).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  c jsonb := '{}'::jsonb;
  t jsonb;
  tabela text;
  esperado jsonb := $j${
    "whatsapp_atendimento_rodizio": {
      "colunas": {
        "ambiente": "text NOT NULL",
        "atualizado_em": "timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
        "empresa_id": "uuid NOT NULL",
        "ordem": "bigint NOT NULL"
      },
      "constraints": {
        "whatsapp_atendimento_rodizio_ambiente_check": "CHECK ((ambiente = ANY (ARRAY['staging'::text, 'production'::text])))",
        "whatsapp_atendimento_rodizio_empresa_id_fkey": "FOREIGN KEY (empresa_id) REFERENCES empresas(id)",
        "whatsapp_atendimento_rodizio_ordem_check": "CHECK ((ordem > 0))",
        "whatsapp_atendimento_rodizio_pkey": "PRIMARY KEY (empresa_id, ambiente)"
      },
      "indices": {
        "whatsapp_atendimento_rodizio_ordem_uq": "CREATE UNIQUE INDEX whatsapp_atendimento_rodizio_ordem_uq ON public.whatsapp_atendimento_rodizio USING btree (ambiente, ordem)",
        "whatsapp_atendimento_rodizio_pkey": "CREATE UNIQUE INDEX whatsapp_atendimento_rodizio_pkey ON public.whatsapp_atendimento_rodizio USING btree (empresa_id, ambiente)"
      }
    },
    "whatsapp_atendimento_status_colisoes": {
      "colunas": {
        "ambiente": "text NOT NULL",
        "detectada_em": "timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
        "provedor_id": "text NOT NULL"
      },
      "constraints": {
        "whatsapp_atendimento_status_colisoes_ambiente_check": "CHECK ((ambiente = ANY (ARRAY['staging'::text, 'production'::text])))",
        "whatsapp_atendimento_status_colisoes_pkey": "PRIMARY KEY (ambiente, provedor_id)",
        "whatsapp_atendimento_status_colisoes_provedor_check": "CHECK (((length(provedor_id) >= 1) AND (length(provedor_id) <= 512)))"
      },
      "indices": {
        "whatsapp_atendimento_status_colisoes_pkey": "CREATE UNIQUE INDEX whatsapp_atendimento_status_colisoes_pkey ON public.whatsapp_atendimento_status_colisoes USING btree (ambiente, provedor_id)",
        "whatsapp_atendimento_status_colisoes_retencao_idx": "CREATE INDEX whatsapp_atendimento_status_colisoes_retencao_idx ON public.whatsapp_atendimento_status_colisoes USING btree (detectada_em)"
      }
    }
  }$j$::jsonb;
BEGIN
  FOR tabela IN SELECT jsonb_object_keys(esperado) LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN RAISE EXCEPTION '117 postcheck: tabela % ausente', tabela; END IF;
    t := jsonb_build_object(
      'colunas', (SELECT COALESCE(jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
          || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')), '{}'::jsonb)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ('public.' || tabela)::regclass AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT COALESCE(jsonb_object_agg(conname, pg_get_constraintdef(oid)), '{}'::jsonb)
        FROM pg_constraint WHERE conrelid = ('public.' || tabela)::regclass AND contype <> 'n'),
      'indices', (SELECT COALESCE(jsonb_object_agg(i.relname, pg_get_indexdef(i.oid)), '{}'::jsonb)
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = ('public.' || tabela)::regclass));
    IF t IS DISTINCT FROM esperado -> tabela THEN
      RAISE EXCEPTION '117 postcheck: definição divergente em %: %', tabela, t;
    END IF;
  END LOOP;
  IF COALESCE((SELECT pg_get_indexdef(to_regclass('public.whatsapp_atendimento_mensagens_ambiente_provedor_idx'))), '')
     <> 'CREATE INDEX whatsapp_atendimento_mensagens_ambiente_provedor_idx ON public.whatsapp_atendimento_mensagens USING btree (ambiente, provedor_id) WHERE (provedor_id IS NOT NULL)'
    THEN RAISE EXCEPTION '117 postcheck: índice de busca por identificador ausente ou divergente'; END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_atendimento_rodizio) THEN RAISE EXCEPTION '117 postcheck: rodízio não está vazio'; END IF;
END $$;
SELECT current_database() AS banco, (SELECT count(*) FROM whatsapp_atendimento_status_colisoes) AS colisoes, true AS aprovado;
ROLLBACK;
