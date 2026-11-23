-- Desfaz a 133. O código volta sozinho à 094 quando a função some (to_regprocedure); nada mais depende dela.
-- Sob tráfego (Astra r1, P3): cada requisição que sondou a 133 logo antes do DROP ainda a chama e falha com 42883
-- (várias ao mesmo tempo, se simultâneas); as que sondarem depois do DROP já leem a 094. Para rollback sem esse erro: 1) publicar o código anterior (que só lê a 094) ou
-- um que não use a 133; 2) esperar terminar as requisições em andamento do deploy antigo (deploy LIVE e instâncias
-- antigas encerradas); 3) só então rodar este arquivo. Em emergência, rodar direto: cada requisição que já selecionou a 133 pode
-- falhar uma vez (Astra r2, P3); as seguintes leem a 094.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DROP FUNCTION public.kidmais133_ocupacoes_escopo(date, date, uuid, uuid);
COMMIT;
