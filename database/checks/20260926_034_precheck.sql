-- Somente leitura. Não aplica a 034.
-- Recusa se o gatilho já existe ou se já há vínculo cruzando empresas.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL THEN
    RAISE EXCEPTION '034 precheck: catálogo comercial ausente.';
  END IF;
  IF to_regprocedure('public.kidmais_034_recusar_empresa_distinta(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '034 precheck: integridade de tenant já aplicada.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pa
      JOIN tabelas_preco t ON t.id = pa.tabela_preco_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE t.empresa_id IS DISTINCT FROM a.empresa_id
  ) THEN
    RAISE EXCEPTION '034 precheck: vínculo cruzado já existe. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_034' AS marco, (SELECT count(*) FROM pacote_adicionais) AS vinculos;
