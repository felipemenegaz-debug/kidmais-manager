-- 120 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere tabelas, constraints pela definição e índices.
-- Dados: as tabelas podem já ter linhas; o postcheck só as conta.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  esperado jsonb := $j${
    "financeiro_entradas_manuais_empresa_uk": "UNIQUE (id, empresa_id)",
    "financeiro_saidas_empresa_uk": "UNIQUE (id, empresa_id)",
    "financeiro_entradas_liquidacoes_entrada_fk": "FOREIGN KEY (entrada_id, empresa_id) REFERENCES financeiro_entradas_manuais(id, empresa_id) ON DELETE RESTRICT",
    "financeiro_entradas_liquidacoes_valor_check": "CHECK ((valor > (0)::numeric))",
    "financeiro_entradas_liquidacoes_taxa_check": "CHECK (((taxa >= (0)::numeric) AND (taxa <= valor)))",
    "financeiro_entradas_liquidacoes_idempotencia_uk": "UNIQUE (empresa_id, chave_idempotencia)",
    "financeiro_saidas_reversoes_saida_fk": "FOREIGN KEY (saida_id, empresa_id) REFERENCES financeiro_saidas(id, empresa_id) ON DELETE RESTRICT",
    "financeiro_saidas_reversoes_valor_check": "CHECK ((valor > (0)::numeric))",
    "financeiro_saidas_reversoes_idempotencia_uk": "UNIQUE (empresa_id, chave_idempotencia)"
  }$j$;
  nome text;
  achado text;
BEGIN
  IF to_regclass('public.financeiro_entradas_liquidacoes') IS NULL OR to_regclass('public.financeiro_saidas_reversoes') IS NULL
    THEN RAISE EXCEPTION '120 postcheck: tabelas ausentes'; END IF;
  FOR nome IN SELECT jsonb_object_keys(esperado) LOOP
    SELECT pg_get_constraintdef(oid) INTO achado FROM pg_constraint WHERE conname = nome;
    IF achado IS DISTINCT FROM esperado->>nome THEN
      RAISE EXCEPTION '120 postcheck: % esperado "%", achado "%"', nome, esperado->>nome, achado;
    END IF;
  END LOOP;
  IF to_regclass('public.financeiro_entradas_liquidacoes_data_idx') IS NULL OR to_regclass('public.financeiro_saidas_reversoes_data_idx') IS NULL
     OR to_regclass('public.financeiro_entradas_liquidacoes_entrada_idx') IS NULL OR to_regclass('public.financeiro_saidas_reversoes_saida_idx') IS NULL
    THEN RAISE EXCEPTION '120 postcheck: índices ausentes'; END IF;
END $$;
SELECT (SELECT count(*) FROM financeiro_entradas_liquidacoes) AS liquidacoes,
       (SELECT count(*) FROM financeiro_saidas_reversoes) AS reversoes,
       true AS aprovado;
ROLLBACK;
