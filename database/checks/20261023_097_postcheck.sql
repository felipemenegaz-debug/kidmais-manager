-- Somente leitura: tabela, índices, restrições (relação, tipo e definição) e gatilho ROW BEFORE INSERT/UPDATE/DELETE
-- (tgtype = 31) com a guarda da 097.
DO $$
BEGIN
  IF to_regclass('public.assinatura_arrependimentos') IS NULL OR to_regprocedure('public.kidmais_097_guarda()') IS NULL
    OR to_regclass('public.assinatura_arrependimentos_pendentes_idx') IS NULL OR to_regclass('public.assinatura_arrependimentos_empresa_idx') IS NULL THEN
    RAISE EXCEPTION '097 postcheck: objeto ausente';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND conrelid = 'public.assinatura_arrependimentos'::regclass AND (
        (contype = 'u' AND conname = 'assinatura_arrependimentos_chave_uk' AND pg_get_constraintdef(oid) = 'UNIQUE (empresa_id, chave_idempotencia)')
     OR (contype = 'c' AND conname = 'assinatura_arrependimentos_intermediador_check'
         AND pg_get_constraintdef(oid) = 'CHECK (((intermediador_comunicado_em IS NULL) = (intermediador_referencia IS NULL)))')
     OR (contype = 'c' AND conname = 'assinatura_arrependimentos_conclusao_check' AND pg_get_constraintdef(oid) LIKE 'CHECK (((situacao = ''RECEBIDO''::text) AND%'
         AND pg_get_constraintdef(oid) NOT LIKE '%OR true%')
     OR (contype = 'f' AND confrelid = 'public.empresa_assinaturas'::regclass AND pg_get_constraintdef(oid) = 'FOREIGN KEY (empresa_id) REFERENCES empresa_assinaturas(empresa_id)'))) <> 4 THEN
    RAISE EXCEPTION '097 postcheck: restrição ausente ou com definição divergente';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31
        AND tgrelid = 'public.assinatura_arrependimentos'::regclass AND tgname = 'assinatura_arrependimentos_097_guarda'
        AND tgfoid = 'public.kidmais_097_guarda()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '097 postcheck: gatilho ausente ou divergente';
  END IF;
  RAISE NOTICE '097 postcheck OK';
END $$;
SELECT situacao, count(*) AS manifestacoes FROM assinatura_arrependimentos GROUP BY situacao ORDER BY situacao;
