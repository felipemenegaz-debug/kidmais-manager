-- Somente leitura. A 133 criou só a função nova, com a definição revisada, e a 094 segue a da 131.
DO $$
DECLARE item record;
BEGIN
  SET LOCAL search_path = public, pg_catalog;
  FOR item IN SELECT * FROM (VALUES
      ('kidmais133_ocupacoes_escopo(date,date,uuid,uuid)', '69e124cd3e763990eb8e5ca54e688c3944158e15543583276db61c4c285f3baa'),
      ('kidmais094_ocupacoes(date,date)', '2fd9540c61c1d30bd64e53e912b90799e3cd6ab48d38f04ea82efe3f21385646')
    ) AS esperado(assinatura, hash) LOOP
    IF (SELECT encode(sha256(convert_to(replace(pg_get_functiondef(p.oid), chr(13), ''), 'UTF8')), 'hex')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || item.assinatura)) IS DISTINCT FROM item.hash THEN
      RAISE EXCEPTION '133: definição divergente da função %', item.assinatura;
    END IF;
  END LOOP;
END $$;
