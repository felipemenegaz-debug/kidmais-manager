-- 128 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere a tabela, a coluna e as regras da 128.
-- Não exige a cópia do disco: ela vem depois, por scripts/disco-para-banco-128.cjs (que tem a conferência própria).
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.disponibilidade_config_legada') IS NULL THEN
    RAISE EXCEPTION '128 postcheck: disponibilidade_config_legada ausente';
  END IF;
  -- Colunas com o tipo e o NOT NULL da 128 (uma tabela homônima diferente não passa).
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.disponibilidade_config_legada'::regclass AND attnum > 0
        AND NOT attisdropped AND attnotnull
        AND (attname, atttypid) IN (('id', 'smallint'::regtype), ('conteudo', 'jsonb'::regtype),
                                    ('origem', 'text'::regtype), ('atualizado_em', 'timestamptz'::regtype))) <> 4
     OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.disponibilidade_config_legada'::regclass AND attnum > 0
           AND NOT attisdropped) <> 4 THEN
    RAISE EXCEPTION '128 postcheck: colunas de disponibilidade_config_legada divergentes';
  END IF;
  -- Chave primária exatamente em id e NÃO diferível (o ON CONFLICT (id) do código e do script falha com PK DEFERRABLE).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attname = 'id'
                   WHERE k.conrelid = 'public.disponibilidade_config_legada'::regclass AND k.contype = 'p'
                     AND NOT k.condeferrable AND k.conkey = ARRAY[a.attnum]::int2[]) THEN
    RAISE EXCEPTION '128 postcheck: chave primária de disponibilidade_config_legada ausente ou diferível';
  END IF;
  -- CHECKs pelo nome E pela definição EXATA de pg_get_constraintdef (sem normalizar: literais, espaços e agrupamento contam).
  -- Referência gerada no PostgreSQL 18 (versão de staging e do PG descartável). Em outra versão, um texto diferente recusa
  -- aqui e a migration volta inteira (o aplicador só faz COMMIT com o postcheck PASS): falha fechada, nunca aceite parcial.
  IF (SELECT count(*) FROM pg_constraint c
        JOIN (VALUES
          ('disponibilidade_config_legada', 'disponibilidade_config_legada_unica',
           'CHECK ((id = 1))'),
          ('disponibilidade_config_legada', 'disponibilidade_config_legada_origem',
           'CHECK ((origem = ANY (ARRAY[''DISCO''::text, ''PAINEL''::text])))'),
          ('disponibilidade_config_legada', 'disponibilidade_config_legada_forma',
           'CHECK (((jsonb_typeof(conteudo) = ''object''::text) AND COALESCE((jsonb_typeof((conteudo -> ''pacoteOverrides''::text)) = ''array''::text), false) AND COALESCE((jsonb_typeof((conteudo -> ''descontos''::text)) = ''array''::text), false)))'),
          ('documentos_publicos', 'documentos_publicos_conteudo_confere',
           'CHECK (((conteudo IS NULL) OR ((octet_length(conteudo) = tamanho_bytes) AND (encode(sha256(conteudo), ''hex''::text) = (sha256)::text))))')
        ) AS esperado(tabela, nome, definicao)
          ON c.conrelid = ('public.' || esperado.tabela)::regclass AND c.conname = esperado.nome
       WHERE c.contype = 'c' AND c.convalidated AND pg_get_constraintdef(c.oid) = esperado.definicao) <> 4 THEN
    RAISE EXCEPTION '128 postcheck: regras (CHECK) da 128 ausentes ou com definição divergente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.documentos_publicos'::regclass AND attname = 'conteudo'
                   AND NOT attisdropped AND atttypid = 'bytea'::regtype AND NOT attnotnull) THEN
    RAISE EXCEPTION '128 postcheck: documentos_publicos.conteudo ausente';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado,
  (SELECT count(*) FROM disponibilidade_config_legada) AS config_legada_linhas,
  (SELECT count(*) FROM documentos_publicos WHERE ativo AND conteudo IS NULL) AS ativos_ainda_no_disco;
ROLLBACK;
