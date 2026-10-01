-- Somente leitura. Não imprime e-mail nem trata UUID como constante.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM empresas
     WHERE codigo = 'kidmais' AND nome = 'Kidmais' AND status = 'ATIVA' AND desativado_em IS NULL
  ) THEN
    RAISE EXCEPTION '046 postcheck: Kidmais não está ativa.';
  END IF;
  IF (
    SELECT count(*) FROM memberships m
      JOIN empresas e ON e.id = m.empresa_id
     WHERE e.codigo = 'kidmais' AND m.status = 'ATIVA' AND m.revogado_em IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION '046 postcheck: a primeira membership ativa não é única.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'papel'
  ) THEN
    RAISE EXCEPTION '046 postcheck: membership recebeu papel.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memberships m
      JOIN empresas e ON e.id = m.empresa_id
     WHERE e.codigo = 'kidmais' AND m.status = 'SUSPENSA'
  ) THEN
    RAISE EXCEPTION '046 postcheck: membership suspensa.';
  END IF;
  IF (
    SELECT count(*) FROM pacotes p
      JOIN empresas e ON e.id = p.empresa_id
     WHERE e.codigo = 'kidmais'
       AND p.codigo IN ('COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM')
  ) <> 7 THEN
    RAISE EXCEPTION '046 postcheck: os sete pacotes não estão na Kidmais.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pacotes
     WHERE codigo IN ('COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM')
       AND empresa_id IS NULL
  ) THEN
    RAISE EXCEPTION '046 postcheck: pacote oficial continua sem empresa.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM adicionais a
      JOIN empresas e ON e.id = a.empresa_id
      JOIN pacote_adicionais pa ON pa.adicional_id = a.id
      JOIN pacotes p ON p.id = pa.pacote_id
     WHERE a.codigo = 'SALADA_PREMIUM'
       AND e.codigo = 'kidmais'
       AND p.codigo = 'PREMIUM'
       AND pa.modalidade = 'INCLUSO'
       AND p.empresa_id = a.empresa_id
  ) THEN
    RAISE EXCEPTION '046 postcheck: SALADA_PREMIUM não acompanhou o pacote oficial.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.empresa_id IS DISTINCT FROM a.empresa_id
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'pacotes_empresa_imutavel_trg'
       AND NOT tgisinternal
       AND tgenabled <> 'O'
  ) THEN
    RAISE EXCEPTION '046 postcheck: vínculo incompatível ou guarda aberta.';
  END IF;
END $$;

SELECT 'pos_046' AS marco,
       (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
