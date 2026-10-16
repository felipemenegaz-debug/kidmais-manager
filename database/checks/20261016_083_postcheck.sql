-- 083 postcheck (somente leitura). Confere pelo catálogo as DEFINIÇÕES dos objetos da 083, não só os nomes (R2 do
-- parecer independente de 16/10/2026): tipo e FK das colunas; expressão dos CHECKs na tabela certa; unicidade, validade,
-- método, colunas e predicado dos índices; gatilhos efetivamente ligados às tabelas (habilitados, BEFORE UPDATE OR
-- DELETE FOR EACH ROW, sem WHEN nem lista de colunas, na função certa); corpo das funções (md5 do prosrc, CR ignorado).
-- Objeto homônimo com definição diferente reprova. Expressões comparadas na forma de pg_get_expr.
DO $$
DECLARE
  t record;
  i record;
  g record;
  att_empresa smallint;
  tipo text;
  att_empresas_id smallint;
BEGIN
  IF to_regclass('public.whatsapp_conexoes') IS NULL OR to_regclass('public.whatsapp_onboarding_tentativas') IS NULL OR to_regclass('public.empresas') IS NULL THEN
    RAISE EXCEPTION '083 postcheck: tabelas da 018/031 ausentes.';
  END IF;
  SELECT attnum INTO att_empresas_id FROM pg_attribute WHERE attrelid = 'public.empresas'::regclass AND attname = 'id' AND NOT attisdropped;

  -- Colunas empresa_id (uuid) e FK validada para empresas(id), em cada tabela.
  FOR t IN SELECT v.rel FROM (VALUES ('public.whatsapp_conexoes'::regclass), ('public.whatsapp_onboarding_tentativas'::regclass)) v(rel) LOOP
    SELECT a.attnum, format_type(a.atttypid, a.atttypmod) INTO att_empresa, tipo
      FROM pg_attribute a WHERE a.attrelid = t.rel AND a.attname = 'empresa_id' AND NOT a.attisdropped;
    IF NOT FOUND OR tipo IS DISTINCT FROM 'uuid' THEN
      RAISE EXCEPTION '083 postcheck: coluna empresa_id ausente ou com tipo diferente de uuid em %.', t.rel;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = t.rel AND k.contype = 'f' AND k.confrelid = 'public.empresas'::regclass
          AND k.conkey = ARRAY[att_empresa]::smallint[] AND k.confkey = ARRAY[att_empresas_id]::smallint[]
          AND k.convalidated AND coalesce((to_jsonb(k) ->> 'conenforced')::boolean, true)) THEN
      RAISE EXCEPTION '083 postcheck: FK de empresa_id para empresas(id) ausente ou inválida em %.', t.rel;
    END IF;
  END LOOP;

  -- CHECKs (NOT VALID por desenho: valem para linhas novas) com a expressão exata, na tabela certa e em vigor.
  FOR i IN SELECT * FROM (VALUES
      ('whatsapp_conexoes_empresa_obrigatoria_check', 'public.whatsapp_conexoes'::regclass,
       '((status <> ''CONFIGURADA''::text) OR (empresa_id IS NOT NULL))'),
      ('whatsapp_tentativas_empresa_obrigatoria_check', 'public.whatsapp_onboarding_tentativas'::regclass,
       '((empresa_id IS NOT NULL) OR (status = ANY (ARRAY[''CONCLUIDA''::text, ''EXPIRADA''::text, ''RECUSADA''::text, ''FALHOU''::text])))')
    ) v(nome, rel, expr) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = i.rel AND k.conname = i.nome AND k.contype = 'c'
          AND pg_get_expr(k.conbin, k.conrelid) = i.expr AND coalesce((to_jsonb(k) ->> 'conenforced')::boolean, true)) THEN
      RAISE EXCEPTION '083 postcheck: CHECK % ausente, em outra tabela ou com expressão diferente da 083.', i.nome;
    END IF;
  END LOOP;

  -- Índices únicos, válidos, btree, sem expressões, com as colunas e o predicado exatos.
  FOR i IN SELECT * FROM (VALUES
      ('whatsapp_conexoes_empresa_configurada_uk', 'public.whatsapp_conexoes'::regclass, ARRAY['ambiente', 'empresa_id'],
       '((status = ''CONFIGURADA''::text) AND (empresa_id IS NOT NULL))'),
      ('whatsapp_conexoes_plataforma_configurada_uk', 'public.whatsapp_conexoes'::regclass, ARRAY['ambiente'],
       '((status = ''CONFIGURADA''::text) AND (empresa_id IS NULL))'),
      ('whatsapp_conexoes_numero_configurado_uk', 'public.whatsapp_conexoes'::regclass, ARRAY['ambiente', 'phone_number_id'],
       '(status = ''CONFIGURADA''::text)'),
      ('whatsapp_tentativas_empresa_ativa_uk', 'public.whatsapp_onboarding_tentativas'::regclass, ARRAY['ambiente', 'empresa_id'],
       '((status = ANY (ARRAY[''INICIADA''::text, ''VALIDANDO''::text])) AND (empresa_id IS NOT NULL))')
    ) v(nome, rel, cols, pred) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index x
          JOIN pg_class ic ON ic.oid = x.indexrelid
          JOIN pg_am am ON am.oid = ic.relam
        WHERE ic.relname = i.nome AND ic.relnamespace = 'public'::regnamespace AND x.indrelid = i.rel
          AND x.indisunique AND x.indisvalid AND x.indisready AND x.indislive AND am.amname = 'btree' AND x.indexprs IS NULL
          AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) = i.cols
          AND pg_get_expr(x.indpred, x.indrelid) = i.pred) THEN
      RAISE EXCEPTION '083 postcheck: índice % ausente, não único, inválido ou com colunas/predicado diferentes da 083.', i.nome;
    END IF;
  END LOOP;
  IF to_regclass('public.whatsapp_conexoes_ambiente_configurada_uk') IS NOT NULL THEN
    RAISE EXCEPTION '083 postcheck: índice antigo (um por ambiente) ainda presente.';
  END IF;

  -- Gatilhos efetivamente ligados às tabelas (tgtype 27 = ROW + BEFORE + DELETE + UPDATE) e corpo das funções.
  FOR g IN SELECT * FROM (VALUES
      ('whatsapp_conexoes_proteger_trg', 'public.whatsapp_conexoes'::regclass,
       to_regprocedure('public.kidmais_whatsapp_conexao_proteger()'), '077c3cdd9fb3dce1d07f5b56702dd052'),
      ('whatsapp_tentativas_proteger_trg', 'public.whatsapp_onboarding_tentativas'::regclass,
       to_regprocedure('public.kidmais_whatsapp_tentativa_proteger()'), 'ea1261ae1a08d4ee9afa2101b9fee85b')
    ) v(nome, rel, fn, corpo) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = g.rel AND tg.tgname = g.nome AND NOT tg.tgisinternal AND tg.tgenabled IN ('O', 'A')
          AND tg.tgfoid = g.fn AND tg.tgtype = 27 AND tg.tgqual IS NULL AND cardinality(tg.tgattr::int2[]) = 0) THEN
      RAISE EXCEPTION '083 postcheck: gatilho % ausente, desligado ou com definição diferente da 083.', g.nome;
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.oid = g.fn AND l.lanname = 'plpgsql' AND NOT p.prosecdef) IS DISTINCT FROM g.corpo THEN
      RAISE EXCEPTION '083 postcheck: função do gatilho % diferente da 083.', g.nome;
    END IF;
  END LOOP;

  RAISE NOTICE '083 postcheck OK: conexões por empresa = %, da plataforma (sem empresa) = %',
    (SELECT count(*) FROM whatsapp_conexoes WHERE empresa_id IS NOT NULL),
    (SELECT count(*) FROM whatsapp_conexoes WHERE empresa_id IS NULL);
END $$;
