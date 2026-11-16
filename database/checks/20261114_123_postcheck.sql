-- 123 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere tabelas, colunas, constraints-chave e gatilhos.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  tabela text;
  gatilho text;
  regra text[];
  definicao text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['festa_pessoas', 'festa_links_area', 'area_familia_sessoes', 'limites_contadores', 'area_familia_eventos'] LOOP
    IF to_regclass('public.' || tabela) IS NULL THEN RAISE EXCEPTION '123 postcheck: tabela % ausente', tabela; END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'validacoes_identidade_cliente'
       AND column_name IN ('festa_pessoa_id', 'consumido_por_area_sessao_id')) <> 2 THEN
    RAISE EXCEPTION '123 postcheck: colunas novas de validacoes_identidade_cliente ausentes';
  END IF;
  -- AF-R4: cada CHECK recriado pela 123 tem de existir NA tabela certa, validado, e conter o trecho da 123. Constraint
  -- ausente dá definição nula e recusa (nunca NULL NOT LIKE, que não entra no IF).
  FOREACH regra SLICE 1 IN ARRAY ARRAY[
      ['validacoes_identidade_cliente_finalidade_check', 'AREA_FAMILIA'],
      ['validacoes_identidade_cliente_pessoa_area_check', 'festa_pessoa_id'],
      ['validacoes_identidade_cliente_pendente_check', 'consumido_por_area_sessao_id'],
      ['validacoes_identidade_cliente_recuperacao_check', 'consumido_por_area_sessao_id'],
      ['validacoes_identidade_cliente_confirmada_check', 'consumido_por_area_sessao_id'],
      ['validacoes_identidade_cliente_consumida_check', 'consumido_por_area_sessao_id'],
      ['validacoes_identidade_cliente_consumo_consistencia', 'consumido_por_area_sessao_id'],
      ['validacoes_identidade_cliente_consumidor_finalidade_check', 'AREA_FAMILIA']] LOOP
    SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
     WHERE conrelid = 'public.validacoes_identidade_cliente'::regclass AND conname = regra[1] AND contype = 'c' AND convalidated;
    IF definicao IS NULL OR strpos(definicao, regra[2]) = 0 THEN
      RAISE EXCEPTION '123 postcheck: check % ausente, não validado ou fora do formato da 123', regra[1];
    END IF;
  END LOOP;
  IF to_regprocedure('public.kidmais_123_cancelar_codigos(uuid)') IS NULL THEN
    RAISE EXCEPTION '123 postcheck: função kidmais_123_cancelar_codigos ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'validacoes_identidade_cliente_pessoa_area_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_familia_sessoes_prazo_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'festa_links_area_pessoa_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'area_familia_sessoes_pessoa_fk') THEN
    RAISE EXCEPTION '123 postcheck: constraint-chave ausente';
  END IF;
  IF to_regclass('public.festa_pessoas_papel_ativo_uk') IS NULL OR to_regclass('public.festa_links_area_ativo_uk') IS NULL
     OR to_regclass('public.area_familia_sessoes_token_uk') IS NULL OR to_regclass('public.validacoes_identidade_cliente_area_sessao_uk') IS NULL THEN
    RAISE EXCEPTION '123 postcheck: índice único ausente';
  END IF;
  FOREACH gatilho IN ARRAY ARRAY['festa_pessoas_validar_trg', 'festa_pessoas_123_alterada_trg', 'validacoes_identidade_cliente_area_trg',
      'area_familia_sessoes_prova_trg', 'area_familia_sessoes_imutavel_trg', 'area_familia_eventos_somente_acrescimo_trg',
      'clientes_123_contato_alterado_trg', 'contratos_123_cancelado_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = gatilho AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION '123 postcheck: gatilho % ausente ou desligado', gatilho;
    END IF;
  END LOOP;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
