-- 092: preço do pacote por quantidades cheias (decisão de Felipe em 22/10/2026).
-- O buffet informa o preço só em quantidades cheias (50, 60, 70...). Cada uma vira uma linha de precos_pacote com
-- tipo_calculo 'PONTO' e convidados_min = convidados_max. Para uma quantidade quebrada (53), o valor de cada convidado é
-- a diferença até o próximo ponto dividida pelos convidados entre os dois: P50 + 3 × (P60 − P50) ÷ 10.
-- Regras: o primeiro ponto é o mínimo do pacote, o último é o máximo, e cada ponto custa igual ou mais que o anterior.
-- A tela e o servidor recusam; aqui a publicação recusa pelas lacunas novas (PONTO_*).
-- Aditiva para o que já existe: FIXO e POR_CONVIDADO continuam iguais, nenhuma linha é reescrita, contratos e
-- fotografias antigos não mudam. Os pacotes com faixas FIXO só passam a PONTO quando o buffet confirma (pela tela).
-- ORDEM: aplicar a 092 ANTES do código que grava PONTO. Com a 092 aplicada e o código antigo no ar, nada muda (não há
-- linha PONTO). Sem a 092, o código novo recusa salvar preços por quantidade (a CHECK antiga barra 'PONTO').
-- Executar somente após autorização própria do ambiente, precheck e backup operacional.
-- Rollback: database/rollback/20261022_092_precos_por_quantidade_down.sql (recusado se houver linha PONTO).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF to_regclass('public.precos_pacote') IS NULL OR to_regclass('public.fechamento_pacote_snapshots') IS NULL
    OR to_regclass('public.tabela_preco_escopos') IS NULL
    OR to_regprocedure('public.kidmais_047_lacunas_escopo(uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_tipo_calculo_check')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fechamento_pacote_snapshots_tipo_check')
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_092_ponto_check') THEN
    RAISE EXCEPTION '092: precheck falhou (006/029/047 ausentes ou 092 anterior/parcial); nada alterado';
  END IF;
END $$;

ALTER TABLE precos_pacote DROP CONSTRAINT precos_pacote_tipo_calculo_check;
ALTER TABLE precos_pacote ADD CONSTRAINT precos_pacote_tipo_calculo_check
  CHECK (tipo_calculo IN ('FIXO', 'POR_CONVIDADO', 'PONTO'));
ALTER TABLE precos_pacote ADD CONSTRAINT precos_pacote_092_ponto_check
  CHECK (tipo_calculo <> 'PONTO' OR convidados_max = convidados_min);

-- A fotografia guarda a linha do ponto de baixo; o valor calculado fica em valor_pacote_base, como hoje.
ALTER TABLE fechamento_pacote_snapshots DROP CONSTRAINT fechamento_pacote_snapshots_tipo_check;
ALTER TABLE fechamento_pacote_snapshots ADD CONSTRAINT fechamento_pacote_snapshots_tipo_check
  CHECK (tipo_calculo IN ('FIXO', 'POR_CONVIDADO', 'PONTO'));

-- Mesma função da 047 (mesma assinatura, chamada pelas guardas da 048/049), com PONTO aceito como preço e três
-- lacunas novas, só para escopos com pontos.
CREATE OR REPLACE FUNCTION kidmais_047_lacunas_escopo(tabela uuid)
RETURNS TABLE (codigo text, detalhe text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH escopo AS (
    SELECT e.id, e.pacote_id, e.categoria_horario, e.cobertura_continua,
           e.limite_convidados_min, e.limite_convidados_max
      FROM tabela_preco_escopos e
     WHERE e.tabela_preco_id = tabela
  ),
  faixa AS (
    SELECT f.id, f.escopo_id, f.convidados_min, f.convidados_max,
           e.pacote_id, e.categoria_horario, e.cobertura_continua,
           e.limite_convidados_min, e.limite_convidados_max,
           p.codigo AS pacote_codigo,
           p.convidados_minimos, p.convidados_maximos
      FROM tabela_preco_escopo_faixas f
      JOIN escopo e ON e.id = f.escopo_id
      JOIN pacotes p ON p.id = e.pacote_id
  ),
  ponto AS (
    SELECT pp.pacote_id, pp.categoria_horario, pp.convidados_min AS convidados, pp.valor,
           pk.codigo AS pacote_codigo, pk.convidados_minimos, pk.convidados_maximos,
           lag(pp.valor) OVER (PARTITION BY pp.pacote_id, pp.categoria_horario ORDER BY pp.convidados_min) AS valor_anterior
      FROM precos_pacote pp
      JOIN pacotes pk ON pk.id = pp.pacote_id
     WHERE pp.tabela_preco_id = tabela
       AND pp.ativo
       AND pp.tipo_calculo = 'PONTO'
  )
  SELECT 'ESCOPO_AUSENTE'::text,
         'A tabela não declara quais pacotes, categorias e faixas vende.'::text
   WHERE NOT EXISTS (SELECT 1 FROM escopo)
  UNION ALL
  SELECT 'COMBINACAO_SEM_FAIXA', p.codigo || ' · ' || e.categoria_horario
    FROM escopo e
    JOIN pacotes p ON p.id = e.pacote_id
   WHERE NOT EXISTS (SELECT 1 FROM faixa f WHERE f.escopo_id = e.id)
  UNION ALL
  SELECT 'EMPRESA_DIVERGENTE', p.codigo
    FROM escopo e
    JOIN pacotes p ON p.id = e.pacote_id
    JOIN tabelas_preco t ON t.id = tabela
   WHERE t.empresa_id IS DISTINCT FROM p.empresa_id
  UNION ALL
  SELECT 'FAIXA_INVALIDA', f.pacote_codigo || ' · ' || f.categoria_horario
    FROM faixa f
   WHERE f.convidados_min < 1
      OR (f.convidados_max IS NOT NULL AND f.convidados_max < f.convidados_min)
  UNION ALL
  SELECT 'FAIXA_SOBREPOSTA', a.pacote_codigo || ' · ' || a.categoria_horario
    FROM faixa a
    JOIN faixa b
      ON b.escopo_id = a.escopo_id
     AND b.id > a.id
     AND numrange(a.convidados_min::numeric, COALESCE(a.convidados_max::numeric, 'Infinity'::numeric), '[]')
         && numrange(b.convidados_min::numeric, COALESCE(b.convidados_max::numeric, 'Infinity'::numeric), '[]')
  UNION ALL
  SELECT 'FAIXA_FORA_DO_LIMITE', f.pacote_codigo || ' · ' || f.categoria_horario
    FROM faixa f
   WHERE (f.limite_convidados_min IS NOT NULL AND f.convidados_min < f.limite_convidados_min)
      OR (f.limite_convidados_max IS NOT NULL AND (f.convidados_max IS NULL OR f.convidados_max > f.limite_convidados_max))
      OR (f.convidados_minimos IS NOT NULL AND f.convidados_min < f.convidados_minimos)
      OR (f.convidados_maximos IS NOT NULL AND (f.convidados_max IS NULL OR f.convidados_max > f.convidados_maximos))
  UNION ALL
  SELECT 'FAIXA_COM_BURACO', x.pacote_codigo || ' · ' || x.categoria_horario
    FROM (
      SELECT f.pacote_codigo, f.categoria_horario, f.cobertura_continua,
             f.convidados_min, f.convidados_max,
             f.limite_convidados_min, f.limite_convidados_max,
             lag(f.convidados_max) OVER (PARTITION BY f.escopo_id ORDER BY f.convidados_min, f.id) AS anterior_max,
             row_number() OVER (PARTITION BY f.escopo_id ORDER BY f.convidados_min, f.id) AS ordem,
             count(*) OVER (PARTITION BY f.escopo_id) AS total
        FROM faixa f
    ) x
   WHERE x.cobertura_continua
     AND (
       (x.ordem > 1 AND (x.anterior_max IS NULL OR x.convidados_min > x.anterior_max + 1))
       OR (x.limite_convidados_min IS NOT NULL AND x.ordem = 1 AND x.convidados_min > x.limite_convidados_min)
       OR (x.limite_convidados_max IS NOT NULL AND x.ordem = x.total
           AND (x.convidados_max IS NULL OR x.convidados_max < x.limite_convidados_max))
     )
  UNION ALL
  SELECT 'FAIXA_SEM_PRECO',
         f.pacote_codigo || ' · ' || f.categoria_horario || ' · ' || f.convidados_min::text
           || '–' || COALESCE(f.convidados_max::text, 'aberto')
    FROM faixa f
   WHERE NOT EXISTS (
     SELECT 1
       FROM precos_pacote p
      WHERE p.tabela_preco_id = tabela
        AND p.ativo
        AND p.pacote_id = f.pacote_id
        AND p.categoria_horario = f.categoria_horario
        AND p.convidados_min = f.convidados_min
        AND p.convidados_max IS NOT DISTINCT FROM f.convidados_max
        AND p.valor > 0
        AND p.tipo_calculo IN ('FIXO', 'POR_CONVIDADO', 'PONTO')
   )
  UNION ALL
  SELECT 'PRECO_FORA_DO_ESCOPO',
         pk.codigo || ' · ' || p.categoria_horario || ' · ' || p.convidados_min::text
           || '–' || COALESCE(p.convidados_max::text, 'aberto')
    FROM precos_pacote p
    JOIN pacotes pk ON pk.id = p.pacote_id
   WHERE p.tabela_preco_id = tabela
     AND p.ativo
     AND NOT EXISTS (
       SELECT 1
         FROM faixa f
        WHERE f.pacote_id = p.pacote_id
          AND f.categoria_horario = p.categoria_horario
          AND f.convidados_min = p.convidados_min
          AND f.convidados_max IS NOT DISTINCT FROM p.convidados_max
     )
  UNION ALL
  -- 092: um pacote/categoria com pontos não mistura faixas nem preço por convidado.
  SELECT DISTINCT 'PONTO_MISTURADO', pt.pacote_codigo || ' · ' || pt.categoria_horario
    FROM ponto pt
   WHERE EXISTS (
     SELECT 1
       FROM precos_pacote o
      WHERE o.tabela_preco_id = tabela
        AND o.ativo
        AND o.pacote_id = pt.pacote_id
        AND o.categoria_horario = pt.categoria_horario
        AND o.tipo_calculo <> 'PONTO'
   )
  UNION ALL
  -- 092: os pontos começam no mínimo e terminam no máximo do pacote.
  SELECT 'PONTO_SEM_EXTREMOS', x.pacote_codigo || ' · ' || x.categoria_horario
    FROM (
      SELECT pt.pacote_codigo, pt.categoria_horario, pt.convidados_minimos, pt.convidados_maximos,
             min(pt.convidados) AS primeiro, max(pt.convidados) AS ultimo
        FROM ponto pt
       GROUP BY pt.pacote_codigo, pt.categoria_horario, pt.convidados_minimos, pt.convidados_maximos
    ) x
   WHERE (x.convidados_minimos IS NOT NULL AND x.primeiro <> x.convidados_minimos)
      OR (x.convidados_maximos IS NOT NULL AND x.ultimo <> x.convidados_maximos)
  UNION ALL
  -- 092: cada quantidade cheia custa igual ou mais que a anterior.
  SELECT 'PONTO_DECRESCENTE', pt.pacote_codigo || ' · ' || pt.categoria_horario || ' · ' || pt.convidados::text
    FROM ponto pt
   WHERE pt.valor_anterior IS NOT NULL
     AND pt.valor < pt.valor_anterior;
$$;

COMMIT;
