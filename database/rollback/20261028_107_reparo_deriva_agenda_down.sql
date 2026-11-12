-- Down da 107 (reparo da deriva da agenda). Proveniência obrigatória (parecer do Astra, P2-R2-1 da rev. 2):
--   * sem public.kidmais107_reparos: RECUSA (não há como saber o que a 107 fez; nada é removido);
--   * registro vazio (a 107 encontrou a base canônica): só apaga o registro; nenhum objeto da 005 é tocado;
--   * cada ação registrada é conferida no estado atual (o objeto canônico existe com a definição gravada e o nome
--     anterior não existe) e desfeita em ordem inversa: renomeação volta ao nome da deriva; gatilho e CHECK criados
--     pela 107 são removidos. Divergência em qualquer ação: RECUSA, nada alterado.
-- Nunca remove objeto que já existia antes da 107: só o que está no registro como CRIAR_* por ela.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE r record; atual text;
BEGIN
  IF to_regclass('public.kidmais107_reparos') IS NULL THEN
    RAISE EXCEPTION '107 down: sem o registro de proveniência (kidmais107_reparos); nada alterado';
  END IF;
  IF to_regclass('public.agenda_saloes') IS NOT NULL AND to_regprocedure('public.kidmais108_instalada()') IS NOT NULL THEN
    RAISE EXCEPTION '107 down: a 108 está instalada; desfaça a 108 antes; nada alterado';
  END IF;
  FOR r IN SELECT * FROM public.kidmais107_reparos ORDER BY ordem DESC LOOP
    IF r.acao = 'RENOMEAR_INDICE' THEN
      SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE INDEX \S+ ON \S+ ', '') INTO atual
        FROM pg_index i WHERE i.indexrelid = to_regclass('public.' || r.nome_novo) AND i.indrelid = ('public.' || r.tabela)::regclass;
      IF atual IS DISTINCT FROM r.definicao OR to_regclass('public.' || r.nome_anterior) IS NOT NULL THEN
        RAISE EXCEPTION '107 down: % não está como a 107 deixou; nada alterado', r.nome_novo;
      END IF;
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.nome_novo, r.nome_anterior);
    ELSIF r.acao IN ('RENOMEAR_CHECK', 'CRIAR_CHECK') THEN
      SELECT pg_get_constraintdef(c.oid) INTO atual FROM pg_constraint c
       WHERE c.conrelid = ('public.' || r.tabela)::regclass AND c.conname = r.nome_novo AND c.contype = 'c';
      IF atual IS DISTINCT FROM r.definicao
         OR (r.acao = 'RENOMEAR_CHECK' AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || r.tabela)::regclass AND c.conname = r.nome_anterior)) THEN
        RAISE EXCEPTION '107 down: % não está como a 107 deixou; nada alterado', r.nome_novo;
      END IF;
      IF r.acao = 'RENOMEAR_CHECK' THEN
        EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tabela, r.nome_novo, r.nome_anterior);
      ELSE
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tabela, r.nome_novo);
      END IF;
    ELSIF r.acao = 'CRIAR_GATILHO' THEN
      SELECT t.tgtype || '|' || t.tgfoid::regprocedure::text || '|' || t.tgnargs || '|' || (t.tgqual IS NULL) || '|' || cardinality(t.tgattr::int2[]) || '|' || t.tgenabled::text INTO atual
        FROM pg_trigger t WHERE t.tgrelid = ('public.' || r.tabela)::regclass AND t.tgname = r.nome_novo AND NOT t.tgisinternal;
      IF atual IS DISTINCT FROM r.definicao THEN
        RAISE EXCEPTION '107 down: % não está como a 107 deixou; nada alterado', r.nome_novo;
      END IF;
      EXECUTE format('DROP TRIGGER %I ON public.%I', r.nome_novo, r.tabela);
    ELSE
      RAISE EXCEPTION '107 down: ação desconhecida no registro (%); nada alterado', r.acao;
    END IF;
  END LOOP;
  DROP TABLE public.kidmais107_reparos;
END $$;
COMMIT;
