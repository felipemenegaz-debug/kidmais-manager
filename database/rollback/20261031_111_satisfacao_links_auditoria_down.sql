-- Rollback da 111 (links de avaliação e auditoria da pesquisa). NÃO EXECUTAR sem autorização explícita
-- (docs/OPERACAO_AGENTES.md).
--
-- Procedimento (plano PS-3, F'): (1) código de volta ao da PS-2 ou SATISFACAO_PESQUISA_ENABLED diferente de "true";
-- (2) quiescência — nenhuma requisição ou escritor em curso; (3) captura em CSV de satisfacao_links_avaliacao e
-- satisfacao_auditoria; (4) este down, na MESMA sessão em que a captura foi confirmada:
--     SET kidmais111.captura_confirmada = 'sim';
-- Sem a captura confirmada, o down recusa se houver qualquer linha: ele APAGA a configuração e a auditoria (não é
-- reversão sem perda). Restauração: reaplicar a 111 e importar as linhas capturadas como estão (sem gerar eventos).
-- Sem CASCADE; não toca na 110.
--
-- Integridade (PS-3 r2): o down só remove uma 111 COMPLETA, conferida com o MESMO manifesto do detector por requisição
-- e do postcheck (lib/satisfacao/instalacao.ts, OBJETOS_111; um teste estático confere as três listas). AUSENTE (nenhum
-- objeto) e PARCIAL (qualquer subconjunto: só uma tabela, funções sem tabelas, gatilho desligado/ausente, restrição
-- ausente) recusam ANTES de qualquer remoção; a conferência é repetida depois do LOCK.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE FUNCTION pg_temp.kidmais111_integridade(OUT presentes int, OUT total int) LANGUAGE sql STABLE AS $f$
  WITH itens(ok) AS (
    SELECT to_regclass('public.' || t.tabela) IS NOT NULL
      FROM (VALUES ('satisfacao_links_avaliacao'), ('satisfacao_auditoria')) AS t(tabela)
    UNION ALL
    SELECT to_regprocedure('public.' || f.assinatura) IS NOT NULL
      FROM (VALUES ('kidmais111_link_guarda()'), ('kidmais111_auditoria_somente_insercao()'), ('kidmais111_auditoria_coerencia()')) AS f(assinatura)
    UNION ALL
    SELECT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = g.nome AND NOT tg.tgisinternal
                     AND tg.tgrelid = to_regclass('public.' || g.tabela) AND tg.tgfoid = to_regprocedure('public.' || g.funcao)
                     AND tg.tgenabled IN ('O', 'A') AND tg.tgtype = g.tipo)
      FROM (VALUES
        ('satisfacao_links_guarda', 'satisfacao_links_avaliacao', 'kidmais111_link_guarda()', 19),
        ('satisfacao_auditoria_imutavel', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 27),
        ('satisfacao_auditoria_truncate', 'satisfacao_auditoria', 'kidmais111_auditoria_somente_insercao()', 34),
        ('satisfacao_auditoria_coerencia', 'satisfacao_auditoria', 'kidmais111_auditoria_coerencia()', 7)) AS g(nome, tabela, funcao, tipo)
    UNION ALL
    SELECT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conname = r.nome AND co.conrelid = to_regclass('public.' || r.tabela)
                     AND co.contype = r.tipo::"char" AND co.convalidated)
      FROM (VALUES
        ('satisfacao_links_uk', 'satisfacao_links_avaliacao', 'u'), ('satisfacao_links_unidade_fk', 'satisfacao_links_avaliacao', 'f'),
        ('satisfacao_links_url', 'satisfacao_links_avaliacao', 'c'),
        ('satisfacao_auditoria_unidade_fk', 'satisfacao_auditoria', 'f'), ('satisfacao_auditoria_tarefa_fk', 'satisfacao_auditoria', 'f'),
        ('satisfacao_auditoria_acao', 'satisfacao_auditoria', 'c'), ('satisfacao_auditoria_nulidade', 'satisfacao_auditoria', 'c'),
        ('satisfacao_auditoria_urls', 'satisfacao_auditoria', 'c')) AS r(nome, tabela, tipo)
    UNION ALL
    SELECT EXISTS (SELECT 1 FROM pg_constraint co JOIN pg_index i ON i.indexrelid = co.conindid WHERE co.conname = 'satisfacao_links_uk'
                     AND co.conrelid = to_regclass('public.satisfacao_links_avaliacao') AND i.indnullsnotdistinct)
  )
  SELECT (count(*) FILTER (WHERE ok))::int, count(*)::int FROM itens
$f$;

DO $$ DECLARE e record; BEGIN
  SELECT * INTO e FROM pg_temp.kidmais111_integridade();
  IF e.presentes = 0 THEN RAISE EXCEPTION '111 ausente: nada a remover.'; END IF;
  IF e.presentes <> e.total THEN
    RAISE EXCEPTION '111 parcial (% de % objetos íntegros): nada removido; restaure a instalação ou trate os objetos à mão, depois de capturar o que existir.', e.presentes, e.total;
  END IF;
END $$;

LOCK TABLE satisfacao_links_avaliacao, satisfacao_auditoria IN ACCESS EXCLUSIVE MODE;

DO $$ DECLARE e record; BEGIN
  SELECT * INTO e FROM pg_temp.kidmais111_integridade();
  IF e.presentes <> e.total THEN RAISE EXCEPTION '111 parcial depois do LOCK (% de %): nada removido.', e.presentes, e.total; END IF;
END $$;

DO $$ BEGIN
  IF (EXISTS (SELECT 1 FROM satisfacao_links_avaliacao) OR EXISTS (SELECT 1 FROM satisfacao_auditoria))
     AND coalesce(current_setting('kidmais111.captura_confirmada', true), '') <> 'sim' THEN
    RAISE EXCEPTION '111: há links ou auditoria; capture e confirme (kidmais111.captura_confirmada) antes do down.';
  END IF;
END $$;

DROP TABLE satisfacao_auditoria;
DROP TABLE satisfacao_links_avaliacao;
DROP FUNCTION kidmais111_auditoria_coerencia(), kidmais111_auditoria_somente_insercao(), kidmais111_link_guarda();
DROP FUNCTION pg_temp.kidmais111_integridade();

COMMIT;
