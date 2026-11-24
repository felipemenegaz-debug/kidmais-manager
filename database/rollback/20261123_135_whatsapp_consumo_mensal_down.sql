-- Desfaz a 135. O código lê a tabela por to_regclass: sem ela, o teto mensal fica desligado (comportamento anterior à
-- 3b) e a tela Resultado não mostra o consumo. O consumo registrado do mês se perde; reaplicar a 135 refaz a carga
-- inicial pelas saídas ainda guardadas (as de conversas já excluídas não voltam).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DROP TABLE public.whatsapp_atendimento_consumo_mensal;
COMMIT;
