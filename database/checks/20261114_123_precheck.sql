-- 123 precheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere os pré-requisitos e que nada da 123 existe.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.festas') IS NULL OR to_regclass('public.contratos') IS NULL OR to_regclass('public.fechamentos') IS NULL
     OR to_regclass('public.pacotes') IS NULL OR to_regclass('public.clientes') IS NULL OR to_regclass('public.empresas') IS NULL
     OR to_regclass('public.usuarios_administrativos') IS NULL OR to_regclass('public.validacoes_identidade_cliente') IS NULL THEN
    RAISE EXCEPTION '123 precheck: pré-requisito ausente';
  END IF;
  IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL THEN RAISE EXCEPTION '123 precheck: kidmais_set_atualizado_em ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pacotes' AND column_name = 'empresa_id')
    THEN RAISE EXCEPTION '123 precheck: pacotes.empresa_id ausente'; END IF;
  -- A área confere o documento do contratante pelo cadastro atual: CPF (PF) ou CNPJ (PJ, 112).
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes'
       AND column_name IN ('tipo_pessoa', 'cnpj', 'representante_nome')) <> 3
    THEN RAISE EXCEPTION '123 precheck: 112 (PJ em clientes) ausente'; END IF;
  IF to_regclass('public.festa_pessoas') IS NOT NULL OR to_regclass('public.festa_links_area') IS NOT NULL
     OR to_regclass('public.area_familia_sessoes') IS NOT NULL OR to_regclass('public.limites_contadores') IS NOT NULL
     OR to_regclass('public.area_familia_eventos') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'validacoes_identidade_cliente'
                 AND column_name IN ('festa_pessoa_id', 'consumido_por_area_sessao_id')) THEN
    RAISE EXCEPTION '123 precheck: 123 já (parcialmente) presente';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.validacoes_identidade_cliente'::regclass AND conname IN (
      'validacoes_identidade_cliente_finalidade_check', 'validacoes_identidade_cliente_pendente_check',
      'validacoes_identidade_cliente_recuperacao_check', 'validacoes_identidade_cliente_confirmada_check',
      'validacoes_identidade_cliente_consumida_check', 'validacoes_identidade_cliente_consumo_consistencia',
      'validacoes_identidade_cliente_consumidor_finalidade_check')) <> 7 THEN
    RAISE EXCEPTION '123 precheck: checks da 010 em validacoes_identidade_cliente fora do esperado';
  END IF;
  IF EXISTS (SELECT 1 FROM validacoes_identidade_cliente WHERE finalidade NOT IN ('FECHAMENTO_PUBLICO', 'CONTRATO_ACEITE')) THEN
    RAISE EXCEPTION '123 precheck: finalidade desconhecida em validacoes_identidade_cliente';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
