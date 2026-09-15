BEGIN READ ONLY;
DO $check$ BEGIN
 IF NOT (WITH esperadas(nome,hash) AS (VALUES ('kidmais019_formalizacao','ef21416cd23e5a2d59c486abc83470ca47dc30a2ef8501b488d216c88804fa25'),
('kidmais019_ocupa','87131946b52479651484ec9076ce264243e79867ab2bc1f02447c6a2eb0599a3'),
('kidmais_ocupacoes_operacionais','2257c1df5a299a86d60a59b8606e432715dd10d713e4659f370934dcf483be91'),
('kidmais019_bloquear_contrato','c53da9b53ef20f045ab259d1aa64ef08b6c093d57876812ece2b8fcce5bf836a'),
('kidmais019_validar_destino','2ace64d66008e23d1947b7ba13d1241934554c8886984515d4ca8f776b24886b'),
('kidmais019_lock_ocupacao','eb5f187f7ef5e7a499413d71cc1a0c5023d65080920997248a7f5d1947460880'),
('kidmais019_validar_contrato','f8f40ebe64775e96e93e3847ef78a312792956ebb0f1e2b873800af9536a810b'),
('kidmais019_proteger_invalidacao','367f9e8df878a2efd8c25513989e15893e236ba637319b565660831685236871'),
('kidmais_proteger_bloqueio_revisao','7b4639279130207c1d3129c463017ebd2468e0aa099c9ba8d5c7de338cdd0871'),
('kidmais_validar_agenda_revisao','997158485f6dc9595cf6045594b220206c59c31b631bc164aad3956963875e89')),
gatilhos(nome,tabela,funcao,diferido) AS (VALUES ('festa019_lock_fechamento','fechamentos','kidmais019_lock_ocupacao',false),
('festa019_lock_contrato','contratos','kidmais019_lock_ocupacao',false),
('festa019_lock_fluxo','contrato_fluxos','kidmais019_lock_ocupacao',false),
('festa019_lock_revisao','fechamento_revisoes','kidmais019_lock_ocupacao',false),
('festa019_contrato','contratos','kidmais019_validar_contrato',true),
('festa019_fluxo','contrato_fluxos','kidmais019_validar_contrato',true),
('festa019_fechamento','fechamentos','kidmais019_validar_contrato',true),
('festa019_festa','festas','kidmais019_validar_contrato',true),
('festa019_invalidacao','festas','kidmais019_proteger_invalidacao',false))
SELECT
 NOT EXISTS(SELECT 1 FROM esperadas e WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=e.nome AND NOT p.prosecdef
 AND encode(sha256(convert_to(replace(p.prosrc,E'\r',''),'UTF8')),'hex')=e.hash))
 AND NOT EXISTS(SELECT 1 FROM gatilhos g WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE t.tgname=g.nome AND t.tgrelid=to_regclass('public.'||g.tabela) AND p.proname=g.funcao AND t.tgenabled='O'
 AND t.tgdeferrable=g.diferido AND t.tginitdeferred=g.diferido AND t.tgtype=CASE WHEN g.diferido THEN 21 ELSE 23 END))
 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND
 ((table_name='festas' AND column_name='origem_criacao') OR (table_name='festa_eventos' AND column_name='ator_tipo'))
 AND data_type='text' AND is_nullable='NO')=2
 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND
 ((table_name='festas' AND column_name='criado_por') OR (table_name='festa_eventos' AND column_name='usuario_id'))
 AND is_nullable='YES')=2
 AND (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace
 AND conname IN ('festa019_autoria_check','festa019_evento_autoria_check') AND convalidated)=2) THEN RAISE EXCEPTION 'Postcheck 019: instalação divergente'; END IF;
 IF (
WITH tabelas AS (
 SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[])
), colunas AS (
 SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) tipo,CASE WHEN (c.relname='festas' AND a.attname='criado_por') OR (c.relname='festa_eventos' AND a.attname='usuario_id') THEN true ELSE a.attnotnull END attnotnull,a.attidentity,
 pg_get_expr(d.adbin,d.adrelid) valor_padrao
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 AND NOT ((c.relname='festas' AND a.attname='origem_criacao') OR (c.relname='festa_eventos' AND a.attname='ator_tipo'))
 AND (c.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (c.relname IN ('fechamentos','fechamento_revisoes') AND a.attname IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom')))
), restricoes AS (
 SELECT r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) definicao
 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
 WHERE n.nspname='public' AND c.conname NOT LIKE 'festa019_%'
 AND NOT (c.contype='n' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum=ANY(c.conkey) AND ((r.relname='festas' AND a.attname='origem_criacao') OR (r.relname='festa_eventos' AND a.attname='ator_tipo')))) AND (r.relname=ANY(ARRAY['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos']::text[]) OR (r.relname IN ('fechamentos','fechamento_revisoes') AND c.conname IN ('fechamentos_buffet_lembrancinha_check','fechamentos_buffet_empratado_check','fechamentos_buffet_bombom_check','fechamento_revisoes_buffet_lembrancinha_check','fechamento_revisoes_buffet_empratado_check','fechamento_revisoes_buffet_bombom_check')))
 UNION ALL
 SELECT b.relname,b.conname,b.contype::"char",b.convalidated,b.condeferrable,b.condeferred,b.definicao
 FROM jsonb_to_recordset(COALESCE((SELECT col_description(a.attrelid,a.attnum)
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.festas') AND a.attname='origem_criacao' AND NOT a.attisdropped),'[]')::jsonb)
 AS b(relname name,conname name,contype text,convalidated boolean,condeferrable boolean,condeferred boolean,definicao text)
), indices AS (
 SELECT t.relname,c.relname nome,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definicao
 FROM pg_index i JOIN tabelas t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
), gatilhos AS (
 SELECT t.relname,g.tgname,g.tgenabled,pg_get_triggerdef(g.oid) definicao FROM pg_trigger g JOIN tabelas t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal AND g.tgname NOT LIKE 'festa019_%'
), funcoes AS (
 SELECT p.proname,replace(pg_get_functiondef(p.oid),chr(13),'') definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND (p.proname LIKE 'festa016_%' OR p.proname IN ('kidmais_hash_revisao_operacional','kidmais_validar_revisao_operacional','kidmais_proteger_fechamento_em_revisao'))
), contrato AS (
 SELECT jsonb_build_object(
 'tabelas',(SELECT jsonb_agg(relname ORDER BY relname) FROM tabelas),
 'colunas',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,attname) FROM colunas c),
 'restricoes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relname,conname) FROM restricoes c),
 'indices',(SELECT jsonb_agg(to_jsonb(i) ORDER BY relname,nome) FROM indices i),
 'gatilhos',(SELECT jsonb_agg(to_jsonb(g) ORDER BY relname,tgname) FROM gatilhos g),
 'funcoes',(SELECT jsonb_agg(to_jsonb(f) ORDER BY proname,definicao) FROM funcoes f),
 'estrutura_descartada',to_regclass('public.festa_ocorrencias') IS NOT NULL
 ) AS documento
)
SELECT encode(sha256(convert_to(documento::text,'UTF8')),'hex') assinatura FROM contrato) <> 'd723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7' THEN RAISE EXCEPTION 'Postcheck 019: baseline 016 divergente'; END IF;
END $check$;
-- Report only: old contracts need explicit reconciliation.
SELECT c.id contrato_id,cf.versao_vigente_id FROM public.contratos c
LEFT JOIN public.contrato_fluxos cf ON cf.contrato_id=c.id
WHERE c.status='ASSINADO' AND NOT EXISTS(SELECT 1 FROM public.festas f WHERE f.contrato_id=c.id AND f.invalidada_em IS NULL);
COMMIT;
