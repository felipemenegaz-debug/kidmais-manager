-- A migration 038 repete este critério depois de travar as tabelas.
-- Este arquivo não instala a guarda e não autoriza seguir se falhar.
-- Não reescreve FESTA_LOCAL / SALADA_PREMIUM e não inventa tenant.
DO $$ BEGIN
  IF to_regclass('public.precos_pacote') IS NULL
     OR to_regclass('public.pacote_adicionais') IS NULL
     OR to_regclass('public.precos_adicional') IS NULL THEN
    RAISE EXCEPTION '038 precheck: catálogo comercial ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM precos_pacote pp
      JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      JOIN pacotes p ON p.id = pp.pacote_id
     WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM precos_adicional pr
      JOIN tabelas_preco t ON t.id = pr.tabela_preco_id
      JOIN adicionais a ON a.id = pr.adicional_id
     WHERE t.empresa_id IS DISTINCT FROM a.empresa_id
  ) OR EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
       AND NOT (
         p.codigo = 'FESTA_LOCAL'
         AND a.codigo = 'SALADA_PREMIUM'
         AND p.empresa_id IS NOT NULL
         AND a.empresa_id IS NULL
       )
  ) THEN
    RAISE EXCEPTION '038 precheck: vínculo incompatível. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_038' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
