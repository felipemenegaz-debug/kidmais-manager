-- Rollback da 092: volta as CHECKs de tipo_calculo e a função de lacunas da 047.
-- Recusado se houver qualquer linha PONTO (preço ou fotografia): o rollback não reescreve preço nem contrato.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precos_pacote_092_ponto_check') THEN
    RAISE EXCEPTION '092 rollback: a 092 não está aplicada; nada alterado';
  END IF;
  IF EXISTS (SELECT 1 FROM precos_pacote WHERE tipo_calculo = 'PONTO')
    OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots WHERE tipo_calculo = 'PONTO') THEN
    RAISE EXCEPTION '092 rollback: há preços ou fotografias por quantidade; nada alterado';
  END IF;
END $$;
ALTER TABLE precos_pacote DROP CONSTRAINT precos_pacote_092_ponto_check;
ALTER TABLE precos_pacote DROP CONSTRAINT precos_pacote_tipo_calculo_check;
ALTER TABLE precos_pacote ADD CONSTRAINT precos_pacote_tipo_calculo_check
  CHECK (tipo_calculo IN ('FIXO', 'POR_CONVIDADO'));
ALTER TABLE fechamento_pacote_snapshots DROP CONSTRAINT fechamento_pacote_snapshots_tipo_check;
ALTER TABLE fechamento_pacote_snapshots ADD CONSTRAINT fechamento_pacote_snapshots_tipo_check
  CHECK (tipo_calculo IN ('FIXO', 'POR_CONVIDADO'));

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
        AND p.tipo_calculo IN ('FIXO', 'POR_CONVIDADO')
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
     );
$$;

COMMIT;
