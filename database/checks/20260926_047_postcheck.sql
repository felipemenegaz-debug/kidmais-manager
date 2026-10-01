-- Somente leitura. A migration não publica tabela.
-- O vazio das tabelas novas vale na aplicação. Escopo gravado depois, pelo admin, não é backfill.
DO $$ BEGIN
  IF to_regclass('public.tabela_preco_escopos') IS NULL
     OR to_regclass('public.tabela_preco_escopo_faixas') IS NULL
     OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NULL THEN
    RAISE EXCEPTION '047 postcheck: escopo comercial ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'kidmais_035_preservar_tabela_publicada'
       AND pg_get_functiondef(oid) NOT LIKE '%kidmais_047_lacunas_escopo%'
  ) THEN
    RAISE EXCEPTION '047 postcheck: a publicação não consulta o escopo declarado.';
  END IF;
END $$;

SELECT 'pos_047' AS marco,
       (SELECT count(*) FROM tabela_preco_escopos) AS escopos;
