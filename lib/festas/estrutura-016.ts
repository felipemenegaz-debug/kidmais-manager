/** Contrato físico da 016. Não inclui nome do banco, OIDs, proprietários ou dados. */
export const tabelasFesta016 = ['festas','festa_areas','festa_usuario_capacidades','festa_tarefas','festa_pendencias','festa_buffet','festa_contagens_convidados','festa_solicitacoes','festa_eventos'];
export const estruturaFesta016Sql = `
WITH tabelas AS (
 SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])
), colunas AS (
 SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) tipo,CASE WHEN (c.relname='festas' AND a.attname='criado_por') OR (c.relname='festa_eventos' AND a.attname='usuario_id') THEN true ELSE a.attnotnull END attnotnull,a.attidentity,
 pg_get_expr(d.adbin,d.adrelid) valor_padrao
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 AND NOT ((c.relname='festas' AND a.attname='origem_criacao') OR (c.relname='festa_eventos' AND a.attname='ator_tipo'))
 AND (c.relname=ANY($1::text[]) OR (c.relname IN ('fechamentos','fechamento_revisoes') AND a.attname IN ('buffet_lembrancinha','buffet_empratado','buffet_bombom')))
), restricoes AS (
 SELECT r.relname,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) definicao
 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
 WHERE n.nspname='public' AND c.conname NOT LIKE 'festa019_%'
 AND NOT (c.contype='n' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum=ANY(c.conkey) AND ((r.relname='festas' AND a.attname='origem_criacao') OR (r.relname='festa_eventos' AND a.attname='ator_tipo')))) AND (r.relname=ANY($1::text[]) OR (r.relname IN ('fechamentos','fechamento_revisoes') AND c.conname IN ('fechamentos_buffet_lembrancinha_check','fechamentos_buffet_empratado_check','fechamentos_buffet_bombom_check','fechamento_revisoes_buffet_lembrancinha_check','fechamento_revisoes_buffet_empratado_check','fechamento_revisoes_buffet_bombom_check')))
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
SELECT encode(sha256(convert_to(documento::text,'UTF8')),'hex') assinatura FROM contrato`;

// Obtida exclusivamente do clone com aplicação limpa + postcheck da migration final.
export const assinaturaEstruturaFesta016 = "d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7";
