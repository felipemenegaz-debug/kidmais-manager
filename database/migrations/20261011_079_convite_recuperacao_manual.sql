-- 079: decisão manual auditável para geração de IA inconclusiva.
-- Executar somente após autorização do ambiente, precheck e backup operacional.
-- A decisão não chama o provedor. O estado INCERTA é transacionado uma única vez.
-- Rollback: database/rollback/20261011_079_convite_recuperacao_manual_down.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;
DO $$
DECLARE definicao text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definicao FROM pg_constraint
    WHERE conrelid='public.convite_geracoes'::regclass AND conname='convite_geracoes_estado_check';
  IF definicao IS NULL OR definicao NOT LIKE '%RESERVADA%' OR definicao NOT LIKE '%CONCLUIDA%' OR definicao NOT LIKE '%INCERTA%'
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes'
      AND column_name IN ('resolucao_resultado','resolucao_por','resolucao_em','resolucao_evidencia','reserva_microusd')) THEN
    RAISE EXCEPTION '079: precheck falhou; nada alterado';
  END IF;
END $$;
ALTER TABLE convite_geracoes DROP CONSTRAINT convite_geracoes_estado_check;
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_estado_check
  CHECK (estado IN ('RESERVADA','CONCLUIDA','INCERTA','RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA'));
ALTER TABLE convite_geracoes ADD COLUMN resolucao_resultado text,
  ADD COLUMN resolucao_por uuid REFERENCES usuarios_administrativos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN resolucao_em timestamptz,
  ADD COLUMN resolucao_evidencia text,
  ADD COLUMN reserva_microusd bigint NOT NULL DEFAULT 300000 CHECK (reserva_microusd >= 0);
ALTER TABLE convite_geracoes ADD CONSTRAINT convite_geracoes_resolucao_consistente CHECK (
  (estado IN ('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA')
    AND resolucao_resultado IS NOT NULL AND resolucao_evidencia IS NOT NULL
    AND resolucao_resultado IN ('COBRANCA_CONFIRMADA','SEM_COBRANCA')
    AND resolucao_por IS NOT NULL AND resolucao_em IS NOT NULL
    AND length(btrim(resolucao_evidencia)) BETWEEN 10 AND 1000
    AND ((estado='RESOLVIDA_COBRADA' AND resolucao_resultado='COBRANCA_CONFIRMADA')
      OR (estado='RESOLVIDA_SEM_COBRANCA' AND resolucao_resultado='SEM_COBRANCA')))
  OR (estado NOT IN ('RESOLVIDA_COBRADA','RESOLVIDA_SEM_COBRANCA')
    AND resolucao_resultado IS NULL AND resolucao_por IS NULL AND resolucao_em IS NULL AND resolucao_evidencia IS NULL)
);
CREATE INDEX convite_geracoes_incertas ON convite_geracoes(convite_id,empresa_id,criado_em) WHERE estado='INCERTA';
COMMIT;
