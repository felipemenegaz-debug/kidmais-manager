-- A migration 036 repete este critério e aborta sozinha.
-- Este arquivo não autoriza aplicar a migration se ele falhar.
-- Não reescreve o pacote_adicional histórico com adicional sem empresa.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL THEN
    RAISE EXCEPTION '036 precheck: catálogo comercial ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS NOT NULL
       AND p.empresa_id IS NOT NULL
       AND t.empresa_id <> p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS NOT NULL
       AND a.empresa_id IS NOT NULL
       AND p.empresa_id <> a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
      JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
      JOIN adicionais a ON a.id = pr.adicional_id
     WHERE t.empresa_id IS NOT NULL
       AND a.empresa_id IS NOT NULL
       AND t.empresa_id <> a.empresa_id
  ) THEN
    RAISE EXCEPTION '036 precheck: vínculo entre duas empresas já existe. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_036' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
