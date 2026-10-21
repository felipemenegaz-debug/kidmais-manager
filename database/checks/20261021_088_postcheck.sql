-- Somente leitura: tabela, constraints, índices e gatilho da 088 presentes e válidos.
DO $$
DECLARE colunas text[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY column_name) INTO colunas FROM information_schema.columns
    WHERE table_schema='public' AND table_name='convite_ia_autorizacoes';
  IF colunas IS DISTINCT FROM ARRAY['convite_id','criado_em','declaracao_responsavel','empresa_id','festa_id','finalidade','id','meio',
      'operador_cliente_id','operador_tipo','operador_usuario_id','provedor','responsavel_nome','responsavel_vinculo','revogacao_motivo','revogada_em',
      'revogada_por','texto_hash','texto_versao']::text[] THEN
    RAISE EXCEPTION '088 postcheck: colunas ausentes ou inesperadas em convite_ia_autorizacoes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_ia_autorizacoes'::regclass AND conname='convite_ia_autorizacoes_operador' AND contype='c' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_ia_autorizacoes'::regclass AND conname='convite_ia_autorizacoes_revogacao' AND contype='c' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.convite_ia_autorizacoes'::regclass AND contype='f' AND confrelid='public.convites'::regclass AND array_length(conkey, 1) = 2) THEN
    RAISE EXCEPTION '088 postcheck: constraints de operador, revogação ou chave composta ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.convite_ia_autorizacao_vigente'::regclass AND indisvalid AND indisunique)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.convite_ia_autorizacoes_empresa'::regclass AND indisvalid)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.convite_ia_autorizacoes'::regclass AND tgname='convite_ia_autorizacao_validar' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION '088 postcheck: índices ou gatilho ausentes';
  END IF;
  RAISE NOTICE '088 postcheck OK';
END $$;
-- Contagem informativa (sem dados pessoais).
SELECT count(*) AS autorizacoes, count(*) FILTER (WHERE revogada_em IS NULL) AS nao_revogadas FROM convite_ia_autorizacoes;
