-- Desfaz a 136 e DESCARTA a escolha "site externo" das campanhas. O código confere a coluna no catálogo a cada uso: sem
-- ela nenhuma campanha é externa, o painel deixa de oferecer o destino externo e os cliques e a atribuição pelo site
-- externo deixam de gravar. Os links /s/<slug> e as campanhas sem site seguem como antes da 136.
-- Recusa sem a confirmação explícita: rodar com  SET kidmais.rollback_136 = 'descartar-destino-externo';  na mesma sessão.
--
-- Só para banco SEM tentativa ativa da 136 no registro (operacao_migration_tentativas): banco descartável, ensaio, cópia
-- local. Num ambiente registrado, o DROP deixaria a tentativa CONCLUIDA apontando para uma coluna que não existe (o
-- --conferir-136 e a reaplicação responderiam DIVERGENCIA_REGISTRO_ESTADO). Em staging ou production com a 136
-- registrada, desfazer é:
--   a) correção para a frente (preferível): desligar a integração (sem MARKETING_SITE_KIDMAIS_EMPRESA_ID, nada grava) ou
--      publicar código que ignore a coluna, sem apagá-la; ou
--   b) restauração do banco (PITR) para antes da aplicação, que leva junto a linha do registro.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF current_setting('kidmais.rollback_136', true) IS DISTINCT FROM 'descartar-destino-externo' THEN
    RAISE EXCEPTION '136 rollback: confirme com SET kidmais.rollback_136 = ''descartar-destino-externo'' (a escolha de destino externo das campanhas será perdida)';
  END IF;
  IF to_regclass('public.operacao_migration_tentativas') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.operacao_migration_tentativas WHERE migration = '136' AND arquivada_em IS NULL) THEN
      RAISE EXCEPTION '136 rollback: a 136 tem tentativa ativa no registro; num ambiente registrado use correção para a frente ou restauração (PITR), não este arquivo';
    END IF;
  END IF;
END $$;
ALTER TABLE public.marketing_campanhas DROP CONSTRAINT kidmais_136_destino_externo_sem_site;
ALTER TABLE public.marketing_campanhas DROP COLUMN destino_externo;
COMMIT;
