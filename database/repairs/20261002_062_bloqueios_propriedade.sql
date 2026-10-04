-- Reparo controlado da 062 (D3): dono dos bloqueios de agenda existentes. Não é migration. NÃO EXECUTADO.
-- A propriedade NUNCA é presumida: cada bloqueio precisa de uma linha em agenda_062_bloqueios_resolucao (empresa,
-- unidade opcional, quem decidiu e motivo), inserida por decisão explícita.
--
-- Pendência que TRAVA a aplicação inteira (nada é alterado): bloqueio ATIVO, SEM DONO, de HOJE EM DIANTE e sem
-- resolução — exatamente a lista "PENDENTE" da consulta 3 do levantamento (mesmo predicado). Bloqueios passados sem
-- dono não travam (não decidem agenda futura) e continuam globais; podem ser resolvidos do mesmo jeito.
-- Também trava: resolução para unidade sem habilitação vigente (habilite a unidade antes, S13) ou de outra empresa.
--
-- CONCORRÊNCIA: executar com as escritas de agenda PAUSADAS (sem contratação, remarcação, bloqueio, assinatura,
-- pagamento que confirme reserva ou integração em andamento) — plano de staging, S17. O reparo trava antes as unidades
-- e todas as datas afetadas em ordem (empresa → unidade → habilitação → datas ordenadas → contratação), o que reduz
-- esperas cruzadas, mas a linha alterada é travada pelo próprio UPDATE e uma escrita concorrente ainda pode formar
-- ciclo: o PostgreSQL aborta um dos lados (40P01). lock_timeout só limita a espera; não evita deadlock. Se o reparo
-- abortar, nada é aplicado (transação única) e ele pode ser repetido dentro da janela.
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
DECLARE pendentes integer; invalidas integer;
BEGIN
  IF to_regclass('public.agenda_062_bloqueios_resolucao') IS NULL OR to_regprocedure('public.kidmais062_unidade_agendavel(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'reparo 062: a 062 não está aplicada.';
  END IF;
  -- Ordem única de locks da agenda: unidades das resoluções (empresa → unidade → habilitação) antes de conferir.
  PERFORM kidmais062_travar_habilitacao(u.estabelecimento_id)
     FROM (SELECT DISTINCT estabelecimento_id FROM agenda_062_bloqueios_resolucao WHERE estabelecimento_id IS NOT NULL ORDER BY estabelecimento_id) u;
  -- Depois das unidades, todas as datas dos bloqueios a atribuir, de uma vez e ordenadas (a função ordena).
  PERFORM kidmais_lock_datas_revisao(ARRAY(SELECT DISTINCT b.data FROM agenda_062_bloqueios_resolucao r
    JOIN bloqueios_agenda b ON b.id = r.bloqueio_id WHERE b.empresa_id IS NULL ORDER BY 1));
  -- Predicado idêntico ao da consulta 3 do levantamento (database/repairs/20261002_062_levantamento_agenda.sql).
  SELECT count(*) INTO pendentes FROM bloqueios_agenda b
   WHERE b.ativo AND b.empresa_id IS NULL AND b.data >= current_date
     AND NOT EXISTS (SELECT 1 FROM agenda_062_bloqueios_resolucao r WHERE r.bloqueio_id = b.id);
  IF pendentes > 0 THEN
    RAISE EXCEPTION 'reparo 062: % bloqueio(s) ativo(s), futuros, sem dono resolvido; resolva todos (ou desative) antes de aplicar.', pendentes;
  END IF;
  SELECT count(*) INTO invalidas FROM agenda_062_bloqueios_resolucao r JOIN bloqueios_agenda b ON b.id = r.bloqueio_id
   WHERE b.empresa_id IS NULL AND r.estabelecimento_id IS NOT NULL AND NOT kidmais062_unidade_agendavel(r.empresa_id, r.estabelecimento_id);
  IF invalidas > 0 THEN
    RAISE EXCEPTION 'reparo 062: % resolução(ões) para unidade sem habilitação vigente; habilite a unidade (ou resolva para a empresa) antes.', invalidas;
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
