-- Somente leitura. Não declara escopo e não publica tabela.
DO $$ BEGIN
  IF to_regclass('public.tabelas_preco') IS NULL OR to_regclass('public.precos_pacote') IS NULL THEN
    RAISE EXCEPTION '047 precheck: tabela de preço ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_035_preservar_tabela_publicada()') IS NULL THEN
    RAISE EXCEPTION '047 precheck: guarda de publicação ausente.';
  END IF;
  IF to_regclass('public.tabela_preco_escopos') IS NOT NULL THEN
    RAISE EXCEPTION '047 precheck: escopo comercial já existe.';
  END IF;
END $$;

SELECT 'pre_047' AS marco,
       (SELECT count(*) FROM tabelas_preco WHERE publicada_em IS NOT NULL) AS tabelas_publicadas;
