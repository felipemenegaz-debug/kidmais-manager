-- 121 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere tabelas, constraints-chave e os gatilhos de acréscimo.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  esperado jsonb := $j${
    "financeiro_aberturas_versao_uk": "UNIQUE (empresa_id, versao)",
    "financeiro_aberturas_idempotencia_uk": "UNIQUE (empresa_id, chave_idempotencia)",
    "financeiro_aberturas_cadeia_check": "CHECK (((versao = 1) = (substitui_id IS NULL)))",
    "financeiro_abertura_conferencias_origem_uk": "UNIQUE (abertura_id, origem_tipo, origem_id, sequencia)",
    "financeiro_abertura_conferencias_idempotencia_uk": "UNIQUE (empresa_id, chave_idempotencia)",
    "financeiro_abertura_conferencias_sequencia_check": "CHECK ((sequencia >= 1))",
    "financeiro_abertura_conferencias_previa_check": "CHECK ((((modo)::text <> 'PREVIA'::text) OR (sequencia = 1)))",
    "financeiro_abertura_conferencias_abertura_fk": "FOREIGN KEY (abertura_id, empresa_id) REFERENCES financeiro_aberturas(id, empresa_id) ON DELETE RESTRICT"
  }$j$;
  nome text;
  achado text;
BEGIN
  IF to_regclass('public.financeiro_aberturas') IS NULL OR to_regclass('public.financeiro_abertura_conferencias') IS NULL
    THEN RAISE EXCEPTION '121 postcheck: tabelas ausentes'; END IF;
  FOR nome IN SELECT jsonb_object_keys(esperado) LOOP
    SELECT pg_get_constraintdef(oid) INTO achado FROM pg_constraint WHERE conname = nome;
    IF achado IS DISTINCT FROM esperado->>nome THEN
      RAISE EXCEPTION '121 postcheck: % esperado "%", achado "%"', nome, esperado->>nome, achado;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger
        WHERE tgname IN ('financeiro_aberturas_121_somente_acrescimo', 'financeiro_abertura_conferencias_121_somente_acrescimo')
          AND NOT tgisinternal AND tgenabled = 'O') <> 2
    THEN RAISE EXCEPTION '121 postcheck: gatilhos de acréscimo ausentes ou desligados'; END IF;
END $$;
SELECT (SELECT count(*) FROM financeiro_aberturas) AS revisoes,
       (SELECT count(*) FROM financeiro_abertura_conferencias) AS conferencias,
       true AS aprovado;
ROLLBACK;
