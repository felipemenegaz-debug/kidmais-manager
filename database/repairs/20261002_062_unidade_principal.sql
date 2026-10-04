-- Reparo controlado da 062 (D2): Unidade principal para empresas ATIVAS sem nenhuma unidade. Não é migration.
-- NÃO EXECUTADO. Exige autorização explícita para o alvo (docs/OPERACAO_AGENTES.md).
--
-- Sem a variável de sessão abaixo o script só valida e aborta (simulação segura):
--   psql -X -v ON_ERROR_STOP=1 -c "SET kidmais.reparo_062 = 'unidade_principal'" -f database/repairs/20261002_062_unidade_principal.sql
-- (ou, numa sessão psql: SET kidmais.reparo_062 = 'unidade_principal'; \i database/repairs/20261002_062_unidade_principal.sql)
--
-- Efeito único: empresa ATIVA sem nenhuma unidade (exceto desativadas) ⇒ estabelecimento 'principal' / "Unidade
-- principal". Pela 043 ele nasce SUSPENSO e, pela regra de elegibilidade da 062 (D6 = habilitação explícita), NÃO fica
-- habilitado para agenda: cria só a identidade da unidade, sem mudar nenhum conflito nem nenhuma contratação.
-- Contratações existentes NÃO recebem unidade aqui: a atribuição é uma decisão por contratação, gravada em
-- agenda_062_fechamentos_resolucao e aplicada por database/repairs/20261002_062_fechamentos_unidade.sql (depois da
-- habilitação da unidade). Nada é atribuído por "a empresa só tem uma unidade".
-- Recuperação: as unidades criadas ficam listadas na saída (RETURNING); a 043 recusa exclusão física de
-- estabelecimento — desativar exige reparo próprio, autorizado.
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
COMMIT;
