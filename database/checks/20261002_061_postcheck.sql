-- Postcheck da 061 (somente leitura). Gerado offline por scripts/migration-061-manifest.mjs.
-- Tabelas e gatilhos ativos, funções com corpo exato da 061 (e kidmais019_ocupa intacta), restrições validadas e
-- nenhuma integração criada pela instalação.
DO $$
DECLARE
  item text;
BEGIN
  IF to_regclass('public.contrato_importacoes') IS NULL OR to_regclass('public.contrato_importacao_financeiro') IS NULL THEN
    RAISE EXCEPTION 'postcheck 061: tabelas ausentes';
  END IF;
  FOREACH item IN ARRAY ARRAY['contrato_importacoes_imutavel_trg', 'contrato_importacao_financeiro_imutavel_trg',
    'contrato_importacoes_truncate_trg', 'contrato_importacao_financeiro_truncate_trg', 'contrato_importacoes_validar_trg',
    'contrato_importacao_financeiro_validar_trg', 'fechamentos_061_origem_trg', 'fechamentos_061_vinculo_trg',
    'contrato_importacoes_061_financeiro_trg', 'festa019_061_origem_importacao'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 061: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['kidmais061_imutavel', 'kidmais061_validar_vinculo', 'kidmais061_validar_financeiro',
    'kidmais061_origem_fechamento', 'kidmais061_exigir_vinculo', 'kidmais061_conferencia_historica', 'kidmais061_historico_passado'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = item AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_catalog']) THEN
      RAISE EXCEPTION 'postcheck 061: função % ausente, SECURITY DEFINER ou sem search_path fixo', item;
    END IF;
  END LOOP;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure) IS DISTINCT FROM '0706e34186753e34bfcb6491e947492b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '3fb0ae66b6e7f9f12f2382d7dc916fa4b485828716350496cc9839fd6c4d98c5'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM 'b024636bcf77ef5ee67dc47cb3d1c6023054cf606ded79218979c8fbb05de467'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3' THEN
    RAISE EXCEPTION 'postcheck 061: corpos de validação/formalização/agenda divergem da 061 (ou a ocupação da 019 mudou)';
  END IF;
  FOREACH item IN ARRAY ARRAY['fechamentos_origem_check', 'contrato_versoes_aceite_metodo_check', 'contrato_versoes_assinatura_documento_check',
    'festa019_autoria_check', 'contrato_importacao_financeiro_soma_ck', 'contrato_importacao_financeiro_situacao_ck'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 061: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'fechamentos_origem_check')) NOT LIKE '%IMPORTACAO_HISTORICA%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'contrato_versoes_aceite_metodo_check')) NOT LIKE '%CONFERENCIA_PAPEL%' THEN
    RAISE EXCEPTION 'postcheck 061: restrições de origem não atualizadas';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contrato_importacoes) OR EXISTS (SELECT 1 FROM public.fechamentos WHERE origem_fechamento = 'IMPORTACAO_HISTORICA') THEN
    RAISE EXCEPTION 'postcheck 061: a instalação não pode integrar contratos (sem backfill)';
  END IF;
END $$;
SELECT 'postcheck 061 OK' AS resultado;
