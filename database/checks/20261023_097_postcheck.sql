-- Somente leitura: tabela, índices, restrições (relação, tipo e definição), colunas (tipo e NOT NULL) e gatilho ROW BEFORE INSERT/UPDATE/DELETE
-- (tgtype = 31) com a guarda da 097.
DO $$
BEGIN
  IF to_regclass('public.assinatura_arrependimentos') IS NULL OR to_regprocedure('public.kidmais_097_guarda()') IS NULL
    OR to_regclass('public.assinatura_arrependimentos_pendentes_idx') IS NULL OR to_regclass('public.assinatura_arrependimentos_empresa_idx') IS NULL THEN
    RAISE EXCEPTION '097 postcheck: objeto ausente';
  END IF;
  -- Igualdade exata com a forma canônica do PostgreSQL 18 de TODAS as restrições da tabela (exceto NOT NULL, conferidas
  -- pelo próprio catálogo): nenhuma a mais, nenhuma a menos, todas validadas. Um "OR true" ou um nome trocado divergem.
  IF EXISTS (
      (SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint
        WHERE convalidated AND contype <> 'n' AND conrelid = 'public.assinatura_arrependimentos'::regclass)
      EXCEPT (VALUES
    ('assinatura_arrependimentos_aviso_interno_check', 'CHECK ((aviso_interno = ANY (ARRAY[''PENDENTE''::text, ''ENVIADO''::text, ''FALHOU''::text, ''NAO_CONFIGURADO''::text])))'),
    ('assinatura_arrependimentos_canal_check', 'CHECK ((canal = ANY (ARRAY[''FERRAMENTA''::text, ''ATENDIMENTO''::text])))'),
    ('assinatura_arrependimentos_chave_uk', 'UNIQUE (empresa_id, chave_idempotencia)'),
    ('assinatura_arrependimentos_concluido_por_fkey', 'FOREIGN KEY (concluido_por) REFERENCES usuarios_administrativos(id)'),
    ('assinatura_arrependimentos_conclusao_check', 'CHECK ((((situacao = ''RECEBIDO''::text) AND (concluido_em IS NULL) AND (concluido_por IS NULL) AND (conclusao_referencia IS NULL) AND (valor_restituido_centavos IS NULL)) OR ((situacao = ''RESTITUIDO''::text) AND (concluido_em IS NOT NULL) AND (concluido_por IS NOT NULL) AND (conclusao_referencia IS NOT NULL) AND (valor_restituido_centavos IS NOT NULL) AND (intermediador_comunicado_em IS NOT NULL) AND (restituicao_limite IS NOT NULL) AND (restituicao_cobranca_ids IS NOT NULL)) OR ((situacao = ''NAO_APLICAVEL''::text) AND (concluido_em IS NOT NULL) AND (concluido_por IS NOT NULL) AND (conclusao_referencia IS NOT NULL) AND (valor_restituido_centavos IS NULL))))'),
    ('assinatura_arrependimentos_conclusao_referencia_check', 'CHECK (((conclusao_referencia IS NULL) OR ((char_length(btrim(conclusao_referencia)) >= 5) AND (char_length(btrim(conclusao_referencia)) <= 500))))'),
    ('assinatura_arrependimentos_email_confirmacao_check', 'CHECK ((email_confirmacao = ANY (ARRAY[''PENDENTE''::text, ''ENVIADO''::text, ''FALHOU''::text, ''SEM_DESTINATARIO''::text])))'),
    ('assinatura_arrependimentos_empresa_id_fkey', 'FOREIGN KEY (empresa_id) REFERENCES empresa_assinaturas(empresa_id)'),
    ('assinatura_arrependimentos_intermediador_check', 'CHECK (((intermediador_comunicado_em IS NULL) = (intermediador_referencia IS NULL)))'),
    ('assinatura_arrependimentos_intermediador_referencia_check', 'CHECK (((intermediador_referencia IS NULL) OR ((char_length(btrim(intermediador_referencia)) >= 3) AND (char_length(btrim(intermediador_referencia)) <= 300))))'),
    ('assinatura_arrependimentos_motivo_check', 'CHECK (((motivo IS NULL) OR (char_length(motivo) <= 500)))'),
    ('assinatura_arrependimentos_pkey', 'PRIMARY KEY (id)'),
    ('assinatura_arrependimentos_protocolo_check', 'CHECK ((protocolo ~ ''^KA-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{8}$''::text))'),
    ('assinatura_arrependimentos_protocolo_key', 'UNIQUE (protocolo)'),
    ('assinatura_arrependimentos_provedor_assinatura_id_check', 'CHECK (((provedor_assinatura_id IS NULL) OR (provedor_assinatura_id ~ ''^[A-Za-z0-9_-]{1,100}$''::text)))'),
    ('assinatura_arrependimentos_restituicao_assinatura_check', 'CHECK (((provedor_assinatura_id IS NULL) OR (restituicao_assinatura_id IS NULL) OR (restituicao_assinatura_id = provedor_assinatura_id)))'),
    ('assinatura_arrependimentos_restituicao_assinatura_id_check', 'CHECK (((restituicao_assinatura_id IS NULL) OR (restituicao_assinatura_id ~ ''^[A-Za-z0-9_-]{1,100}$''::text)))'),
    ('assinatura_arrependimentos_restituicao_check', 'CHECK (((situacao = ''RESTITUIDO''::text) OR ((restituicao_limite IS NULL) AND (restituicao_assinatura_id IS NULL) AND (restituicao_cobranca_ids IS NULL))))'),
    ('assinatura_arrependimentos_restituicao_cobranca_ids_check', 'CHECK (((restituicao_cobranca_ids IS NULL) OR (((cardinality(restituicao_cobranca_ids) >= 1) AND (cardinality(restituicao_cobranca_ids) <= 50)) AND (array_to_string(restituicao_cobranca_ids, '',''::text) ~ ''^[A-Za-z0-9_-]{1,100}(,[A-Za-z0-9_-]{1,100})*$''::text))))'),
    ('assinatura_arrependimentos_situacao_assinatura_check', 'CHECK ((situacao_assinatura = ANY (ARRAY[''TESTE''::text, ''ATIVA''::text, ''EM_ATRASO''::text, ''CANCELADA_FIM_PERIODO''::text, ''ENCERRADA''::text])))'),
    ('assinatura_arrependimentos_situacao_check', 'CHECK ((situacao = ANY (ARRAY[''RECEBIDO''::text, ''RESTITUIDO''::text, ''NAO_APLICAVEL''::text])))'),
    ('assinatura_arrependimentos_solicitado_por_fkey', 'FOREIGN KEY (solicitado_por) REFERENCES usuarios_administrativos(id)'),
    ('assinatura_arrependimentos_valor_restituido_centavos_check', 'CHECK (((valor_restituido_centavos IS NULL) OR (valor_restituido_centavos > 0)))')))
    OR (SELECT count(*) FROM pg_constraint WHERE convalidated AND contype <> 'n' AND conrelid = 'public.assinatura_arrependimentos'::regclass) <> 23 THEN
    RAISE EXCEPTION '097 postcheck: restrição ausente ou com definição divergente';
  END IF;
  -- Revisão 8da88ba (P3-C1): colunas, ordem, tipo e NOT NULL por igualdade exata com o catálogo (as restrições NOT NULL
  -- ficam fora da comparação acima; sem esta conferência, retirar NOT NULL de situacao passava).
  IF (SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END, ', ' ORDER BY attnum)
        FROM pg_attribute WHERE attrelid = 'public.assinatura_arrependimentos'::regclass AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM 'id uuid NOT NULL, protocolo text NOT NULL, empresa_id uuid NOT NULL, chave_idempotencia uuid NOT NULL, canal text NOT NULL, solicitado_por uuid NOT NULL, solicitado_em timestamp with time zone NOT NULL, motivo text, situacao_assinatura text NOT NULL, contratado_em timestamp with time zone, dentro_de_7_dias boolean, provedor_disponivel boolean NOT NULL, provedor_assinatura_id text, intermediador_comunicado_em timestamp with time zone, intermediador_referencia text, situacao text NOT NULL, concluido_em timestamp with time zone, concluido_por uuid, conclusao_referencia text, valor_restituido_centavos integer, restituicao_limite date, restituicao_assinatura_id text, restituicao_cobranca_ids text[], email_confirmacao text NOT NULL, aviso_interno text NOT NULL' THEN
    RAISE EXCEPTION '097 postcheck: colunas, tipos ou NOT NULL divergentes';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31
        AND tgrelid = 'public.assinatura_arrependimentos'::regclass AND tgname = 'assinatura_arrependimentos_097_guarda'
        AND tgfoid = 'public.kidmais_097_guarda()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '097 postcheck: gatilho ausente ou divergente';
  END IF;
  RAISE NOTICE '097 postcheck OK';
END $$;
SELECT situacao, count(*) AS manifestacoes FROM assinatura_arrependimentos GROUP BY situacao ORDER BY situacao;
