-- Reparo controlado da 062 (D3): dono dos bloqueios de agenda existentes. Não é migration. NÃO EXECUTADO.
-- A propriedade NUNCA é presumida: cada bloqueio ativo sem empresa precisa de uma linha em
-- agenda_062_bloqueios_resolucao (empresa, unidade opcional, quem decidiu e motivo), inserida por decisão explícita.
-- Qualquer bloqueio ativo sem resolução BLOQUEIA a aplicação inteira (nada é alterado).
--
-- Simulação segura sem a variável; para aplicar (com autorização para o alvo):
--   SET kidmais.reparo_062 = 'bloqueios'; \i database/repairs/20261002_062_bloqueios_propriedade.sql
-- Efeito: bloqueios_agenda.empresa_id/estabelecimento_id recebem a resolução (alcance passa de global para a empresa
-- ou unidade). O gatilho da 062/019 revalida cada bloqueio contra as contratações do novo alcance.
-- Recuperação: as linhas alteradas saem no RETURNING; voltar a global = UPDATE ... SET empresa_id = NULL por reparo
-- próprio autorizado (o alcance global é sempre seguro: só bloqueia mais).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE pendentes integer;
BEGIN
  IF to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL THEN RAISE EXCEPTION 'reparo 062: a 062 não está aplicada.'; END IF;
  SELECT count(*) INTO pendentes FROM bloqueios_agenda b
   WHERE b.ativo AND b.empresa_id IS NULL AND NOT EXISTS (SELECT 1 FROM agenda_062_bloqueios_resolucao r WHERE r.bloqueio_id = b.id);
  IF pendentes > 0 THEN
    RAISE EXCEPTION 'reparo 062: % bloqueio(s) ativo(s) sem dono resolvido; resolva todos (ou desative) antes de aplicar.', pendentes;
  END IF;
  IF current_setting('kidmais.reparo_062', true) IS DISTINCT FROM 'bloqueios' THEN
    RAISE EXCEPTION 'reparo 062 (simulação): sem pendências; defina kidmais.reparo_062 = bloqueios para aplicar.';
  END IF;
END $$;

UPDATE bloqueios_agenda b SET empresa_id = r.empresa_id, estabelecimento_id = r.estabelecimento_id
  FROM agenda_062_bloqueios_resolucao r
 WHERE r.bloqueio_id = b.id AND b.empresa_id IS NULL
RETURNING b.id AS bloqueio_id, b.empresa_id, b.estabelecimento_id, 'BLOQUEIO_ATRIBUIDO' AS efeito;
COMMIT;
