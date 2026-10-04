-- 062 precheck (somente leitura). Gerado offline por scripts/migration-062-manifest.mjs.
-- Pré-requisitos (061 aplicada), corpos anteriores exatos (019/061) e relatório do que a migration NÃO faz:
-- nenhuma contratação ou bloqueio existente recebe empresa/unidade (D2/D3 ficam em database/repairs).
DO $$
DECLARE
  sem_unidade integer; bloqueios integer; turnos integer; codigos_globais integer;
BEGIN
  IF to_regclass('public.contrato_importacoes') IS NULL OR to_regprocedure('public.kidmais061_historico_passado(uuid)') IS NULL THEN
    RAISE EXCEPTION '062 precheck: 061 não aplicada.';
  END IF;
  IF to_regclass('public.estabelecimentos') IS NULL THEN RAISE EXCEPTION '062 precheck: 043 não aplicada.'; END IF;
  IF to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL THEN RAISE EXCEPTION '062 precheck: já aplicada.'; END IF;
  IF (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_destino(uuid)'::regprocedure) IS DISTINCT FROM '2ace64d66008e23d1947b7ba13d1241934554c8886984515d4ca8f776b24886b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_validar_contrato()'::regprocedure) IS DISTINCT FROM 'f8f40ebe64775e96e93e3847ef78a312792956ebb0f1e2b873800af9536a810b'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_proteger_bloqueio_revisao()'::regprocedure) IS DISTINCT FROM '7b4639279130207c1d3129c463017ebd2468e0aa099c9ba8d5c7de338cdd0871'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_validar_agenda_revisao()'::regprocedure) IS DISTINCT FROM 'b024636bcf77ef5ee67dc47cb3d1c6023054cf606ded79218979c8fbb05de467'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_ocupa(uuid)'::regprocedure) IS DISTINCT FROM '87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais_ocupacoes_operacionais(date,date)'::regprocedure) IS DISTINCT FROM '3fb0ae66b6e7f9f12f2382d7dc916fa4b485828716350496cc9839fd6c4d98c5'
     OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.kidmais019_formalizacao(uuid,uuid)'::regprocedure) IS DISTINCT FROM '1b428128346f7158389c6a3495f72e9c92a39930b2cb4afe571b9aec900a91ba' THEN
    RAISE EXCEPTION '062 precheck: corpos de agenda divergem da 019/061.';
  END IF;
  SELECT count(*) INTO codigos_globais FROM (SELECT i.indexrelid, ic.relname AS nome, co.conname AS restricao,
       i.indisvalid, i.indisready, am.amname
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'codigo' AND NOT a.attisdropped
  LEFT JOIN pg_constraint co ON co.conindid = i.indexrelid AND co.contype = 'u'
 WHERE i.indrelid = 'public.configuracao_agenda'::regclass AND i.indisunique
   AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
   AND i.indpred IS NULL AND i.indexprs IS NULL) codigo_global;
  IF codigos_globais > 1
     OR (codigos_globais = 0 AND to_regclass('public.configuracao_agenda_062_codigo_escopo_uk') IS NULL)
     OR EXISTS (SELECT 1 FROM (SELECT i.indexrelid, ic.relname AS nome, co.conname AS restricao,
       i.indisvalid, i.indisready, am.amname
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'codigo' AND NOT a.attisdropped
  LEFT JOIN pg_constraint co ON co.conindid = i.indexrelid AND co.contype = 'u'
 WHERE i.indrelid = 'public.configuracao_agenda'::regclass AND i.indisunique
   AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
   AND i.indpred IS NULL AND i.indexprs IS NULL) codigo_global
                 WHERE NOT indisvalid OR NOT indisready OR amname <> 'btree') THEN
    RAISE EXCEPTION '062 precheck: unicidade global de codigo ausente, múltipla ou inválida.';
  END IF;
  SELECT count(*) INTO sem_unidade FROM public.empresas e WHERE e.status = 'ATIVA'
    AND NOT EXISTS (SELECT 1 FROM public.estabelecimentos u WHERE u.empresa_id = e.id AND u.status <> 'DESATIVADO');
  SELECT count(*) INTO bloqueios FROM public.bloqueios_agenda WHERE ativo;
  SELECT count(*) INTO turnos FROM public.configuracao_agenda WHERE ativo;
  RAISE NOTICE '062 precheck: % empresa(s) ativa(s) sem unidade (D2: reparo Unidade principal e decisões por contratação); % bloqueio(s) ativo(s) continuam globais até resolução (D3); % turno(s) ativo(s) ficam como modelos globais (D5).', sem_unidade, bloqueios, turnos;
END $$;
SELECT '062 precheck OK' AS resultado;
