-- A migration 041 repete este critério depois de travar pacotes.
-- Não associa empresa ao legado e não reescreve revisao_anterior_id.
DO $$ BEGIN
  IF to_regclass('public.pacotes') IS NULL THEN
    RAISE EXCEPTION '041 precheck: pacote ausente.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'revisao_anterior_id'
  ) THEN
    RAISE EXCEPTION '041 precheck: revisão de pacote ausente.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pacotes filho
      JOIN pacotes pai ON pai.id = filho.revisao_anterior_id
     WHERE filho.empresa_id IS DISTINCT FROM pai.empresa_id
  ) THEN
    RAISE EXCEPTION '041 precheck: revisão cruza empresas. Não corrigir daqui.';
  END IF;
END $$;
SELECT 'pre_041' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
