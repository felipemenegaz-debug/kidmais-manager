-- Desfaz a 134 e DESCARTA as marcas "Interna" (a auditoria EMPRESA_USO_ALTERADO continua com o histórico).
-- O código confere a tabela por to_regclass a cada leitura: sem ela, todas as empresas voltam a contar como Cliente e a
-- marcação responde que a migration 134 não está aplicada. Nada mais depende da tabela.
-- Recusa sem a confirmação explícita: rodar com  SET kidmais.rollback_134 = 'descartar-marcas';  na mesma sessão.
--
-- Só para banco SEM tentativa ativa da 134 no registro (operacao_migration_tentativas), ou seja, onde a 134 não foi
-- aplicada pelo registro: banco descartável, ensaio, cópia local. Astra r1 (P2): num ambiente registrado, o DROP deixaria
-- a tentativa CONCLUIDA apontando para uma tabela que não existe, e --conferir-134 e a reaplicação passariam a responder
-- DIVERGENCIA_REGISTRO_ESTADO (código 3). Por isso o arquivo recusa quando há tentativa não arquivada da 134.
-- Em staging ou production com a 134 registrada, desfazer é:
--   a) correção para a frente (preferível): publicar código que ignore a marca (ou esvaziar a tabela por uma migration
--      nova, registrada), sem apagar a tabela da 134; ou
--   b) restauração do banco (PITR) para antes da aplicação, que leva junto a linha do registro.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF current_setting('kidmais.rollback_134', true) IS DISTINCT FROM 'descartar-marcas' THEN
    RAISE EXCEPTION '134 rollback: confirme com SET kidmais.rollback_134 = ''descartar-marcas'' (as marcas Interna serão perdidas)';
  END IF;
  IF to_regclass('public.operacao_migration_tentativas') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.operacao_migration_tentativas WHERE migration = '134' AND arquivada_em IS NULL) THEN
      RAISE EXCEPTION '134 rollback: a 134 tem tentativa ativa no registro; num ambiente registrado use correção para a frente ou restauração (PITR), não este arquivo';
    END IF;
  END IF;
END $$;
DROP TABLE public.plataforma_empresas_uso;
COMMIT;
