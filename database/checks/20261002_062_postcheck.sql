-- Postcheck da 062 (somente leitura). Gerado offline por scripts/migration-062-manifest.mjs.
-- Estrutura de escopo, regras com corpo exato da 062, ocupação/formalização/ocupações intactas (019/061), gatilhos
-- ativos e, na primeira instalação, nenhum escopo atribuído a dado existente.
DO $$
DECLARE
  item text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
      (table_name = 'fechamentos' AND column_name = 'estabelecimento_id')
      OR (table_name IN ('bloqueios_agenda', 'configuracao_agenda') AND column_name IN ('empresa_id', 'estabelecimento_id')))) <> 5
     OR to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL
     OR to_regclass('public.agenda_062_fechamentos_resolucao') IS NULL
     OR to_regclass('public.agenda_062_unidades_habilitacao') IS NULL
     OR to_regclass('public.agenda_062_unidades_habilitacao_vigente_uk') IS NULL
     OR to_regclass('public.configuracao_agenda_062_codigo_escopo_uk') IS NULL
     OR EXISTS (SELECT i.indexrelid, ic.relname AS nome, co.conname AS restricao,
       i.indisvalid, i.indisready, am.amname
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'codigo' AND NOT a.attisdropped
  LEFT JOIN pg_constraint co ON co.conindid = i.indexrelid AND co.contype = 'u'
 WHERE i.indrelid = 'public.configuracao_agenda'::regclass AND i.indisunique
   AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
   AND i.indpred IS NULL AND i.indexprs IS NULL) THEN
    RAISE EXCEPTION 'postcheck 062: estrutura de escopo ausente ou código de turno ainda único globalmente';
  END IF;
  FOREACH item IN ARRAY ARRAY['fechamentos_062_estabelecimento_fk', 'fechamentos_062_unidade_exige_empresa_check', 'bloqueios_agenda_062_estabelecimento_fk', 'bloqueios_agenda_062_unidade_exige_empresa_check', 'configuracao_agenda_062_estabelecimento_fk', 'configuracao_agenda_062_unidade_exige_empresa_check'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 062: restrição % ausente ou não validada', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['fechamentos_062_unidade_trg', 'contrato_fluxos_062_unidade_trg', 'bloqueios_agenda_062_unidade_trg', 'configuracao_agenda_062_unidade_trg', 'fechamento_revisoes_062_unidade_trg', 'contrato_importacoes_062_unidade_trg', 'agenda_062_unidades_habilitacao_guard_trg', 'agenda_062_unidades_habilitacao_truncate_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = item AND tgenabled = 'O' AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'postcheck 062: gatilho % ausente ou desligado', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY ARRAY['public.kidmais062_habilitacao_guard()', 'public.kidmais062_mesmo_recurso(uuid,uuid,uuid,uuid)', 'public.kidmais062_bloqueio_aplica(uuid,uuid,uuid,uuid)', 'public.kidmais062_operador_agenda(uuid,uuid,text)', 'public.kidmais062_unidade_agendavel(uuid,uuid)', 'public.kidmais062_travar_habilitacao(uuid)', 'public.kidmais062_ocupacoes_escopo(date,date)', 'public.kidmais062_unidade_fechamento()', 'public.kidmais062_fluxo_unidade()', 'public.kidmais062_unidade_ativa()', 'public.kidmais062_revisao_unidade()', 'public.kidmais062_vinculo_unidade()'] LOOP
    IF to_regprocedure(item) IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(item)) THEN
      RAISE EXCEPTION 'postcheck 062: função % ausente ou SECURITY DEFINER', item;
    END IF;
  END LOOP;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_destino(uuid)'::regprocedure) IS DISTINCT FROM '95d78b638b10bc449dc20e795727e5bc52220d2977c291158aecdbecc33c633d'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_contrato()'::regprocedure) IS DISTINCT FROM '8572e2ee2cc990c6b6cd20045911b5c852510c7dafda73714e0f8808c72229e6'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_proteger_bloqueio_revisao()'::regprocedure) IS DISTINCT FROM '74ac39079d343f7db514322ca043925ea9c6a2fb2ffe7b5b7752b0a181d812b9'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM '830dd6a376f1dceadab9f20ad606665ec7b4692bfd531881c3da42f1e3d0b2ad'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '3fb0ae66b6e7f9f12f2382d7dc916fa4b485828716350496cc9839fd6c4d98c5'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais062_ocupacoes_escopo(date,date)'::regprocedure) IS DISTINCT FROM 'e2fdec749c6d1f1f570e48acb46a5708ff6a4d30003623ccf2dbcc887befbe37' THEN
    RAISE EXCEPTION 'postcheck 062: corpos de agenda divergem da 062 (ou ocupação/formalização/ocupações mudaram)';
  END IF;
END $$;
-- Relatório (não falha): o que segue com o alcance anterior e espera decisão explícita (D2/D3).
SELECT (SELECT count(*) FROM public.fechamentos WHERE empresa_id IS NOT NULL AND estabelecimento_id IS NULL) AS contratacoes_sem_unidade,
       (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL) AS bloqueios_globais,
       (SELECT count(*) FROM public.configuracao_agenda WHERE empresa_id IS NOT NULL) AS turnos_por_empresa;
SELECT 'postcheck 062 OK' AS resultado;
