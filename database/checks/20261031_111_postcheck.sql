-- Postcheck da 111 (links de avaliação e auditoria da pesquisa): somente leitura; qualquer divergência interrompe.
-- Os gatilhos são identificados pela relação (tgrelid), pela função (tgfoid, por assinatura), pela habilitação e pelo
-- evento/nível (tgtype: 1 linha, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE). É o MESMO manifesto do detector
-- por requisição (lib/satisfacao/instalacao.ts, OBJETOS_111); um teste estático confere que os dois coincidem.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
      ('kidmais111_link_guarda()'), ('kidmais111_auditoria_somente_insercao()'), ('kidmais111_auditoria_coerencia()')) AS f(assinatura) LOOP
    IF to_regprocedure('public.' || item.assinatura) IS NULL THEN RAISE EXCEPTION 'postcheck 111: função % ausente', item.assinatura; END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES ('satisfacao_links_avaliacao'), ('satisfacao_auditoria')) AS t(tabela) LOOP
    IF to_regclass('public.' || item.tabela) IS NULL THEN RAISE EXCEPTION 'postcheck 111: tabela % ausente', item.tabela; END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
      ('satisfacao_links_guarda', 'satisfacao_links_avaliacao', 'kidmais111_link_guarda()', 19),
      ('satisfacao_auditoria_imutavel', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 27),
      ('satisfacao_auditoria_truncate', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 34),
      ('satisfacao_auditoria_coerencia', 'satisfacao_auditoria', 'kidmais111_auditoria_coerencia()', 7)) AS g(nome, tabela, funcao, tipo) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = item.nome AND NOT tg.tgisinternal
                     AND tg.tgrelid = to_regclass('public.' || item.tabela) AND tg.tgfoid = to_regprocedure('public.' || item.funcao)
                     AND tg.tgenabled IN ('O', 'A') AND tg.tgtype = item.tipo) THEN
      RAISE EXCEPTION 'postcheck 111: gatilho % ausente, desligado, em outra relação, com outra função ou outro evento/nível', item.nome;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
      ('satisfacao_links_uk', 'satisfacao_links_avaliacao', 'u'), ('satisfacao_links_unidade_fk', 'satisfacao_links_avaliacao', 'f'),
      ('satisfacao_links_url', 'satisfacao_links_avaliacao', 'c'),
      ('satisfacao_auditoria_unidade_fk', 'satisfacao_auditoria', 'f'), ('satisfacao_auditoria_tarefa_fk', 'satisfacao_auditoria', 'f'),
      ('satisfacao_auditoria_acao', 'satisfacao_auditoria', 'c'), ('satisfacao_auditoria_nulidade', 'satisfacao_auditoria', 'c'),
      ('satisfacao_auditoria_urls', 'satisfacao_auditoria', 'c')) AS r(nome, tabela, tipo) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.nome AND conrelid = to_regclass('public.' || item.tabela) AND contype = item.tipo::"char" AND convalidated) THEN
      RAISE EXCEPTION 'postcheck 111: restrição % ausente, em outra relação ou não validada', item.nome;
    END IF;
  END LOOP;
  -- A unicidade trata a unidade NULL (link da empresa) como igual: um só link da empresa.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint co JOIN pg_index i ON i.indexrelid = co.conindid
                  WHERE co.conname = 'satisfacao_links_uk' AND i.indnullsnotdistinct) THEN
    RAISE EXCEPTION 'postcheck 111: satisfacao_links_uk sem NULLS NOT DISTINCT';
  END IF;
  -- FKs com RESTRICT nas duas ações; a da unidade em MATCH SIMPLE (s).
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('satisfacao_links_unidade_fk', 'satisfacao_auditoria_unidade_fk', 'satisfacao_auditoria_tarefa_fk')
        AND contype = 'f' AND confupdtype = 'r' AND confdeltype = 'r' AND confmatchtype = 's' AND cardinality(conkey) = 2) <> 3 THEN
    RAISE EXCEPTION 'postcheck 111: FKs compostas sem RESTRICT ou fora de MATCH SIMPLE';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND ((table_name = 'satisfacao_links_avaliacao' AND column_name IN ('empresa_id', 'url', 'criado_por', 'atualizado_por'))
                 OR (table_name = 'satisfacao_auditoria' AND column_name IN ('empresa_id', 'ator_usuario_id', 'acao', 'criado_em')))
               AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'postcheck 111: coluna obrigatória aceita NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'satisfacao_auditoria' AND column_name = 'criado_em' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'postcheck 111: criado_em da auditoria não pode ter default (instante decisório do serviço)';
  END IF;
END $$;
