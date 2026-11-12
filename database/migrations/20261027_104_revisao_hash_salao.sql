-- 104: hash da revisão operacional com o salão do destino (fase S-E do fluxo "cliente com 2 salões"; plano S-E/S-D
-- rev. 4.1 aprovado pelo Astra em 27/10/2026, R4-E1 e R41-1..R41-4).
--   * fechamento_revisoes.hash_versao (1 ou 2, imutável depois do INSERT). Toda revisão existente fica em 1 sem tocar em
--     nenhum valor; só a criação de uma revisão nova em agenda POR_SALAO grava 2 (código da S-E).
--   * kidmais_hash_revisao_operacional: com hash_versao = 1 devolve o MESMO texto de hoje (corpo da 016 + um objeto vazio
--     concatenado à operação, que não muda o jsonb); com 2 acrescenta 'salao_id' à operação. Mesmo nome, assinatura,
--     LANGUAGE sql STABLE e SEM SET search_path (proconfig nulo), como na 016; o validador diferido da 016 segue igual.
--   * substitui uma função existente: o precheck exige o corpo exato da 016 (sha256 9986a2a6bad41a28ac036c8e59b6358e6f75bda680781c97896eff180bed940f, sem CR) e a
--     transação confere que o hash de TODAS as revisões existentes é idêntico antes e depois da troca.
-- Rollback: database/rollback/20261027_104_revisao_hash_salao_down.sql (recusado com qualquer revisão em hash_versao 2).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.fechamento_revisoes IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE f record;
BEGIN
  IF to_regclass('public.fechamento_revisoes') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass
       AND attname = 'salao_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '104: precheck falhou (094 ausente: fechamento_revisoes.salao_id); nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped)
     OR to_regprocedure('public.kidmais104_hash_versao_imutavel()') IS NOT NULL THEN
    RAISE EXCEPTION '104: precheck falhou (já aplicada ou parcial); nada alterado';
  END IF;
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = '9986a2a6bad41a28ac036c8e59b6358e6f75bda680781c97896eff180bed940f' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104: precheck falhou (kidmais_hash_revisao_operacional diferente da 016); nada alterado';
  END IF;
END $$;
CREATE TEMP TABLE kidmais104_hash_antes ON COMMIT DROP AS
  SELECT r.id, public.kidmais_hash_revisao_operacional(r.id) AS hash FROM public.fechamento_revisoes r;
ALTER TABLE public.fechamento_revisoes ADD COLUMN hash_versao smallint NOT NULL DEFAULT 1;
ALTER TABLE public.fechamento_revisoes ADD CONSTRAINT fechamento_revisoes_hash_versao_ck CHECK (hash_versao IN (1, 2));
CREATE FUNCTION public.kidmais104_hash_versao_imutavel() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.hash_versao IS DISTINCT FROM OLD.hash_versao THEN
    RAISE EXCEPTION '104: a versão do hash da revisão não muda depois de criada' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER kidmais104_hash_versao_imutavel BEFORE UPDATE ON public.fechamento_revisoes
  FOR EACH ROW EXECUTE FUNCTION public.kidmais104_hash_versao_imutavel();
CREATE OR REPLACE FUNCTION kidmais_hash_revisao_operacional(rid uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',(jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',r.buffet_lembrancinha,'buffet_empratado',r.buffet_empratado,'buffet_bombom',r.buffet_bombom)) || CASE WHEN r.hash_versao = 2 THEN jsonb_build_object('salao_id',r.salao_id) ELSE '{}'::jsonb END),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex') FROM public.fechamento_revisoes r WHERE r.id=rid;
$$;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = 'fe0f0199883b0c9d994478a2aba4e92940bea0f52250ef2ea62462900615f6ed' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104: postcheck falhou (corpo da função de hash)';
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = 'public.fechamento_revisoes'::regclass AND a.attname = 'hash_versao' AND NOT a.attisdropped
                   AND a.atttypid = 'smallint'::regtype AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = '1')
     AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.fechamento_revisoes'::regclass AND c.contype = 'c'
            AND c.conname = 'fechamento_revisoes_hash_versao_ck' AND c.convalidated AND NOT c.connoinherit
            AND pg_get_constraintdef(c.oid) = 'CHECK ((hash_versao = ANY (ARRAY[1, 2])))'
            AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao')]::int2[]) = 1
     AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                 WHERE t.tgrelid = 'public.fechamento_revisoes'::regclass AND t.tgname = 'kidmais104_hash_versao_imutavel' AND NOT t.tgisinternal
                   AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.tgattr::text = '' AND t.tgqual IS NULL AND t.tgnargs = 0
                   AND t.tgconstraint = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
                   AND p.oid = to_regprocedure('public.kidmais104_hash_versao_imutavel()') AND p.pronamespace = 'public'::regnamespace
                   AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.provolatile = 'v' AND NOT p.prosecdef
                   AND p.proconfig = ARRAY['search_path=public, pg_catalog']
                   AND encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') = '182ead96ac34a0abcd6251d500bb3b5705657301fe915a6addd19f82b432ec85')) THEN
    RAISE EXCEPTION '104: postcheck falhou (coluna, restrição ou gatilho de hash_versao)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fechamento_revisoes WHERE hash_versao <> 1)
     OR (SELECT count(*) FROM kidmais104_hash_antes) <> (SELECT count(*) FROM public.fechamento_revisoes)
     OR EXISTS (SELECT 1 FROM kidmais104_hash_antes a WHERE a.hash IS DISTINCT FROM public.kidmais_hash_revisao_operacional(a.id)) THEN
    RAISE EXCEPTION '104: postcheck falhou (hash de revisão existente mudou)';
  END IF;
END $$;
COMMIT;
