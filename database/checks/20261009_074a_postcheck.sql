-- 074 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura; não mostra dados de clientes.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regclass('public.assinatura_isencoes') IS NULL
     OR to_regclass('public.assinatura_fundadores') IS NULL
     OR to_regclass('public.assinatura_contratacoes') IS NULL
     OR to_regprocedure('public.kidmais_074_registro_guarda()') IS NULL THEN
    RAISE EXCEPTION '074 postcheck: estruturas ausentes.';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
      AND tgrelid IN ('public.assinatura_isencoes'::regclass,'public.assinatura_fundadores'::regclass,'public.assinatura_contratacoes'::regclass)
      AND tgname IN ('assinatura_isencoes_074_guarda','assinatura_fundadores_074_guarda','assinatura_contratacoes_074_guarda',
                    'assinatura_isencoes_074_truncate','assinatura_fundadores_074_truncate','assinatura_contratacoes_074_truncate')) <> 6 THEN
    RAISE EXCEPTION '074 postcheck: gatilhos ausentes/desativados.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.assinatura_fundadores'::regclass
      AND conname = 'assinatura_fundadores_confirmacao_fk' AND condeferrable AND condeferred AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.empresa_assinaturas'::regclass
      AND conname = 'empresa_assinaturas_contratacao_fk' AND convalidated) THEN
    RAISE EXCEPTION '074 postcheck: vínculos de confirmação ausentes.';
  END IF;
  IF (SELECT count(*) FROM pg_index WHERE indisunique AND indisvalid AND indrelid = 'public.assinatura_fundadores'::regclass
      AND indexrelid IN (to_regclass('public.assinatura_fundadores_vaga_uk'),to_regclass('public.assinatura_fundadores_empresa_uk'),to_regclass('public.assinatura_fundadores_documento_uk'))) <> 3 THEN
    RAISE EXCEPTION '074 postcheck: índices de concorrência ausentes.';
  END IF;
  IF EXISTS (SELECT 1 FROM assinatura_fundadores WHERE estado <> 'LIBERADA' GROUP BY vaga HAVING count(*) > 1)
     OR (SELECT count(*) FROM assinatura_fundadores WHERE estado <> 'LIBERADA') > 20 THEN
    RAISE EXCEPTION '074 postcheck: campanha excede capacidade.';
  END IF;
  IF EXISTS (SELECT 1 FROM empresa_assinaturas a LEFT JOIN assinatura_contratacoes c ON c.empresa_id = a.empresa_id AND c.id = a.contratacao_atual_id
      WHERE a.plano <> 'UNICO' AND (c.id IS NULL OR c.estado <> 'CONFIRMADA' OR c.plano <> a.plano OR c.ciclo IS DISTINCT FROM a.ciclo OR c.provedor_assinatura_id IS DISTINCT FROM a.provedor_assinatura_id)) THEN
    RAISE EXCEPTION '074 postcheck: plano sem contratação correspondente.';
  END IF;
  IF EXISTS (SELECT 1 FROM assinatura_isencoes i JOIN empresa_assinaturas a ON a.empresa_id = i.empresa_id WHERE a.provedor_assinatura_id IS NOT NULL OR a.plano <> 'UNICO') THEN
    RAISE EXCEPTION '074 postcheck: isenção com vínculo de cobrança.';
  END IF;
  IF position('Plano exige contratação confirmada' IN pg_get_functiondef('public.kidmais_068_assinatura_guarda()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '074 postcheck: guarda integrada ausente.';
  END IF;
  RAISE NOTICE '074 postcheck OK. Não comprova webhook, provedor, acesso por plano ou vínculo da isenção Kidmais.';
END $$;
ROLLBACK;
