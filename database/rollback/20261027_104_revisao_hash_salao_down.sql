-- Rollback da 104. Só com autorização própria. Recusado (nada alterado) se QUALQUER revisão tiver hash_versao 2: o hash
-- dela inclui o salão e deixaria de bater com o corpo da 016. Volta ao corpo exato da 016 e confere que o hash de todas as
-- revisões (todas em 1) é idêntico antes e depois.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.fechamento_revisoes IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE f record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped) THEN
    RAISE EXCEPTION '104 rollback: 104 ausente; nada alterado';
  END IF;
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = 'fe0f0199883b0c9d994478a2aba4e92940bea0f52250ef2ea62462900615f6ed' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104 rollback: função de hash diferente da 104; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fechamento_revisoes WHERE hash_versao = 2) THEN
    RAISE EXCEPTION '104 rollback: há revisão com hash_versao 2; nada alterado';
  END IF;
END $$;
CREATE TEMP TABLE kidmais104_hash_antes ON COMMIT DROP AS
  SELECT r.id, public.kidmais_hash_revisao_operacional(r.id) AS hash FROM public.fechamento_revisoes r;
CREATE OR REPLACE FUNCTION kidmais_hash_revisao_operacional(rid uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('schemaVersao',1,'operacao',(jsonb_build_object('cliente_id',r.cliente_id,'responsavel_adicional_id',r.responsavel_adicional_id,'aniversariante_id',r.aniversariante_id,'idade_aniversariante_evento',r.idade_aniversariante_evento,'tema_festa',r.tema_festa,'data_evento',r.data_evento,'horario_inicio',r.horario_inicio,'horario_fim',r.horario_fim,'configuracao_agenda_id',r.configuracao_agenda_id,'pacote_id',r.pacote_id,'tabela_preco_id',r.tabela_preco_id,'preco_pacote_id',r.preco_pacote_id,'regra_desconto_pacote_id',r.regra_desconto_pacote_id,'categoria_horario',r.categoria_horario,'categoria_preco_aplicada',r.categoria_preco_aplicada,'convidados',r.convidados,'convidados_faturados',r.convidados_faturados,'valor_pacote_base',r.valor_pacote_base,'desconto_percentual',r.desconto_percentual,'valor_desconto_pacote',r.valor_desconto_pacote,'valor_pacote_aplicado',r.valor_pacote_aplicado,'valor_adicionais',r.valor_adicionais,'valor_tabela',r.valor_tabela,'valor_negociado',r.valor_negociado,'valor_aprovado',r.valor_aprovado,'motivo_negociacao',r.motivo_negociacao,'observacoes_negociacao',r.observacoes_negociacao,'forma_pagamento_pretendida',r.forma_pagamento_pretendida,'condicao_pagamento',r.condicao_pagamento,'alteracoes_pacote',r.alteracoes_pacote,'observacoes_cliente',r.observacoes_cliente,'observacoes_equipe',r.observacoes_equipe,'usuario_responsavel_id',r.usuario_responsavel_id,'buffet_status',r.buffet_status,'buffet_salgados',r.buffet_salgados,'buffet_bebidas',r.buffet_bebidas,'buffet_doces',r.buffet_doces,'buffet_bolo',r.buffet_bolo,'buffet_outros',r.buffet_outros) || jsonb_strip_nulls(jsonb_build_object('buffet_lembrancinha',r.buffet_lembrancinha,'buffet_empratado',r.buffet_empratado,'buffet_bombom',r.buffet_bombom))),'adicionais',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['id','fechamento_id','fechamento_revisao_id','criado_em','atualizado_em'] ORDER BY a.adicional_id) FROM public.fechamento_revisao_adicionais a WHERE a.fechamento_revisao_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex') FROM public.fechamento_revisoes r WHERE r.id=rid;
$$;
DROP TRIGGER kidmais104_hash_versao_imutavel ON public.fechamento_revisoes;
DROP FUNCTION public.kidmais104_hash_versao_imutavel();
ALTER TABLE public.fechamento_revisoes DROP CONSTRAINT fechamento_revisoes_hash_versao_ck;
ALTER TABLE public.fechamento_revisoes DROP COLUMN hash_versao;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM (SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS corpo, p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AS sql_lang,
             p.provolatile::text AS vol, p.proconfig IS NULL AS sem_config, NOT p.prosecdef AS invoker, p.prorettype = 'text'::regtype AS ret,
             p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')) x;
  IF f.corpo IS NULL OR NOT (f.corpo = '9986a2a6bad41a28ac036c8e59b6358e6f75bda680781c97896eff180bed940f' AND f.sql_lang AND f.vol = 's' AND f.sem_config AND f.invoker AND f.ret AND f.kind = 'f') THEN
    RAISE EXCEPTION '104 rollback: corpo da 016 não restaurado';
  END IF;
  IF EXISTS (SELECT 1 FROM kidmais104_hash_antes a WHERE a.hash IS DISTINCT FROM public.kidmais_hash_revisao_operacional(a.id)) THEN
    RAISE EXCEPTION '104 rollback: hash de revisão mudou';
  END IF;
END $$;
COMMIT;
