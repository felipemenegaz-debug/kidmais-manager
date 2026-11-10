-- 118 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere, contra literais exatos:
--   * colunas (tipo, NOT NULL e default) das duas tabelas novas, pelo pg_attribute;
--   * constraints pela DEFINIÇÃO (pg_get_constraintdef; contype 'n' fica de fora, o NOT NULL já está nas colunas);
--   * índices (pg_get_indexdef), inclusive o único parcial da linha viva; gatilhos (BEFORE UPDATE OR DELETE, FOR EACH ROW,
--     ligados);
--   * as três funções pela definição completa (pg_get_functiondef: corpo, volatilidade, search_path).
-- Dados: as tabelas podem já ter linhas (o código publicado passa a reservar assim que elas existem); o postcheck só as conta.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  c jsonb := '{}'::jsonb;
  t jsonb;
  tabela text;
  f jsonb;
  esperado jsonb := $j${
    "ia_importacao_cotas": {
      "colunas": {
        "criado_em": "timestamp with time zone NOT NULL DEFAULT clock_timestamp()",
        "empresa_id": "uuid NOT NULL",
        "migracao_inicio": "timestamp with time zone"
      },
      "constraints": {
        "ia_importacao_cotas_empresa_id_fkey": "FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        "ia_importacao_cotas_pkey": "PRIMARY KEY (empresa_id)"
      },
      "gatilhos": {
        "ia_importacao_cotas_118_guarda": "CREATE TRIGGER ia_importacao_cotas_118_guarda BEFORE DELETE OR UPDATE ON public.ia_importacao_cotas FOR EACH ROW EXECUTE FUNCTION kidmais_118_guarda() [O]"
      },
      "indices": {
        "ia_importacao_cotas_pkey": "CREATE UNIQUE INDEX ia_importacao_cotas_pkey ON public.ia_importacao_cotas USING btree (empresa_id)"
      }
    },
    "ia_importacao_usos": {
      "colunas": {
        "atualizado_em": "timestamp with time zone NOT NULL",
        "criado_em": "timestamp with time zone NOT NULL",
        "documento_id": "uuid NOT NULL",
        "empresa_id": "uuid NOT NULL",
        "estado": "text NOT NULL",
        "expira_em": "timestamp with time zone NOT NULL",
        "id": "uuid NOT NULL DEFAULT gen_random_uuid()",
        "operacao_id": "uuid NOT NULL",
        "periodo": "text NOT NULL",
        "sha256": "character(64) NOT NULL"
      },
      "constraints": {
        "ia_importacao_usos_documento_fk": "FOREIGN KEY (documento_id, empresa_id) REFERENCES ia_documentos(id, empresa_id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        "ia_importacao_usos_empresa_id_fkey": "FOREIGN KEY (empresa_id) REFERENCES ia_importacao_cotas(empresa_id) ON UPDATE RESTRICT ON DELETE RESTRICT",
        "ia_importacao_usos_estado_check": "CHECK ((estado = ANY (ARRAY['RESERVADA'::text, 'CONSUMIDA'::text, 'LIBERADA'::text])))",
        "ia_importacao_usos_operacao_uk": "UNIQUE (operacao_id)",
        "ia_importacao_usos_periodo_check": "CHECK ((periodo ~ '^([0-9]{4}-(0[1-9]|1[0-2])|IMPLANTACAO|MIGRACAO)$'::text))",
        "ia_importacao_usos_pkey": "PRIMARY KEY (id)",
        "ia_importacao_usos_prazo_check": "CHECK (((expira_em > criado_em) AND (atualizado_em >= criado_em)))",
        "ia_importacao_usos_sha256_check": "CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"
      },
      "gatilhos": {
        "ia_importacao_usos_118_guarda": "CREATE TRIGGER ia_importacao_usos_118_guarda BEFORE DELETE OR UPDATE ON public.ia_importacao_usos FOR EACH ROW EXECUTE FUNCTION kidmais_118_guarda() [O]"
      },
      "indices": {
        "ia_importacao_usos_operacao_uk": "CREATE UNIQUE INDEX ia_importacao_usos_operacao_uk ON public.ia_importacao_usos USING btree (operacao_id)",
        "ia_importacao_usos_periodo_idx": "CREATE INDEX ia_importacao_usos_periodo_idx ON public.ia_importacao_usos USING btree (empresa_id, periodo) WHERE (estado = ANY (ARRAY['RESERVADA'::text, 'CONSUMIDA'::text]))",
        "ia_importacao_usos_pkey": "CREATE UNIQUE INDEX ia_importacao_usos_pkey ON public.ia_importacao_usos USING btree (id)",
        "ia_importacao_usos_vivo_uk": "CREATE UNIQUE INDEX ia_importacao_usos_vivo_uk ON public.ia_importacao_usos USING btree (empresa_id, sha256) WHERE (estado = ANY (ARRAY['RESERVADA'::text, 'CONSUMIDA'::text]))"
      }
    }
  }$j$::jsonb;
  funcoes jsonb := $j${
    "kidmais_118_guarda()": "CREATE OR REPLACE FUNCTION public.kidmais_118_guarda()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO 'pg_catalog', 'pg_temp'\nAS $function$\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RAISE EXCEPTION '% não é apagada (118).', TG_TABLE_NAME USING ERRCODE = 'P0001';\n  END IF;\n  IF TG_TABLE_NAME = 'ia_importacao_cotas' THEN\n    IF NEW.empresa_id <> OLD.empresa_id OR NEW.criado_em <> OLD.criado_em THEN\n      RAISE EXCEPTION 'Identidade da cota é imutável (118).' USING ERRCODE = 'P0001';\n    END IF;\n    IF OLD.migracao_inicio IS NOT NULL AND NEW.migracao_inicio IS DISTINCT FROM OLD.migracao_inicio THEN\n      RAISE EXCEPTION 'O início da janela de migração não muda (118).' USING ERRCODE = 'P0001';\n    END IF;\n    RETURN NEW;\n  END IF;\n  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id OR NEW.sha256 <> OLD.sha256 OR NEW.documento_id <> OLD.documento_id\n     OR NEW.operacao_id <> OLD.operacao_id OR NEW.periodo <> OLD.periodo OR NEW.expira_em <> OLD.expira_em OR NEW.criado_em <> OLD.criado_em THEN\n    RAISE EXCEPTION 'Identidade, período e prazo do uso são imutáveis (118).' USING ERRCODE = 'P0001';\n  END IF;\n  IF OLD.estado <> 'RESERVADA' OR NEW.estado NOT IN ('CONSUMIDA', 'LIBERADA') THEN\n    RAISE EXCEPTION 'Transição de uso inválida: % → % (118).', OLD.estado, NEW.estado USING ERRCODE = 'P0001';\n  END IF;\n  RETURN NEW;\nEND $function$\n",
    "kidmais_118_janela_migracao(timestamp with time zone,timestamp with time zone)": "CREATE OR REPLACE FUNCTION public.kidmais_118_janela_migracao(inicio timestamp with time zone, t timestamp with time zone)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE PARALLEL SAFE\n SET search_path TO 'pg_catalog', 'pg_temp'\nAS $function$ SELECT inicio IS NULL OR (t >= inicio AND t < inicio + interval '720 hours') $function$\n",
    "kidmais_118_periodo_mensal(timestamp with time zone)": "CREATE OR REPLACE FUNCTION public.kidmais_118_periodo_mensal(t timestamp with time zone)\n RETURNS text\n LANGUAGE sql\n STABLE PARALLEL SAFE\n SET search_path TO 'pg_catalog', 'pg_temp'\nAS $function$ SELECT to_char(t AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') $function$\n"
  }$j$::jsonb;
BEGIN
  IF to_regclass('public.ia_importacao_cotas') IS NULL OR to_regclass('public.ia_importacao_usos') IS NULL
    THEN RAISE EXCEPTION '118 postcheck: tabelas ausentes'; END IF;
  FOREACH tabela IN ARRAY ARRAY['ia_importacao_cotas', 'ia_importacao_usos'] LOOP
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
    THEN RAISE EXCEPTION '118 postcheck: definição das tabelas novas divergente: %', c; END IF;
  SELECT jsonb_object_agg(p.oid::regprocedure::text, pg_get_functiondef(p.oid)) INTO f
    FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.kidmais_118_janela_migracao(timestamptz,timestamptz)'),
                                   to_regprocedure('public.kidmais_118_periodo_mensal(timestamptz)'),
                                   to_regprocedure('public.kidmais_118_guarda()'));
  IF f IS DISTINCT FROM funcoes
    THEN RAISE EXCEPTION '118 postcheck: funções divergentes: %', f; END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM ia_importacao_cotas) AS empresas_com_cota, (SELECT count(*) FROM ia_importacao_usos) AS usos;
ROLLBACK;
