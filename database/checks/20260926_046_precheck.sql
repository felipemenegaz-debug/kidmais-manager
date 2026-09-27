-- Somente leitura. Não provisiona, não atribui e não apaga vínculo.
DO $$ 
DECLARE
  email_alvo text := 'felipemenegaz@gmail.com';
  sete text[] := ARRAY['COMPACTA','COMPLETA','ESSENCIAL','MINI_FESTA','PIZZA_PARTY','POCKET','PREMIUM'];
  n_email integer;
BEGIN
  IF to_regclass('public.empresas') IS NULL
     OR to_regclass('public.memberships') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL
     OR to_regprocedure('public.kidmais_036_empresa_pai_imutavel()') IS NULL
     OR to_regprocedure('public.kidmais_044_guard_empresas()') IS NULL
     OR to_regprocedure('public.kidmais_045_guard_memberships()') IS NULL THEN
    RAISE EXCEPTION '046 precheck: fundação comercial ausente.';
  END IF;
  IF EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais') THEN
    RAISE EXCEPTION '046 precheck: a empresa Kidmais já existe.';
  END IF;
  SELECT count(*) INTO n_email
    FROM usuarios_administrativos
   WHERE lower(btrim(email)) = lower(btrim(email_alvo));
  IF n_email <> 1 THEN
    RAISE EXCEPTION '046 precheck: a identidade administrativa não é única.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM usuarios_administrativos
     WHERE lower(btrim(email)) = lower(btrim(email_alvo))
       AND ativo
       AND papel = 'REPRESENTANTE_AUTORIZADO'
  ) THEN
    RAISE EXCEPTION '046 precheck: a identidade administrativa não está ativa como representante autorizado.';
  END IF;
  IF (
    SELECT coalesce(array_agg(codigo::text ORDER BY codigo), ARRAY[]::text[])
      FROM pacotes
     WHERE empresa_id IS NULL
  ) IS DISTINCT FROM (
    SELECT array_agg(item.codigo ORDER BY item.codigo)
      FROM unnest(sete) AS item(codigo)
  ) THEN
    RAISE EXCEPTION '046 precheck: o conjunto de pacotes sem empresa divergiu.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE a.id IN (
       SELECT pa2.adicional_id
         FROM pacote_adicionais pa2
         JOIN pacotes p2 ON p2.id = pa2.pacote_id
        WHERE p2.codigo = ANY (sete)
     )
       AND p.codigo <> ALL (sete)
  ) THEN
    RAISE EXCEPTION '046 precheck: vínculo fora dos sete pacotes. Não apagar daqui.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pacote_adicionais pa
      JOIN pacotes p ON p.id = pa.pacote_id
      JOIN adicionais a ON a.id = pa.adicional_id
     WHERE p.codigo = 'PREMIUM'
       AND a.codigo = 'SALADA_PREMIUM'
       AND pa.modalidade = 'INCLUSO'
       AND p.empresa_id IS NULL
       AND a.empresa_id IS NULL
  ) THEN
    RAISE EXCEPTION '046 precheck: SALADA_PREMIUM não está inclusa no pacote oficial.';
  END IF;
END $$;

SELECT 'pre_046' AS marco, (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL) AS pacotes_sem_empresa;
