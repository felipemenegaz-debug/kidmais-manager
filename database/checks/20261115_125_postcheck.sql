-- 125 postcheck PREPARADO, NÃO EXECUTADO. Somente leitura. Confere o catálogo COMPLETO da 125 (achado P2 do Astra em
-- c71bae8a: com as três tabelas presentes o aplicador genérico só roda este postcheck, então ele não pode aceitar a 125
-- incompleta): nas três tabelas novas, colunas, constraints (toda FK, inclusive as inline, com tabela, colunas e ON DELETE;
-- todo CHECK com a expressão), índices e gatilhos exatamente como a 125 cria; o CHECK novo de area_familia_eventos.tipo; os
-- três gatilhos da 125 nas tabelas da 123 com tabela, eventos e função; as 7 funções da 125 com o corpo da 125; e a função
-- existente kidmais_set_atualizado_em() ligada aos gatilhos de atualizado_em. As linhas NOT NULL de pg_constraint (PG 18)
-- ficam de fora da comparação de constraints: o NOT NULL é conferido pelas colunas, igual em qualquer versão.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE
  t text;
  g text[];
  f text[];
BEGIN
  -- area_familia_avisos_pagamento: colunas (ordem, tipo, NOT NULL, default), constraints validadas (FK com tabela, colunas e ON DELETE;
  -- CHECK com a expressão), índices válidos e gatilhos ligados: exatamente estes, nada a mais e nada a menos.
  t := 'public.area_familia_avisos_pagamento';
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION '125 postcheck: tabela % ausente', t; END IF;
  IF (SELECT coalesce(array_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END
                || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum), ARRAY[]::text[])
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = to_regclass(t) AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM ARRAY[
      'id uuid NOT NULL DEFAULT gen_random_uuid()',
      'festa_id uuid NOT NULL',
      'empresa_id uuid NOT NULL',
      'pessoa_id uuid NOT NULL',
      'parcela_id uuid NOT NULL',
      'parcela_numero smallint NOT NULL',
      'saldo_centavos bigint NOT NULL',
      'observacao text',
      'estado text NOT NULL DEFAULT ''PENDENTE''::text',
      'criado_em timestamp with time zone NOT NULL DEFAULT now()',
      'tratado_em timestamp with time zone',
      'tratado_por_usuario_id uuid'] THEN
    RAISE EXCEPTION '125 postcheck: colunas de % fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(conname || ': ' || pg_get_constraintdef(oid) ORDER BY conname COLLATE "C"), ARRAY[]::text[]) FROM pg_constraint
       WHERE conrelid = to_regclass(t) AND contype <> 'n') IS DISTINCT FROM ARRAY[
      'area_familia_avisos_pagamento_estado_check: CHECK ((estado = ANY (ARRAY[''PENDENTE''::text, ''CONFERIDO''::text, ''DESCARTADO''::text])))',
      'area_familia_avisos_pagamento_observacao_check: CHECK (((observacao IS NULL) OR (((length(btrim(observacao)) >= 1) AND (length(btrim(observacao)) <= 280)) AND (observacao = btrim(observacao)))))',
      'area_familia_avisos_pagamento_parcela_id_fkey: FOREIGN KEY (parcela_id) REFERENCES pagamento_parcelas(id) ON DELETE RESTRICT',
      'area_familia_avisos_pagamento_parcela_numero_check: CHECK ((parcela_numero > 0))',
      'area_familia_avisos_pagamento_pessoa_fk: FOREIGN KEY (pessoa_id, festa_id, empresa_id) REFERENCES festa_pessoas(id, festa_id, empresa_id) ON DELETE RESTRICT',
      'area_familia_avisos_pagamento_pkey: PRIMARY KEY (id)',
      'area_familia_avisos_pagamento_saldo_centavos_check: CHECK (((saldo_centavos > 0) AND (saldo_centavos <= ''100000000000''::bigint)))',
      'area_familia_avisos_pagamento_tratado_por_usuario_id_fkey: FOREIGN KEY (tratado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT',
      'area_familia_avisos_pagamento_tratamento_check: CHECK ((((estado = ''PENDENTE''::text) AND (tratado_em IS NULL) AND (tratado_por_usuario_id IS NULL)) OR ((estado <> ''PENDENTE''::text) AND (tratado_em IS NOT NULL) AND (tratado_por_usuario_id IS NOT NULL))))']
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND contype <> 'n' AND NOT convalidated) THEN
    RAISE EXCEPTION '125 postcheck: constraints de % ausentes, a mais, não validadas ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_indexdef(indexrelid) ORDER BY pg_get_indexdef(indexrelid) COLLATE "C"), ARRAY[]::text[]) FROM pg_index
       WHERE indrelid = to_regclass(t)) IS DISTINCT FROM ARRAY[
      'CREATE INDEX area_familia_avisos_pagamento_festa_idx ON public.area_familia_avisos_pagamento USING btree (festa_id, criado_em DESC)',
      'CREATE UNIQUE INDEX area_familia_avisos_pagamento_pendente_uk ON public.area_familia_avisos_pagamento USING btree (parcela_id) WHERE (estado = ''PENDENTE''::text)',
      'CREATE UNIQUE INDEX area_familia_avisos_pagamento_pkey ON public.area_familia_avisos_pagamento USING btree (id)']
     OR EXISTS (SELECT 1 FROM pg_index WHERE indrelid = to_regclass(t) AND NOT (indisvalid AND indisready AND indislive)) THEN
    RAISE EXCEPTION '125 postcheck: índices de % ausentes, a mais, inválidos ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_triggerdef(oid) ORDER BY tgname COLLATE "C"), ARRAY[]::text[]) FROM pg_trigger
       WHERE tgrelid = to_regclass(t) AND NOT tgisinternal) IS DISTINCT FROM ARRAY[
      'CREATE TRIGGER area_familia_avisos_pagamento_validar_trg BEFORE INSERT OR DELETE OR UPDATE ON public.area_familia_avisos_pagamento FOR EACH ROW EXECUTE FUNCTION kidmais_125_aviso_pagamento_validar()']
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(t) AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION '125 postcheck: gatilhos de % ausentes, a mais, desligados ou fora do formato da 125', t;
  END IF;
  -- area_familia_aviso_empresa: colunas (ordem, tipo, NOT NULL, default), constraints validadas (FK com tabela, colunas e ON DELETE;
  -- CHECK com a expressão), índices válidos e gatilhos ligados: exatamente estes, nada a mais e nada a menos.
  t := 'public.area_familia_aviso_empresa';
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION '125 postcheck: tabela % ausente', t; END IF;
  IF (SELECT coalesce(array_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END
                || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum), ARRAY[]::text[])
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = to_regclass(t) AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM ARRAY[
      'empresa_id uuid NOT NULL',
      'texto text',
      'atualizado_por_usuario_id uuid NOT NULL',
      'atualizado_em timestamp with time zone NOT NULL DEFAULT now()'] THEN
    RAISE EXCEPTION '125 postcheck: colunas de % fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(conname || ': ' || pg_get_constraintdef(oid) ORDER BY conname COLLATE "C"), ARRAY[]::text[]) FROM pg_constraint
       WHERE conrelid = to_regclass(t) AND contype <> 'n') IS DISTINCT FROM ARRAY[
      'area_familia_aviso_empresa_atualizado_por_usuario_id_fkey: FOREIGN KEY (atualizado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT',
      'area_familia_aviso_empresa_empresa_id_fkey: FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT',
      'area_familia_aviso_empresa_pkey: PRIMARY KEY (empresa_id)',
      'area_familia_aviso_empresa_texto_check: CHECK (((texto IS NULL) OR (((length(btrim(texto)) >= 1) AND (length(btrim(texto)) <= 500)) AND (texto = btrim(texto)))))']
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND contype <> 'n' AND NOT convalidated) THEN
    RAISE EXCEPTION '125 postcheck: constraints de % ausentes, a mais, não validadas ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_indexdef(indexrelid) ORDER BY pg_get_indexdef(indexrelid) COLLATE "C"), ARRAY[]::text[]) FROM pg_index
       WHERE indrelid = to_regclass(t)) IS DISTINCT FROM ARRAY[
      'CREATE UNIQUE INDEX area_familia_aviso_empresa_pkey ON public.area_familia_aviso_empresa USING btree (empresa_id)']
     OR EXISTS (SELECT 1 FROM pg_index WHERE indrelid = to_regclass(t) AND NOT (indisvalid AND indisready AND indislive)) THEN
    RAISE EXCEPTION '125 postcheck: índices de % ausentes, a mais, inválidos ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_triggerdef(oid) ORDER BY tgname COLLATE "C"), ARRAY[]::text[]) FROM pg_trigger
       WHERE tgrelid = to_regclass(t) AND NOT tgisinternal) IS DISTINCT FROM ARRAY[
      'CREATE TRIGGER area_familia_aviso_empresa_atualizado_em_trg BEFORE UPDATE ON public.area_familia_aviso_empresa FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em()']
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(t) AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION '125 postcheck: gatilhos de % ausentes, a mais, desligados ou fora do formato da 125', t;
  END IF;
  -- festa_pendencias_familia: colunas (ordem, tipo, NOT NULL, default), constraints validadas (FK com tabela, colunas e ON DELETE;
  -- CHECK com a expressão), índices válidos e gatilhos ligados: exatamente estes, nada a mais e nada a menos.
  t := 'public.festa_pendencias_familia';
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION '125 postcheck: tabela % ausente', t; END IF;
  IF (SELECT coalesce(array_agg(attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END
                || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum), ARRAY[]::text[])
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = to_regclass(t) AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM ARRAY[
      'pendencia_id uuid NOT NULL',
      'festa_id uuid NOT NULL',
      'empresa_id uuid NOT NULL',
      'visivel boolean NOT NULL',
      'texto text NOT NULL',
      'atualizado_por_usuario_id uuid NOT NULL',
      'criado_em timestamp with time zone NOT NULL DEFAULT now()',
      'atualizado_em timestamp with time zone NOT NULL DEFAULT now()',
      'feito_em timestamp with time zone',
      'feito_por_pessoa_id uuid',
      'devolvido_em timestamp with time zone',
      'devolvido_por_usuario_id uuid'] THEN
    RAISE EXCEPTION '125 postcheck: colunas de % fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(conname || ': ' || pg_get_constraintdef(oid) ORDER BY conname COLLATE "C"), ARRAY[]::text[]) FROM pg_constraint
       WHERE conrelid = to_regclass(t) AND contype <> 'n') IS DISTINCT FROM ARRAY[
      'festa_pendencias_familia_atualizado_por_usuario_id_fkey: FOREIGN KEY (atualizado_por_usuario_id) REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT',
      'festa_pendencias_familia_devolvido_check: CHECK (((devolvido_em IS NULL) = (devolvido_por_usuario_id IS NULL)))',
      'festa_pendencias_familia_devolvido_por_usuario_id_fkey: FOREIGN KEY (devolvido_por_usuario_id) REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT',
      'festa_pendencias_familia_empresa_id_fkey: FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT',
      'festa_pendencias_familia_feito_check: CHECK (((feito_em IS NULL) = (feito_por_pessoa_id IS NULL)))',
      'festa_pendencias_familia_feito_devolvido_check: CHECK (((feito_em IS NULL) OR (devolvido_em IS NULL)))',
      'festa_pendencias_familia_pendencia_fk: FOREIGN KEY (festa_id, pendencia_id) REFERENCES festa_pendencias(festa_id, id) ON DELETE RESTRICT',
      'festa_pendencias_familia_pessoa_fk: FOREIGN KEY (feito_por_pessoa_id, festa_id, empresa_id) REFERENCES festa_pessoas(id, festa_id, empresa_id) ON DELETE RESTRICT',
      'festa_pendencias_familia_pkey: PRIMARY KEY (pendencia_id)',
      'festa_pendencias_familia_texto_check: CHECK ((((length(btrim(texto)) >= 1) AND (length(btrim(texto)) <= 280)) AND (texto = btrim(texto))))']
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(t) AND contype <> 'n' AND NOT convalidated) THEN
    RAISE EXCEPTION '125 postcheck: constraints de % ausentes, a mais, não validadas ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_indexdef(indexrelid) ORDER BY pg_get_indexdef(indexrelid) COLLATE "C"), ARRAY[]::text[]) FROM pg_index
       WHERE indrelid = to_regclass(t)) IS DISTINCT FROM ARRAY[
      'CREATE INDEX festa_pendencias_familia_festa_idx ON public.festa_pendencias_familia USING btree (festa_id)',
      'CREATE UNIQUE INDEX festa_pendencias_familia_pkey ON public.festa_pendencias_familia USING btree (pendencia_id)']
     OR EXISTS (SELECT 1 FROM pg_index WHERE indrelid = to_regclass(t) AND NOT (indisvalid AND indisready AND indislive)) THEN
    RAISE EXCEPTION '125 postcheck: índices de % ausentes, a mais, inválidos ou fora do formato da 125', t;
  END IF;
  IF (SELECT coalesce(array_agg(pg_get_triggerdef(oid) ORDER BY tgname COLLATE "C"), ARRAY[]::text[]) FROM pg_trigger
       WHERE tgrelid = to_regclass(t) AND NOT tgisinternal) IS DISTINCT FROM ARRAY[
      'CREATE TRIGGER festa_pendencias_familia_atualizado_em_trg BEFORE UPDATE ON public.festa_pendencias_familia FOR EACH ROW EXECUTE FUNCTION kidmais_set_atualizado_em()',
      'CREATE TRIGGER festa_pendencias_familia_validar_trg BEFORE INSERT OR DELETE OR UPDATE ON public.festa_pendencias_familia FOR EACH ROW EXECUTE FUNCTION kidmais_125_pendencia_familia_validar()']
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(t) AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION '125 postcheck: gatilhos de % ausentes, a mais, desligados ou fora do formato da 125', t;
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = to_regclass('public.area_familia_eventos') AND conname = 'area_familia_eventos_tipo_check' AND contype = 'c' AND convalidated)
     IS DISTINCT FROM 'CHECK ((tipo = ANY (ARRAY[''LINK_GERADO''::text, ''LINK_REVOGADO''::text, ''ENTRADA''::text, ''SAIR''::text, ''SAIR_DE_TODOS''::text, ''BUFFET_DESCONECTOU''::text, ''PESSOA_CADASTRADA''::text, ''PESSOA_REMOVIDA''::text, ''CONTATO_ALTERADO''::text, ''SESSOES_DERRUBADAS''::text, ''AVISO_PAGAMENTO''::text, ''AVISO_PAGAMENTO_TRATADO''::text, ''PENDENCIA_FEITA''::text, ''PENDENCIA_DEVOLVIDA''::text, ''PENDENCIA_VISIBILIDADE''::text, ''AVISO_FIXO''::text])))' THEN
    RAISE EXCEPTION '125 postcheck: CHECK de area_familia_eventos.tipo ausente ou fora do formato da 125';
  END IF;
  -- Gatilhos da 125 nas tabelas da 123: [tabela, nome, definição completa (eventos, colunas, função)], ligados.
  FOREACH g SLICE 1 IN ARRAY ARRAY[
      ['public.area_familia_eventos', 'area_familia_eventos_125_pessoas_trg',
       'CREATE TRIGGER area_familia_eventos_125_pessoas_trg BEFORE INSERT ON public.area_familia_eventos FOR EACH ROW EXECUTE FUNCTION kidmais_125_evento_pessoas_da_festa()'],
      ['public.festa_links_area', 'festa_links_area_125_autoria_trg',
       'CREATE TRIGGER festa_links_area_125_autoria_trg BEFORE INSERT ON public.festa_links_area FOR EACH ROW EXECUTE FUNCTION kidmais_125_link_por_pessoa()'],
      ['public.festa_pessoas', 'festa_pessoas_125_remocao_trg',
       'CREATE TRIGGER festa_pessoas_125_remocao_trg BEFORE UPDATE OF removido_por_pessoa_id, removido_por_usuario_id ON public.festa_pessoas FOR EACH ROW EXECUTE FUNCTION kidmais_125_remocao_por_pessoa()']] LOOP
    IF to_regclass(g[1]) IS NULL OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(g[1]) AND tgname = g[2] AND NOT tgisinternal
                    AND tgenabled = 'O' AND pg_get_triggerdef(oid) = g[3]) THEN
      RAISE EXCEPTION '125 postcheck: gatilho % ausente, desligado ou fora do formato da 125', g[2];
    END IF;
  END LOOP;
  -- Funções da 125: [assinatura, sha256 LF do corpo].
  FOREACH f SLICE 1 IN ARRAY ARRAY[
      ['public.kidmais_125_aviso_pagamento_validar()', '82a48a96dc50db0db67d227c9ff0591af161f1b2bd2a3722c8a766d5eabd3b50'],
      ['public.kidmais_125_contratante_ativo(uuid,uuid)', '0a2cb07178f82dc1d4c7d6466ea68ec7f1a914f9e20e49e397a0da129c9295e0'],
      ['public.kidmais_125_evento_pessoas_da_festa()', 'eb8464d2e45ff08c13909f8fd31f84de3343351374393dc2d5c0599e6aa7035a'],
      ['public.kidmais_125_link_por_pessoa()', 'b1449dd4ab817564aba10fc6baf9fa450ed4d4069656aa9993b5770b44cdbf45'],
      ['public.kidmais_125_pendencia_familia_validar()', '8b5e98279b8e758af29738e4f07db49d7bb268245229580ebfa038127736523e'],
      ['public.kidmais_125_pessoa_ativa(uuid,uuid)', 'de727ab3697038dec8513cfa69dbf2db9c7791a5ce224b5df3c27927727ef98c'],
      ['public.kidmais_125_remocao_por_pessoa()', '77a8af5924d1f00ae949791960916ead9fc7621e06cc73deed9504cb19d05e9e']] LOOP
    IF to_regprocedure(f[1]) IS NULL OR (SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') FROM pg_proc
         WHERE oid = to_regprocedure(f[1])) IS DISTINCT FROM f[2] THEN
      RAISE EXCEPTION '125 postcheck: função % ausente ou divergente da 125', f[1];
    END IF;
  END LOOP;
  -- Os gatilhos de atualizado_em usam a função existente do schema public (não uma homônima de outro schema).
  IF to_regprocedure('public.kidmais_set_atualizado_em()') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE tgfoid = to_regprocedure('public.kidmais_set_atualizado_em()') AND NOT tgisinternal
          AND tgname IN ('festa_pendencias_familia_atualizado_em_trg', 'area_familia_aviso_empresa_atualizado_em_trg')
          AND tgrelid IN (to_regclass('public.festa_pendencias_familia'), to_regclass('public.area_familia_aviso_empresa'))) <> 2 THEN
    RAISE EXCEPTION '125 postcheck: gatilhos de atualizado_em fora de public.kidmais_set_atualizado_em()';
  END IF;
END $$;
SELECT current_database() AS banco, true AS aprovado;
ROLLBACK;
