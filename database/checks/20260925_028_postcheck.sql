-- Somente leitura. Confere a estrutura que o serviço de cadastro usa.
-- Não exige zero linhas: este postcheck vale depois da instalação, não só antes do primeiro rascunho.
-- Este arquivo não foi executado e não comprova execução ou concorrência.
DO $$ BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_empresas'
      AND column_name IN (
        'nome_comercial', 'razao_social', 'cnpj', 'versao', 'atualizado_em',
        'sede_cep', 'sede_logradouro', 'sede_numero', 'sede_sem_numero', 'sede_complemento',
        'sede_bairro', 'sede_cidade', 'sede_uf', 'sede_pais'
      )
  ) <> 14 THEN
    RAISE EXCEPTION '028: colunas da empresa usadas pelo serviço ausentes';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_unidades'
      AND column_name IN (
        'nome', 'mesmo_endereco_sede', 'cep', 'logradouro', 'numero', 'sem_numero', 'complemento',
        'bairro', 'cidade', 'uf', 'pais', 'referencia_chegada', 'telefone', 'whatsapp',
        'email_comercial', 'site', 'instagram'
      )
  ) <> 17 THEN
    RAISE EXCEPTION '028: colunas da unidade usadas pelo serviço ausentes';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'perfil_empresa_revisoes'
      AND column_name IN (
        'numero', 'estado', 'versao_base', 'edicao', 'conteudo', 'motivo', 'autor_id',
        'criado_em', 'atualizado_em', 'aplicado_em', 'aplicado_por'
      )
  ) <> 11 THEN
    RAISE EXCEPTION '028: colunas da revisão usadas pelo serviço ausentes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perfil_empresa_revisoes_ciclo_check'
      AND conrelid = 'public.perfil_empresa_revisoes'::regclass
      AND pg_get_constraintdef(oid) LIKE '%motivo IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%aplicado_por IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION '028: revisão aplicada ainda aceita motivo nulo';
  END IF;
END $$;
