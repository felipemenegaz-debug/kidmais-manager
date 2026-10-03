-- Reparo controlado da 062 (D2): Unidade principal para empresas sem unidade e unidade das contratações de empresas
-- com UMA unidade ELEGÍVEL. Não é migration. NÃO EXECUTADO. Exige autorização explícita para o alvo
-- (docs/OPERACAO_AGENTES.md).
--
-- Sem a variável de sessão abaixo o script só valida e aborta (simulação segura):
--   psql -X -v ON_ERROR_STOP=1 -c "SET kidmais.reparo_062 = 'unidade_principal'" -f database/repairs/20261002_062_unidade_principal.sql
-- (ou, numa sessão psql: SET kidmais.reparo_062 = 'unidade_principal'; \i database/repairs/20261002_062_unidade_principal.sql)
--
-- Efeitos (todos na mesma transação):
--   1. empresa ATIVA sem nenhuma unidade (exceto desativadas) ⇒ estabelecimento 'principal' / "Unidade principal". Pela
--      043 ele nasce SUSPENSO e, pela regra de elegibilidade da 062 (D6), NÃO fica elegível para agenda: cria só a
--      identidade da unidade, sem mudar nenhum conflito;
--   2. empresa com EXATAMENTE uma unidade ELEGÍVEL (kidmais062_unidade_agendavel) ⇒ contratações dela sem unidade
--      passam a apontar para essa unidade. Com a regra atual (só ATIVO), nenhuma é atribuída.
--   Empresas com mais de uma unidade elegível: nada é atribuído (exige decisão por contratação).
-- Recuperação: as unidades criadas e as atribuições ficam listadas na saída (RETURNING); a 043 recusa exclusão física de
-- estabelecimento e a 062 recusa trocar unidade definida — reverter exige reparo próprio, autorizado.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF to_regprocedure('public.kidmais062_unidade_agendavel(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'reparo 062: a 062 não está aplicada.'; END IF;
  IF current_setting('kidmais.reparo_062', true) IS DISTINCT FROM 'unidade_principal' THEN
    RAISE EXCEPTION 'reparo 062 (simulação): defina kidmais.reparo_062 = unidade_principal para aplicar. Use o levantamento antes.';
  END IF;
END $$;

INSERT INTO estabelecimentos (empresa_id, codigo, nome, status)
SELECT e.id, 'principal', 'Unidade principal', 'SUSPENSO'
  FROM empresas e
 WHERE e.status = 'ATIVA'
   AND NOT EXISTS (SELECT 1 FROM estabelecimentos u WHERE u.empresa_id = e.id AND u.status <> 'DESATIVADO')
   AND NOT EXISTS (SELECT 1 FROM estabelecimentos u WHERE u.empresa_id = e.id AND u.codigo = 'principal')
RETURNING empresa_id, id AS estabelecimento_id, 'UNIDADE_PRINCIPAL_CRIADA' AS efeito;

WITH unica AS (
  SELECT empresa_id, min(id::text)::uuid AS estabelecimento_id
    FROM estabelecimentos WHERE kidmais062_unidade_agendavel(empresa_id, id) GROUP BY empresa_id HAVING count(*) = 1
)
UPDATE fechamentos f SET estabelecimento_id = unica.estabelecimento_id
  FROM unica
 WHERE f.empresa_id = unica.empresa_id AND f.estabelecimento_id IS NULL
RETURNING f.id AS fechamento_id, f.empresa_id, f.estabelecimento_id, 'UNIDADE_ATRIBUIDA' AS efeito;
COMMIT;
