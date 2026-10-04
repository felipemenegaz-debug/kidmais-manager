-- Reparo controlado da 062 (D2): unidade das contratações existentes, SÓ por decisão explícita. Não é migration.
-- NÃO EXECUTADO. Exige autorização explícita para o alvo (docs/OPERACAO_AGENTES.md).
--
-- Cada contratação a atribuir precisa de uma linha em agenda_062_fechamentos_resolucao (unidade, quem decidiu e
-- motivo), inserida por decisão explícita depois do levantamento (consulta 6). Sem linha, a contratação continua sem
-- unidade = vale para a empresa inteira (alcance seguro: só bloqueia mais).
--
-- Ordem segura (plano de staging): habilitar a unidade (S13) ANTES deste reparo. Decisão para unidade sem
-- habilitação vigente, de outra empresa, ou para contratação que já tem outra unidade TRAVA a aplicação inteira
-- (nada é alterado). Decisão já aplicada (mesma unidade) é ignorada: repetir o reparo não muda nada.
--
-- CONCORRÊNCIA: executar com as escritas de agenda PAUSADAS (sem contratação, remarcação, bloqueio, assinatura,
-- pagamento que confirme reserva ou integração em andamento) — plano de staging, S17. O reparo trava antes as unidades
-- e todas as datas afetadas em ordem (empresa → unidade → habilitação → datas ordenadas → contratação), o que reduz
-- esperas cruzadas, mas a linha alterada é travada pelo próprio UPDATE e uma escrita concorrente ainda pode formar
-- ciclo: o PostgreSQL aborta um dos lados (40P01). lock_timeout só limita a espera; não evita deadlock. Se o reparo
-- abortar, nada é aplicado (transação única) e ele pode ser repetido dentro da janela.
--
-- Simulação segura sem a variável; para aplicar (com autorização para o alvo):
--   SET kidmais.reparo_062 = 'fechamentos_unidade'; \i database/repairs/20261002_062_fechamentos_unidade.sql
-- Efeito: fechamentos.estabelecimento_id recebe a unidade decidida (alcance passa da empresa inteira para a unidade).
-- Os gatilhos da 062/019 revalidam cada contratação (unidade habilitada; conflitos só no mesmo recurso).
-- Recuperação: as linhas alteradas saem no RETURNING; a 062 recusa trocar unidade definida — reverter exige reparo
-- próprio, autorizado.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE invalidas integer; pendentes integer;
BEGIN
  IF to_regclass('public.agenda_062_fechamentos_resolucao') IS NULL OR to_regprocedure('public.kidmais062_unidade_agendavel(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'reparo 062: a 062 não está aplicada.';
  END IF;
  -- Ordem única de locks da agenda: unidades decididas (empresa → unidade → habilitação) antes de conferir e das contratações.
  PERFORM kidmais062_travar_habilitacao(u.estabelecimento_id)
     FROM (SELECT DISTINCT estabelecimento_id FROM agenda_062_fechamentos_resolucao ORDER BY estabelecimento_id) u;
  -- Depois das unidades, todas as datas das contratações a atribuir, de uma vez e ordenadas (a função ordena).
  PERFORM kidmais_lock_datas_revisao(ARRAY(SELECT DISTINCT f.data_evento FROM agenda_062_fechamentos_resolucao r
    JOIN fechamentos f ON f.id = r.fechamento_id WHERE f.estabelecimento_id IS NULL ORDER BY 1));
  SELECT count(*) INTO invalidas FROM agenda_062_fechamentos_resolucao r LEFT JOIN fechamentos f ON f.id = r.fechamento_id
   WHERE f.id IS NULL OR f.empresa_id IS DISTINCT FROM r.empresa_id
      OR (f.estabelecimento_id IS NOT NULL AND f.estabelecimento_id <> r.estabelecimento_id)
      OR (f.estabelecimento_id IS NULL AND NOT kidmais062_unidade_agendavel(r.empresa_id, r.estabelecimento_id));
  IF invalidas > 0 THEN
    RAISE EXCEPTION 'reparo 062: % decisão(ões) inválida(s) (contratação de outra empresa, já com outra unidade, ou unidade sem habilitação vigente); corrija as decisões ou habilite a unidade antes.', invalidas;
  END IF;
  SELECT count(*) INTO pendentes FROM fechamentos f
   WHERE f.empresa_id IS NOT NULL AND f.estabelecimento_id IS NULL AND f.data_evento >= current_date AND f.status NOT IN ('CANCELADO', 'RECUSADO', 'EXPIRADO')
     AND NOT EXISTS (SELECT 1 FROM agenda_062_fechamentos_resolucao r WHERE r.fechamento_id = f.id);
  RAISE NOTICE 'reparo 062: % contratação(ões) futura(s) sem decisão continuam valendo para a empresa inteira.', pendentes;
  IF current_setting('kidmais.reparo_062', true) IS DISTINCT FROM 'fechamentos_unidade' THEN
    RAISE EXCEPTION 'reparo 062 (simulação): decisões válidas; defina kidmais.reparo_062 = fechamentos_unidade para aplicar.';
  END IF;
END $$;

UPDATE fechamentos f SET estabelecimento_id = r.estabelecimento_id
  FROM agenda_062_fechamentos_resolucao r
 WHERE r.fechamento_id = f.id AND f.empresa_id = r.empresa_id AND f.estabelecimento_id IS NULL
RETURNING f.id AS fechamento_id, f.empresa_id, f.estabelecimento_id, 'UNIDADE_ATRIBUIDA' AS efeito;
COMMIT;
